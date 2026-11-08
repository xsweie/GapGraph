import type { AppState, LearningUpdate, Pack, Question } from '../../shared/types'
import { checkpoint, packRevision } from './learning'
import { buildToday } from './queue'
import { nodesOfAttempt } from './attempt-log'

export function applyLearningUpdate(state: AppState, update: LearningUpdate): void {
  if (update.kind === 'diagnostic') state.diagnostic = update.round
  if (update.kind === 'signal') state.signals = [...(state.signals ?? []), update.signal].slice(-500)
}

export function todayFromPath(pack: Pack, state: AppState, questions: Question[], now: number, date: string, reason?: string, stepId?: string) {
  const previous = state.path
  const changedGraph = previous?.revision !== packRevision(pack) || previous?.packId !== pack.packId
  const newDay = previous && new Date(previous.checkedAt).toDateString() !== new Date(now).toDateString()
  if (changedGraph || newDay || reason) {
    state.path = checkpoint(pack, state, now, reason ?? (previous ? changedGraph ? '范围或知识网已调整' : '新一天，重新检查复习时间' : '按当前范围生成初步路径'), stepId)
    const tasks = buildToday({
      nodes: pack.nodes, questions, mastery: state.mastery, now, date,
      dailyMinutes: state.settings.dailyMinutes, daysLeft: Infinity, path: state.path, previous: state.tasks
    })
    state.tasks = [...state.tasks.filter((t) => t.date !== date), ...tasks]
  }
  const active = new Set(pack.nodes.map((node) => node.id))
  return state.tasks.filter((t) => t.date === date && t.status !== 'postponed' && active.has(t.nodeId)).sort((a, b) => a.sortOrder - b.sortOrder)
}

export function trackTaskTime(state: AppState, taskId: string | undefined, durationMs: number, date: string): void {
  const task = state.tasks.find((t) => t.id === taskId && t.date === date && t.status === 'pending')
  if (task && Number.isFinite(durationMs)) task.spentMinutes = (task.spentMinutes ?? 0) + Math.max(0, durationMs / 60000)
}

export function activeQuestions(pack: Pack, questions: Question[]): Question[] {
  const ids = new Set(pack.nodes.filter((n) => n.kind !== 'root').map((n) => n.id))
  return questions.filter((q) => q.tags.length && q.tags.every((tag) => ids.has(tag.nodeId)))
}

/** Old builds refreshed lastAt on guesses. Reconcile only timestamps that match that old write. */
export function restoreEvidenceClocks(state: AppState): void {
  const guessedClock = new Set<string>()
  const validClock = new Map<string, number>()
  for (const attempt of state.attempts) for (const tag of nodesOfAttempt(attempt)) {
    if (attempt.guessed && state.mastery[tag.nodeId]?.lastAt === attempt.submittedAt) guessedClock.add(tag.nodeId)
    if (!attempt.guessed) validClock.set(tag.nodeId, Math.max(validClock.get(tag.nodeId) ?? 0, attempt.submittedAt))
  }
  for (const id of guessedClock) state.mastery[id].lastAt = validClock.get(id) ?? null
}
