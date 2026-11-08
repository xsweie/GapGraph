import './styles.css'
import 'katex/dist/katex.min.css'
import type { AppState, ErrorReason, KNode, LearningSignal, LearningUpdate, LoadResult, Mastery, PathStep, Question, SubmitPayload, SubmitResult, Task } from '../../shared/types'
import { band, effective, selfLevelOf } from '../../shared/mastery'
import { KnowledgeGraph, type GraphMode } from './graph'
import { createLocalApi } from './local-api'
import {
  createDiagnostic,
  diagnosticCoverage,
  diagnosticTargets,
  DIAG_TARGET,
  nextQuestion,
  primaryNodeOf,
  summarize,
  type DiagState,
  type DiagSummary
} from '../../main/domain/diagnostic'
import { BANDS, buildHeatmap, summarizeHeat } from '../../main/domain/heatmap'
import { attributionLine, reasonsFor } from '../../main/domain/attribution'
import aiJson from '../../../resources/ai/gaokao-math-function.json'
import { addCard, isSaved, loadCards, removeCard } from './cards'
import { askAi, endpointStatus, explainNode, generateQuestions, getEndpoint, initEndpoint, setEndpoint, type AiAnswer, type DetailedExplain } from './ai'
import { explainOf, saveExplain } from './explain'
import { addToBank } from './qbank'
import { clearPositions, commitStructure, effectivePack, hasUndo, loadPositions, saveOnePosition, undoStructure } from './edits'
import { PHYSICS_SLIDERS, loadPhysics, resetPhysics, savePhysics } from './physics'
import {
  LAYOUT_DEFAULT,
  LEFT_MAX,
  LEFT_MIN,
  RIGHT_MAX,
  RIGHT_MIN,
  clampWidth,
  loadLayout,
  saveLayout,
  type LayoutState
} from './sidebar'
import { builtinPack, currentPack, listPacks, packProgress, questionsOfPack, relTime, removeCustomPack, renamePack, resolvePack, saveCustomPack, saveMergedPack, setActivePackId, markStudied, stateOfPack } from './packs'
import { canMerge, mergeSources } from '../../main/domain/merge'
import { assessNode, newEffectiveSince, packRevision, PRACTICE_CHECK_MIN } from '../../main/domain/learning'
import { primaryAttemptNode } from '../../main/domain/attempt-log'
import { activeQuestions } from '../../main/domain/learning-state'
import { legacyScope } from '../../main/domain/scope'
import { openScopeEditor } from './scope-editor'
import { bindNodeEditor } from './node-editor'
import { escapeHtml as esc, renderStudyText } from './study-text'
import { bindHelpTips, helpTip } from './help-tip'

/** 实时提问的状态（只保留当前节点的） */
let askState: { nodeId: string; loading: boolean; answer?: AiAnswer; error?: string } | null = null
/** 详细讲解的生成状态（按节点，切走再切回来不会互相干扰） */
const explainStates = new Map<string, { loading: boolean; error?: string; detail: DetailedExplain | null }>()
const expandedExplanations = new Set<string>()

/** 正在为哪个考点准备题目（避免重复请求） */
const preparing = new Set<string>()

function questionsOf(nodeId: string): Question[] {
  return questions.filter((q) => primaryNodeOf(q) === nodeId)
}

function noQuestionHint(): string {
  if (desktop) return '这个考点暂缺题目，可以在网页版生成。'
  const ai = endpointStatus()
  if (!ai.reachable) return '这个考点暂缺题目。启动 AI 服务后可生成新题。'
  if (!ai.supportsQuestions) return '当前 AI 代理版本过旧。关闭原启动窗口，重新运行 start.bat 后可生成完整题目。'
  return '暂未生成可用题目，可以再试一次。'
}

/**
 * 按需出题：只有当用户真的要做的这个考点题不够时，才现出 3 道。
 * 返回是否可用（已有题 或 生成成功）。
 */
async function ensureQuestions(nodeId: string, need = 3): Promise<boolean> {
  if (questionsOf(nodeId).length >= need) return true
  const ai = endpointStatus()
  if (desktop || !ai.reachable || !ai.supportsQuestions) return questionsOf(nodeId).length > 0
  if (preparing.has(nodeId)) return false
  preparing.add(nodeId)
  try {
    const node = nodeById(nodeId)
    if (!node) return false
    const want = need - questionsOf(nodeId).length
    const got = await generateQuestions(node, want, [2, 3, 4].slice(0, want), {
      exam: pack.meta?.exam ?? '',
      subject: pack.meta?.subject ?? pack.subject ?? '',
      // 融合板块里，出题上下文用它原本所属的章节，避免串到别的章
      chapter: node.origin ?? pack.meta?.chapter ?? pack.title ?? '',
      scope: pack.scope
    })
    if (!got.length) return questionsOf(nodeId).length > 0
    const saved = addToBank(pack.packId, got, nodeId)
    questions.push(...saved)
    return questionsOf(nodeId).length >= 1
  } catch {
    return questionsOf(nodeId).length > 0
  } finally {
    preparing.delete(nodeId)
  }
}

interface AiNodeContent {
  explain: string
  cards: { type: string; front: string; back: string }[]
}
const AI_CONTENT = aiJson as unknown as {
  promptVersion: string
  model: string
  byNode: Record<string, AiNodeContent>
}

function builtinContent(nodeId: string): AiNodeContent | undefined {
  return pack.packId === builtinPack().packId ? AI_CONTENT.byNode[nodeId] : undefined
}
import {
  GUIDE_RELEASES,
  GUIDE_RULES,
  GUIDE_STEPS,
  GUIDE_VERSION,
  markSeen,
  shouldShowGuide
} from './guide'

interface Overview {
  coverage: { measured: number; total: number }
  estimate: number
  band: number
  daysLeft: number
  todayKey: string
}

interface Api {
  load(): Promise<LoadResult & { overview: Overview }>
  submit(p: SubmitPayload): Promise<SubmitResult & { today: Task[]; overview: Overview }>
  check(questionId: string, answer: string): Promise<{ correct: boolean }>
  updateSettings(patch: Partial<AppState['settings']>): Promise<{ state: AppState; today: Task[]; overview: Overview }>
  completeTask(id: string): Promise<{ state: AppState; today: Task[]; overview: Overview }>
  postponeTask(id: string): Promise<{ state: AppState; today: Task[]; overview: Overview }>
  rebuildQueue(): Promise<{ state: AppState; today: Task[]; overview: Overview }>
  learning(update: LearningUpdate): Promise<{ state: AppState; today: Task[]; overview: Overview }>
  rate(nodeId: string, level: 0 | 1 | 2): Promise<{ state: AppState; today: Task[]; overview: Overview }>
}

/** 有 Electron 预加载就用它；在浏览器里跑时退回本地实现（同一套算法，数据存 localStorage） */
const desktopApi = (window as unknown as { api?: Api }).api
const desktop = !!desktopApi
const api: Api = desktopApi ?? createLocalApi()

const BAND_COLOR: Record<string, string> = {
  red: 'var(--c1)',
  orange: 'var(--c2)',
  yellow: 'var(--c3)',
  green: 'var(--c5)',
  self: 'var(--self)', // 自评未验证：虚线圈，不用实心色
  unmeasured: 'var(--c0)'
}

const KIND_LABEL: Record<string, string> = {
  review: '到期复习',
  gap: '缺口补救',
  diagnose: '先摸底',
  new: '新学'
}
const BAND_NAME: Record<string, string> = {
  red: '红',
  orange: '橙',
  yellow: '黄',
  green: '绿',
  self: '自评',
  unmeasured: '未测'
}

/** 面板上那枚标签用的完整说法：说清楚这个状态是"验证过"还是"自己说的" */
/**
 * 权重说明。examWeight 是"重要性"的估计，不是历年考频。
 * 目前没有任何节点真的统计过考频，所以这一栏绝不能写成"考频"。
 */
function weightNote(n: KNode): string {
  const level = n.examWeight >= 0.7 ? '高' : n.examWeight >= 0.4 ? '中' : '低'
  const source = n.weightLocked ? '手工锁定' : n.weightSource === 'manual' ? '人工整理' : n.weightSource === 'stats' ? '原有统计来源' : 'AI 估计，待核验'
  return '目标重要性 ' + level + '（' + source + '）'
}

let pack: LoadResult['pack']
let questions: Question[] = []
let state: AppState
let today: Task[] = []
let overview: Overview
let selectedId: string | null = null
let graph: KnowledgeGraph
let mode: GraphMode = 'structure'

const $ = <T extends Element = HTMLElement>(sel: string): T => document.querySelector(sel) as T

const studyText = (value: unknown): string => renderStudyText(value, pack.scope?.subject || pack.subject)

function nodeById(id: string): KNode | undefined {
  return pack.nodes.find((n) => n.id === id)
}

function pathOf(id: string): string {
  const names: string[] = []
  const seen = new Set<string>()
  let cur = nodeById(id)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    names.unshift(cur.name)
    cur = cur.parentId ? nodeById(cur.parentId) : undefined
  }
  return names.join(' › ')
}

function masteryOf(id: string): Mastery {
  return state.mastery[id] ?? { K: 0, A: 0.3, s: 1, n: 0, nok: 0, misconception: 0, lastAt: null }
}

/** 一条前置关系的"为什么" */
function whyOf(a: string, b: string, kind: 'prereq' | 'confusable'): string {
  const r = (pack.relations ?? []).find(
    (x) => x.kind === kind && ((x.a === a && x.b === b) || (kind === 'confusable' && x.a === b && x.b === a))
  )
  return r?.why ?? ''
}

/** 该考点往上所有前置，按"先学的在前"排好 */
function foundationChain(id: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])
  const walk = (cur: string): void => {
    const n = nodeById(cur)
    if (!n) return
    for (const p of n.prereq) {
      if (seen.has(p)) continue
      seen.add(p)
      walk(p)
      out.push(p)
    }
  }
  walk(id)
  return out
}

/* ---------------- 使用指南 ---------------- */

function closeGuide(): void {
  const box = $('#guide')
  markSeen()
  box.classList.remove('open')
  box.innerHTML = ''
}

function renderGuide(): void {
  const box = $('#guide')
  const latest = GUIDE_RELEASES[0]
  const history = GUIDE_RELEASES.slice(1).map((r) => `v${r.version}`).join(' · ')

  box.innerHTML = `
    <div class="gsheet">
      <div class="ghead">
        <div>
          <h2>使用指南</h2>
          <div class="gsub">v${GUIDE_VERSION} · 每次更新都会重写这一页</div>
        </div>
        <button class="ghost small" id="gclose">关闭</button>
      </div>

      <ol class="gsteps">
        ${GUIDE_STEPS.map(
          (s, i) =>
            `<li><div class="gtitle"><span class="gnum">${i + 1}</span>${s.title}</div><p>${s.body}</p></li>`
        ).join('')}
      </ol>

      <div class="gblock">
        <h3>几条规矩（都是故意的）</h3>
        <ul class="grules">${GUIDE_RULES.map((r) => `<li>${r}</li>`).join('')}</ul>
      </div>

      <div class="gblock">
        <h3>本次更新 · v${latest.version}</h3>
        <ul class="grules">${latest.items.map((r) => `<li>${r}</li>`).join('')}</ul>
        ${history ? `<div class="gsub" style="margin-top:10px">更早的版本：${history}</div>` : ''}
      </div>

      <div class="gfoot"><button class="primary" id="gok">开始使用</button></div>
    </div>
  `
  box.classList.add('open')
  box.onclick = (e) => {
    if (e.target === box) closeGuide()
  }
  box.querySelector('#gclose')?.addEventListener('click', () => closeGuide())
  box.querySelector('#gok')?.addEventListener('click', () => closeGuide())
}

/* ---------------- 设置 ---------------- */

function renderSettings(): void {
  const box = $('#settings')
  const s = state.settings
  let minutes = s.dailyMinutes

  box.innerHTML = `
    <div class="gsheet" style="width:min(520px,92vw)">
      <div class="ghead">
        <div>
          <h2>设置</h2>
          <div class="gsub">改完立即生效，今天的任务会重排</div>
        </div>
        <button class="ghost small" id="set-close">关闭</button>
      </div>

      <div class="sblock">
        <h3>每天最多花多久</h3>
        <div class="rchips">
          ${[20, 40, 60, 90].map((m) => `<button class="rc ${m === minutes ? 'sel' : ''}" data-min="${m}">${m} 分钟</button>`).join('')}
        </div>
        <div class="gsub" style="margin-top:6px">超出的任务不会排给你——宁可少给，也不让你想卸载</div>
      </div>

      <div class="sblock">
        <h3>AI 服务地址（可选）</h3>
        <input type="text" id="set-ai" value="${esc(getEndpoint())}" class="sinput" style="width:100%" />
        <div class="gsub" style="margin-top:6px">
          留空 = 只用预生成讲解（离线可用）。想用实时问答：先在命令行跑
          <code>node scripts/ai-proxy.cjs</code>，再把地址填这里。浏览器版必须这样走，因为直接调 API 会被跨域拦住。
        </div>
      </div>

      <div class="gfoot" style="justify-content:space-between">
        <button class="ghost small" id="set-rebuild">重排今日任务</button>
        <button class="primary" id="set-save">保存</button>
      </div>
    </div>
  `
  box.classList.add('open')
  box.onclick = (e) => {
    if (e.target === box) closeSettings()
  }

  box.querySelectorAll<HTMLButtonElement>('[data-min]').forEach((b) => {
    b.addEventListener('click', () => {
      minutes = Number(b.dataset.min)
      box.querySelectorAll<HTMLButtonElement>('[data-min]').forEach((x) => x.classList.toggle('sel', x === b))
    })
  })

  box.querySelector('#set-close')?.addEventListener('click', () => closeSettings())
  box.querySelector('#set-rebuild')?.addEventListener('click', async () => {
    const r = await api.rebuildQueue()
    state = r.state
    today = r.today
    overview = r.overview
    closeSettings()
    renderToday()
    renderHeader()
  })
  box.querySelector('#set-save')?.addEventListener('click', async () => {
    const ai = box.querySelector<HTMLInputElement>('#set-ai')?.value ?? ''
    setEndpoint(ai)
    await initEndpoint()
    const r = await api.updateSettings({ dailyMinutes: minutes })
    state = r.state
    today = r.today
    overview = r.overview
    closeSettings()
    renderHeader()
    renderToday()
    refreshVisuals()
  })
}

function closeSettings(): void {
  const box = $('#settings')
  box.classList.remove('open')
  box.innerHTML = ''
}

/* ---------------- 进入向导：先问清楚你在学什么 ---------------- */

function renderWizard(edit = false): void {
  if (desktop) {
    if (edit) alert('桌面版可学习内置板块。范围与知识网编辑请使用网页版。')
    else enterPack(builtinPack().packId)
    return
  }
  const base = edit ? currentPack() : null
  const existing = base ? pack : undefined
  const expected = existing ? packRevision(existing) : ''
  openScopeEditor($('#wizard'), {
    pack: existing, close: closeWizard,
    builtin: edit ? undefined : () => enterPack(builtinPack().packId),
    apply: async (candidate) => {
      if (base) {
        await commitStructure(base, expected, candidate)
        location.reload()
      } else {
        saveCustomPack(candidate)
        enterPack(candidate.packId)
      }
    }
  })
}

function closeWizard(): void {
  const box = $('#wizard')
  if (box.dataset.scopeApplying) return
  box.classList.remove('open')
  box.innerHTML = ''
  delete box.dataset.scopeEditor
}

/**
 * Esc 关掉最上层浮层。
 * 之前向导没有关闭入口，用户卡在里面只能刷新页面——这就是这个函数存在的理由。
 */
function closeTopOverlay(): boolean {
  // 右栏全屏也算一层：先退出全屏，再关浮层
  if (panelExpanded) {
    setPanelExpanded(false)
    return true
  }
  const layers: [string, () => void][] = [
    ['#wizard', closeWizard],
    ['#cards', closeCards],
    ['#settings', closeSettings],
    ['#guide', closeGuide],
    ['#modal', closeModal]
  ]
  for (const [sel, close] of layers) {
    const el = $(sel)
    if (el && el.classList.contains('open')) {
      close()
      return true
    }
  }
  return false
}

function closeModal(): void {
  if (submitting) return
  if (diagResult) { closeDiagnostic(false); return }
  const box = $('#modal')
  box.classList.remove('open')
  box.innerHTML = ''
  session = null
}

/* ---------------- 大厅 ---------------- */

/** 大厅里的多选（用于融合板块），只存在内存里 */
let picked = new Set<string>()

function selectedPacks() {
  return [...picked].flatMap((id) => {
    const source = resolvePack(id)
    return source ? [effectivePack(source)] : []
  })
}

function renderHome(): void {
  const box = $('#home')
  const packs = listPacks().filter((entry) => !desktop || entry.builtin)
  const cards = loadCards()
  const recent = cards.sort((a, b) => b.at - a.at).slice(0, 3)
  // 已删除/已融合掉的板块要从选中集合里踢出去
  picked = new Set([...picked].filter((id) => packs.some((p) => p.id === id)))

  const mergeCheck = (() => {
    if (picked.size < 2) return { ok: false, reason: '勾选 2 个同学科的板块，就能把它们融合成一个' }
    return canMerge(selectedPacks())
  })()

  const cardsBySubject = new Map<string, string[]>()
  for (const entry of packs) {
    const prog = packProgress(entry.id)
    const pct = prog.total ? Math.round((prog.measured / prog.total) * 100) : 0
    const on = picked.has(entry.id)
    const merged = entry.id.startsWith('merge-')
    const subjectCards = cardsBySubject.get(entry.subject) ?? []
    subjectCards.push(`<div class="pcard ${on ? 'picked' : ''}" data-pack-card="${entry.id}">
        <div class="pmeta">
          ${esc(entry.exam)}
          <button class="pick ${on ? 'on' : ''}" data-pick="${entry.id}" title="${on ? '取消选择' : '选中（用于融合）'}">${on ? '✓' : '＋'}</button>
        </div>
        <div class="ptitle">${esc(entry.chapter)}</div>
        <div class="pbar"><i style="width:${pct}%"></i></div>
        <div class="pstat">
          已测 ${prog.measured}/${prog.total} · ${relTime(prog.lastAt)}
          ${entry.builtin ? '' : merged ? ' · 融合板块' : ' · AI 生成'}
        </div>
        <div class="pactions">
          <button class="primary small" data-enter="${entry.id}">继续学习</button>
          <button class="ghost small" data-rename="${entry.id}">改名</button>
          ${entry.builtin ? '' : `<button class="ghost small" data-drop="${entry.id}">删除</button>`}
        </div>
      </div>`)
    cardsBySubject.set(entry.subject, subjectCards)
  }
  const packGroups = [...cardsBySubject]
    .sort(([a], [b]) => Number(!a) - Number(!b))
    .map(([subject, subjectCards], i) => `<section class="pack-group" aria-labelledby="pack-subject-${i}">
      <h4 id="pack-subject-${i}">${esc(subject || '未分类')}</h4>
      <div class="packgrid">${subjectCards.join('')}</div>
    </section>`).join('')

  box.innerHTML = `
    <div class="hhead">
      <div class="brand">KnowMap</div>
      <div class="spacer"></div>
      <button class="ghost small" id="h-cards">知识库 ${cards.length}</button>
      <button class="ghost small" id="h-settings">设置</button>
      <button class="ghost small" id="h-guide">指南</button>
    </div>

    <div class="hmain">
      <div class="hero" id="h-new">
        <div>
          <div class="hero-k">开始学习新板块</div>
          <div class="hero-t">描述学习目标，确认要学的内容，再生成知识网</div>
        </div>
        <div class="scope-actions"><button id="h-builtin">打开内置板块</button>${desktop ? '<span class="hint">自定义板块请使用网页版</span>' : '<button class="primary" id="h-add">新建学习板块</button>'}</div>
      </div>

      ${
        picked.size
          ? `<div class="mergebox">
               <div class="mergeinfo">
                 <b>已选 ${picked.size} 个板块</b>
                 <span class="${mergeCheck.ok ? 'okline' : 'badline'}">${
                   mergeCheck.ok ? '同学科，可以融合成一张图' : esc(mergeCheck.reason ?? '')
                 }</span>
               </div>
               <div class="gsub" style="margin-top:10px">给融合后的板块起个名字</div>
               <div class="askrow" style="margin-top:6px">
                 <input id="merge-name" />
                 <button class="primary small" id="merge-go" ${mergeCheck.ok ? '' : 'disabled'}>融合</button>
                 <button class="ghost small" id="merge-cancel">取消</button>
               </div>
             </div>`
          : ''
      }

      <h3 class="sec">我的板块</h3>
      ${packGroups || '<div class="emptybox">还没有板块。点上面的「新建学习板块」开始。</div>'}

      <h3 class="sec">知识库</h3>
      ${
        cards.length
          ? `<div class="kbbox">
               <div class="kbhead">
                 <span>已收藏 ${cards.length} 张卡片</span>
                 <button class="ghost small" id="h-kb">打开知识库</button>
               </div>
               ${recent
                 .map(
                   (c) => `<div class="kbrow">
                     <span class="actype ${c.type}">卡片</span>
                     <span class="kbfront">${renderStudyText(c.front, packs.find((entry) => entry.id === c.packId)?.subject)}</span>
                     <span class="acfrom">${esc(c.nodeName)}</span>
                   </div>`
                 )
                 .join('')}
             </div>`
          : `<div class="emptybox">还没有收藏。学习时点开任意考点，讲解下面的卡片点 ☆ 就能存到这里。</div>`
      }
    </div>
  `

  $('#h-builtin')?.addEventListener('click', () => enterPack(builtinPack().packId))
  $('#h-add')?.addEventListener('click', () => renderWizard())
  $('#h-cards')?.addEventListener('click', () => renderCards())
  $('#h-kb')?.addEventListener('click', () => renderCards())
  $('#h-guide')?.addEventListener('click', () => renderGuide())
  $('#h-settings')?.addEventListener('click', () => renderSettings())
  box.querySelectorAll<HTMLButtonElement>('[data-enter]').forEach((b) => {
    b.addEventListener('click', () => enterPack(b.dataset.enter as string))
  })
  box.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      const id = b.dataset.pick as string
      if (picked.has(id)) picked.delete(id)
      else picked.add(id)
      renderHome()
    })
  })
  box.querySelectorAll<HTMLButtonElement>('[data-rename]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      openRename(b.dataset.rename as string)
    })
  })
  box.querySelectorAll<HTMLButtonElement>('[data-drop]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      const id = b.dataset.drop as string
      if (confirm('删除这个板块？学习记录会一起删除。')) {
        removeCustomPack(id)
        renderHome()
      }
    })
  })
  box.querySelector('#merge-cancel')?.addEventListener('click', () => {
    picked.clear()
    renderHome()
  })
  box.querySelector('#merge-go')?.addEventListener('click', () => void doMerge())
}

/* ---------------- 融合板块 ---------------- */

async function doMerge(): Promise<void> {
  const sources = selectedPacks()
  const gate = canMerge(sources)
  if (!gate.ok) {
    alert(gate.reason ?? '不能融合')
    return
  }
  const input = $('#merge-name') as HTMLInputElement | null
  const title = (input?.value ?? '').trim()
  if (!title) {
    alert('先给融合后的板块取个名字')
    input?.focus()
    return
  }
  const btn = $('#merge-go') as HTMLButtonElement | null
  if (btn) {
    btn.disabled = true
    btn.textContent = '融合中…'
  }
  try {
    const merged = mergeSources(
      sources.map((graph) => {
        const st = stateOfPack(graph)
        return { pack: graph, questions: activeQuestions(graph, questionsOfPack(graph.packId)), mastery: st.mastery, attempts: st.attempts }
      }),
      title
    )
    const state: AppState = {
      settings: {
        dailyMinutes: 40,
        examDate: '',
        totalScore: merged.pack.totalScore,
        packId: merged.pack.packId
      },
      mastery: merged.mastery,
      attempts: merged.attempts,
      tasks: []
    }
    saveMergedPack(merged.pack, merged.questions, state)
    picked.clear()
    if (merged.warnings.length) alert(merged.warnings.join('\n'))
    enterPack(merged.pack.packId)
  } catch (e) {
    alert(`融合失败：${(e as Error).message}`)
    input?.focus()
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = '融合'
    }
  }
}

/* ---------------- 重命名板块 ---------------- */

function openRename(packId: string): void {
  const entry = listPacks().find((p) => p.id === packId)
  if (!entry) return
  const box = $('#cards')
  box.innerHTML = `
    <div class="gsheet" style="width:min(460px,92vw)">
      <div class="ghead">
        <div>
          <h2>给板块改名</h2>
          <div class="gsub">只改显示名，考点、题目、记录都不动</div>
        </div>
        <button class="ghost small" id="rn-close">✕</button>
      </div>
      <div class="sblock">
        <input id="rn-input" class="sinput" style="width:100%" maxlength="40" value="${esc(entry.chapter)}" />
      </div>
      <div class="gfoot" style="justify-content:flex-end;gap:8px">
        <button class="ghost small" id="rn-cancel">取消</button>
        <button class="primary" id="rn-save">保存</button>
      </div>
    </div>
  `
  box.classList.add('open')
  const input = box.querySelector<HTMLInputElement>('#rn-input')
  input?.focus()
  input?.select()
  const close = (): void => {
    box.classList.remove('open')
    box.innerHTML = ''
  }
  box.querySelector('#rn-close')?.addEventListener('click', close)
  box.querySelector('#rn-cancel')?.addEventListener('click', close)
  const save = (): void => {
    const v = input?.value.trim() ?? ''
    if (v) renamePack(packId, v)
    close()
    renderHome()
  }
  box.querySelector('#rn-save')?.addEventListener('click', save)
  input?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') save()
  })
}

function enterPack(id: string): void {
  setActivePackId(id)
  markStudied(id)
  location.hash = '#study'
  location.reload()
}

/* ---------------- 布局 ---------------- */

function mount(): void {
  $('#app').innerHTML = `
    <div id="home"></div>
    <div class="shell" id="study">
      <header>
        <div class="brand">KnowMap</div>
        <div class="stats">
          <span>已测 <b id="coverage">0/0</b></span>
          <span id="study-goal"></span>
        </div>
        <div class="spacer"></div>
        <div class="views">
          <button data-view="graph" aria-pressed="true">图谱</button>
          <button data-view="heat" aria-pressed="false">热力表</button>
        </div>
        <div class="modes g-only">
          <button data-mode="structure" aria-pressed="true">① 结构</button>
          <button data-mode="gap" aria-pressed="false">② 缺口</button>
        </div>
        <button class="ghost small h-only" id="heat-sort">缺口优先</button>
        <button class="ghost small" id="diag">摸底</button>
        <button class="small" id="plan-btn" aria-pressed="false">规划</button>
        <button class="ghost small" id="cards-btn">卡片 0</button>
        <button class="ghost small g-only" id="guide-btn">指南</button>
        ${desktop ? '' : '<button class="ghost small" id="edit-scope">范围与结构</button>'}
        <button class="ghost small" id="lobby-btn">大厅</button>
        <button class="ghost small" id="settings-btn">设置</button>
      </header>
      <main>
        <aside id="today"></aside>
        <div class="splitter" id="split-left" title="拖动调宽 / 双击复位"></div>
        <section id="stage">
          <button class="edge-tab" id="tab-left" title="收起 / 展开今日">‹</button>
          <button class="edge-tab" id="tab-right" title="收起 / 展开讲解">›</button>
          <div class="stage-tools g-only">
            <button class="ghost small" id="fold" aria-pressed="true" title="只看两层，收起深层考点">折叠</button>
            <button class="ghost small" id="phys-btn" title="调整图谱的手感参数">力学</button>
            <button class="ghost small" id="relayout" title="清掉手工位置，重新排一次">重排</button>
          </div>
          <svg id="graph" data-mode="structure"></svg>
          <div id="phys" class="physpanel"></div>
          <div class="legend">
            <button class="small" type="button" data-help data-help-template="graph-legend"
              aria-description="颜色表示能力估计，灰色表示未测，虚线圈表示自评待验证。实线表示层级，虚线表示前置，点线表示易混。">图例 <span aria-hidden="true">?</span></button>
            <template id="graph-legend">
              <div class="legend-items">
                <span><i style="background:var(--c1)"></i>估计偏低</span>
                <span><i style="background:var(--c2)"></i>较低</span>
                <span><i style="background:var(--c3)"></i>中等</span>
                <span><i style="background:var(--c5)"></i>较高</span>
                <span><i class="hollow"></i>自评待验证</span>
                <span><i style="background:var(--c0)"></i>没测过</span>
                <span><span class="line"></span>结构层级</span>
                <span><span class="line pre"></span>必要前置</span>
                <span><span class="line con"></span>易混关系</span>
              </div>
              <div class="legend-note">${desktop ? '拖动节点可调整位置' : '拖动节点调整位置，右键增删考点。'}</div>
            </template>
          </div>
          <div id="heat"></div>
        </section>
        <div class="splitter" id="split-right" title="拖动调宽 / 双击复位"></div>
        <aside id="panel"></aside>
      </main>
    </div>
    <div id="modal"></div>
    <div id="guide"></div>
    <div id="settings"></div>
    <div id="cards"></div>
    <div id="wizard"></div>
    <div id="help-tooltip" class="help-tooltip" role="tooltip" hidden></div>
    ${desktop ? '' : '<div id="node-menu" class="node-menu" role="group" hidden></div><dialog id="node-editor" class="gsheet scope-sheet node-dialog" aria-labelledby="node-edit-title"></dialog>'}
  `

  bindHelpTips($('#help-tooltip'))
  $('#guide-btn').addEventListener('click', () => renderGuide())
  $('#settings-btn').addEventListener('click', () => renderSettings())
  $('#cards-btn').addEventListener('click', () => renderCards())
  $('#lobby-btn').addEventListener('click', () => {
    location.hash = ''
    location.reload()
  })

  const openNodeMenu = desktop ? undefined : bindNodeEditor($('#node-menu'), $('#node-editor'), async (original, candidate, focusId) => {
    const base = currentPack()
    if (!base) throw new Error('请重新打开当前板块后再编辑。')
    await commitStructure(base, packRevision(original), candidate)
    history.replaceState({ structureFocusId: focusId }, '', '#study')
    location.reload()
  })
  graph = new KnowledgeGraph($('#graph') as unknown as SVGSVGElement, {
    onSelect: (id) => selectNode(id),
    onContextMenu: openNodeMenu && ((id, event) => openNodeMenu(pack, id, event)),
    // 拖完立刻记下来，下次打开还在原地
    onMoveNode: (id, x, y) => {
      saveOnePosition(pack.packId, id, x, y)
    }
  })
  graph.setMode('structure')
  graph.setPhysics(physics)

  document.querySelectorAll<HTMLButtonElement>('.modes button').forEach((b) => {
    b.addEventListener('click', () => {
      mode = b.dataset.mode as GraphMode
      document.querySelectorAll<HTMLButtonElement>('.modes button').forEach((x) => {
        x.setAttribute('aria-pressed', String(x === b))
      })
      graph.setMode(mode)
    })
  })
  $('#diag').addEventListener('click', () => startDiagnostic())
  $('#plan-btn').addEventListener('click', () => togglePlanning(!planning.open))
  $('#edit-scope')?.addEventListener('click', () => renderWizard(true))
  $('#phys-btn')?.addEventListener('click', () => renderPhysics())
  $('#tab-left')?.addEventListener('click', () => setLayout({ ...layout, leftClosed: !layout.leftClosed }))
  $('#tab-right')?.addEventListener('click', () => setLayout({ ...layout, rightClosed: !layout.rightClosed }))
  attachSplitter($('#split-left') as HTMLElement | null, 'left')
  attachSplitter($('#split-right') as HTMLElement | null, 'right')
  applyLayout()
  $('#relayout')?.addEventListener('click', () => {
    clearPositions(pack.packId)
    graph.resetLayout()
  })

  document.querySelectorAll<HTMLButtonElement>('.views button').forEach((b) => {
    b.addEventListener('click', () => setView(b.dataset.view as 'graph' | 'heat'))
  })
  $('#heat-sort').addEventListener('click', (ev) => {
    heatSort = heatSort === 'priority' ? 'tree' : 'priority'
    const btn = ev.currentTarget as HTMLButtonElement
    btn.textContent = heatSort === 'priority' ? '缺口优先' : '结构顺序'
    renderHeat()
  })
  document.body.dataset.view = 'graph'
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTopOverlay()
  })
  $('#fold').addEventListener('click', (e) => {
    const next = !graph.isFolded()
    graph.setFold(next)
    ;(e.currentTarget as HTMLButtonElement).setAttribute('aria-pressed', String(next))
    graph.fit()
  })
}

/* ---------------- 渲染 ---------------- */

function renderHeader(): void {
  $('#coverage').textContent = overview.coverage.measured + '/' + overview.coverage.total
  $('#study-goal').textContent = pack.scope?.goal || '补齐本板块'
  const btn = $('#cards-btn')
  if (btn) btn.textContent = `卡片 ${loadCards().length}`
}

/* ---------------- 我的卡片 ---------------- */

function renderCards(): void {
  const box = $('#cards')
  const cards = loadCards().sort((a, b) => b.at - a.at)
  const subjects = new Map(listPacks().map(({ id, subject }) => [id, subject]))
  const typeName: Record<string, string> = { conclusion: '结论', method: '方法', pitfall: '易错', formula: '公式' }

  box.innerHTML = `
    <div class="gsheet" style="width:min(680px,92vw)">
      <div class="ghead">
        <div>
          <h2>我的卡片</h2>
          <div class="gsub">共 ${cards.length} 张 · 从考点讲解里收藏的</div>
        </div>
        <button class="ghost small" id="cards-close">关闭</button>
      </div>
      ${
        cards.length === 0
          ? `<div class="panel-empty" style="margin-top:18px">还没有收藏。点开任意一个考点，讲解下面有卡片，点 ☆ 就能存下来。</div>`
          : `<div class="cardlist">${cards
              .map(
                (c) => `<div class="aicard">
                  <div class="achead">
                    <span class="actype">${esc(typeName[c.type] ?? c.type)}</span>
                    <span class="acfrom">${esc(c.nodeName)}</span>
                    <button class="star on" data-del="${esc(c.id)}" title="删除">★</button>
                  </div>
                  <div class="acfront study-text">${renderStudyText(c.front, subjects.get(c.packId ?? ''))}</div>
                  <div class="acback study-text">${renderStudyText(c.back, subjects.get(c.packId ?? ''))}</div>
                </div>`
              )
              .join('')}</div>`
      }
    </div>
  `
  box.classList.add('open')
  box.onclick = (e) => {
    if (e.target === box) closeCards()
  }
  box.querySelector('#cards-close')?.addEventListener('click', () => closeCards())
  box.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => {
    b.addEventListener('click', () => {
      removeCard(b.dataset.del!)
      renderCards()
      renderHeader()
      renderPanel()
    })
  })
}

function closeCards(): void {
  const box = $('#cards')
  box.classList.remove('open')
  box.innerHTML = ''
}


const planning = { open: false, focused: false, all: false, daily: false, current: '' }
const actionName = { diagnose: '诊断', gap: '补习并练习', review: '复习' }

function shownSteps(): PathStep[] {
  const steps = state.path?.steps ?? []
  return planning.all ? steps : steps.filter((step) => !step.done).slice(0, 3)
}

function updatePlanFocus(fit = false): void {
  if (!state) return
  const ids = new Set(planning.open && planning.focused && document.body.dataset.view === 'graph'
    ? shownSteps().map((step) => step.nodeId) : [])
  if (planning.current && !shownSteps().some((step) => step.id === planning.current)) {
    planning.current = ''
    selectedId = null
    graph.select(null)
    renderPanel()
  }
  graph.setFocus(ids)
  if (fit && ids.size) graph.fit(ids)
}

function togglePlanning(open: boolean): void {
  planning.open = planning.focused = open
  planning.daily = planning.all = false
  planning.current = ''
  $('#plan-btn').setAttribute('aria-pressed', String(open))
  if (open) {
    if (layout.leftClosed) setLayout({ ...layout, leftClosed: false })
    setView('graph')
  }
  updatePlanFocus(open)
  renderToday()
}

async function syncLearning(update: LearningUpdate): Promise<void> {
  const result = await api.learning(update)
  state = result.state
  today = result.today
  overview = result.overview
  renderHeader()
  updatePlanFocus()
  renderToday()
}

function trackSignal(nodeId: string, kind: LearningSignal['kind'], questionId?: string): Promise<void> {
  return api.learning({ kind: 'signal', signal: { nodeId, kind, questionId, at: Date.now() } }).then(() => undefined)
}

async function reportConfusion(nodeId: string, questionId?: string): Promise<void> {
  await trackSignal(nodeId, 'confusion', questionId)
  if (session) session.confusion = true
  else await syncLearning({ kind: 'checkpoint', reason: '按主动标记的困惑检查定点诊断' })
}

function taskMatches(step: PathStep): Task | undefined {
  return today.find((t) => t.status === 'pending' && (t.stepId === step.id || (t.nodeId === step.nodeId && t.kind === step.action)))
}

function focusStep(step: PathStep): void {
  planning.focused = true
  planning.current = step.id
  setView('graph')
  selectNode(step.nodeId)
  graph.fit(new Set([step.nodeId]))
}

function renderPlanning(): void {
  const box = $('#today')
  const path = state.path
  const round = state.diagnostic
  const progress = round ? diagnosticCoverage(round, pack.nodes) : null
  const status = !progress?.effective ? '初步路径' : progress.ready ? '已结合摸底 · 已获得初步画像' : '已结合摸底 · 证据有限'
  const first = path?.steps.find((step) => !step.done && !step.invalid && !step.blockedBy.length)
  const top = `<div class="ghead"><div class="col-title">学习规划</div><button id="plan-close" class="small ghost">关闭规划</button></div>
    <div class="scope-actions"><button id="plan-list" aria-pressed="${!planning.daily}">学习路径</button><button id="plan-daily" aria-pressed="${planning.daily}">今日任务</button></div>`
  if (planning.daily) {
    renderDaily()
    box.insertAdjacentHTML('afterbegin', top)
  } else {
    const coverageText = progress ? ` · ${progress.effective} 道有效题，${progress.covered}/${progress.branches} 个主分支` : ''
    const rows = shownSteps().map((step) => {
      const task = taskMatches(step)
      const blocked = step.invalid || step.blockedBy.length > 0
      const qCount = questionsOf(step.nodeId).length
      const info = [step.evidence, blocked ? '' : step.reason,
        !step.done && !blocked ? (task ? '今日任务 · ' : '') + (qCount ? qCount + ' 道可用题' : '缺题，可尝试准备') : ''
      ].filter(Boolean).join('\n')
      return `<article class="card path-step ${step.done ? 'done' : ''} ${step.id === planning.current ? 'current' : ''}" data-path-step="${esc(step.id)}">
        <div class="kind">${step.done ? '已完成' : step.invalid ? '结构待修正' : blocked ? '等待前置' : actionName[step.action]}</div>
        <div class="path-title"><button class="path-node ghost" data-focus-step="${esc(step.id)}">${esc(nodeById(step.nodeId)?.name ?? step.nodeId)}</button>
          ${helpTip('规划依据', info)}</div>
        ${blocked ? `<p class="meta">${esc(step.reason)}</p>` : ''}
        ${!step.done && !blocked ? `<div class="actions"><button class="primary small" data-run-step="${esc(step.id)}">开始${actionName[step.action]}</button></div>` : ''}
      </article>`
    })
    const scope = legacyScope(pack)
    const pathInfo = [scope.goal || '补齐本板块', scope.depth,
      path && `路径 v${path.version} · ${path.reason}\n最近检查 ${new Date(path.checkedAt).toLocaleString('zh-CN')}`].filter(Boolean).join('\n')
    box.innerHTML = top + `
      <h3 class="plan-title">${esc(pack.title)} ${helpTip('路径与学习目标', pathInfo)}</h3>
      <p>${status}${coverageText}</p>
      <p><strong>下一步</strong> ${first ? esc(actionName[first.action] + ' · ' + (nodeById(first.nodeId)?.name ?? first.nodeId)) : '暂无可执行步骤'}</p>
      <div class="scope-actions">
        <button id="plan-rebuild" class="small">重新规划</button>
        <button id="plan-all" class="small">${planning.all ? '接下来三步' : '查看整条路径'}</button>
        <button id="plan-focus" class="small" ${rows.length ? '' : 'disabled'}>${planning.focused && rows.length ? '清除高亮' : '回到规划'}</button>
      </div>
      <div class="col-title">${planning.all ? '整条路径' : '接下来三步'}</div>
      ${rows.join('') || '<p class="panel-empty">暂无后续步骤。可切到今日任务，或在新证据出现后重新规划。</p>'}
      ${!desktop ? `<div class="scope-actions"><button id="plan-edit" class="small">调整范围与结构</button>${hasUndo(pack.packId) ? '<button id="plan-undo" class="small">撤销上次结构修订</button>' : ''}</div>` : ''}
    `
  }
  box.querySelector('#plan-close')?.addEventListener('click', () => togglePlanning(false))
  box.querySelector('#plan-list')?.addEventListener('click', () => { planning.daily = false; renderToday() })
  box.querySelector('#plan-daily')?.addEventListener('click', () => { planning.daily = true; renderToday() })
  box.querySelector('#plan-rebuild')?.addEventListener('click', () => void syncLearning({ kind: 'checkpoint', reason: '手动重新规划' }))
  box.querySelector('#plan-all')?.addEventListener('click', () => {
    planning.all = !planning.all
    updatePlanFocus(true)
    renderToday()
  })
  box.querySelector('#plan-focus')?.addEventListener('click', () => {
    planning.focused = !planning.focused
    updatePlanFocus(planning.focused)
    renderToday()
  })
  box.querySelector('#plan-edit')?.addEventListener('click', () => renderWizard(true))
  box.querySelector('#plan-undo')?.addEventListener('click', async () => {
    if (!confirm('撤销上次范围和知识网修订？答题和收藏会保留。')) return
    try { await undoStructure(pack.packId, packRevision(pack)); location.reload() }
    catch (error) { alert((error as Error).message) }
  })
  box.querySelectorAll<HTMLButtonElement>('[data-focus-step],[data-run-step]').forEach((button) => {
    button.addEventListener('click', () => {
      const step = path?.steps.find((s) => s.id === (button.dataset.focusStep ?? button.dataset.runStep))
      if (!step) return
      if (button.dataset.runStep) {
        if (!step.done && !step.invalid && !step.blockedBy.length) void startAction(step.nodeId, taskMatches(step), step, button)
      } else focusStep(step)
    })
  })
}

function renderToday(): void {
  if (planning.open) renderPlanning()
  else renderDaily()
}

function renderDaily(): void {
  const box = $('#today')
  const round = state.diagnostic
  const resumable = round && !round.finished && round.askedIds.length > 0
  const pending = today.filter((task) => task.status === 'pending')
  const spent = state.tasks.filter((t) => t.date === overview.todayKey)
    .reduce((sum, t) => sum + (t.spentMinutes ?? (t.status === 'done' ? t.estMinutes : 0)), 0)
  const blocked = state.path?.steps.some((step) => !step.done && (step.invalid || step.blockedBy.length))
  const rows = today.map((t) => `
    <div class="card ${t.status === 'done' ? 'done' : ''}" data-task="${esc(t.id)}">
      <div class="kind">${KIND_LABEL[t.kind]} · 约 ${t.estMinutes} 分钟</div>
      <div class="name">${esc(nodeById(t.nodeId)?.name ?? t.nodeId)}</div>
      <div class="meta">${t.status === 'done' ? '已完成' : questionsOf(t.nodeId).length ? questionsOf(t.nodeId).length + ' 道可用题' : '暂缺题目，可尝试准备'}</div>
      ${t.status === 'pending' ? `<div class="actions">
        <button class="primary small" data-start="${esc(t.id)}">开始</button>
        <button class="ghost small" data-postpone="${esc(t.id)}">推迟</button>
      </div>` : ''}
    </div>`)
  const empty = state.path?.steps.some((step) => !step.done && !step.invalid && !step.blockedBy.length)
    ? '当前动作未装入剩余预算，或已推迟。' : blocked ? '后续步骤正在等待前置或结构修正。' : '暂无待办。'
  box.innerHTML = `
    <div class="card intro">
      <div class="name">渐进摸底 ${helpTip('摸底规则', `最多提交 ${DIAG_TARGET} 次，优先覆盖主要分支。可以跳过，随时打开初步规划。`)}</div>
      <div class="actions"><button class="small" id="diag-start">${resumable ? '继续摸底' : '开始摸底'}</button></div>
    </div>
    <div class="col-title">今日任务 · ${pending.length} 项待开始</div>
    ${rows.join('')}
    ${pending.length ? '' : `<p class="panel-empty">${empty}</p>`}
    <div class="hint">已用 ${Math.ceil(spent)} / ${state.settings.dailyMinutes} 分钟 ${helpTip('今日任务预算', '每日最多安排三张任务卡，按剩余时间和学习路径安排。')}</div>`
  box.querySelector('#diag-start')?.addEventListener('click', () => void startDiagnostic())
  box.querySelectorAll<HTMLButtonElement>('[data-start]').forEach((button) => {
    button.addEventListener('click', () => {
      const task = today.find((t) => t.id === button.dataset.start && t.status === 'pending')
      if (task) void startAction(task.nodeId, task, undefined, button)
    })
  })
  box.querySelectorAll<HTMLButtonElement>('[data-postpone]').forEach((button) => {
    button.addEventListener('click', async () => {
      const r = await api.postponeTask(button.dataset.postpone!)
      state = r.state
      today = r.today
      overview = r.overview
      renderToday()
      renderHeader()
    })
  })
}

async function startAction(nodeId: string, task?: Task, step?: PathStep, button?: HTMLButtonElement): Promise<void> {
  if (session || preparing.has(nodeId)) return
  const targeted = (task?.kind ?? step?.action ?? 'diagnose') === 'diagnose'
  const limit = task?.estMinutes === 4 ? 1 : 3
  const answered = new Set(state.attempts.filter((a) => !a.guessed && primaryAttemptNode(a) === nodeId).map((a) => a.questionId))
  const available = () => questionsOf(nodeId).sort((a, b) => targeted ? Number(answered.has(a.id)) - Number(answered.has(b.id)) : 0)
  let qs = available()
  if (!qs.length || (targeted && qs.filter((q) => !answered.has(q.id)).length < Math.min(2, limit))) {
    if (button) { button.disabled = true; button.textContent = '准备题目…' }
    try { await ensureQuestions(nodeId, Math.max(limit, qs.length + 2)) }
    finally { if (button) { button.disabled = false; button.textContent = '重试或开始' } }
    qs = available()
  }
  if (session) return
  if (!qs.length) {
    alert(noQuestionHint())
    return
  }
  openPractice(qs.slice(0, limit).map((q) => q.id), nodeId, task?.id ?? null, targeted, step?.id)
}


function renderPanel(): void {
  const box = $('#panel')
  if (!selectedId) {
    box.innerHTML = '<div class="panel-empty">选一个考点，查看讲解和练习。</div>'
    return
  }
  const n = nodeById(selectedId)
  if (!n) return
  const m = masteryOf(n.id)
  const now = Date.now()
  const eff = effective(m, now)
  const b = band(m, now)
  const touched = m.n > 0
  const assessment = assessNode(state, n.id, now)
  const content = builtinContent(n.id)
  const qs = questionsOf(n.id)
  // 没有题时，能不能现场出题决定按钮是"可点"还是"灰掉"
  const aiReady = endpointStatus()
  const canGen = !desktop && aiReady.reachable && aiReady.supportsQuestions
  // 详细讲解：先读缓存，再看是否正在为这个节点生成
  const exSt = explainStates.get(n.id)
  const detail = exSt?.detail ?? explainOf(pack.packId, n.id)
  const explainLoading = !!exSt?.loading
  const explainError = exSt?.error ?? ''
  const explainButton = `<button class="ghost small explain-btn" id="explain-more" ${explainLoading ? 'disabled' : ''}>
    ${explainLoading ? '生成中…' : detail ? '重新生成' : '生成详细讲解'}
  </button>`
  const selfLevel = selfLevelOf(m)
  const selfRating = { none: '没学过', weak: '学过不会', basic: '会', unknown: '未填写' }[selfLevel]

  box.innerHTML = `
    <div class="pname-row">
      <h2 class="node-name">${esc(n.name)}</h2>
      <button class="panel-expand" id="panel-expand" title="${panelExpanded ? '返回（Esc）' : '全屏看讲解'}">${panelExpanded ? '⤡' : '⤢'}</button>
    </div>
    <div class="node-path">${esc(pathOf(n.id))}</div>
    <div class="score-row">
      <div class="score-big ${touched ? '' : 'na'}">${touched ? eff.M.toFixed(2) : '未测'}</div>
      <div class="pill">${esc(assessment.label)}</div>
      <div class="pill">可信度 ${(eff.conf * 100).toFixed(0)}%</div>
      ${helpTip('掌握度依据', [assessment.evidence, assessment.due ? '已到复习时间' : '当前未到期', weightNote(n)].join('\n'))}
    </div>
    <div class="bar"><i style="width:${Math.round(eff.M * 100)}%;background:${BAND_COLOR[b]}"></i></div>
    ${n.kind !== 'root' ? `<div class="scope-actions"><button class="small" id="node-detect">测一下这个点</button>
      <button class="small" id="node-confused">我还是不懂</button>${desktop ? '' : '<button class="small" id="node-edit">调整范围与结构</button>'}</div>` : ''}

    <div class="block">
      <h3>讲解 ${detail ? '' : explainButton}</h3>
      <p class="study-text">${studyText((content?.explain ?? n.brief) ?? '（暂无讲解）')}</p>
      ${
        explainError
          ? `<div class="hint" role="alert" style="color:#a52222">${esc(explainError)}</div>`
          : ''
      }
      ${
        detail
          ? `<details class="explain-detail" id="node-detail" ${expandedExplanations.has(n.id) ? 'open' : ''}>
             <summary><span class="explain-show">展开详细讲解</span><span class="explain-hide">收起详细讲解</span></summary>
             <div class="xdetail">
               <div class="xsec">
                 <div class="xhead">定义与基础认知</div>
                 <p class="xtext study-text">${studyText(detail.definition)}</p>
                 ${
                   detail.basics.length
                     ? `<ul class="xlist">${detail.basics.map((s) => `<li class="study-text">${studyText(s)}</li>`).join('')}</ul>`
                     : ''
                 }
               </div>
               ${
                 detail.exams.length
                   ? `<div class="xsec">
                        <div class="xhead">涉及的考法</div>
                        <ul class="xlist">${detail.exams.map((s) => `<li class="study-text">${studyText(s)}</li>`).join('')}</ul>
                      </div>`
                   : ''
               }
               ${
                 detail.keypoints.length
                   ? `<div class="xsec">
                        <div class="xhead">知识点</div>
                        <ul class="xlist">${detail.keypoints.map((s) => `<li class="study-text">${studyText(s)}</li>`).join('')}</ul>
                      </div>`
                   : ''
               }
               <div class="explain-footer">${explainButton} ${helpTip('讲解来源', `生成于 ${new Date(detail.at).toLocaleString('zh-CN')}。\n由 AI 生成，存疑时可以追问。`)}</div>
             </div></details>`
          : ''
      }
    </div>

    ${(() => {
      const cards = content?.cards ?? []
      if (!cards.length) return ''
      const typeName: Record<string, string> = { conclusion: '结论', method: '方法', pitfall: '易错', formula: '公式' }
      return `<div class="block">
          <h3>卡片 ${helpTip('收藏卡片', '点 ☆ 收藏，之后在顶栏「卡片」查看。')}</h3>
          ${cards
            .map((c) => {
              const saved = isSaved(pack.packId, n.id, c.front)
              return `<div class="aicard">
                <div class="achead">
                  <span class="actype ${c.type}">${typeName[c.type] ?? c.type}</span>
                  <button class="star ${saved ? 'on' : ''}" data-star="${encodeURIComponent(c.front)}" title="${saved ? '取消收藏' : '收藏这张卡'}">${saved ? '★' : '☆'}</button>
                </div>
                <div class="acfront study-text">${studyText(c.front)}</div>
                <div class="acback study-text">${studyText(c.back)}</div>
              </div>`
            })
            .join('')}
        </div>`
    })()}

    ${(() => {
      const a = attributionLine(n, state.attempts, state.mastery, pack.nodes, now)
      if (!a) return ''
      return `<div class="block">
          <h3>你主要错在</h3>
          <p><b>${a.label}</b><span class="hint"> · ${a.total} 次错题里有 ${a.count} 次</span></p>
          <p class="hint" style="margin-top:6px">
            建议：${esc(a.suggestion.text)}
            ${a.suggestion.goto ? `<span class="chip" data-goto="${esc(a.suggestion.goto)}">去看「${esc(nodeById(a.suggestion.goto)?.name ?? '')}」</span>` : ''}
          </p>
        </div>`
    })()}

    <div class="block">
      <h3>AI 答疑 ${helpTip('答疑上下文', '实时答疑会发送当前考点、学习范围和本次问题。')}</h3>
      ${(() => {
        const ai = endpointStatus()
        if (!ai.endpoint || !ai.reachable) {
          const why = ai.endpoint ? `连不上 ${ai.endpoint}。` : '未检测到 AI 服务。'
          return `<div class="hint">AI 服务未连接 ${helpTip('连接 AI 服务', why + '可用 start.bat 启动，或在设置中检查 AI 服务地址。讲解和卡片仍可离线查看。')}</div>`
        }
        const st = askState && askState.nodeId === n.id ? askState : null
        return `
          <div class="askrow">
            <input id="ask-input" ${st?.loading ? 'disabled' : ''} />
            <button class="primary small" id="ask-btn" ${st?.loading ? 'disabled' : ''}>${st?.loading ? '思考中…' : '问'}</button>
          </div>
          <div class="askchips" style="margin-top:8px">${nodeAskPresets(n)
            .map((p) => `<button class="askchip" data-panel-ask="${esc(p)}" ${st?.loading ? 'disabled' : ''}>${esc(p)}</button>`)
            .join('')}</div>
          ${
            st?.error
              ? `<div class="hint" style="color:#a52222;margin-top:8px">${esc(st.error)}</div>`
              : ''
          }
          ${
            st?.answer
              ? `<div class="aianswer">
                   <div class="aatext study-text">${studyText(st.answer.answer)}</div>
                   ${st.answer.cards
                     .map(
                       (c) => `<div class="aicard" style="margin-top:8px">
                         <div class="achead"><span class="actype">卡片</span>
                         <button class="star ${isSaved(pack.packId, n.id, c.front) ? 'on' : ''}" data-star="${encodeURIComponent(c.front)}" data-json="${encodeURIComponent(JSON.stringify(c))}">${isSaved(pack.packId, n.id, c.front) ? '★' : '☆'}</button></div>
                         <div class="acfront study-text">${studyText(c.front)}</div>
                         <div class="acback study-text">${studyText(c.back)}</div>
                       </div>`
                     )
                     .join('')}
                   ${helpTip('答疑耗时', `本次答疑耗时 ${st.answer.ms} ms。`)}
                 </div>`
              : ''
          }`
      })()}
    </div>

    <div class="block">
      <h3>你学过吗 ${helpTip('自评说明', `当前自评：${selfRating}。自评记录你的感受，能力由有效答题更新。`)}</h3>
      <div class="chiprow" id="rate">
        <button class="chip" data-level="0" aria-pressed="${selfLevel === 'none'}">没学过</button>
        <button class="chip" data-level="1" aria-pressed="${selfLevel === 'weak'}">学过不会</button>
        <button class="chip" data-level="2" aria-pressed="${selfLevel === 'basic'}">会</button>
      </div>
    </div>

    ${
      foundationChain(n.id).length
        ? `<div class="block">
             <h3>必要前置 ${helpTip('前置学习顺序', '从左到右复习。掌握情况未知的基础先做检测。')}</h3>
             <div class="chain">${foundationChain(n.id)
               .map((p) => `<span class="chip" data-goto="${esc(p)}">${esc(nodeById(p)?.name ?? p)}</span>`)
               .join('<span class="sep">→</span>')}<span class="sep">→</span><span class="here">${esc(n.name)}</span></div>
           </div>`
        : ''
    }

    ${
      n.prereq.length
        ? `<div class="block"><h3>前置 ${helpTip('前置考点', '学这个考点前需要掌握的内容。')}</h3><ul class="rels">${n.prereq
            .map((p) => {
              const why = whyOf(p, n.id, 'prereq')
              return `<li><span class="chip" data-goto="${esc(p)}">${esc(nodeById(p)?.name ?? p)}</span>${why ? helpTip('前置关系说明', why) : ''}</li>`
            })
            .join('')}</ul></div>`
        : ''
    }

    ${
      n.confusable.length
        ? `<div class="block"><h3>容易混 ${helpTip('易混考点', '可以把容易混淆的考点放在一起对比练习。')}</h3><ul class="rels">${n.confusable
            .map((p) => {
              const why = whyOf(n.id, p, 'confusable')
              return `<li><span class="chip conf" data-goto="${esc(p)}">⇄ ${esc(nodeById(p)?.name ?? p)}</span>${why ? helpTip('易混关系说明', why) : ''}</li>`
            })
            .join('')}</ul></div>`
        : ''
    }

    <div class="block">
      <h3>题目 ${
        qs.length
          ? `· ${qs.length} 道`
          : canGen
            ? helpTip('按需出题', '点下方按钮为这个考点现场生成 3 道题。')
            : ''
      }</h3>
      ${!qs.length && !canGen ? `<p>${esc(noQuestionHint())}</p>` : ''}
      <div style="margin-top:8px">
        <button class="primary small" id="practice" ${qs.length || canGen ? '' : 'disabled'}>${
          qs.length ? '做 3 道' : canGen ? '现出 3 道题' : '做 3 道'
        }</button>
      </div>
    </div>
  `

  box.querySelectorAll<HTMLElement>('[data-goto]').forEach((c) => {
    c.addEventListener('click', () => selectNode(c.dataset.goto as string))
  })
  box.querySelector('#node-edit')?.addEventListener('click', () => renderWizard(true))
  box.querySelector('#node-detect')?.addEventListener('click', (event) => {
    const step = state.path?.steps.find((s) => s.nodeId === n.id && s.action === 'diagnose' && !s.done && !s.invalid && !s.blockedBy.length)
    void startAction(n.id, step && taskMatches(step), step, event.currentTarget as HTMLButtonElement)
  })
  box.querySelector('#node-confused')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement
    await reportConfusion(n.id)
    button.textContent = '已记录，可定点检测'
  })
  box.querySelector('#panel-expand')?.addEventListener('click', () => setPanelExpanded(!panelExpanded))
  box.querySelectorAll<HTMLButtonElement>('[data-star]').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const front = decodeURIComponent(b.dataset.star as string)
      const rawJson = b.dataset.json
      const card = rawJson
        ? (JSON.parse(decodeURIComponent(rawJson)) as { type: string; front: string; back: string })
        : (content?.cards ?? []).find((c) => c.front === front)
      if (!card) return
      const saved = loadCards().find((c) => c.packId === pack.packId && c.nodeId === n.id && c.front === front)
      if (saved) removeCard(saved.id)
      else {
        addCard({ packId: pack.packId, nodeId: n.id, nodeName: n.name, type: card.type, front: card.front, back: card.back })
        void trackSignal(n.id, 'card')
      }
      renderPanel()
      renderHeader()
    })
  })

  const askBtn = box.querySelector<HTMLButtonElement>('#ask-btn')
  if (askBtn) {
    const submitAsk = async (): Promise<void> => {
      const input = box.querySelector<HTMLInputElement>('#ask-input')
      const question = (input?.value ?? '').trim()
      if (!question) return
      askState = { nodeId: n.id, loading: true }
      renderPanel()
      try {
        const explain = content?.explain ?? n.brief ?? ''
        await trackSignal(n.id, 'question')
        const res = await askAi({ nodeName: n.name, nodePath: pathOf(n.id), explain, question, subject: pack.subject, scope: pack.scope })
        askState = res
          ? { nodeId: n.id, loading: false, answer: res }
          : { nodeId: n.id, loading: false, error: '实时 AI 未连接' }
      } catch (e) {
        askState = { nodeId: n.id, loading: false, error: `请求失败：${(e as Error).message}` }
      }
      renderPanel()
    }
    askBtn.addEventListener('click', () => void submitAsk())
    box.querySelector('#ask-input')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void submitAsk()
    })
    // 预设问题：填进去直接问，省得自己想怎么措辞
    box.querySelectorAll<HTMLElement>('[data-panel-ask]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const input = box.querySelector<HTMLInputElement>('#ask-input')
        if (input) input.value = chip.dataset.panelAsk ?? ''
        void submitAsk()
      })
    })
  }
  /* 详细讲解：当场生成并把结果按板块缓存下来 */
  const detailSection = box.querySelector<HTMLDetailsElement>('#node-detail')
  detailSection?.addEventListener('toggle', () => {
    if (!detailSection.isConnected) return
    if (detailSection.open) expandedExplanations.add(n.id)
    else expandedExplanations.delete(n.id)
  })
  box.querySelector('#explain-more')?.addEventListener('click', async () => {
    if (!aiReady.reachable) {
      explainStates.set(n.id, { detail, loading: false, error: 'AI 服务未连接，请运行 start.bat。' })
      renderPanel()
      return
    }
    explainStates.set(n.id, { detail, loading: true })
    renderPanel()
    try {
      const res = await explainNode({
        nodeName: n.name,
        nodePath: pathOf(n.id),
        brief: n.brief ?? '',
        exam: pack.meta?.exam ?? '',
        subject: pack.meta?.subject ?? pack.subject ?? '',
        chapter: n.origin ?? pack.meta?.chapter ?? pack.title ?? '',
        scope: pack.scope
      })
      if (!res) {
        explainStates.set(n.id, { detail, loading: false, error: 'AI 服务没连上' })
      } else if (!res.definition && !res.basics.length && !res.exams.length && !res.keypoints.length) {
        explainStates.set(n.id, { detail, loading: false, error: 'AI 这次没返回内容，稍后再试一次' })
      } else {
        saveExplain(pack.packId, n.id, res)
        explainStates.set(n.id, { detail: res, loading: false })
        if (!detail) expandedExplanations.add(n.id)
      }
    } catch (e) {
      explainStates.set(n.id, { detail, loading: false, error: `生成失败：${(e as Error).message}` })
    }
    if (selectedId === n.id) renderPanel()
  })

  box.querySelectorAll<HTMLElement>('#rate .chip').forEach((c) => {
    c.addEventListener('click', async () => {
      const level = Number(c.dataset.level) as 0 | 1 | 2
      const r = await api.rate(n.id, level)
      state = r.state
      today = r.today
      overview = r.overview
      renderToday()
      renderHeader()
      renderPanel()
      refreshVisuals()
    })
  })
  const pbtn = box.querySelector<HTMLButtonElement>('#practice')
  pbtn?.addEventListener('click', async () => {
    const have = questionsOf(n.id)
    if (have.length > 0) {
      openPractice(have.slice(0, 3).map((q) => q.id), n.id, null)
      return
    }
    // 题不够 → 现出题。这是"按需生成"的主入口。
    pbtn.textContent = '正在出题…'
    pbtn.disabled = true
    const ok = await ensureQuestions(n.id, 3)
    if (!ok) {
      pbtn.textContent = '出题失败'
      alert(noQuestionHint())
      renderPanel()
      return
    }
    renderPanel()
    const fresh = questionsOf(n.id)
    if (fresh.length) openPractice(fresh.slice(0, 3).map((q) => q.id), n.id, null)
  })
}

function selectNode(id: string | null): void {
  if (id && id !== selectedId && nodeById(id)?.kind !== 'root') void trackSignal(id, 'explain')
  selectedId = id
  if (planning.open) {
    const matches = shownSteps().filter((step) => step.nodeId === id)
    const step = matches.find((item) => !item.done) ?? matches[0]
    if (id && !step) planning.focused = false
    planning.current = step?.id ?? ''
    updatePlanFocus()
    renderToday()
    if (step && !planning.daily) {
      $('#today').querySelector(`[data-path-step="${CSS.escape(step.id)}"]`)?.scrollIntoView({ block: 'nearest' })
    }
  }
  graph.select(id)
  renderPanel()
}

/* ---------------- 热力表 ---------------- */

let heatSort: 'priority' | 'tree' = 'priority'

const CELL_CLASS = (r: number | null): string => {
  if (r === null) return 'none'
  if (r < 0.4) return 'bad'
  if (r < 0.7) return 'mid'
  if (r < 0.9) return 'ok'
  return 'good'
}

function renderHeat(): void {
  const box = $('#heat')
  const now = Date.now()
  const rows = buildHeatmap({
    nodes: pack.nodes,
    questions: desktop ? questions : activeQuestions(pack, questionsOfPack(pack.packId)),
    attempts: state.attempts,
    mastery: state.mastery,
    now,
    daysLeft: Infinity,
    sort: heatSort
  })
  const sum = summarizeHeat(rows)

  const body = rows
    .map((r) => {
      const cells = BANDS.map((b) => {
        const c = r.cells[b.key]
        const hint =
          b.hint +
          `：有效 ${c.correct}/${c.attempts}` +
          (c.excluded ? `（另有 ${c.excluded} 条疑似蒙对，未计入）` : '')
        return `<td class="hcell ${CELL_CLASS(c.ratio)}" title="${hint}">
                  ${c.ratio === null ? '—' : `${c.correct}/${c.attempts}`}
                </td>`
      }).join('')
      const m = r.mastery === null ? '<span class="hm none">没测过</span>' : `<span class="hm" style="background:${bandColor(r.mastery)}"></span>${r.mastery.toFixed(2)}`
      const conf = r.mastery === null ? '—' : `${Math.round(r.conf * 100)}%`
      return `<tr data-node="${esc(r.nodeId)}" class="${selectedId === r.nodeId ? 'sel' : ''}">
        <td class="hname">
          ${r.parentName ? `<span class="hpath">${esc(r.parentName)}</span>` : ''}${esc(r.name)}
        </td>
        ${cells}
        <td class="hnum">${m}</td>
        <td class="hnum conf">${conf}</td>
      </tr>`
    })
    .join('')

  box.innerHTML = `
    <div class="hbar">
      <b>${sum.total}</b> 个考点 ·
      <b class="warn">${rows.filter((row) => assessNode(state, row.nodeId, now).action === 'gap').length}</b> 个有依据的缺口 ·
      <b>${sum.unmeasured}</b> 个没测过
      ${sum.excluded ? `<span class="hsep">|</span><span class="hint-inline">已剔除 ${sum.excluded} 条疑似蒙对</span>` : ''}
      ${helpTip('热力表读法', '格子中的「2/3」表示该难度做对 2 次，共作答 3 次。「—」表示还没做过该难度。')}
    </div>
    <table class="heat">
      <thead>
        <tr>
          <th class="hname">考点</th>
          ${BANDS.map((b) => `<th title="${b.hint}">${b.label}</th>`).join('')}
          <th>掌握</th>
          <th>可信度</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `

  box.querySelectorAll<HTMLElement>('tr[data-node]').forEach((tr) => {
    tr.addEventListener('click', () => {
      selectNode(tr.dataset.node as string)
      renderHeat()
    })
  })
}

function bandColor(m: number): string {
  if (m < 0.25) return 'var(--c1)'
  if (m < 0.4) return 'var(--c2)'
  if (m < 0.6) return 'var(--c3)'
  return 'var(--c5)'
}

function refreshVisuals(): void {
  graph.setData(pack.nodes, state.mastery, Date.now(), pack.relations ?? [])
  updatePlanFocus()
  if (document.body.dataset.view === 'heat') renderHeat()
}

/* ---------------- 力学面板 ---------------- */

let physics = loadPhysics()

function renderPhysics(): void {
  const box = $('#phys')
  if (!box) return
  const open = box.classList.contains('open')
  box.classList.toggle('open', !open)
  if (open) {
    box.innerHTML = ''
    return
  }
  const rows = PHYSICS_SLIDERS.map((s) => {
    const raw = Math.abs(physics[s.key])
    const shown = s.display ? s.display(physics[s.key]) : physics[s.key]
    return `<label class="prow">
      <span class="plabel">${s.label}<b>${Number(shown).toFixed(s.step < 1 ? 2 : 0)}</b></span>
      <input type="range" data-phys="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${raw}" />
      <span class="phint">${s.hint}</span>
    </label>`
  }).join('')

  box.innerHTML = `
    <div class="phead">
      <span>图谱力学</span>
      <button class="pclose" id="phys-close" title="关闭">✕</button>
    </div>
    ${rows}
    <div class="pfoot">
      <button class="ghost small" id="phys-reset">恢复默认</button>
      <button class="ghost small" id="phys-reheat">重排一次</button>
    </div>
  `

  box.querySelector('#phys-close')?.addEventListener('click', () => {
    box.classList.remove('open')
    box.innerHTML = ''
  })
  box.querySelector('#phys-reset')?.addEventListener('click', () => {
    physics = resetPhysics()
    graph.applyPhysicalBatch(physics)
    renderPhysics()
    renderPhysics()
  })
  box.querySelector('#phys-reheat')?.addEventListener('click', () => {
    clearPositions(pack.packId)
    graph.applyPhysicalBatch(physics)
  })
  box.querySelectorAll<HTMLInputElement>('[data-phys]').forEach((el) => {
    el.addEventListener('input', () => {
      const key = el.dataset.phys as keyof typeof physics
      const meta = PHYSICS_SLIDERS.find((s) => s.key === key)
      const raw = Number(el.value)
      physics = { ...physics, [key]: meta?.parse ? meta.parse(raw) : raw }
      savePhysics(physics)
      const shown = meta?.display ? meta.display(physics[key]) : physics[key]
      const label = el.parentElement?.querySelector('.plabel b')
      if (label) label.textContent = Number(shown).toFixed(meta && meta.step < 1 ? 2 : 0)
      graph.setPhysics({ [key]: physics[key] })
    })
  })
}

/* ---------------- 可拖拽侧栏 ---------------- */

let layout = loadLayout()

function applyLayout(): void {
  const m = document.querySelector('main') as HTMLElement | null
  if (!m) return
  m.style.setProperty('--left-w', (layout.leftClosed ? 0 : layout.left) + 'px')
  m.style.setProperty('--right-w', (layout.rightClosed ? 0 : layout.right) + 'px')
  m.classList.toggle('left-closed', layout.leftClosed)
  m.classList.toggle('right-closed', layout.rightClosed)
  const tl = $('#tab-left')
  const tr = $('#tab-right')
  if (tl) {
    tl.textContent = layout.leftClosed ? '›' : '‹'
    tl.title = layout.leftClosed ? '展开今日' : '收起今日'
  }
  if (tr) {
    tr.textContent = layout.rightClosed ? '‹' : '›'
    tr.title = layout.rightClosed ? '展开讲解' : '收起讲解'
  }
}

function setLayout(next: LayoutState): void {
  layout = next
  applyLayout()
  saveLayout(layout)
}

function attachSplitter(el: HTMLElement | null, side: 'left' | 'right'): void {
  if (!el) return
  el.addEventListener('pointerdown', (e) => {
    const main = document.querySelector('main') as HTMLElement | null
    if (!main) return
    e.preventDefault()
    const rect = main.getBoundingClientRect()
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* 合成事件没有真实 pointerId，捕获失败不影响拖动 */
    }
    document.body.classList.add('col-resizing')

    const move = (ev: PointerEvent): void => {
      if (side === 'left') {
        const w = clampWidth(ev.clientX - rect.left, LEFT_MIN, LEFT_MAX)
        layout = { ...layout, left: w, leftClosed: false }
      } else {
        const w = clampWidth(rect.right - ev.clientX, RIGHT_MIN, RIGHT_MAX)
        layout = { ...layout, right: w, rightClosed: false }
      }
      applyLayout()
    }
    const up = (): void => {
      document.body.classList.remove('col-resizing')
      el.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      saveLayout(layout)
      graph.fit()
    }
    el.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })
  // 双击复位这一侧
  el.addEventListener('dblclick', () => {
    setLayout(
      side === 'left'
        ? { ...layout, left: LAYOUT_DEFAULT.left, leftClosed: false }
        : { ...layout, right: LAYOUT_DEFAULT.right, rightClosed: false }
    )
    graph.fit()
  })
}

/** 舞台尺寸变了要重新取景，否则图会偏到一边 */
/* ---------------- 右栏全屏 ---------------- */

let panelExpanded = false

/** 全屏看讲解：把右栏铺满整屏，正文限宽保证行长可读 */
function setPanelExpanded(next: boolean): void {
  panelExpanded = next
  document.body.dataset.panel = next ? 'full' : ''
  renderPanel()
  const btn = $('#panel-expand') as HTMLButtonElement | null
  btn?.focus()
}

function setView(view: 'graph' | 'heat'): void {  document.body.dataset.view = view
  document.querySelectorAll<HTMLButtonElement>('.views button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.view === view))
  })
  if (view === 'heat') renderHeat()
  updatePlanFocus()
}

/* ---------------- 做题 ---------------- */

interface Session {
  ids: string[]
  index: number
  taskId: string | null
  startedAt: number
  answer: string
  /** null = 用户还没选；不要默认成 sure，否则"确定但答错"的判定会被白送 */
  confidence: 'sure' | 'unsure' | null
  /** answering → (错了才进 reason) → feedback */
  phase: 'answering' | 'reason' | 'feedback'
  last?: SubmitResult
  /** 摸底模式：题目是边测边挑的，不是固定列表 */
  diag?: DiagState
  targeted?: boolean
  stepId?: string
  id: string
  prerequisiteSnapshot: string
  confusion?: boolean
}

let session: Session | null = null
let diagResult: DiagSummary | null = null
let submitting = false
let startingDiagnostic = false

/* ---------------- 题目追问 ----------------
 * 规则：**交卷之后**才能对这题追问，作答期间不开放。
 * 理由很实在——没作答就问，等于让人替你想，这题就不算做过了。
 */
const askKey = () => 'gapgraph.asks.' + pack.packId + '.v1'
interface AskTurn {
  q: string
  a: string
}
let askBusy = false
let askDraft = ''
let askError = ''

function loadAsks(): Record<string, AskTurn[]> {
  try {
    const raw = localStorage.getItem(askKey())
    const v = raw ? JSON.parse(raw) : {}
    return v && typeof v === 'object' ? (v as Record<string, AskTurn[]>) : {}
  } catch {
    return {}
  }
}

function asksOf(qid: string): AskTurn[] {
  const all = loadAsks()
  return Array.isArray(all[qid]) ? all[qid] : []
}

function pushAsk(qid: string, turn: AskTurn): void {
  const all = loadAsks()
  const list = Array.isArray(all[qid]) ? all[qid] : []
  all[qid] = [...list, turn].slice(-8)
  try {
    localStorage.setItem(askKey(), JSON.stringify(all))
  } catch {
    /* 忽略 */
  }
}

/** 把这道题完整摊给 AI 看：题干、选项、我选的、正确答案、解析 */
function questionContext(q: Question, mine: string): string {
  const lines: string[] = []
  const typeName = q.type === 'single' ? '单选' : q.type === 'judge' ? '判断' : '填空'
  lines.push(`题型：${typeName}（难度 ${q.difficulty}）`)
  lines.push(`题干：${q.stem}`)
  if (q.options?.length) {
    lines.push(`选项：${q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('  ')}`)
  }
  const right = Array.isArray(q.answer) ? q.answer.join(' 或 ') : q.answer
  lines.push(`我的作答：${mine || '（空）'}`)
  lines.push(`正确答案：${right}`)
  if (q.solution) lines.push(`题库解析：${q.solution}`)
  return lines.join('\n')
}

async function askAboutQuestion(q: Question): Promise<void> {
  const text = askDraft.trim()
  if (!text || askBusy) return
  const n = pack.nodes.find((x) => x.id === primaryNodeOf(q))
  const context = questionContext(q, session?.answer ?? '')
  askBusy = true
  askError = ''
  askDraft = ''
  renderModal()
  try {
    if (n) await trackSignal(n.id, 'question', q.id)
    const res = await askAi({
      nodeName: n?.name ?? '这道题', nodePath: n ? pathOf(n.id) : '', explain: n?.brief ?? '',
      question: text, subject: pack.subject, scope: pack.scope, context
    })
    if (res?.answer) pushAsk(q.id, { q: text, a: res.answer })
    else askError = 'AI 没接上。可以查看题库解析或稍后重试。'
  } catch (error) {
    askError = '追问失败，可以重试。' + (error as Error).message
  } finally {
    askBusy = false
    renderModal()
  }
}

/**
 * 追问的预设问题按"这道题 + 这个考点"现场生成。
 * 以前是四个写死的通用句子（"这题为什么错"），换个学科、换个考点就都一样，
 * 等于没帮上忙。现在至少带上考点名、题型和这次对错。
 */
function askPresetsFor(q: Question, nodeName: string, correct?: boolean): string[] {
  const name = nodeName || '这个考点'
  const out: string[] = []
  if (correct === false) out.push('我错在哪一步')
  else if (correct === true) out.push('这题还有更快的做法吗')
  else out.push('这题的关键一步是什么')

  if (q.type === 'single') out.push('其他选项为什么不对')
  else if (q.type === 'judge') out.push(`这题为什么判「${String(q.answer) === 'true' ? '对' : '错'}」`)
  else out.push('答案还有别的写法吗')

  out.push(`「${name}」在这题里怎么用`)
  out.push(`用更简单的例子讲「${name}」`)
  return out.slice(0, 4)
}

/** 右栏（针对整个考点）的预设问题 */
function nodeAskPresets(n: KNode): string[] {
  const name = n.name
  return [`「${name}」到底在讲什么`, `「${name}」最容易错在哪`, `「${name}」和前置的关系`, `给我一道「${name}」的例题`]
}


function prerequisiteSnapshot(): string {
  const ids = [...new Set(pack.nodes.flatMap((n) => n.prereq))].sort()
  const now = Date.now()
  return JSON.stringify(ids.map((id) => {
    const assessment = assessNode(state, id, now)
    return [id, assessment.label === '稳定' ? 'stable' : assessment.action]
  }))
}

function newSession(ids: string[], taskId: string | null): Session {
  return {
    ids, taskId, index: 0, startedAt: Date.now(), answer: '', confidence: null, phase: 'answering',
    id: 'session-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
    prerequisiteSnapshot: prerequisiteSnapshot()
  }
}

async function startDiagnostic(): Promise<void> {
  if (session || startingDiagnostic) return
  startingDiagnostic = true
  const button = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null
  if (button) button.disabled = true
  try {
    const revision = packRevision(pack)
    const saved = state.diagnostic
    const diag: DiagState = { ...(saved && !saved.finished ? saved : createDiagnostic()), revision }
    let first = nextQuestion(diag, questions, pack.nodes, state.mastery)
    if (!first && !diagnosticCoverage(diag, pack.nodes).ready && diag.askedIds.length < DIAG_TARGET) {
      const targets = diagnosticTargets(diag, questions, pack.nodes)
      if (button) button.textContent = '准备摸底题…'
      await Promise.all(targets.map((n) => ensureQuestions(n.id, questionsOf(n.id).length + 2)))
      first = nextQuestion(diag, questions, pack.nodes, state.mastery)
    }
    if (session) return
    const finished = !first && (diagnosticCoverage(diag, pack.nodes).ready || diag.askedIds.length >= DIAG_TARGET)
    await syncLearning({ kind: 'diagnostic', round: { ...diag, finished } })
    if (!first) {
      diagResult = summarize(diag, pack.nodes, state.mastery, Date.now())
      renderModal()
      await syncLearning({ kind: 'checkpoint', reason: '摸底暂缺可用题，按现有证据检查路径' })
      return
    }
    diagResult = null
    session = { ...newSession([first.id], null), diag }
    renderModal()
  } catch (error) { alert((error as Error).message) }
  finally {
    startingDiagnostic = false
    if (button) { button.disabled = false; button.textContent = '摸底' }
  }
}

async function finishDiagnostic(): Promise<void> {
  if (!session?.diag) return
  const diag = session.diag
  diagResult = summarize(diag, pack.nodes, state.mastery, Date.now())
  const finished = diagResult.progress.ready || diag.askedIds.length >= DIAG_TARGET
  session = null
  renderModal()
  await syncLearning({ kind: 'diagnostic', round: { ...diag, finished } })
  await syncLearning({ kind: 'checkpoint', reason: finished ? '摸底检查点' : '题库覆盖有限，按已提交证据检查' })
}

function closeDiagnostic(goWeakest: boolean): void {
  const weak = diagResult?.weakest[0]
  diagResult = null
  renderModal()
  if (goWeakest && weak) selectNode(weak.id)
}

function openPractice(ids: string[], nodeId: string | null, taskId: string | null, targeted = false, stepId?: string): void {
  if (!ids.length || session) return
  askDraft = ''
  askError = ''
  session = { ...newSession(ids, taskId), targeted, stepId }
  if (nodeId) selectNode(nodeId)
  renderModal()
}

async function pauseSession(): Promise<void> {
  const current = session
  if (!current || submitting) return
  session = null
  renderModal()
  if (current.diag?.answered.length) await syncLearning({ kind: 'checkpoint', reason: '摸底已暂停，保留有限证据' })
  else if (current.confusion) await syncLearning({ kind: 'checkpoint', reason: '按本次主动困惑检查定点诊断' })
  else if (current.prerequisiteSnapshot !== prerequisiteSnapshot()) {
    await syncLearning({ kind: 'checkpoint', reason: '会话结束，必要前置的判断已变化' })
  } else if (newEffectiveSince(state.attempts, state.path?.checkedAt ?? 0) >= PRACTICE_CHECK_MIN) {
    await syncLearning({ kind: 'checkpoint', reason: '练习结束，累计三道新有效题' })
  }
}


function renderModal(): void {
  const box = $('#modal')

  // 摸底结果页
  if (diagResult) {
    const progress = diagResult.progress
    box.innerHTML = `
      <div class="sheet">
        <div class="qhead"><span>本轮摸底</span><span>${diagResult.answered}/${DIAG_TARGET} 次提交</span></div>
        <div class="stem">${progress.ready ? '已获得初步画像' : '证据有限'}</div>
        <p>${progress.effective} 道不同的有效题 · ${progress.covered}/${progress.branches} 个主分支
          ${helpTip('摸底结果说明', `初步画像需要 6 道有效题和 ${progress.required} 个主分支。未测考点显示未知。` +
            (progress.ready ? '' : '可以先学习，之后继续摸底，或用定点检测补充证据。'))}</p>
        ${
          diagResult.weakest.length
            ? `<div class="block"><h3>可进一步定点验证</h3>
                 <div class="chiprow">${diagResult.weakest
                   .map((w) => `<button class="small" data-weak="${esc(w.id)}">测一下 ${esc(w.name)}</button>`)
                   .join('')}</div>
               </div>`
            : ''
        }
        <div class="footer-row">
          <div class="spacer"></div>
          <button class="primary" id="diag-done">打开规划</button>
        </div>
      </div>`
    box.classList.add('open')
    box.querySelectorAll<HTMLElement>('[data-weak]').forEach((c) => {
      c.addEventListener('click', () => {
        const id = c.dataset.weak as string
        diagResult = null
        renderModal()
        void startAction(id)
      })
    })
    box.querySelector('#diag-done')?.addEventListener('click', () => { closeDiagnostic(false); togglePlanning(true) })
    return
  }

  if (!session) {
    box.classList.remove('open')
    box.innerHTML = ''
    return
  }
  const q = questions.find((x) => x.id === session!.ids[session!.index])!
  const total = session.ids.length
  const answered = session.phase === 'feedback'
  const askingReason = session.phase === 'reason'

  let inputHtml = ''
  if (askingReason) {
    inputHtml = ''
  } else if (q.type === 'single') {
    inputHtml = `<div class="opts">${(q.options ?? [])
      .map(
        (o, i) =>
          `<button class="opt study-text ${session!.answer === o ? 'sel' : ''}" data-opt="${i}">${String.fromCharCode(65 + i)}. ${studyText(o)}</button>`
      )
      .join('')}</div>`
  } else if (q.type === 'judge') {
    inputHtml = `<div class="opts">
      <button class="opt ${session!.answer === 'true' ? 'sel' : ''}" data-judge="true">正确</button>
      <button class="opt ${session!.answer === 'false' ? 'sel' : ''}" data-judge="false">错误</button>
    </div>`
  } else {
    inputHtml = `<input class="blank" id="blank" value="${session!.answer.replace(/"/g, '&quot;')}" />`
  }

  const fb =
    answered && session.last
      ? `<div class="feedback ${session.last.correct ? 'ok' : 'bad'}">
         <b>${session.last.correct ? '答对了' : '答错了'}</b>
         ${session.last.guessed ? ' · 这条不计入掌握分（疑似蒙对）' : ''}
         <span class="delta"> ${session.last.before.toFixed(2)} → ${session.last.after.toFixed(2)}</span>
         <span class="bandshift">${BAND_NAME[session.last.beforeBand]} → ${BAND_NAME[session.last.afterBand]}</span>
         ${session.last.solution ? `<div class="study-text" style="margin-top:6px;color:#444">${studyText(session.last.solution)}</div>` : ''}
       </div>`
      : ''

  const reasonHtml = askingReason
    ? `<div class="reasonbox">
         <div class="rtitle">这题错在哪？ ${helpTip('错因说明', '错因用于调整后续推荐。跳过仍会记录这次作答。')}</div>
         <div class="rchips">
           ${reasonsFor(pack.meta?.subject).map((r) => `<button class="rc" data-reason="${r.key}" title="${r.hint}">${r.label}</button>`).join('')}
         </div>
       </div>`
    : ''

  // 追问只在交卷后出现：没作答就问，这题等于没做
  const askTurns = answered ? asksOf(q.id) : []
  const qNode = pack.nodes.find((x) => x.id === primaryNodeOf(q))
  const askChips = askPresetsFor(q, qNode?.name ?? '', answered ? session.last?.correct : undefined)
  const askHtml = answered
    ? `<div class="askbox">
         <div class="askhead"><b>对这题还有疑问？</b>${helpTip('追问上下文', '追问会发送当前学习范围和这道题的相关内容。')}</div>
         <div class="askchips">${askChips.map((p) => `<button class="askchip" data-ask="${esc(p)}">${esc(p)}</button>`).join('')}</div>
         ${qNode ? '<div class="scope-actions"><button class="small" id="q-confused">我还是不懂</button><button class="small" id="q-detect">测一下这个点</button></div>' : ''}
         <div class="askrow">
           <input id="qask-input" class="askinput"
             value="${esc(askDraft).replace(/"/g, '&quot;')}" ${askBusy ? 'disabled' : ''} />
           <button class="primary small" id="ask-send" ${askBusy ? 'disabled' : ''}>${askBusy ? '想问…' : '问'}</button>
         </div>
         ${askError ? `<div class="askerr">${esc(askError)}</div>` : ''}
         ${
           askTurns.length
             ? `<div class="asklog">${askTurns
                 .map(
                   (t) => `<div class="askitem"><div class="askq study-text">${studyText(t.q)}</div><div class="aska study-text">${studyText(t.a)}</div></div>`
                 )
                 .join('')}</div>`
             : ''
         }
       </div>`
    : ''

  box.innerHTML = `
    <div class="sheet">
      <div class="qhead">
        <span>${session.diag ? `摸底 · ${session.diag.askedIds.length}/${DIAG_TARGET} 次已提交` : `第 ${session.index + 1} / ${total} 题`} · 难度 ${'●'.repeat(q.difficulty)}</span>
        <span>${session.diag ? '按分支渐进选题' : session.targeted ? '定点检测' : (KIND_LABEL[(today.find((t) => t.id === session!.taskId)?.kind ?? 'gap') as string] ?? '')}</span>
      </div>
      ${session.diag ? `<div class="diagbar"><i style="width:${Math.round((session.diag.askedIds.length / DIAG_TARGET) * 100)}%"></i></div>` : ''}
      <div class="stem study-text">${studyText(q.stem)}</div>
      ${inputHtml}
      ${reasonHtml}
      ${fb}
      ${askHtml}
      <div class="footer-row">
        ${
          answered
            ? `<button class="primary" id="next">${session.index + 1 < total ? '下一题' : '完成'}</button>`
            : askingReason
              ? `<div class="spacer"></div><button class="ghost small" id="skip-reason">跳过</button>`
              : `<div class="conf-toggle" data-picked="${session.confidence ? '1' : '0'}">
                 <button class="small" data-conf="sure" aria-pressed="${session.confidence === 'sure'}">我很确定</button>
                 <button class="small" data-conf="unsure" aria-pressed="${session.confidence === 'unsure'}">不确定</button>
               </div>
               <div class="spacer"></div>
               ${
                 session.answer && !session.confidence
                   ? `<span class="hint conf-need">先选一下把握程度</span>`
                   : ''
               }
               <button class="ghost small" id="later">${session.diag ? '暂停摸底' : '稍后'}</button>
               <button class="primary" id="submit" ${
                 session.answer && session.confidence ? '' : 'disabled'
               } title="${session.answer ? (session.confidence ? '提交' : '先选我很确定 / 不确定') : '先作答'}">提交</button>`
        }
      </div>
    </div>`
  box.classList.add('open')

  box.querySelectorAll<HTMLButtonElement>('[data-reason]').forEach((b) => {
    b.addEventListener('click', () => void commitAnswer(b.dataset.reason as ErrorReason))
  })
  box.querySelector('#skip-reason')?.addEventListener('click', () => void commitAnswer(null))

  box.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((b) => {
    b.addEventListener('click', () => {
      session!.answer = q.options![Number(b.dataset.opt)]
      renderModal()
    })
  })
  box.querySelectorAll<HTMLButtonElement>('[data-judge]').forEach((b) => {
    b.addEventListener('click', () => {
      session!.answer = b.dataset.judge as string
      renderModal()
    })
  })
  box.querySelectorAll<HTMLButtonElement>('[data-conf]').forEach((b) => {
    b.addEventListener('click', () => {
      session!.confidence = b.dataset.conf as 'sure' | 'unsure'
      renderModal()
    })
  })
  const blank = box.querySelector<HTMLInputElement>('#blank')
  if (blank) {
    blank.addEventListener('input', () => {
      session!.answer = blank.value
      const s = box.querySelector<HTMLButtonElement>('#submit')
      if (s) s.disabled = !blank.value.trim()
    })
    blank.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && blank.value.trim()) void doSubmit()
    })
  }
  box.querySelector('#submit')?.addEventListener('click', () => void doSubmit())
  box.querySelectorAll<HTMLButtonElement>('[data-ask]').forEach((b) => {
    b.addEventListener('click', () => {
      askDraft = b.dataset.ask as string
      void askAboutQuestion(q)
    })
  })
  const askInput = box.querySelector<HTMLInputElement>('#qask-input')
  askInput?.addEventListener('input', () => {
    askDraft = askInput.value
  })
  // 发送时直接读输入框的值：中文输入法组合期间 input 事件可能丢，
  // 只靠 askDraft 会出现"点了没反应"。
  const sendAsk = (): void => {
    const el = box.querySelector<HTMLInputElement>('#qask-input')
    if (el) askDraft = el.value
    void askAboutQuestion(q)
  }
  askInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendAsk()
  })
  box.querySelector('#ask-send')?.addEventListener('click', sendAsk)
  box.querySelector('#q-confused')?.addEventListener('click', async (event) => {
    if (!qNode) return
    const button = event.currentTarget as HTMLButtonElement
    await reportConfusion(qNode.id, q.id)
    button.textContent = '已记录困惑'
  })
  box.querySelector('#q-detect')?.addEventListener('click', async () => {
    if (!qNode) return
    if (session && session.index === session.ids.length - 1 && !session.diag) await finishSession()
    else await pauseSession()
    await startAction(qNode.id)
  })
  box.querySelector('#later')?.addEventListener('click', () => void pauseSession())
  box.querySelector('#next')?.addEventListener('click', () => {
    if (!session) return
    if (session.index + 1 < session.ids.length) {
      session.index++
      session.answer = ''
      session.confidence = null
      session.phase = 'answering'
      session.startedAt = Date.now()
      renderModal()
    } else if (session.diag) {
      void finishDiagnostic()
    } else {
      void finishSession()
    }
  })
}

/** 先判对错（不改状态）：答错了先问一句"错在哪"，再落库 */
async function doSubmit(): Promise<void> {
  const current = session
  if (!current || submitting || current.phase !== 'answering' || !current.confidence) return
  const q = questions.find((x) => x.id === current.ids[current.index])!
  submitting = true
  try {
    const { correct } = await api.check(q.id, current.answer)
    if (!correct) {
      current.phase = 'reason'
      renderModal()
      return
    }
  } catch (error) {
    alert((error as Error).message)
    return
  } finally { submitting = false }
  await commitAnswer(null)
}

async function commitAnswer(reason: ErrorReason): Promise<void> {
  const current = session
  if (!current || submitting || current.phase === 'feedback') return
  const q = questions.find((x) => x.id === current.ids[current.index])!
  submitting = true
  try {
    const r = await api.submit({
      questionId: q.id, answer: current.answer, durationMs: Date.now() - current.startedAt,
      selfConfidence: current.confidence ?? 'unknown', errorReason: reason,
      submissionId: current.id + '-' + current.index, taskId: current.taskId ?? undefined,
      diagnostic: !!current.diag
    })
    current.last = r
    current.phase = 'feedback'
    state = r.state
    today = r.today
    overview = r.overview
    if (current.diag && state.diagnostic) {
      current.diag = state.diagnostic
      const next = nextQuestion(current.diag, questions, pack.nodes, state.mastery)
      if (next) current.ids.push(next.id)
    }
    refreshVisuals()
    renderToday()
    renderHeader()
    renderPanel()
    renderModal()
  } catch (error) {
    alert('作答未能保存，可以重试。' + (error as Error).message)
  } finally { submitting = false }
}

async function finishSession(): Promise<void> {
  const current = session
  if (!current || current.phase !== 'feedback' || current.index !== current.ids.length - 1) return
  session = null
  renderModal()
  if (current.taskId) {
    const r = await api.completeTask(current.taskId)
    state = r.state
    today = r.today
    overview = r.overview
    renderToday()
    renderHeader()
    updatePlanFocus()
  } else if (current.targeted || current.stepId || current.confusion ||
    newEffectiveSince(state.attempts, state.path?.checkedAt ?? 0) >= PRACTICE_CHECK_MIN || current.prerequisiteSnapshot !== prerequisiteSnapshot()) {
    await syncLearning({ kind: 'checkpoint',
      reason: current.targeted ? '完成定点检测后检查路径' : '完成练习后检查新证据与前置',
      completedStep: current.stepId })
  }
}


/* ---------------- 启动 ---------------- */

async function boot(): Promise<void> {
  try {
    await bootInner()
  } catch (err) {
    // 启动失败时别留一个白屏给人猜：把错误直接摊在页面上
    console.error(err)
    document.body.insertAdjacentHTML(
      'beforeend',
      `<pre id="booterr" style="position:fixed;left:0;right:0;bottom:0;max-height:46%;overflow:auto;
        background:#fff3f3;color:#a11;border-top:2px solid #e88;font:12px/1.6 ui-monospace,monospace;
        padding:12px 16px;margin:0;white-space:pre-wrap;z-index:99">启动失败：${
          err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err)
        }</pre>`
    )
  }
}

async function bootInner(): Promise<void> {
  mount()
  await initEndpoint()

  const data = await api.load()
  pack = data.pack
  questions = data.questions
  state = data.state
  today = data.today
  overview = data.overview

  const hash = location.hash.replace('#', '')
  const wantsStudy = hash === 'study' || hash === 'diag' || hash === 'heat'
  const page = wantsStudy && (desktop || currentPack()) ? 'study' : 'home'
  document.body.dataset.page = page

  if (page === 'home') {
    renderHome()
    if (shouldShowGuide()) renderGuide()
    return
  }

  renderHeader()
  renderToday()
  const focusId = history.state?.structureFocusId as string | undefined
  if (focusId) {
    history.replaceState(null, '')
    selectedId = nodeById(focusId)?.id ?? null
  }
  renderPanel()
  refreshVisuals()
  graph.select(selectedId)
  graph.setPositions(loadPositions(pack.packId))
  requestAnimationFrame(() => graph.fit())
  setTimeout(() => graph.fit(), 80)

  // 深链：地址后加 #diag 直接进摸底、#heat 直接看热力表（方便演示与自测）
  if (hash === 'diag') startDiagnostic()
  else if (hash === 'heat') setView('heat')
  else if (hash === 'settings') renderSettings()
}

void boot()
