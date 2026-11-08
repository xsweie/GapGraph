import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppState, LearningUpdate, LoadResult, Pack, Question, SubmitPayload, SubmitResult, Task } from '../shared/types'
import { DAY, effective, freshMastery, migrateMastery, setSelfLevel } from './domain/mastery'
import { blankMastery, coverage, daysUntil } from './domain/queue'
import { isCorrect } from './domain/grading'
import { applyLearningUpdate, restoreEvidenceClocks, todayFromPath } from './domain/learning-state'
import { submitAnswer } from './domain/submission'
import { alignGraph } from './domain/scope'

interface QuestionBank {
  packId: string
  questions: Question[]
}

function resourceRoot(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const direct = join(base, 'resources')
  return existsSync(direct) ? direct : join(process.cwd(), 'resources')
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function todayKey(now: number): string {
  const d = new Date(now)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export class Service {
  pack!: Pack
  questions: Question[] = []
  private state!: AppState
  private file = ''

  constructor() {
    const root = resourceRoot()
    this.pack = alignGraph(readJson<Pack>(join(root, 'packs', 'gaokao-math-function.json')))
    const bank = readJson<QuestionBank>(join(root, 'questions', 'gaokao-math-function.json'))
    this.questions = bank.questions

    const dir = join(app.getPath('userData'), 'data')
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'state.json')
    this.state = this.loadState()
  }

  private defaultState(): AppState {
    return {
      settings: {
        dailyMinutes: 40,
        examDate: '',
        totalScore: this.pack.totalScore,
        packId: this.pack.packId
      },
      mastery: blankMastery(this.pack.nodes),
      attempts: [],
      tasks: []
    }
  }

  private loadState(): AppState {
    if (!existsSync(this.file)) return this.defaultState()
    try {
      const s = readJson<AppState>(this.file)
      // 补全新增节点，避免升级后出现空洞
      for (const n of this.pack.nodes) {
        if (!s.mastery[n.id]) s.mastery[n.id] = freshMastery(n.kind === 'root' ? 1 : 0)
      }
      // v1 → v2 迁移：把自评/能力/保持/可信度拆开。幂等，重复执行不改任何数。
      for (const id of Object.keys(s.mastery)) s.mastery[id] = migrateMastery(s.mastery[id])
      restoreEvidenceClocks(s)
      s.schemaVersion = 2
      return s
    } catch {
      return this.defaultState()
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8')
  }

  private daysLeft(now: number): number {
    return daysUntil(this.state.settings.examDate, now)
  }

  today(now = Date.now(), reason?: string, stepId?: string): Task[] {
    const before = this.state.path
    const tasks = todayFromPath(this.pack, this.state, this.questions, now, todayKey(now), reason, stepId)
    if (before !== this.state.path) this.save()
    return tasks
  }

  rebuild(): Task[] {
    return this.today(Date.now(), '手动重新规划')
  }

  learning(update: LearningUpdate) {
    applyLearningUpdate(this.state, update)
    const today = this.today(Date.now(), update.kind === 'checkpoint' ? update.reason : undefined,
      update.kind === 'checkpoint' ? update.completedStep : undefined)
    this.save()
    return { state: this.state, today, overview: this.overview() }
  }

  load(): LoadResult {
    const now = Date.now()
    return {
      pack: this.pack,
      questions: this.questions,
      state: this.state,
      today: this.today(now)
    }
  }

  submit(payload: SubmitPayload): SubmitResult {
    const now = Date.now()
    const result = submitAnswer(this.state, this.questions, payload, now, todayKey(now))
    this.save()
    return result
  }

  completeTask(taskId: string): { state: AppState; today: Task[] } {
    const t = this.state.tasks.find((x) => x.id === taskId)
    if (t) t.status = 'done'
    const today = this.today(Date.now(), '完成今日任务后检查路径', t?.stepId)
    this.save()
    return { state: this.state, today }
  }

  postponeTask(taskId: string): { state: AppState; today: Task[] } {
    const t = this.state.tasks.find((x) => x.id === taskId)
    if (t) t.status = 'postponed'
    this.save()
    return { state: this.state, today: this.today() }
  }

  /** 只判对错，不改任何状态 —— 让界面能在落库前先问错因 */
  check(questionId: string, answer: string): { correct: boolean } {
    const q = this.questions.find((x) => x.id === questionId)
    if (!q) throw new Error(`题目不存在: ${questionId}`)
    return { correct: isCorrect(q, answer) }
  }

  updateSettings(patch: Partial<AppState['settings']>): { state: AppState; today: Task[]; overview: ReturnType<Service['overview']> } {
    const s = this.state.settings
    if (typeof patch.dailyMinutes === 'number') {
      s.dailyMinutes = Math.max(10, Math.min(240, Math.round(patch.dailyMinutes)))
    }
    if (typeof patch.examDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patch.examDate)) {
      s.examDate = patch.examDate
    }
    if (typeof patch.totalScore === 'number' && patch.totalScore > 0) {
      s.totalScore = Math.round(patch.totalScore)
    }
    this.save()
    const today = this.today(Date.now(), '更新今日时间预算')
    return { state: this.state, today, overview: this.overview() }
  }

  /** 三档自评：没学过 0 / 学过不会 0.5 / 会 1（"会"也只给 0.6 分，余量留给证据） */
  rate(nodeId: string, level: 0 | 1 | 2): AppState {
    const m = this.state.mastery[nodeId] ?? freshMastery(0)
    // v2：自评只是主观报告，**不再**顺手把能力改成 0.6
    const levelName = level === 0 ? 'none' : level === 1 ? 'weak' : 'basic'
    this.state.mastery[nodeId] = setSelfLevel(m, levelName, Date.now())
    this.save()
    return this.state
  }

  overview() {
    const now = Date.now()
    const cov = coverage(this.state, this.pack.nodes)
    const effs = this.pack.nodes
      .filter((n) => n.kind !== 'root')
      .map((n) => effective(this.state.mastery[n.id] ?? freshMastery(0), now).eff)
    const raw = effs.reduce((a, b) => a + b, 0) / Math.max(1, effs.length)
    const est = this.state.settings.totalScore * (0.55 + 0.45 * raw)
    const band = est * 0.09
    return {
      coverage: cov,
      estimate: Math.round(est),
      band: Math.round(band),
      daysLeft: this.daysLeft(now),
      todayKey: todayKey(now),
      staleAfterDays: DAY
    }
  }
}
