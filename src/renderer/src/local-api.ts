/*
 * 浏览器运行模式：不依赖 Electron 主进程。
 * 与 Electron 版共用同一份领域算法（掌握度 / 优先级 / 队列 / 判分），
 * 区别只有两处：数据存在 localStorage，题库与考纲包由打包工具内联进来。
 */
import packJson from '../../../resources/packs/gaokao-math-function.json'
import questionsJson from '../../../resources/questions/gaokao-math-function.json'
import type { AppState, LearningUpdate, LoadResult, Pack, Question, SubmitPayload, SubmitResult, Task } from '../../shared/types'
import { effective, freshMastery, migrateMastery, setSelfLevel } from '../../shared/mastery'
import { blankMastery, coverage, daysUntil } from '../../main/domain/queue'
import { isCorrect } from '../../main/domain/grading'
import { activeQuestions, applyLearningUpdate, restoreEvidenceClocks, todayFromPath } from '../../main/domain/learning-state'
import { submitAnswer } from '../../main/domain/submission'
import { builtinPack, currentPack, stateKeyFor } from './packs'
import { loadPlayableBank } from './qbank'
import { effectivePack } from './edits'

/** 当前生效的考纲：由引导流程选定，换了章节就换这一份；状态按 packId 隔离 */
const RAW_PACK: Pack = currentPack() ?? builtinPack()
/** 用户增删过的考点在这里套上去 */
const PACK: Pack = effectivePack(RAW_PACK)
const BUILTIN_ID = (packJson as unknown as Pack).packId
/** 内置题库 + 按需生成后缓存下来的题 */
const BUILTIN_QUESTIONS: Question[] = [
  ...(PACK.packId === BUILTIN_ID ? (questionsJson as unknown as { questions: Question[] }).questions : [])
]
const currentQuestions = () => activeQuestions(PACK, [...BUILTIN_QUESTIONS, ...loadPlayableBank(PACK.packId)])
const KEY = stateKeyFor(PACK.packId)

function todayKey(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function defaultState(): AppState {
  return {
    settings: { dailyMinutes: 40, examDate: '', totalScore: PACK.totalScore, packId: PACK.packId },
    mastery: blankMastery(PACK.nodes),
    attempts: [],
    tasks: []
  }
}

/**
 * 存储层：优先 localStorage。
 * file:// 打开时浏览器可能禁用 localStorage，写失败不能让整个应用崩掉，
 * 所以退化成"内存里的状态"——功能全都能用，只是关掉页面不保留。
 */
let memoryState: AppState | null = null
let storageOk = true

function read(): AppState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return memoryState ?? defaultState()
    const s = JSON.parse(raw) as AppState
    for (const n of PACK.nodes) {
      if (!s.mastery[n.id]) s.mastery[n.id] = freshMastery(n.kind === 'root' ? 1 : 0)
    }
    // 旧存档迁移：早期版本只存了 n/nok，没有时间衰减的累加器。
    // 用 n/nok 作为初值，等价于"假设这些证据都是刚刚发生的"，
    // 之后每做一题都会按真实时间自然衰减，不会凭空丢分。
    for (const id of Object.keys(s.mastery)) {
      const m = s.mastery[id]
      if (m && typeof m.W !== 'number') {
        m.W = m.n ?? 0
        m.Aw = (m.nok ?? 0) * 1
      }
    }
    // v1 → v2：把自评/能力/保持/可信度拆开。幂等，重复执行不改任何数。
    for (const id of Object.keys(s.mastery)) s.mastery[id] = migrateMastery(s.mastery[id])
    restoreEvidenceClocks(s)
    s.schemaVersion = 2
    return s
  } catch {
    storageOk = false
    return memoryState ?? defaultState()
  }
}

function write(s: AppState): void {
  memoryState = s
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    storageOk = false
  }
}

export function storageHealthy(): boolean {
  return storageOk
}

function daysLeft(s: AppState, now: number): number {
  return daysUntil(s.settings.examDate, now)
}

function ensureToday(s: AppState, now: number, reason?: string, stepId?: string): Task[] {
  const before = s.path
  const today = todayFromPath(PACK, s, currentQuestions(), now, todayKey(now), reason, stepId)
  if (before !== s.path) write(s)
  return today
}

function overviewOf(s: AppState, now: number) {
  const cov = coverage(s, PACK.nodes)
  const effs = PACK.nodes
    .filter((n) => n.kind !== 'root')
    .map((n) => effective(s.mastery[n.id] ?? freshMastery(0), now).eff)
  const raw = effs.reduce((a, b) => a + b, 0) / Math.max(1, effs.length)
  const est = s.settings.totalScore * (0.55 + 0.45 * raw)
  return {
    coverage: cov,
    estimate: Math.round(est),
    band: Math.round(est * 0.09),
    daysLeft: daysLeft(s, now),
    todayKey: todayKey(now)
  }
}

export function createLocalApi() {
  return {
    async load(): Promise<LoadResult & { overview: ReturnType<typeof overviewOf> }> {
      const now = Date.now()
      const state = read()
      return { pack: PACK, questions: currentQuestions(), state, today: ensureToday(state, now), overview: overviewOf(state, now) }
    },

    async submit(payload: SubmitPayload): Promise<SubmitResult & { today: Task[]; overview: ReturnType<typeof overviewOf> }> {
      const now = Date.now()
      const state = read()
      const result = submitAnswer(state, currentQuestions(), payload, now, todayKey(now))
      write(state)
      return { ...result, today: ensureToday(state, now), overview: overviewOf(state, now) }
    },

    async completeTask(taskId: string) {
      const state = read()
      const t = state.tasks.find((x) => x.id === taskId)
      const now = Date.now()
      if (t) t.status = 'done'
      const today = ensureToday(state, now, '完成今日任务后检查路径', t?.stepId)
      write(state)
      return { state, today, overview: overviewOf(state, now) }
    },

    async postponeTask(taskId: string) {
      const state = read()
      const t = state.tasks.find((x) => x.id === taskId)
      if (t) t.status = 'postponed'
      write(state)
      return { state, today: ensureToday(state, Date.now()), overview: overviewOf(state, Date.now()) }
    },

    async learning(update: LearningUpdate) {
      const state = read()
      applyLearningUpdate(state, update)
      const now = Date.now()
      const today = ensureToday(state, now, update.kind === 'checkpoint' ? update.reason : undefined,
        update.kind === 'checkpoint' ? update.completedStep : undefined)
      write(state)
      return { state, today, overview: overviewOf(state, now) }
    },

    async rebuildQueue() {
      return this.learning({ kind: 'checkpoint', reason: '手动重新规划' })
    },

    async rate(nodeId: string, level: 0 | 1 | 2) {
      const state = read()
      const m = state.mastery[nodeId] ?? freshMastery(0)
      // v2：自评只是主观报告，不再顺手把能力改成 0.6
      const levelName = level === 0 ? 'none' : level === 1 ? 'weak' : 'basic'
      state.mastery[nodeId] = setSelfLevel(m, levelName, Date.now())
      write(state)
      const now = Date.now()
      return { state, today: ensureToday(state, now), overview: overviewOf(state, now) }
    },

    async check(questionId: string, answer: string) {
      const q = currentQuestions().find((x) => x.id === questionId)
      if (!q) throw new Error('题目不存在')
      return { correct: isCorrect(q, answer) }
    },

    async updateSettings(patch: Partial<AppState['settings']>) {
      const state = read()
      const s = state.settings
      if (typeof patch.dailyMinutes === 'number') {
        s.dailyMinutes = Math.max(10, Math.min(240, Math.round(patch.dailyMinutes)))
      }
      if (typeof patch.examDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patch.examDate)) {
        s.examDate = patch.examDate
      }
      if (typeof patch.totalScore === 'number' && patch.totalScore > 0) {
        s.totalScore = Math.round(patch.totalScore)
      }
      write(state)
      const now = Date.now()
      return { state, today: ensureToday(state, now, '更新今日时间预算'), overview: overviewOf(state, now) }
    }
  }
}
