import type { KNode, Pack, Relation } from '../../shared/types'
import { packRevision } from '../../main/domain/learning'
import { alignGraph, validateGraph, validateScope } from '../../main/domain/scope'

/**
 * 用户对板块的本地修改（增删考点、拖动位置）。
 *
 * 为什么不直接改 pack：内置考纲是随包分发的只读文件，AI 生成的板块也不该被就地改坏。
 * 所以用"叠加层"：原数据不动，只记录"加了哪些、删了哪些、挪到哪了"。
 * 好处是随时能还原，而且切换板块时状态键不受影响。
 */

const editKey = (packId: string): string => `gapgraph.edit.${packId}.v1`
const posKey = (packId: string): string => `gapgraph.pos.${packId}.v1`
const revisionKey = (id: string): string => `gapgraph.structure.${id}.v1`

interface Structure {
  current: Pack
  previous?: Pack
  knownIds: string[]
}

function readStructure(id: string): Structure | null {
  const raw = localStorage.getItem(revisionKey(id))
  const structure = raw ? JSON.parse(raw) as Structure : null
  if (structure && structure.current?.packId !== id) throw new Error('板块修订记录不匹配。')
  return structure
}

export function effectivePack(base: Pack): Pack {
  let stored: Structure | null = null
  try { stored = readStructure(base.packId) } catch { /* 仍可读取旧板块 */ }
  return stored?.current ?? alignGraph(applyEdits(base, loadEdits(base.packId)))
}

export function hasUndo(id: string): boolean {
  try { return !!readStructure(id)?.previous } catch { return false }
}

function revisionId(): string {
  return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
}

async function withRevisionLock<T>(id: string, change: () => T): Promise<T> {
  return navigator.locks ? navigator.locks.request(revisionKey(id), change) : change()
}

export async function commitStructure(base: Pack, expected: string, candidate: Pack): Promise<void> {
  await withRevisionLock(base.packId, () => {
    const stored = readStructure(base.packId)
    const current = stored?.current ?? effectivePack(base)
    if (candidate.packId !== base.packId || packRevision(current) !== expected) throw new Error('预览已过期，请重新打开范围编辑。')
    const known = new Set([...(stored?.knownIds ?? []), ...base.nodes.map((n) => n.id), ...current.nodes.map((n) => n.id), ...loadEdits(base.packId).removed])
    const currentIds = new Set(current.nodes.map((n) => n.id))
    if (candidate.nodes.some((n) => !currentIds.has(n.id) && known.has(n.id))) throw new Error('新增考点必须使用新 ID，归档考点不能复用。')
    if (candidate.subject !== current.subject && candidate.nodes.some((n) => n.kind !== 'root' && currentIds.has(n.id))) {
      throw new Error('更换学科时请新建板块，或为所有含义改变的考点使用新 ID。')
    }
    if (candidate.scope) validateScope(candidate.scope)
    validateGraph(candidate, !!candidate.scope)
    const next: Pack = { ...candidate, revision: revisionId(), scope: candidate.scope && {
      ...candidate.scope, version: (current.scope?.version ?? 0) + 1
    } }
    for (const n of next.nodes) known.add(n.id)
    localStorage.setItem(revisionKey(base.packId), JSON.stringify({ current: next, previous: current, knownIds: [...known] }))
  })
}

export async function undoStructure(id: string, expected: string): Promise<void> {
  await withRevisionLock(id, () => {
    const stored = readStructure(id)
    if (!stored?.previous || packRevision(stored.current) !== expected) throw new Error('没有可撤销的当前修订，请刷新。')
    const current = { ...stored.previous, revision: revisionId(), scope: stored.previous.scope && {
      ...stored.previous.scope, version: (stored.current.scope?.version ?? 0) + 1
    } }
    localStorage.setItem(revisionKey(id), JSON.stringify({ current, knownIds: stored.knownIds }))
  })
}

export interface PackEdits {
  added: KNode[]
  removed: string[]
}

export function loadEdits(packId: string): PackEdits {
  try {
    const raw = localStorage.getItem(editKey(packId))
    if (!raw) return { added: [], removed: [] }
    const v = JSON.parse(raw) as Partial<PackEdits>
    return {
      added: Array.isArray(v.added) ? (v.added as KNode[]) : [],
      removed: Array.isArray(v.removed) ? (v.removed as string[]) : []
    }
  } catch {
    return { added: [], removed: [] }
  }
}

function persistEdits(packId: string, e: PackEdits): void {
  try {
    localStorage.setItem(editKey(packId), JSON.stringify(e))
  } catch {
    /* 忽略 */
  }
}

/** 把叠加层套到原始板块上，得到实际参与计算的板块 */
export function applyEdits(pack: Pack, edits: PackEdits): Pack {
  if (!edits.removed.length && !edits.added.length) return pack
  const removed = new Set(edits.removed)
  const kept = pack.nodes.filter((n) => !removed.has(n.id))
  const root = kept.find((n) => n.kind === 'root') ?? kept[0]
  const exists = new Set(kept.map((n) => n.id))

  const nodes: KNode[] = kept.map((n) => ({
    ...n,
    // 父节点被删了，就挂回根，别让子树变成孤儿
    parentId: n.parentId && !exists.has(n.parentId) ? (root?.id ?? null) : n.parentId,
    prereq: n.prereq.filter((p) => exists.has(p)),
    confusable: n.confusable.filter((p) => exists.has(p))
  }))

  for (const a of edits.added) {
    if (exists.has(a.id)) continue
    const parent = a.parentId && exists.has(a.parentId) ? a.parentId : (root?.id ?? null)
    nodes.push({ ...a, parentId: parent, edited: true })
    exists.add(a.id)
  }

  const relations: Relation[] = (pack.relations ?? []).filter((r) => exists.has(r.a) && exists.has(r.b))
  return { ...pack, nodes, relations }
}

export function addUserNode(packId: string, node: KNode): void {
  const e = loadEdits(packId)
  e.removed = e.removed.filter((id) => id !== node.id)
  e.added = [...e.added.filter((n) => n.id !== node.id), node]
  persistEdits(packId, e)
}

/** 删除：自己加的从 added 里去掉；原有的记进 removed */
export function removeUserNode(packId: string, nodeId: string): void {
  const e = loadEdits(packId)
  const wasAdded = e.added.some((n) => n.id === nodeId)
  e.added = e.added.filter((n) => n.id !== nodeId)
  if (!wasAdded) e.removed = [...new Set([...e.removed, nodeId])]
  // 删父节点时，它下面用户自己加的节点跟着走，避免变成孤儿
  const childIds = e.added.filter((n) => n.parentId === nodeId).map((n) => n.id)
  if (childIds.length) {
    e.added = e.added.filter((n) => !childIds.includes(n.id))
    e.removed = [...new Set([...e.removed, ...childIds])]
  }
  persistEdits(packId, e)
}

/** 还原所有自定义修改 */
export function resetEdits(packId: string): void {
  try {
    localStorage.removeItem(editKey(packId))
  } catch {
    /* 忽略 */
  }
}

/* ---------------- 节点位置 ---------------- */

export type PositionMap = Record<string, [number, number]>

export function loadPositions(packId: string): PositionMap {
  try {
    const raw = localStorage.getItem(posKey(packId))
    return raw ? (JSON.parse(raw) as PositionMap) : {}
  } catch {
    return {}
  }
}

export function savePositions(packId: string, map: PositionMap): void {
  try {
    localStorage.setItem(posKey(packId), JSON.stringify(map))
  } catch {
    /* 忽略 */
  }
}

export function saveOnePosition(packId: string, id: string, x: number, y: number): void {
  const map = loadPositions(packId)
  map[id] = [x, y]
  savePositions(packId, map)
}

export function clearPositions(packId: string): void {
  try {
    localStorage.removeItem(posKey(packId))
  } catch {
    /* 忽略 */
  }
}
