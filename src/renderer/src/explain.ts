import type { DetailedExplain } from './ai'

/**
 * 详细讲解的本地缓存。
 *
 * 按板块 + 考点存：换板块不会串，同一考点重复打开不用重新花钱生成。
 * 缓存用于直接展开详细讲解，用户也可以手动重新生成。
 */
const key = (packId: string): string => `gapgraph.explain.${packId}.v1`

export type ExplainMap = Record<string, DetailedExplain>

export function loadExplains(packId: string): ExplainMap {
  try {
    const raw = localStorage.getItem(key(packId))
    if (!raw) return {}
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as ExplainMap) : {}
  } catch {
    return {}
  }
}

export function explainOf(packId: string, nodeId: string): DetailedExplain | null {
  const all = loadExplains(packId)
  const e = all[nodeId]
  return e && typeof e.definition === 'string' ? e : null
}

export function saveExplain(packId: string, nodeId: string, e: DetailedExplain): void {
  const all = loadExplains(packId)
  all[nodeId] = e
  try {
    localStorage.setItem(key(packId), JSON.stringify(all))
  } catch {
    /* 存不下就算了，至少这次能看到 */
  }
}

export function clearExplain(packId: string, nodeId: string): void {
  const all = loadExplains(packId)
  delete all[nodeId]
  try {
    localStorage.setItem(key(packId), JSON.stringify(all))
  } catch {
    /* 忽略 */
  }
}

/** 有几个考点已经生成过详细版（大厅/设置里用得上） */
export function explainCount(packId: string): number {
  return Object.keys(loadExplains(packId)).length
}
