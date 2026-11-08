import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Question } from '../src/shared/types'
import { addToBank, loadBank, loadPlayableBank, saveBank } from '../src/renderer/src/qbank'

const question = (id: string, fields: Partial<Question> = {}): Question => ({
  id, type: 'blank', difficulty: 2, stem: '例题题干', answer: '答案', solution: '题目解析',
  tags: [{ nodeId: 'reading', weight: 1, primary: true }], ...fields
})

function useBankStorage() {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value)
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('生成题文本', () => {
  it('跳过命中旧截断长度的生成题，保留原始记录和确认完整的题', () => {
    useBankStorage()
    const stem = 'x'.repeat(220)
    const old = [
      question('g1', { stem }),
      question('m0_m1_g2', { options: ['x'.repeat(60), 'B', 'C', 'D'] }),
      question('g3', { solution: 'x'.repeat(300) })
    ]
    const valid = [question('g4'), question('m0_q1', { stem }), question('g5', { stem, fullText: true })]
    saveBank('pack', [...old, ...valid])
    expect(loadPlayableBank('pack')).toEqual(valid)
    expect(loadBank('pack')).toEqual([...old, ...valid])
  })

  it('长题和分段按原样保存，可用完整版本替换旧题而不复用题号', () => {
    useBankStorage()
    const stem = '阅读材料'.repeat(80) + '\n\n请回答问题。'
    const option = '选项内容'.repeat(30)
    const solution = '这是一段完整的解析。'.repeat(40)
    saveBank('pack', [question('g1', { stem: stem.slice(0, 220) }), question('g2', { stem, options: [option.slice(0, 60)] })])
    const added = addToBank('pack', [{
      type: 'single', difficulty: 2, stem, options: [option, 'B', 'C', 'D'], answer: option, solution, fullText: true
    }], 'reading')
    expect(added).toHaveLength(1)
    expect(loadPlayableBank('pack')).toEqual([
      question('g3', { type: 'single', stem, options: [option, 'B', 'C', 'D'], answer: option, solution, fullText: true })
    ])
    expect(loadBank('pack').map((q) => q.id)).toEqual(['g1', 'g2', 'g3'])
  })
})
