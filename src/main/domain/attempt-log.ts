import type { AttemptRecord, AttemptTag, ErrorReason, Question, SelfConfidence } from '../../shared/types'

/**
 * 构造一条作答记录。
 *
 * 抽出来是为了两件事：
 *  1. 浏览器模式（local-api）和 Electron 模式（service）必须产出完全一样的记录结构，
 *     否则两套运行时会各自漂移；
 *  2. 这里要把"这道题影响到哪些考点"完整记下来。以前只存 nodePrimary，
 *     导致一道综合题推动了三个节点的分数，事后却只能查到主节点一个。
 */
export function buildAttemptRecord(input: {
  id: string
  question: Question
  primaryNodeId: string
  correct: boolean
  /** 疑似蒙对：3 秒内答对中高难度题 */
  guessed: boolean
  durationMs: number
  now: number
  selfConfidence: SelfConfidence
  errorReason: ErrorReason
}): AttemptRecord {
  const { question, correct, primaryNodeId } = input

  // 与掌握度更新用的是同一份 tag 列表和同一套权重规则（答错时次考点打三折）
  const tags: AttemptTag[] = question.tags.map((t) => {
    const primary = t.nodeId === primaryNodeId
    const w = primary || correct ? t.weight : t.weight * 0.3
    return { nodeId: t.nodeId, weight: w, primary }
  })

  return {
    id: input.id,
    questionId: question.id,
    nodePrimary: primaryNodeId,
    startedAt: input.now - input.durationMs,
    submittedAt: input.now,
    durationMs: input.durationMs,
    correct,
    selfConfidence: input.selfConfidence,
    guessed: input.guessed,
    errorReason: correct ? null : input.errorReason,
    tags
  }
}

/**
 * 一条记录影响到的全部考点。
 * 老记录没有 tags 字段，退回"只有主节点"，行为与升级前一致。
 */
export function nodesOfAttempt(a: AttemptRecord): AttemptTag[] {
  if (!Array.isArray(a.tags) || !a.tags.length) return [{ nodeId: a.nodePrimary, weight: 1, primary: true }]

  // 旧融合记录只给主考点字段加了前缀，使用该前缀对齐旧标签。
  const primary = a.tags.find((tag) => tag.primary)?.nodeId
  if (primary && a.nodePrimary.endsWith(primary)) {
    const prefix = a.nodePrimary.slice(0, -primary.length)
    if (/^(?:m\d+_)+$/.test(prefix)) return a.tags.map((tag) => ({ ...tag, nodeId: prefix + tag.nodeId }))
  }
  return a.tags
}

export function primaryAttemptNode(a: AttemptRecord): string | undefined {
  return nodesOfAttempt(a).find((tag) => tag.primary)?.nodeId
}
