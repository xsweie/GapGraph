/** 实时 AI：通过本地代理调用（浏览器版受 CORS 限制，必须走代理；Electron 同样可以走） */
import type { KNode, ScopeSpec } from '../../shared/types'
import type { NewQuestion } from './qbank'

const KEY = 'gapgraph.ai.endpoint'

/** 解析出的可用地址（启动时探测一次，之后走缓存） */
let resolved = ''
let reachable = false
let routes: string[] = []
let capabilities: string[] = []
let proxyVersion = ''
let probed = false

function readStored(): string {
  try {
    return (localStorage.getItem(KEY) ?? '').trim().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/**
 * 启动时探测一次：
 * 1) 设置里填了地址 → 用它
 * 2) 页面是 http 打开的 → 在没有可用设置时试同源
 * 3) 探测 /health 不通就认定"没有 AI 服务"
 *
 * 之前少了这一步，Vite dev（5180）会被误当成 AI 服务，请求 /pack 直接 404。
 */
export async function initEndpoint(): Promise<void> {
  probed = true
  const stored = readStored()
  const origin = /^https?:\/\//.test(location.origin) ? location.origin : ''
  const candidates = new Set([stored, origin].filter(Boolean))

  for (const ep of candidates) {
    try {
      const res = await fetch(`${ep}/health`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) continue
      const j = (await res.json()) as { ok?: boolean; version?: string; routes?: string[]; capabilities?: string[] }
      if (j?.ok) {
        resolved = ep
        reachable = true
        routes = Array.isArray(j.routes) ? j.routes : []
        capabilities = Array.isArray(j.capabilities) ? j.capabilities : []
        proxyVersion = typeof j.version === 'string' ? j.version : ''
        return
      }
    } catch {
      /* 试下一个 */
    }
  }
  resolved = stored // 填过地址但连不上，也让界面能显示"连不上哪个"
  reachable = false
  routes = []
  capabilities = []
  proxyVersion = ''
}

export function getEndpoint(): string {
  if (resolved) return resolved
  if (probed) return ''
  return readStored()
}

export function endpointStatus(): {
  endpoint: string
  reachable: boolean
  supportsPack: boolean
  supportsScope: boolean
  supportsOptionalScope: boolean
  proxyVersion: string
  supportsChat: boolean
  supportsQuestions: boolean
  supportsExplain: boolean
} {
  return {
    endpoint: getEndpoint(),
    reachable,
    supportsPack: routes.includes('pack'),
    supportsScope: routes.includes('scope'),
    supportsOptionalScope: routes.includes('pack') && capabilities.includes('optional-scope'),
    proxyVersion,
    supportsChat: routes.includes('chat'),
    supportsQuestions: routes.includes('questions') && capabilities.includes('full-question-text'),
    supportsExplain: routes.includes('explain')
  }
}

/**
 * 按需为一个考点出题。
 * 服务端已经做过独立复核（不一致的题会被丢掉），这里只负责传参和解析。
 */
export async function generateQuestions(
  node: { name: string; brief?: string; examWeight: number },
  need: number,
  difficulties: number[],
  ctx?: { exam?: string; subject?: string; chapter?: string; scope?: ScopeSpec }
): Promise<NewQuestion[]> {
  const endpoint = getEndpoint()
  if (!endpoint) return []

  const res = await fetch(`${endpoint}/questions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nodeName: node.name,
      brief: node.brief ?? '',
      examWeight: node.examWeight,
      need,
      difficulties: difficulties.slice(0, need),
      exam: ctx?.exam ?? '',
      subject: ctx?.subject ?? '',
      chapter: ctx?.chapter ?? '',
      scope: ctx?.scope
    }),
    signal: AbortSignal.timeout(60000)
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`出题失败 ${res.status} ${detail.slice(0, 100)}`)
  }
  const data = (await res.json()) as { questions?: NewQuestion[] }
  return Array.isArray(data.questions) ? data.questions.filter((q) => q?.fullText === true) : []
}

export function setEndpoint(value: string): void {
  try {
    const v = value.trim().replace(/\/+$/, '')
    if (v) localStorage.setItem(KEY, v)
    else localStorage.removeItem(KEY)
  } catch {
    /* 忽略 */
  }
}

export interface AskPayload {
  scope?: ScopeSpec
  subject?: string
  nodeName: string
  nodePath: string
  explain: string
  question: string
  /** 追问某道题时附带的题目上下文（题干/选项/我的答案/正确答案/解析） */
  context?: string
}

export interface AiCard {
  type: string
  front: string
  back: string
}

export interface AiAnswer {
  answer: string
  cards: AiCard[]
  ms: number
}

export interface GeneratedPack {
  exam: string
  subject: string
  chapter: string
  nodes: unknown[]
  ms: number
  tokens: number
}

/** 按学习描述和可选范围生成知识网。 */
export async function generatePack(input: { scope: ScopeSpec; request?: string; current?: KNode[] }): Promise<GeneratedPack> {
  const current = input.current?.map(({ id, name, parentId, kind, prereq, scopeIds, supplementary, examWeight, weightLocked, edited }) =>
    ({ id, name, parentId, kind, prereq, scopeIds, supplementary, examWeight, weightLocked, edited }))
  return scopeRequest('/pack', { ...input, current })
}

export interface ScopeDraft {
  stage?: string
  subject?: string
  topic?: string
  goal?: string
  depth?: string
  include?: string[]
  exclude?: string[]
  foundations?: string[]
  question?: string
}

export function draftScope(request: string, scope?: ScopeSpec): Promise<ScopeDraft> {
  return scopeRequest('/scope', { request, scope })
}

async function scopeRequest<T>(route: '/scope' | '/pack', input: object): Promise<T> {
  const supportsRoute = () => route === '/pack' ? endpointStatus().supportsOptionalScope : endpointStatus().supportsScope
  if (!supportsRoute()) await initEndpoint()
  const endpoint = getEndpoint()
  if (!endpointStatus().reachable) throw new Error('AI 代理离线，请运行 start.bat 后重试。')
  if (!supportsRoute()) throw new Error('AI 代理版本过旧，请关闭旧启动窗口并重新运行 start.bat。')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60000)
  try {
    const res = await fetch(`${endpoint}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: ctrl.signal
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`生成失败 ${res.status} ${detail.slice(0, 100)}`)
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** 返回 null 表示"没配代理"；抛错表示"配了但失败" */
export async function askAi(payload: AskPayload): Promise<AiAnswer | null> {
  const endpoint = getEndpoint()
  if (!endpoint) return null

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    const res = await fetch(`${endpoint}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`代理返回 ${res.status} ${detail.slice(0, 80)}`)
    }
    const data = (await res.json()) as AiAnswer
    return { answer: String(data.answer ?? ''), cards: Array.isArray(data.cards) ? data.cards : [], ms: Number(data.ms) || 0 }
  } finally {
    clearTimeout(timer)
  }
}

/* ---------------- 详细讲解 ---------------- */

export interface ExplainPayload {
  scope?: ScopeSpec
  nodeName: string
  nodePath: string
  brief: string
  exam?: string
  subject?: string
  chapter?: string
}

export interface DetailedExplain {
  definition: string
  basics: string[]
  exams: string[]
  keypoints: string[]
  ms: number
  at: number
}

/**
 * 当场生成某个考点的详细讲解。
 * 返回 null = 代理没配；抛错 = 配了但失败（调用方要给出可读提示）。
 */
export async function explainNode(payload: ExplainPayload): Promise<DetailedExplain | null> {
  const endpoint = getEndpoint()
  if (!endpoint) return null

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 40000)
  try {
    const res = await fetch(`${endpoint}/explain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`代理返回 ${res.status} ${detail.slice(0, 80)}`)
    }
    const d = (await res.json()) as Partial<DetailedExplain>
    const list = (v: unknown): string[] =>
      (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 6)
    return {
      definition: String(d.definition ?? '').slice(0, 1400),
      basics: list(d.basics),
      exams: list(d.exams),
      keypoints: list(d.keypoints),
      ms: Number(d.ms) || 0,
      at: Date.now()
    }
  } finally {
    clearTimeout(timer)
  }
}
