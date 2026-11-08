import type { Question } from '../../shared/types'

/**
 * 按需生成的题库缓存。
 *
 * 设计原则：不预先生成整本题库。
 *  - 建章节时只备"摸底够用"的一小撮
 *  - 用户真要做某个考点时，才为那个考点出 3 道
 * 生成结果按 packId 分开存，切章节互不干扰。
 */
export const bankKey = (packId: string): string => `gapgraph.qbank.${packId}.v1`

export function loadBank(packId: string): Question[] {
  try {
    const raw = localStorage.getItem(bankKey(packId))
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as Question[]) : []
  } catch {
    return []
  }
}

/** 旧代理返回前会硬截文本。命中旧上限的生成题留在题库中，但不再安排练习。 */
function playable(question: Question): boolean {
  if (question.fullText || !/^(?:m\d+_)*g\d+$/.test(question.id)) return true
  return question.stem.length !== 220 && !question.options?.some((option) => option.length === 60) &&
    question.solution?.length !== 300
}

export function loadPlayableBank(packId: string): Question[] {
  return loadBank(packId).filter(playable)
}

/** 整批覆盖（融合板块时用：把几个板块的题合并写进新板块） */
export function saveBank(packId: string, list: Question[]): Question[] {
  localStorage.setItem(bankKey(packId), JSON.stringify(list))
  return list
}

export interface NewQuestion {
  type: 'single' | 'blank' | 'judge'
  difficulty: number
  stem: string
  options?: string[]
  answer: string
  solution: string
  fullText: true
}

export function addToBank(packId: string, items: NewQuestion[], nodeId: string): Question[] {
  const bank = loadBank(packId)
  const stems = new Set(bank.filter(playable).map((q) => q.stem.replace(/\s+/g, '')))
  const added: Question[] = []
  let seq = bank.length
  for (const it of items) {
    const k = it.stem.replace(/\s+/g, '')
    if (stems.has(k)) continue
    stems.add(k)
    seq++
    added.push({
      id: `g${seq}`,
      type: it.type,
      difficulty: it.difficulty,
      stem: it.stem,
      ...(it.options ? { options: it.options } : {}),
      answer: it.answer,
      solution: it.solution,
      fullText: it.fullText,
      tags: [{ nodeId, weight: 1, primary: true }]
    })
  }
  if (added.length) saveBank(packId, [...bank, ...added])
  return added
}

export function questionsFor(packId: string, nodeId: string): Question[] {
  return loadPlayableBank(packId).filter((q) => q.tags?.some((t) => t.nodeId === nodeId))
}

export function bankSize(packId: string): number {
  return loadBank(packId).length
}
