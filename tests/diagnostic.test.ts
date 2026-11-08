import { describe, expect, it } from 'vitest'
import type { KNode, Mastery, Question } from '../src/shared/types'
import { freshMastery } from '../src/shared/mastery'
import {
  DIAG_TARGET,
  applyDiagAnswer,
  createDiagnostic,
  diagnosticTargets,
  nextQuestion,
  primaryNodeOf,
  summarize
} from '../src/main/domain/diagnostic'
import { blankMastery } from '../src/main/domain/queue'

const NOW = Date.UTC(2026, 0, 10)

const mkNode = (id: string, weight: number, prereq: string[] = []): KNode => ({
  id,
  name: id,
  parentId: 'root',
  kind: 'concept',
  examWeight: weight,
  prereq,
  confusable: []
})

const root: KNode = {
  id: 'root',
  name: 'root',
  parentId: null,
  kind: 'root',
  examWeight: 1,
  prereq: [],
  confusable: []
}

const mkQ = (id: string, nodeId: string, difficulty: number): Question => ({
  id,
  type: 'judge',
  stem: id,
  answer: 'true',
  difficulty,
  tags: [{ nodeId, weight: 1, primary: true }]
})

describe('摸底选题', () => {
  const nodes = [root, mkNode('basic', 0.9), mkNode('mid', 0.8), mkNode('hard', 0.7), mkNode('clinic', 0.6, ['basic'])]
  const questions = [
    mkQ('q_b1', 'basic', 1),
    mkQ('q_b2', 'basic', 2),
    mkQ('q_m1', 'mid', 2),
    mkQ('q_m2', 'mid', 3),
    mkQ('q_h1', 'hard', 4),
    mkQ('q_h2', 'hard', 5),
    mkQ('q_c1', 'clinic', 1)
  ]
  const mastery: Record<string, Mastery> = blankMastery(nodes)

  it('第一题从简单处起步，不会一上来就打击人', () => {
    const q = nextQuestion(createDiagnostic(), questions, nodes, mastery)
    expect(q).not.toBeNull()
    expect(q!.difficulty).toBeLessThanOrEqual(2)
  })

  it('不重复出同一道题', () => {
    let s = createDiagnostic()
    const seen = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const q = nextQuestion(s, questions, nodes, mastery)
      expect(q).not.toBeNull()
      expect(seen.has(q!.id)).toBe(false)
      seen.add(q!.id)
      s = applyDiagAnswer(s, q!.id, primaryNodeOf(q!)!, true)
    }
  })

  it('答对后难度上升，答错后难度下降', () => {
    const s0 = createDiagnostic()
    const up = applyDiagAnswer(s0, 'x', 'basic', true)
    const down = applyDiagAnswer(s0, 'x', 'basic', false)
    expect(up.targetDifficulty).toBeGreaterThan(s0.targetDifficulty)
    expect(down.targetDifficulty).toBeLessThan(s0.targetDifficulty)
  })

  it('答错后优先下钻到它的前置考点', () => {
    const s = applyDiagAnswer(createDiagnostic(), 'q_c1', 'clinic', false)
    const q = nextQuestion(s, questions, nodes, mastery)
    expect(q).not.toBeNull()
    expect(primaryNodeOf(q!)).toBe('basic')
  })

  it('优先覆盖没测过的考点', () => {
    const s = applyDiagAnswer(createDiagnostic(), 'q_b1', 'basic', true)
    const q = nextQuestion(s, questions, nodes, mastery)
    expect(primaryNodeOf(q!)).not.toBe('basic')
  })

  it('达到目标题量就停', () => {
    let s = createDiagnostic()
    for (let i = 0; i < DIAG_TARGET; i++) s = applyDiagAnswer(s, `fake_${i}`, 'basic', true)
    expect(nextQuestion(s, questions, nodes, mastery)).toBeNull()
  })

  it('一个题都不剩时返回 null，不死循环', () => {
    let s = createDiagnostic()
    for (const q of questions) s = applyDiagAnswer(s, q.id, primaryNodeOf(q)!, true)
    expect(nextQuestion(s, questions, nodes, mastery)).toBeNull()
  })

  it('主分支已经测过时，缺题优先准备新子节点的题目', () => {
    const child = { ...mkNode('new-child', 0.5), parentId: 'basic' }
    const state = applyDiagAnswer(createDiagnostic(), 'q_b1', 'basic', true)
    expect(diagnosticTargets(state, questions, [root, nodes[1], child]).map((node) => node.id)).toEqual(['new-child'])
  })
})

describe('摸底结果', () => {
  const nodes = [root, mkNode('a', 0.9), mkNode('b', 0.8), mkNode('c', 0.7)]
  const mastery: Record<string, Mastery> = blankMastery(nodes)
  mastery.a = { ...freshMastery(1), A: 0.9, n: 4, lastAt: NOW }
  mastery.b = { ...freshMastery(1), A: 0.1, n: 3, lastAt: NOW }
  mastery.c = { ...freshMastery(1), A: 0.3, n: 2, lastAt: NOW }

  it('统计测过的考点与最薄的三处', () => {
    let s = createDiagnostic()
    s = applyDiagAnswer(s, 'q1', 'a', true)
    s = applyDiagAnswer(s, 'q2', 'b', false)
    s = applyDiagAnswer(s, 'q3', 'c', false)
    const r = summarize(s, nodes, mastery, NOW)
    expect(r.answered).toBe(3)
    expect(r.touched).toBe(3)
    expect(r.weakest[0].id).toBe('b')
    expect(r.weakest.length).toBeLessThanOrEqual(3)
    expect(r.bands.red + r.bands.orange + r.bands.yellow + r.bands.green).toBe(3)
  })

  it('已归档的考点保留提交次数，但不进入当前诊断建议', () => {
    const s = applyDiagAnswer(applyDiagAnswer(createDiagnostic(), 'q1', 'a', true), 'q2', 'b', false)
    const r = summarize(s, nodes.filter((node) => node.id !== 'b'), mastery, NOW)
    expect(r.answered).toBe(2)
    expect(r.touched).toBe(1)
    expect(r.weakest.map((node) => node.id)).toEqual(['a'])
  })
})
