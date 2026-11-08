import type { AppState, KNode, LearningPath, Mastery, Question, Task } from '../../shared/types'
import { dueUrgency, isDue, retention, freshMastery } from './mastery'
import { questionsForNode, rankGaps } from './priority'

export interface BuildQueueArgs {
  nodes: KNode[]
  questions: Question[]
  mastery: Record<string, Mastery>
  now: number
  dailyMinutes: number
  daysLeft: number
  date: string
  path?: LearningPath
  previous?: Task[]
}

const REVIEW_MINUTES = 8
const GAP_MINUTES = 13
/** 诊断卡比补救卡轻一点：只是摸底，不该占满预算 */
const DIAGNOSE_MINUTES = 10
const MAX_CARDS = 3

/**
 * 今日队列：到期复习 1–2 张 + 缺口补救 1 张（+ 新学 0–1 张，v0.1 不开）。
 * 硬规矩：总时长不超过用户设定，装不下就少给 —— 宁可少给，也不能给到想卸载。
 */
export function buildToday(args: BuildQueueArgs): Task[] {
  if (args.path) return buildPathToday(args, args.path)
  const { nodes, questions, mastery, now, dailyMinutes, daysLeft, date } = args
  const tasks: Task[] = []
  const used = new Set<string>()

  /* 1) 到期复习：按遗忘紧急度排序 */
  const due = nodes
    .filter((n) => n.kind !== 'root')
    .map((n) => ({ n, m: mastery[n.id] }))
    .filter((x): x is { n: KNode; m: Mastery } => !!x.m && isDue(x.m, now))
    .sort((a, b) => dueUrgency(b.m, now) - dueUrgency(a.m, now))

  for (const item of due.slice(0, 2)) {
    const qs = questionsForNode(item.n.id, questions).slice(0, 3)
    if (qs.length === 0) continue
    tasks.push({
      id: `${date}-review-${item.n.id}`,
      date,
      kind: 'review',
      nodeId: item.n.id,
      questionIds: qs.map((q) => q.id),
      estMinutes: REVIEW_MINUTES,
      status: 'pending',
      sortOrder: tasks.length
    })
    used.add(item.n.id)
  }

  /* 2) 缺口补救 / 待诊断：优先级最高的那个（跳过已排的）
   *
   * 这里区分两种卡：
   *   known=false → 'diagnose'：还没测过，先摸个底，不预设"你不会"
   *   known=true  → 'gap'     ：测出来确实是洞，做补救
   * 任务书 B8：未知节点应该优先"是否需要诊断"，而不是直接当成不会。
   */
  const ranked = rankGaps(nodes, mastery, { now, rush: daysLeft <= 30 })
  for (const g of ranked) {
    if (used.has(g.node.id)) continue
    if (g.node.kind === 'root') continue
    if (g.reason === 'solid') continue
    const qs = questionsForNode(g.node.id, questions).slice(0, 3)
    if (qs.length === 0) continue
    const diagnose = g.reason === 'diagnose'
    tasks.push({
      id: `${date}-${diagnose ? 'diag1' : 'gap'}-${g.node.id}`,
      date,
      kind: diagnose ? 'diagnose' : 'gap',
      nodeId: g.node.id,
      questionIds: qs.map((q) => q.id),
      estMinutes: diagnose ? DIAGNOSE_MINUTES : GAP_MINUTES,
      status: 'pending',
      sortOrder: tasks.length
    })
    used.add(g.node.id)
    break
  }

  /* 3) 预算装箱：超了就砍尾巴 */
  const out: Task[] = []
  let spent = 0
  for (const t of tasks.slice(0, MAX_CARDS)) {
    if (spent + t.estMinutes > dailyMinutes) break
    spent += t.estMinutes
    out.push(t)
  }

  /* 4) 太少就补一个轻动作，避免"今天没事干" */
  if (out.length === 0) {
    const fallback = ranked.find((g) => !used.has(g.node.id) && g.node.kind !== 'root')
    if (fallback && dailyMinutes >= 4) {
      const qs = questionsForNode(fallback.node.id, questions).slice(0, 1)
      if (qs.length) {
        out.push({
          id: `${date}-${fallback.reason === 'diagnose' ? 'diag1' : 'gap'}-${fallback.node.id}`,
          date,
          kind: fallback.reason === 'diagnose' ? 'diagnose' : 'gap',
          nodeId: fallback.node.id,
          questionIds: qs.map((q) => q.id),
          estMinutes: 4,
          status: 'pending',
          sortOrder: 0
        })
      }
    }
  }

  return out
}

function buildPathToday(args: BuildQueueArgs, path: LearningPath): Task[] {
  const previous = (args.previous ?? []).filter((t) => t.date === args.date)
  const retained = previous.filter((t) => t.status !== 'pending' || (t.spentMinutes ?? 0) > 0)
  const tasks = retained.filter((t) => t.status === 'done')
  let budget = args.dailyMinutes - retained.reduce((sum, t) => sum + (t.spentMinutes ?? (t.status === 'done' ? t.estMinutes : 0)), 0)
  let reviews = tasks.filter((t) => t.kind === 'review').length
  for (const step of path.steps) {
    if (tasks.length >= MAX_CARDS) break
    if (step.done || step.invalid || step.blockedBy.length || (step.action === 'review' && reviews >= 2)) continue
    const id = `${args.date}-${step.action === 'diagnose' ? 'diag1' : step.action}-${step.nodeId}`
    const prior = previous.find((t) => t.id === id)
    if (prior && prior.status !== 'pending') continue
    const qs = args.questions.filter((q) => (q.tags.find((t) => t.primary) ?? q.tags[0])?.nodeId === step.nodeId)
    const standard = step.action === 'review' ? REVIEW_MINUTES : step.action === 'gap' ? GAP_MINUTES : DIAGNOSE_MINUTES
    const cost = budget >= standard ? standard : budget >= 4 ? 4 : 0
    if (!cost) continue
    budget -= cost
    if (step.action === 'review') reviews++
    tasks.push({
      id, date: args.date, kind: step.action, nodeId: step.nodeId, stepId: step.id,
      questionIds: qs.slice(0, cost === 4 ? 1 : 3).map((q) => q.id), estMinutes: cost,
      spentMinutes: prior?.spentMinutes, status: 'pending', sortOrder: tasks.length
    })
  }
  // A postponed card still prevents the same action being recreated today.
  return [...tasks, ...retained.filter((t) => t.status !== 'done' && !tasks.some((task) => task.id === t.id))
    .map((t): Task => ({ ...t, status: 'postponed' }))]
}

/** 新建状态时给所有考点铺一层默认掌握（根节点只是容器，不参与评估） */
export function blankMastery(nodes: KNode[]): Record<string, Mastery> {
  const out: Record<string, Mastery> = {}
  for (const n of nodes) out[n.id] = freshMastery(0)
  return out
}

export function coverage(state: AppState, nodes: KNode[]): { measured: number; total: number } {
  const total = nodes.filter((n) => n.kind !== 'root').length
  const measured = nodes.filter((n) => n.kind !== 'root' && (state.mastery[n.id]?.n ?? 0) > 0).length
  return { measured, total }
}

export function daysUntil(examDate: string, now: number): number {
  const t = new Date(examDate + 'T00:00:00').getTime()
  if (Number.isNaN(t)) return 999
  return Math.max(0, Math.round((t - now) / 86_400_000))
}

/** 供界面显示：最近一次保持率，用来解释"为什么它到期了" */
export function retentionOf(m: Mastery, now: number): number {
  return retention(m, now)
}
