import type { AppState, KNode, LearningPath, Mastery, Pack, PathStep } from '../../shared/types'
import { DAY, effective, evidenceOf, freshMastery, isDue } from '../../shared/mastery'
import { gapPriority } from './priority'
import { primaryAttemptNode } from './attempt-log'

/** 首版产品默认值。只有不同的有效主考点题能通过证据门槛。 */
export const EVIDENCE_MIN = 2
export const EVIDENCE_DAYS = 30
export const PRACTICE_CHECK_MIN = 3

export function newEffectiveSince(attempts: AppState['attempts'], since: number): number {
  const first = new Map<string, number>()
  for (const attempt of attempts) {
    if (attempt.guessed || !primaryAttemptNode(attempt)) continue
    first.set(attempt.questionId, Math.min(first.get(attempt.questionId) ?? Infinity, attempt.submittedAt))
  }
  return [...first.values()].filter((at) => at > since).length
}

export function packRevision(pack: Pack): string {
  return pack.revision ?? 'base'
}

export function assessNode(state: Pick<AppState, 'mastery' | 'attempts'>, nodeId: string, now: number) {
  const m: Mastery = state.mastery[nodeId] ?? freshMastery(0)
  const latest = new Map<string, typeof state.attempts[number]>()
  for (const a of state.attempts) {
    if (a.guessed || primaryAttemptNode(a) !== nodeId) continue
    const old = latest.get(a.questionId)
    if (!old || old.submittedAt <= a.submittedAt) latest.set(a.questionId, a)
  }
  const recent = [...latest.values()].filter((a) => now - a.submittedAt <= EVIDENCE_DAYS * DAY)
  const correct = recent.filter((a) => a.correct).length
  const raw = effective(m, now)
  const due = isDue(m, now)
  const label = recent.length < EVIDENCE_MIN
    ? latest.size >= EVIDENCE_MIN ? '证据过旧' : raw.known || latest.size ? '初步证据' : evidenceOf(m) === 'self' ? '仅自评' : '未知'
    : correct > 0 && correct < recent.length && Math.abs(correct / recent.length - 0.5) < 0.26
      ? '证据冲突'
      : correct / recent.length >= 0.75 && raw.M >= 0.6 ? '稳定' : '有依据的缺口'
  const action: PathStep['action'] | null = label === '稳定' ? due ? 'review' : null
    : label === '有依据的缺口' ? 'gap' : 'diagnose'
  return { label, action, due, evidence: label + ' · ' + recent.length + ' 道近期有效主考点题', raw }
}

/** 前置字段是硬依赖，关系表只补理由。旧图中的坏引用只阻塞受影响的分支。 */
export function makePath(pack: Pack, state: AppState, now: number): PathStep[] {
  const nodes = pack.nodes.filter((n) => n.kind !== 'root')
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const assessments = new Map(nodes.map((n) => [n.id, assessNode(state, n.id, now)]))
  const dependents = new Map<string, string[]>()
  for (const node of nodes) for (const id of new Set(node.prereq)) {
    dependents.set(id, [...(dependents.get(id) ?? []), node.id])
  }
  const faults = new Map<string, boolean>()
  function hasFault(id: string, visiting: Set<string>): boolean {
    const known = faults.get(id)
    if (known !== undefined) return known
    const node = byId.get(id)
    if (!node || visiting.has(id)) return true
    visiting.add(id)
    const bad = node.prereq.some((p) => hasFault(p, visiting))
    visiting.delete(id)
    faults.set(id, bad)
    return bad
  }

  const candidates = nodes.flatMap((node) => {
    const a = assessments.get(node.id)!
    const invalid = hasFault(node.id, new Set())
    const confusion = (state.signals ?? []).filter((s) => s.nodeId === node.id && s.kind === 'confusion' && now - s.at <= 7 * DAY).length
    const action = a.action ?? (invalid || confusion >= 2 ? 'diagnose' : null)
    if (!action) return []
    const prerequisites = [...new Set(node.prereq)]
    const blockedBy = prerequisites.filter((id) => assessments.get(id)?.label !== '稳定' || faults.get(id))
    const downstream = dependents.get(node.id) ?? []
    const related = node.scopeIds?.some((id) => pack.scope?.include.some((item) => item.id === id))
    const explanation = action === 'review' ? '稳定且已到复习时间'
      : action === 'gap' ? '有效证据支持先补习再练习'
        : confusion ? '已主动标记困惑，建议定点检测' : '需要有效主考点题验证'
    const reason = invalid ? '前置引用异常或形成循环，需先修正结构'
      : blockedBy.length ? '等待 ' + blockedBy.map((id) => byId.get(id)?.name ?? id).join('、')
        : downstream.length ? '影响 ' + downstream.map((id) => byId.get(id)?.name ?? id).join('、') + '，' + explanation
          : explanation
    const step: PathStep = {
      id: action + ':' + node.id, nodeId: node.id, action, prerequisites, blockedBy,
      dependents: downstream, evidence: a.evidence, reason, invalid
    }
    const rank = gapPriority(node, state.mastery[node.id] ?? freshMastery(0), [], { now, rush: false }) +
      node.examWeight * 0.3 + (related ? 0.25 : 0) + downstream.length * 0.6 +
      (action === 'diagnose' ? Math.min(confusion, 3) * 0.4 + (1 - a.raw.conf) * 0.15 : 0) +
      (action === 'review' ? 0.45 + (1 - a.raw.retention) * 0.3 : 0)
    return [{ step, rank }]
  })
  candidates.sort((a, b) => b.rank - a.rank || a.step.id.localeCompare(b.step.id))

  const ordered: PathStep[] = []
  const placed = new Set<string>()
  const pending = candidates.filter((c) => !c.step.invalid)
  while (pending.length) {
    const index = pending.findIndex(({ step }) => step.blockedBy.every((id) => placed.has(id)))
    if (index < 0) break
    const [{ step }] = pending.splice(index, 1)
    placed.add(step.nodeId)
    ordered.push(step)
  }
  return [...ordered, ...pending.map((c) => c.step), ...candidates.filter((c) => c.step.invalid).map((c) => c.step)]
}

export function samePath(a: PathStep[], b: PathStep[]): boolean {
  const key = (steps: PathStep[]) => JSON.stringify(steps.filter((s) => !s.done).map((s) => [s.id, s.prerequisites, s.blockedBy, s.invalid]))
  return key(a) === key(b)
}

export function checkpoint(pack: Pack, state: AppState, now: number, reason: string, completedStep?: string): LearningPath {
  const previous = state.path?.packId === pack.packId ? state.path : undefined
  const revision = packRevision(pack)
  const active = makePath(pack, state, now)
  const activeIds = new Set(pack.nodes.map((n) => n.id))
  const date = new Date(now).toDateString()
  const completed = new Map((previous?.steps ?? [])
    .filter((s) => activeIds.has(s.nodeId) && (s.id === completedStep ||
      (s.done && new Date(previous!.checkedAt).toDateString() === date && previous!.revision === revision)))
    .map((s) => [s.id, { ...s, done: true }]))
  const steps = [...active.filter((s) => !completed.has(s.id)), ...completed.values()]
  const changed = !previous || previous.revision !== revision || !samePath(previous.steps, steps)
  return {
    packId: pack.packId, revision, version: (previous?.version ?? 0) + Number(changed),
    steps, checkedAt: now, reason: changed ? reason : previous?.reason ?? reason
  }
}

export function primaryBranch(nodeId: string, nodes: KNode[]): string | null {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  let node = byId.get(nodeId)
  while (node?.parentId && !seen.has(node.id)) {
    seen.add(node.id)
    const parent = byId.get(node.parentId)
    if (parent?.kind === 'root') return node.id
    node = parent
  }
  return null
}
