import type { DiagnosticRound, KNode, Mastery, Question } from '../../shared/types'
import { band, masteryScore } from '../../shared/mastery'
import { primaryBranch } from './learning'

export const DIAG_TARGET = 10
/** 少于这个数不做结论 */
export const DIAG_MIN = 6

export type DiagState = DiagnosticRound

export function createDiagnostic(): DiagState {
  return { askedIds: [], answered: [], targetDifficulty: 2 }
}

export function primaryNodeOf(q: Question): string | null {
  const t = q.tags.find((x) => x.primary) ?? q.tags[0]
  return t?.nodeId ?? null
}

/**
 * 挑下一题：
 * 1) 优先覆盖还没测过的考点（摸底的意义在于"铺开"，不是"刷满一个点"）
 * 2) 上一题答错了，就往它的前置考点下钻 —— 这是"你错在根上"的来源
 * 3) 难度向 targetDifficulty 收敛
 */
export function nextQuestion(
  state: DiagState,
  questions: Question[],
  nodes: KNode[],
  mastery: Record<string, Mastery>
): Question | null {
  if (state.askedIds.length >= DIAG_TARGET || diagnosticCoverage(state, nodes).ready) return null

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const covered = new Set(state.answered.filter((a) => !a.guessed).map((a) => a.nodeId))
  const branches = new Set([...covered].map((id) => primaryBranch(id, nodes)))
  const lastWrong = [...state.answered].reverse().find((a) => !a.correct)
  const drill = new Set(lastWrong ? (byId.get(lastWrong.nodeId)?.prereq ?? []) : [])

  let best: { q: Question; score: number } | null = null
  for (const q of questions) {
    if (state.askedIds.includes(q.id)) continue
    const nodeId = primaryNodeOf(q)
    if (!nodeId) continue
    const node = byId.get(nodeId)
    if (!node) continue

    let score = 0
    if (!branches.has(primaryBranch(nodeId, nodes))) score += 12
    if (!covered.has(nodeId)) score += 3
    if (drill.has(nodeId)) score += 4
    score += 2 * node.examWeight
    score -= 1.6 * Math.abs(q.difficulty - state.targetDifficulty)
    const m = mastery[nodeId]
    if (m && m.n >= 2) score -= 2

    if (!best || score > best.score) best = { q, score }
  }
  return best?.q ?? null
}

export function applyDiagAnswer(
  state: DiagState,
  questionId: string,
  nodeId: string,
  correct: boolean,
  guessed = false
): DiagState {
  if (state.askedIds.includes(questionId) || state.askedIds.length >= DIAG_TARGET) return state
  return {
    ...state,
    askedIds: [...state.askedIds, questionId],
    answered: [...state.answered, { questionId, nodeId, correct, guessed }],
    targetDifficulty: guessed ? state.targetDifficulty : correct
      ? Math.min(5, state.targetDifficulty + 1)
      : Math.max(1, state.targetDifficulty - 1)
  }
}

export function diagnosticCoverage(state: DiagState, nodes: KNode[]) {
  const valid = new Set(nodes.filter((n) => n.kind !== 'root').map((n) => n.id))
  const effective = state.answered.filter((a) => !a.guessed && valid.has(a.nodeId))
  const distinct = new Set(effective.map((a) => a.questionId)).size
  const covered = new Set(effective.map((a) => primaryBranch(a.nodeId, nodes)).filter(Boolean)).size
  const root = nodes.find((n) => n.kind === 'root')
  const branches = nodes.filter((n) => n.parentId === root?.id).length
  return { effective: distinct, covered, branches, required: Math.min(3, branches), ready: distinct >= DIAG_MIN && covered >= Math.min(3, branches) }
}

export interface DiagSummary {
  progress: ReturnType<typeof diagnosticCoverage>
  answered: number
  touched: number
  /** 摸底结束时的分档统计；self/unmeasured 不会出现（这些节点都答过题） */
  bands: { red: number; orange: number; yellow: number; green: number; self: number }
  weakest: { id: string; name: string; score: number }[]
}

/** 摸底结果：只说三件事 —— 测了多少、塌了几处、最薄的是谁 */
export function summarize(
  state: DiagState,
  nodes: KNode[],
  mastery: Record<string, Mastery>,
  now: number
): DiagSummary {
  const touchedIds = [...new Set(state.answered.filter((a) => !a.guessed).map((a) => a.nodeId))]
  const bands = { red: 0, orange: 0, yellow: 0, green: 0, self: 0 }
  const scored: { id: string; name: string; score: number }[] = []

  for (const id of touchedIds) {
    const m = mastery[id]
    if (!m || m.n === 0) continue
    const b = band(m, now)
    // 摸完底的节点都答过题，理论上不会落在这两档；保险起见跳过而不是崩掉
    if (b === 'unmeasured' || b === 'self') continue
    bands[b] += 1
    scored.push({ id, name: nodes.find((n) => n.id === id)?.name ?? id, score: masteryScore(m, now) })
  }

  scored.sort((a, b) => a.score - b.score)

  return {
    progress: diagnosticCoverage(state, nodes),
    answered: state.answered.length,
    touched: touchedIds.length,
    bands,
    weakest: scored.slice(0, 3)
  }
}
