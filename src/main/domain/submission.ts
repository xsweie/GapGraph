import type { AppState, Question, SubmitPayload, SubmitResult } from '../../shared/types'
import { applyAttempt, band, freshMastery, masteryScore } from '../../shared/mastery'
import { buildAttemptRecord } from './attempt-log'
import { isCorrect } from './grading'
import { trackTaskTime } from './learning-state'
import { applyDiagAnswer } from './diagnostic'

export function submitAnswer(state: AppState, questions: Question[], payload: SubmitPayload, now: number, date: string): SubmitResult {
  const q = questions.find((item) => item.id === payload.questionId)
  const primary = q && (q.tags.find((tag) => tag.primary) ?? q.tags[0])
  if (!q || !primary) throw new Error('题目不存在或考点已归档。')
  const old = payload.submissionId && state.attempts.find((a) => a.id === payload.submissionId)
  if (old && old.questionId !== q.id) throw new Error('提交标识与题目不一致。')
  const correct = old ? old.correct : isCorrect(q, payload.answer)
  const guessed = old ? old.guessed : correct && payload.durationMs < 3000 && q.difficulty >= 3
  const before = state.mastery[primary.nodeId] ?? freshMastery(0)

  if (!old) {
    for (const tag of q.tags) {
      state.mastery[tag.nodeId] = applyAttempt(state.mastery[tag.nodeId] ?? freshMastery(0), {
        difficulty: q.difficulty, correct, guessed, now,
        weight: tag.primary || correct ? tag.weight : tag.weight * 0.3,
        sure: payload.selfConfidence === 'sure', errorReason: correct ? null : payload.errorReason
      })
    }
    state.attempts.push(buildAttemptRecord({
      id: payload.submissionId ?? 'a_' + now + '_' + Math.random().toString(36).slice(2),
      question: q, primaryNodeId: primary.nodeId, correct, guessed, durationMs: payload.durationMs,
      now, selfConfidence: payload.selfConfidence, errorReason: payload.errorReason
    }))
    trackTaskTime(state, payload.taskId, payload.durationMs, date)
    if (payload.diagnostic && state.diagnostic && !state.diagnostic.finished) {
      state.diagnostic = applyDiagAnswer(state.diagnostic, q.id, primary.nodeId, correct, guessed)
    }
  }

  const after = state.mastery[primary.nodeId] ?? before
  return {
    correct, guessed, nodeId: primary.nodeId, state, solution: q.solution,
    before: masteryScore(before, now), after: masteryScore(after, now),
    beforeBand: band(before, now), afterBand: band(after, now)
  }
}
