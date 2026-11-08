import { describe, expect, it, vi } from 'vitest'
import type { KNode, Mastery, Pack, Question } from '../src/shared/types'
import { freshMastery } from '../src/shared/mastery'
import { canMerge, mergeSources, type MergeSource } from '../src/main/domain/merge'
import { nodesOfAttempt, primaryAttemptNode } from '../src/main/domain/attempt-log'
import { saveMergedPack, stateKeyFor } from '../src/renderer/src/packs'
import { bankKey } from '../src/renderer/src/qbank'

const node = (id: string, name: string, parentId: string | null, kind: KNode['kind'] = 'concept'): KNode => ({
  id,
  name,
  parentId,
  kind,
  examWeight: 0.8,
  prereq: [],
  confusable: []
})

function mkPack(id: string, exam: string, subject: string, chapter: string, extra?: Partial<Pack>): Pack {
  return {
    packId: id,
    title: chapter,
    subject,
    totalScore: 150,
    source: 'test',
    meta: { exam, subject, chapter },
    nodes: [
      node('r', chapter, null, 'root'),
      node('a', '概念A', 'r'),
      node('b', '概念B', 'r')
    ],
    relations: [],
    ...extra
  }
}

function mkSource(pack: Pack, opts: { questions?: Partial<Question>[]; mastered?: string[] } = {}): MergeSource {
  const questions: Question[] = (opts.questions ?? [{ id: 'q1' }, { id: 'q2' }]).map((q, i) => ({
    id: q.id ?? `q${i + 1}`,
    type: 'blank' as const,
    difficulty: 2,
    stem: `题${i + 1}`,
    answer: '1',
    solution: '略',
    tags: [{ nodeId: 'a', weight: 1, primary: true }]
  }))
  const mastery: Record<string, Mastery> = {}
  for (const n of pack.nodes) mastery[n.id] = freshMastery(n.kind === 'root' ? 1 : 0)
  for (const id of opts.mastered ?? []) mastery[id] = { ...freshMastery(1), A: 0.8, n: 3, lastAt: Date.now() }
  return { pack, questions, mastery, attempts: [] }
}

describe('学科闸门：防止跨学科污染', () => {
  it('同考试同科目可以融合', () => {
    const a = mkPack('p1', '高考', '化学', '烯烃')
    const b = mkPack('p2', '高考', '化学', '烷烃')
    expect(canMerge([a, b])).toEqual({ ok: true })
  })

  it('不同科目直接拒绝，并说清原因', () => {
    const a = mkPack('p1', '高考', '数学', '函数')
    const b = mkPack('p2', '高考', '化学', '加成反应')
    const r = canMerge([a, b])
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('不是同一学科')
  })

  it('同科目但不同考试也拒绝（高考 vs 考研）', () => {
    const a = mkPack('p1', '高考', '数学', '函数')
    const b = mkPack('p2', '考研', '数学', '多元函数')
    expect(canMerge([a, b]).ok).toBe(false)
  })

  it('按学科融合考试留空的新版板块，有明确考试信息时沿用', () => {
    const a = mkPack('p1', '', ' 数学 ', '函数')
    const b = mkPack('p2', ' ', '数学', '数列', { meta: { exam: '', subject: '', chapter: '数列' } })
    const c = mkPack('p3', '高考', '数学', '三角函数')
    const d = mkPack('p4', '考研', '数学', '极限')
    expect(canMerge([a, b]).ok).toBe(true)
    expect(canMerge([a, c, d]).reason).toContain('不同考试')
    expect(mergeSources([mkSource(b), mkSource(c)], '数学复习').pack.meta).toMatchObject({ exam: '高考', subject: '数学' })
  })

  it('只选一个不行，超过四个也不行', () => {
    const one = mkPack('p1', '高考', '化学', '烯烃')
    expect(canMerge([one]).ok).toBe(false)
    const many = [1, 2, 3, 4, 5].map((i) => mkPack(`p${i}`, '高考', '化学', `第${i}章`))
    expect(canMerge(many).ok).toBe(false)
  })

  it('缺学科信息时拒绝，而不是瞎猜', () => {
    const a = mkPack('p1', '高考', '化学', '烯烃')
    const b = { ...mkPack('p2', '', '', '烷烃'), meta: undefined, subject: '' }
    const r = canMerge([a, b as Pack])
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('缺少学科信息')
  })
})

describe('融合：结构', () => {
  const a = mkPack('p1', '高考', '化学', '烯烃')
  const b = mkPack('p2', '高考', '化学', '烷烃')
  a.nodes[1].prereq = ['r']
  a.relations = [{ a: 'r', b: 'a', kind: 'prereq', why: '先总览再细节' }]

  it('产生唯一的新根，名字就是用户取的名字', () => {
    const r = mergeSources([mkSource(a), mkSource(b)], '烃类化合物')
    const roots = r.pack.nodes.filter((n) => n.kind === 'root')
    expect(roots).toHaveLength(1)
    expect(roots[0].name).toBe('烃类化合物')
  })

  it('原来的两个根降级成总览节点，挂在新区块下面', () => {
    const r = mergeSources([mkSource(a), mkSource(b)], '烃类化合物')
    const overview = r.pack.nodes.filter((n) => n.parentId === 'mroot' && n.name === '烯烃')
    expect(overview).toHaveLength(1)
    expect(overview[0].kind).toBe('concept')
  })

  it('节点 id 不冲突（两章都有 a/b 也不会互相覆盖）', () => {
    const r = mergeSources([mkSource(a), mkSource(b)], '烃类化合物')
    const ids = r.pack.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(r.pack.nodes.filter((n) => n.name === '概念A')).toHaveLength(2)
  })

  it('父链、前置、易混、关系都重映射到新 id', () => {
    const r = mergeSources([mkSource(a), mkSource(b)], '烃类化合物')
    const aNode = r.pack.nodes.find((n) => n.id === 'm0_a')!
    expect(aNode.parentId).toBe('m0_r')
    expect(aNode.prereq).toEqual(['m0_r'])
    expect(r.pack.relations?.[0]).toMatchObject({ a: 'm0_r', b: 'm0_a', why: '先总览再细节' })
  })

  it('每个节点记住自己来自哪一章（出题上下文靠它）', () => {
    const r = mergeSources([mkSource(a), mkSource(b)], '烃类化合物')
    expect(r.pack.nodes.find((n) => n.id === 'm0_a')!.origin).toBe('烯烃')
    expect(r.pack.nodes.find((n) => n.id === 'm1_a')!.origin).toBe('烷烃')
  })

  it('新板块的学科标签沿用来源，章节名用新名字', () => {
    const r = mergeSources([mkSource(a), mkSource(b)], '烃类化合物')
    expect(r.pack.meta).toEqual({ exam: '高考', subject: '化学', chapter: '烃类化合物' })
  })
})

describe('融合：题库与学习记录', () => {
  const a = mkPack('p1', '高考', '化学', '烯烃')
  const b = mkPack('p2', '高考', '化学', '烷烃')

  it('两边的题都带过来，且题号不撞', () => {
    const r = mergeSources([mkSource(a), mkSource(b)], '烃类化合物')
    expect(r.questions).toHaveLength(4)
    expect(new Set(r.questions.map((q) => q.id)).size).toBe(4)
  })

  it('题的考点归属重映射到新节点', () => {
    const r = mergeSources([mkSource(a), mkSource(b)], '烃类化合物')
    const q0 = r.questions.find((q) => q.id === 'm0_q1')!
    expect(q0.tags[0].nodeId).toBe('m0_a')
  })

  it('掌握度跟过来（融合完不该变回一片灰）', () => {
    const r = mergeSources([mkSource(a, { mastered: ['a'] }), mkSource(b)], '烃类化合物')
    expect(r.mastery['m0_a'].n).toBe(3)
    expect(r.mastery['m0_a'].A).toBeCloseTo(0.8)
    expect(r.mastery['m1_a'].n).toBe(0)
  })

  it('作答记录也搬，且 questionId 一起加前缀', () => {
    const sa = mkSource(a)
    sa.attempts = [
      {
        id: 'att1',
        questionId: 'q1',
        nodePrimary: 'a',
        startedAt: 1,
        submittedAt: 2,
        durationMs: 1,
        correct: false,
        selfConfidence: 'sure',
        guessed: false,
        errorReason: 'concept',
        tags: [{ nodeId: 'a', primary: true, weight: 1 }, { nodeId: 'b', primary: false, weight: 0.4 }]
      }
    ]
    const r = mergeSources([sa, mkSource(b)], '烃类化合物')
    expect(r.attempts).toHaveLength(1)
    expect(r.attempts[0]).toMatchObject({ id: 'm0_att1', questionId: 'm0_q1', nodePrimary: 'm0_a' })
    expect(nodesOfAttempt(r.attempts[0]).map((tag) => tag.nodeId)).toEqual(['m0_a', 'm0_b'])
    const legacy = { ...r.attempts[0], nodePrimary: 'm1_m0_a', tags: sa.attempts[0].tags }
    expect(primaryAttemptNode(legacy)).toBe('m1_m0_a')
    expect(nodesOfAttempt(legacy).map((tag) => tag.nodeId)).toEqual(['m1_m0_a', 'm1_m0_b'])
  })

  it('同名考点会给出提示，但不擅自改名', () => {
    const r = mergeSources([mkSource(a), mkSource(b)], '烃类化合物')
    expect(r.warnings.join()).toContain('同名考点')
    expect(r.pack.nodes.filter((n) => n.name === '概念A')).toHaveLength(2)
  })

  it('跨学科调用直接抛错，不会生成半成品', () => {
    const math = mkPack('p3', '高考', '数学', '函数')
    expect(() => mergeSources([mkSource(a), mkSource(math)], '乱七八糟')).toThrow(/不是同一学科/)
  })
})

it('保存融合板块失败时清理半成品，并可重试', () => {
  const pack = mkPack('merge-test', '', '数学', '复习')
  const { questions, mastery, attempts } = mkSource(pack)
  const settings = { dailyMinutes: 40, examDate: '', totalScore: 150, packId: pack.packId }
  const state = { settings, mastery, attempts, tasks: [] }
  const registry = 'gapgraph.packs.v1'
  const initial = JSON.stringify({ source: mkPack('source', '', '数学', '函数') })
  const data = new Map([[registry, initial]])
  let full = true
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (full && key === registry) throw new Error('quota')
      data.set(key, value)
    },
    removeItem: (key: string) => data.delete(key)
  })
  try {
    expect(() => saveMergedPack(pack, questions, state)).toThrow('quota')
    expect([...data]).toEqual([[registry, initial]])
    full = false
    saveMergedPack(pack, questions, state)
    expect(JSON.parse(data.get(registry)!)[pack.packId]).toEqual(pack)
    expect(JSON.parse(data.get(bankKey(pack.packId))!)).toEqual(questions)
    expect(JSON.parse(data.get(stateKeyFor(pack.packId))!)).toEqual(state)
  } finally { vi.unstubAllGlobals() }
})
