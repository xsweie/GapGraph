import type { Question } from '../../shared/types'

/**
 * 按需生成的题库缓存。
 *
 * 设计原则：不预先生成整本题库。
 *  - 建章节时只备"摸底够用"的一小撮
 *  - 用户真要做某个考点时，才为那个考点出 3 道
 * 生成结果按 packId 分开存，切章节互不干扰。
 */
const key = (packId: string): string => `gapgraph.qbank.${packId}.v1`

export function loadBank(packId: string): Question[] {
  try {
    const raw = localStorage.getItem(key(packId))
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as Question[]) : []
  } catch {
    return []
  }
}

function persist(packId: string, list: Question[]): Question[] {
  try {
    localStorage.setItem(key(packId), JSON.stringify(list))
  } catch {
    /* 存储不可用时仍返回内存结果，当次会话可用 */
  }
  return list
}

/** 整批覆盖（融合板块时用：把几个板块的题合并写进新板块） */
export function saveBank(packId: string, list: Question[]): Question[] {
  return persist(packId, list)
}

export interface NewQuestion {
  type: 'single' | 'blank' | 'judge'
  difficulty: number
  stem: string
  options?: string[]
  answer: string
  solution: string
}

export function addToBank(packId: string, items: NewQuestion[], nodeId: string): Question[] {
  const bank = loadBank(packId)
  const stems = new Set(bank.map((q) => q.stem.replace(/\s+/g, '')))
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
      tags: [{ nodeId, weight: 1, primary: true }]
    })
  }
  if (added.length) localStorage.setItem(key(packId), JSON.stringify([...bank, ...added]))
  return added
}

export function questionsFor(packId: string, nodeId: string): Question[] {
  return loadBank(packId).filter((q) => q.tags?.some((t) => t.nodeId === nodeId))
}

export function bankSize(packId: string): number {
  return loadBank(packId).length
}
