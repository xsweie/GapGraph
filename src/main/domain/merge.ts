import type { AttemptRecord, KNode, Mastery, Pack, Question, Relation } from '../../shared/types'
import { freshMastery } from '../../shared/mastery'
import { nodesOfAttempt } from './attempt-log'

/**
 * 板块融合。
 *
 * 两章同属一个学科时，单独练永远看不到"它们互相怎么干扰"；
 * 合成一张图之后，易混关系和前置关系才能跨章成立。
 *
 * 但融合有个硬边界：**不同学科的板块绝不能合**。
 * 数学的函数和化学的加成反应合在一起，出题时上下文就会互相污染，
 * 学生看到的是一张没有意义的杂图。所以 canMerge 先做学科闸门。
 */

export interface MergeSource {
  pack: Pack
  questions: Question[]
  mastery: Record<string, Mastery>
  attempts: AttemptRecord[]
}

export interface MergeResult {
  pack: Pack
  questions: Question[]
  mastery: Record<string, Mastery>
  attempts: AttemptRecord[]
  warnings: string[]
}

function examOf(p: Pack): string {
  return (p.meta?.exam ?? '').trim()
}
export function packSubject(p: Pack): string {
  return p.scope?.subject?.trim() || p.meta?.subject?.trim() || p.subject?.trim() || ''
}
function chapterOf(p: Pack): string {
  return p.meta?.chapter?.trim() || p.title.trim()
}

/** 学科必须相同，已填写的考试信息须一致。 */
export function canMerge(packs: Pack[]): { ok: boolean; reason?: string } {
  if (packs.length < 2) return { ok: false, reason: '至少选两个板块' }
  if (packs.length > 4) return { ok: false, reason: '最多一次融合 4 个板块' }

  const missing = packs.find((p) => !packSubject(p))
  if (missing) {
    return { ok: false, reason: `「${missing.title}」缺少学科信息，请在「范围与结构」填写学科` }
  }

  const subject = packSubject(packs[0])
  const bad = packs.find((p) => packSubject(p) !== subject)
  if (bad) {
    return { ok: false, reason: `「${subject}」和「${packSubject(bad)}」不是同一学科，不能融合` }
  }
  const exams = new Set(packs.map(examOf).filter(Boolean))
  if (exams.size > 1) return { ok: false, reason: `所选板块属于不同考试（${[...exams].join('、')}），不能融合` }
  return { ok: true }
}

/** 重映射表：老 id → 新 id */
function prefixOf(index: number): string {
  return `m${index}_`
}

export function mergeSources(sources: MergeSource[], newTitle: string): MergeResult {
  const gate = canMerge(sources.map((s) => s.pack))
  if (!gate.ok) throw new Error(gate.reason ?? '不能融合')

  const title = newTitle.trim() || '融合板块'
  const first = sources[0].pack
  const warnings: string[] = []

  const rootId = 'mroot'
  const nodes: KNode[] = [
    {
      id: rootId,
      name: title,
      parentId: null,
      kind: 'root',
      examWeight: 1,
      prereq: [],
      confusable: [],
      brief: `由 ${sources.length} 个章节融合：${sources.map((s) => chapterOf(s.pack)).join(' + ')}`
    }
  ]
  const relations: Relation[] = []
  const questions: Question[] = []
  const mastery: Record<string, Mastery> = { [rootId]: freshMastery(1) }
  const attempts: AttemptRecord[] = []

  sources.forEach((src, index) => {
    const pfx = prefixOf(index)
    const chapter = chapterOf(src.pack)
    const idMap = new Map<string, string>()
    for (const n of src.pack.nodes) idMap.set(n.id, pfx + n.id)

    // 源根节点降级成"这一章的总览"，挂到融合根下面
    for (const n of src.pack.nodes) {
      const isRoot = n.kind === 'root' || n.parentId === null
      const mapped: KNode = {
        ...n,
        id: pfx + n.id,
        parentId: n.parentId ? (idMap.get(n.parentId) ?? rootId) : rootId,
        kind: isRoot ? 'concept' : n.kind,
        prereq: [],
        confusable: [],
        scopeIds: undefined,
        origin: n.origin ?? chapter
      }
      if (isRoot) mapped.name = chapter
      nodes.push(mapped)
    }

    // 关系重映射（引用不存在的就丢掉）
    const remapRef = (id: string): string | null => idMap.get(id) ?? null
    for (const n of src.pack.nodes) {
      const target = nodes.find((x) => x.id === idMap.get(n.id))
      if (!target) continue
      target.prereq = n.prereq.map(remapRef).filter((x): x is string => !!x)
      target.confusable = n.confusable.map(remapRef).filter((x): x is string => !!x)
    }
    for (const r of src.pack.relations ?? []) {
      const a = remapRef(r.a)
      const b = remapRef(r.b)
      if (a && b) relations.push({ ...r, a, b })
    }

    // 题目：id 也要加前缀，否则两个板块的 q001 会撞
    for (const q of src.questions) {
      questions.push({
        ...q,
        id: `${pfx}${q.id}`,
        tags: q.tags
          .map((t) => ({ ...t, nodeId: remapRef(t.nodeId) }))
          .filter((t): t is Question['tags'][number] => !!t.nodeId)
      })
    }

    // 学习记录：掌握度与作答历史一起搬，否则融合完颜色全丢
    for (const [oldId, m] of Object.entries(src.mastery)) {
      const newId = remapRef(oldId)
      if (newId) mastery[newId] = { ...m }
    }
    for (const a of src.attempts) {
      const np = remapRef(a.nodePrimary)
      if (!np) continue
      attempts.push({
        ...a,
        id: `${pfx}${a.id}`,
        questionId: `${pfx}${a.questionId}`,
        nodePrimary: np,
        ...(a.tags?.length ? { tags: nodesOfAttempt(a).flatMap((tag) => {
          const nodeId = remapRef(tag.nodeId)
          return nodeId ? [{ ...tag, nodeId }] : []
        }) } : {})
      })
    }
  })

  // 同名节点提示（不自动改名，免得图上字太长）
  const nameCount = new Map<string, number>()
  for (const n of nodes) nameCount.set(n.name, (nameCount.get(n.name) ?? 0) + 1)
  const dup = [...nameCount.entries()].filter(([name, c]) => c > 1 && name !== title)
  if (dup.length) {
    warnings.push(`有 ${dup.length} 个同名考点（如「${dup[0][0]}」），它们来自不同章节，详情里会标注来源`)
  }

  const pack: Pack = {
    packId: `merge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    title,
    subject: packSubject(first),
    totalScore: first.totalScore,
    source: `融合：${sources.map((s) => chapterOf(s.pack)).join(' + ')}`,
    meta: { exam: sources.map(({ pack }) => examOf(pack)).find(Boolean) ?? '', subject: packSubject(first), chapter: title },
    nodes,
    relations
  }

  return { pack, questions, mastery, attempts, warnings }
}
