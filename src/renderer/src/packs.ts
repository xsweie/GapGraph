import type { AppState, Pack, Question } from '../../shared/types'
import { effectivePack } from './edits'
import { blankMastery } from '../../main/domain/queue'
import builtin from '../../../resources/packs/gaokao-math-function.json'
import builtinQuestions from '../../../resources/questions/gaokao-math-function.json'
import { loadBank, saveBank } from './qbank'

const CUSTOM_KEY = 'gapgraph.packs.v1'
const ACTIVE_KEY = 'gapgraph.activepack.v1'
const RENAME_KEY = 'gapgraph.renames.v1'

export interface PackEntry {
  id: string
  title: string
  builtin: boolean
  exam: string
  subject: string
  chapter: string
}

const BUILTIN = builtin as unknown as Pack

export function builtinPack(): Pack {
  return BUILTIN
}

export function customPacks(): Record<string, Pack> {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY)
    return raw ? (JSON.parse(raw) as Record<string, Pack>) : {}
  } catch {
    return {}
  }
}

/** 内置板块的改名覆写（内置数据本身是只读的，不能改文件） */
function renames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(RENAME_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function listPacks(): PackEntry[] {
  const rn = renames()
  return [BUILTIN, ...Object.values(customPacks())].map((base) => {
    const p = effectivePack(base)
    return {
      id: p.packId, builtin: p.packId === BUILTIN.packId,
      title: rn[p.packId] ?? p.title, chapter: rn[p.packId] ?? p.meta?.chapter ?? p.title,
      exam: p.meta?.exam ?? '', subject: p.scope?.subject ?? p.subject
    }
  })
}

/** 改名：内置的存覆写，自定义的直接改数据 */
export function renamePack(id: string, newTitle: string): void {
  const title = newTitle.trim().slice(0, 40)
  if (!title) return
  const base = resolvePack(id)
  if (id === BUILTIN.packId || (base && effectivePack(base).revision)) {
    const rn = renames()
    rn[id] = title
    try {
      localStorage.setItem(RENAME_KEY, JSON.stringify(rn))
    } catch {
      /* 忽略 */
    }
    return
  }
  const all = customPacks()
  const p = all[id]
  if (!p) return
  p.title = title
  if (p.meta) p.meta.chapter = title
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(all))
  } catch {
    /* 忽略 */
  }
}

/** 取某个板块现有的全部题目（内置来自随包文件，自定义来自本地缓存） */
export function questionsOfPack(packId: string): Question[] {
  if (packId === BUILTIN.packId) {
    return [...(builtinQuestions as unknown as { questions: Question[] }).questions, ...loadBank(packId)]
  }
  return loadBank(packId)
}

/** 取某个板块的学习状态（没有就返回空状态） */
export function stateOfPack(pack: Pack): AppState {
  try {
    const raw = localStorage.getItem(stateKeyFor(pack.packId))
    if (raw) return JSON.parse(raw) as AppState
  } catch {
    /* 落到默认 */
  }
  return {
    settings: { dailyMinutes: 40, examDate: '', totalScore: pack.totalScore, packId: pack.packId },
    mastery: blankMastery(pack.nodes),
    attempts: [],
    tasks: []
  }
}

/** 融合结果落盘：板块、题库、学习状态三样一起写 */
export function saveMergedPack(pack: Pack, questions: Question[], state: AppState): void {
  const all = customPacks()
  all[pack.packId] = pack
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(all))
  } catch {
    /* 忽略 */
  }
  saveBank(pack.packId, questions)
  try {
    localStorage.setItem(stateKeyFor(pack.packId), JSON.stringify({ ...state, tasks: [] }))
  } catch {
    /* 忽略 */
  }
}

export function activePackId(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setActivePackId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id)
  } catch {
    /* 忽略 */
  }
}

export function resolvePack(id: string): Pack | null {
  if (id === BUILTIN.packId) return BUILTIN
  return customPacks()[id] ?? null
}

/** 当前该用哪一份考纲；没有任何选择时返回 null，交给引导流程 */
export function currentPack(): Pack | null {
  const id = activePackId()
  if (!id) return null
  return resolvePack(id)
}

export function saveCustomPack(pack: Pack): void {
  const all = customPacks()
  all[pack.packId] = pack
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(all))
}

export function removeCustomPack(id: string): void {
  const all = customPacks()
  delete all[id]
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(all))
  } catch {
    /* 忽略 */
  }
  if (activePackId() === id) setActivePackId(BUILTIN.packId)
}

export function stateKeyFor(packId: string): string {
  return `gapgraph.state.${packId}.v1`
}

/** 大厅用：这个板块学到哪儿了 */
export interface PackProgress {
  measured: number
  total: number
  lastAt: number
  hasQuestions: boolean
}

const STUDIED_KEY = (id: string): string => `gapgraph.studied.${id}`

export function markStudied(packId: string): void {
  try {
    localStorage.setItem(STUDIED_KEY(packId), String(Date.now()))
  } catch {
    /* 忽略 */
  }
}

export function packProgress(packId: string): PackProgress {
  const base = resolvePack(packId)
  const pack = base && effectivePack(base)
  const total = pack ? pack.nodes.filter((n) => n.kind !== 'root').length : 0
  let measured = 0
  let lastAt = 0
  try {
    const raw = localStorage.getItem(stateKeyFor(packId))
    if (raw) {
      const s = JSON.parse(raw) as { mastery?: Record<string, { n?: number }>; attempts?: { submittedAt?: number }[] }
      const m = s.mastery ?? {}
      measured = pack?.nodes.filter((n) => n.kind !== 'root' && (m[n.id]?.n ?? 0) > 0).length ?? 0
      const last = s.attempts?.[s.attempts.length - 1]
      lastAt = last?.submittedAt ?? 0
    }
    const stored = localStorage.getItem(STUDIED_KEY(packId))
    if (stored) lastAt = Math.max(lastAt, Number(stored) || 0)
  } catch {
    /* 忽略 */
  }
  return { measured, total, lastAt, hasQuestions: packId === BUILTIN.packId }
}

export function relTime(ts: number): string {
  if (!ts) return '还没开始'
  const d = Date.now() - ts
  const min = Math.floor(d / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const day = Math.floor(h / 24)
  if (day === 1) return '昨天'
  if (day < 30) return `${day} 天前`
  return `${Math.floor(day / 30)} 个月前`
}
