import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState, AttemptRecord, KNode, Pack, Question, ScopeSpec } from '../src/shared/types'
import { DAY, applyAttempt, freshMastery, setSelfLevel } from '../src/shared/mastery'
import { activeQuestions, restoreEvidenceClocks } from '../src/main/domain/learning-state'
import { applyDiagAnswer, createDiagnostic, diagnosticCoverage, nextQuestion } from '../src/main/domain/diagnostic'
import { assessNode, checkpoint, makePath, newEffectiveSince, packRevision } from '../src/main/domain/learning'
import { buildToday } from '../src/main/domain/queue'
import { alignGraph, scopedPack } from '../src/main/domain/scope'
import { submitAnswer } from '../src/main/domain/submission'
import { commitStructure, effectivePack, undoStructure } from '../src/renderer/src/edits'

const now = Date.UTC(2026, 10, 8, 12)
const node = (id: string, parentId: string | null, prereq: string[] = []): KNode => ({
  id, name: id, parentId, prereq, kind: parentId ? 'concept' : 'root', examWeight: 0.6, confusable: []
})
const pack: Pack = {
  packId: 'test', title: '函数', subject: '数学', source: 'fixture', totalScore: 150,
  nodes: [node('root', null), node('base', 'root'), node('graph', 'root', ['base']), node('read', 'graph', ['base']), node('other', 'root'), node('third', 'root')]
}
const state = (): AppState => ({
  settings: { packId: pack.packId, dailyMinutes: 40, totalScore: 150, examDate: '' },
  mastery: {}, attempts: [], tasks: []
})
const attempt = (id: string, nodeId: string, correct: boolean, extra?: Partial<AttemptRecord>): AttemptRecord => ({
  id, questionId: id, nodePrimary: nodeId, startedAt: now - 5000, submittedAt: now, durationMs: 5000,
  correct, guessed: false, selfConfidence: 'sure', errorReason: correct ? null : 'concept', ...extra
})
const q = (id: string, nodeId: string): Question => ({
  id, type: 'judge', answer: 'true', stem: id, difficulty: 3, tags: [{ primary: true, nodeId, weight: 1 }]
})

afterEach(() => vi.unstubAllGlobals())

describe('证据与路径', () => {
  it('自评、重复、猜对和次考点无法通过两题门槛', () => {
    const data = state()
    data.mastery.base = setSelfLevel(freshMastery(0), 'basic', now)
    expect(assessNode(data, 'base', now).label).toBe('仅自评')
    data.attempts = [
      attempt('q1', 'base', false),
      attempt('retry', 'base', false, { questionId: 'q1' }),
      attempt('guess', 'base', true, { guessed: true }),
      attempt('secondary', 'other', true, { tags: [{ nodeId: 'base', weight: 0.4, primary: false }] })
    ]
    expect(assessNode(data, 'base', now).action).toBe('diagnose')
    expect(makePath(pack, data, now).find((s) => s.nodeId === 'graph')?.blockedBy).toEqual(['base'])
  })

  it('合并共用前置，连续错误先补，稳定解锁下游，到期才排复习', () => {
    const data = state()
    const initial = makePath(pack, data, now)
    expect(initial.filter((s) => s.nodeId === 'base')).toHaveLength(1)
    expect(initial[0].dependents).toEqual(['graph', 'read'])
    data.attempts = [attempt('a', 'base', false), attempt('b', 'base', false)]
    expect(makePath(pack, data, now)[0].action).toBe('gap')
    data.attempts = [attempt('a', 'base', true), attempt('b', 'base', true)]
    data.mastery.base = { ...freshMastery(0), n: 2, A: 0.9, W: 2, Aw: 1.8, lastAt: now }
    const stable = makePath(pack, data, now)
    expect(stable.some((s) => s.nodeId === 'base')).toBe(false)
    expect(stable.find((s) => s.nodeId === 'graph')?.blockedBy).toEqual([])
    expect(makePath(pack, data, now + 4 * DAY).find((s) => s.nodeId === 'base')?.action).toBe('review')
    expect(assessNode(data, 'base', now + 31 * DAY).label).toBe('证据过旧')
  })

  it('检查点保留版本直到动作、顺序或结构修订发生变化', () => {
    const data = state()
    data.path = checkpoint(pack, data, now, '初次')
    data.signals = [{ nodeId: 'base', kind: 'question', at: now }]
    expect(checkpoint(pack, data, now, '再检查').version).toBe(1)
    data.attempts = [attempt('a', 'base', false), attempt('b', 'base', false)]
    expect(checkpoint(pack, data, now, '有效证据').version).toBe(2)
    expect(checkpoint({ ...pack, revision: '2' }, data, now, '结构修订').revision).toBe('2')
  })

  it('普通练习跨会话累计新题，不重计检查点前已验证的题', () => {
    const attempts = [attempt('old', 'base', true, { submittedAt: now - DAY }),
      attempt('repeat', 'base', false, { questionId: 'old' }),
      attempt('a', 'base', true), attempt('b', 'other', false), attempt('c', 'third', true)]
    expect(newEffectiveSince(attempts, now - 1)).toBe(3)
    expect(newEffectiveSince(attempts, now)).toBe(0)
  })

  it('旧环只阻塞相关分支，预算和已用时间不会排入阻塞任务', () => {
    const legacy = { ...pack, nodes: pack.nodes.map((n) => n.id === 'base' ? { ...n, prereq: ['graph'] } : n) }
    const data = state()
    const path = checkpoint(legacy, data, now, '检查')
    expect(path.steps.find((s) => s.nodeId === 'read')?.invalid).toBe(true)
    expect(path.steps.find((s) => s.nodeId === 'other')?.invalid).toBe(false)
    const previous: AppState['tasks'] = [{
      id: 'old', date: 'today', kind: 'gap', nodeId: 'old', questionIds: [], estMinutes: 8, spentMinutes: 7, status: 'done', sortOrder: 0
    }]
    const args = { nodes: legacy.nodes, questions: [], mastery: {}, now, dailyMinutes: 10, daysLeft: Infinity, date: 'today', path, previous }
    expect(buildToday(args)).toEqual(previous)
    const tasks = buildToday({ ...args, dailyMinutes: 17 })
    expect(tasks.filter((t) => t.status === 'pending').map((t) => t.nodeId)).toEqual(['other'])
    expect(tasks[1].questionIds).toEqual([])
  })

  it('重复提交幂等，疑似蒙对不刷新任何掌握字段，也不提前完成任务', () => {
    const data = state()
    const before = { ...freshMastery(0), n: 1, lastAt: now - DAY }
    data.mastery.base = before
    data.tasks = [{ id: 'one', date: 'today', kind: 'diagnose', nodeId: 'base', questionIds: ['q1'], estMinutes: 10, sortOrder: 0, status: 'pending' }]
    const question = q('q1', 'base')
    const submit = { questionId: question.id, answer: 'true', durationMs: 100, errorReason: null,
      selfConfidence: 'unsure' as const, submissionId: 'once', taskId: 'one' }
    submitAnswer(data, [question], submit, now, 'today')
    submitAnswer(data, [question], submit, now, 'today')
    expect(data.attempts).toHaveLength(1)
    expect(data.mastery.base).toEqual(before)
    expect(data.tasks[0].status).toBe('pending')
    expect(applyAttempt(before, { now, correct: true, guessed: true, difficulty: 3, sure: false, weight: 1 })).toEqual(before)
  })

  it('旧版本误刷新复习时间时回到最近的有效作答', () => {
    const data = state()
    data.mastery.base = { ...freshMastery(0), n: 1, lastAt: now }
    data.attempts = [attempt('effective', 'base', false, { submittedAt: now - DAY }), attempt('guess', 'base', true, { guessed: true })]
    restoreEvidenceClocks(data)
    expect(data.mastery.base.lastAt).toBe(now - DAY)
    expect(data.attempts).toHaveLength(2)
  })
})

describe('渐进摸底', () => {
  it('优先未覆盖分支，题库不足不降低分母；猜对与重复题不算有效覆盖', () => {
    const bank = [q('x', 'base'), q('y', 'graph')]
    let round = applyDiagAnswer(createDiagnostic(), 'old', 'base', true)
    expect(nextQuestion(round, bank, pack.nodes, {})?.id).toBe('y')
    for (let i = 0; i < 6; i++) round = applyDiagAnswer(round, 'b' + i, 'base', true)
    round = applyDiagAnswer(round, 'guess', 'graph', true, true)
    round = applyDiagAnswer(round, 'old', 'other', true)
    expect(diagnosticCoverage(round, pack.nodes)).toMatchObject({ effective: 7, covered: 1, branches: 4, required: 3, ready: false })
    round = applyDiagAnswer(round, 'g', 'graph', true)
    round = applyDiagAnswer(round, 'o', 'other', false)
    expect(diagnosticCoverage(round, pack.nodes).ready).toBe(true)
    expect(nextQuestion(round, bank, pack.nodes, {})).toBeNull()
  })
})

const scope: ScopeSpec = {
  source: 'confirmed', version: 1, stage: '初二', subject: '数学', topic: '一次函数', goal: '补齐', depth: '理解',
  include: [{ id: 'scope-graph', label: '图像' }], exclude: ['拓展'], foundations: []
}
const raw = [node('root', null), { ...node('line', 'root'), scopeIds: ['scope-graph'] }]

describe('范围与结构修订', () => {
  it('接受窄范围，拒绝缺覆盖、重复 ID、坏引用和两种环', () => {
    expect(scopedPack(scope, raw, 'n').nodes).toHaveLength(2)
    expect(() => scopedPack(scope, [raw[0], node('line', 'root')], 'n')).toThrow('关联范围')
    expect(() => scopedPack(scope, [...raw, raw[1]], 'n')).toThrow('重复')
    expect(() => scopedPack(scope, [raw[0], { ...raw[1], prereq: ['missing'] }], 'n')).toThrow('引用无效')
    expect(() => scopedPack(scope, [raw[0], { ...raw[1], prereq: ['other'] },
      { ...node('other', 'root', ['line']), scopeIds: ['scope-graph'] }], 'n')).toThrow('循环')
    expect(() => scopedPack(scope, [raw[0], { ...raw[1], parentId: 'line' }], 'n')).toThrow('循环')
    const aligned = alignGraph({ ...pack, relations: [{ kind: 'prereq', a: 'base', b: 'other', why: '关联' }] })
    expect(aligned.nodes.find((n) => n.id === 'other')?.prereq).toEqual(['base'])
  })

  it('过期与写失败保留当前图；撤销只恢复结构，归档题不再被选入', async () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => { store.set(key, value) })
    }
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('navigator', {})
    const base = scopedPack(scope, raw, 'custom')
    const candidate = { ...base, nodes: [{ ...base.nodes[0] }, { ...base.nodes[1], id: 'new-id' }] }
    await commitStructure(base, 'base', candidate)
    const saved = effectivePack(base)
    expect(activeQuestions(saved, [q('history', 'line'), q('fresh', 'new-id')]).map((item) => item.id)).toEqual(['fresh'])
    await expect(commitStructure(base, 'base', candidate)).rejects.toThrow('过期')
    storage.setItem.mockImplementationOnce(() => { throw Error('quota') })
    await expect(commitStructure(base, packRevision(saved), candidate)).rejects.toThrow('quota')
    expect(effectivePack(base)).toEqual(saved)
    storage.setItem('attempt-history', 'old-and-new')
    await undoStructure(base.packId, packRevision(saved))
    expect(effectivePack(base).nodes.map((n) => n.id)).toEqual(['root', 'line'])
    expect(storage.getItem('attempt-history')).toBe('old-and-new')
  })
})
