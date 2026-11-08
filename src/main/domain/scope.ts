import type { KNode, Pack, Relation, ScopeItem, ScopeSpec } from '../../shared/types'

export function legacyScope(pack: Pack): ScopeSpec {
  const root = pack.nodes.find((n) => n.kind === 'root')
  return pack.scope ?? {
    version: 0, source: 'legacy', stage: pack.meta?.exam ?? '', subject: pack.subject,
    topic: pack.meta?.chapter ?? pack.title, goal: '补齐本板块', depth: '理解概念并能应用',
    include: pack.nodes.filter((n) => n.parentId === root?.id).map((n) => ({ id: 'scope-' + n.id, label: n.name })),
    exclude: [], foundations: []
  }
}

export function scopeItems(lines: string, previous: ScopeItem[], nextId: () => string): ScopeItem[] {
  return [...new Set(lines.split(/\r?\n/).map((label) => label.trim()).filter(Boolean))]
    .map((label) => previous.find((item) => item.label === label) ?? { id: nextId(), label })
}

export function validateScope(scope: ScopeSpec): void {
  if (![scope.stage, scope.subject, scope.topic, scope.goal, scope.depth].every((v) => v.trim())) {
    throw new Error('请补全学段、学科、主题、目标和深度。')
  }
  const items = [...scope.include, ...scope.foundations]
  if (!scope.include.length || new Set(items.map((i) => i.id)).size !== items.length) {
    throw new Error('请至少纳入一项内容，范围条目须各自独立。')
  }
}

export function relationships(nodes: KNode[], previous: Relation[] = []): Relation[] {
  const ids = new Set(nodes.map((n) => n.id))
  const reasons = new Map(previous.filter((r) => r.kind === 'prereq').map((r) => [JSON.stringify([r.a, r.b]), r.why]))
  const confusable = previous.filter((r) => r.kind === 'confusable' && ids.has(r.a) && ids.has(r.b))
  const prerequisites = nodes.flatMap((n) => [...new Set(n.prereq)].filter((id) => ids.has(id)).map((id): Relation => ({
    a: id, b: n.id, kind: 'prereq', why: reasons.get(JSON.stringify([id, n.id])) ?? '学习该考点需要此基础'
  })))
  return [...prerequisites, ...confusable]
}

/** 旧包保留坏引用供规划诊断。旧关系表里仅有的必要前置并入统一方向。 */
export function alignGraph(pack: Pack): Pack {
  const extra = new Map<string, string[]>()
  for (const r of pack.relations ?? []) if (r.kind === 'prereq') {
    extra.set(r.b, [...(extra.get(r.b) ?? []), r.a])
  }
  const nodes = pack.nodes.map((n) => ({ ...n, prereq: [...new Set([...n.prereq, ...(extra.get(n.id) ?? [])])] }))
  return { ...pack, nodes, relations: relationships(nodes, pack.relations) }
}

export function validateGraph(pack: Pack, requireCoverage = true): void {
  const nodes = pack.nodes
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const roots = nodes.filter((n) => n.kind === 'root')
  if (roots.length !== 1 || roots[0].parentId !== null || nodes.length < 2) throw new Error('需要一个根节点及至少一个考点。')
  if (byId.size !== nodes.length || nodes.some((n) => !/^[a-zA-Z0-9_-]{1,80}$/.test(n.id) || !n.name.trim() ||
    ['__proto__', 'constructor', 'prototype'].includes(n.id))) throw new Error('考点 ID 为空、无效或重复。')

  const scope = pack.scope
  const items = [...(scope?.include ?? []), ...(scope?.foundations ?? [])]
  const ids = new Set(items.map((i) => i.id))
  const covered = new Set<string>()
  for (const n of nodes) {
    if (n.kind !== 'root' && (!n.parentId || !byId.has(n.parentId))) throw new Error('父级不存在：' + n.name)
    if (n.prereq.some((p) => !byId.has(p) || byId.get(p)?.kind === 'root') || n.confusable.some((p) => !byId.has(p) || p === n.id)) {
      throw new Error('前置或易混引用无效：' + n.name)
    }
    if ((n.scopeIds ?? []).some((id) => !ids.has(id))) throw new Error('范围条目引用不存在：' + n.name)
    if (n.kind !== 'root' && scope && requireCoverage && !n.scopeIds?.length && !n.supplementary) {
      throw new Error('请为「' + n.name + '」关联范围，或明确标记为补充基础。')
    }
    if (n.kind !== 'root') n.scopeIds?.forEach((id) => covered.add(id))
  }
  for (const r of pack.relations ?? []) {
    if (!byId.has(r.a) || !byId.has(r.b) || r.a === r.b) throw new Error('关系引用无效。')
    if (r.kind === 'prereq' && !byId.get(r.b)?.prereq.includes(r.a)) throw new Error('前置关系方向不一致。')
  }
  for (const [label, links] of [
    ['父级', (n: KNode) => n.parentId ? [n.parentId] : []],
    ['前置', (n: KNode) => n.prereq]
  ] as const) {
    const done = new Set<string>()
    const stack = new Set<string>()
    function walk(id: string): void {
      if (done.has(id)) return
      if (stack.has(id)) throw new Error(label + '关系存在循环：' + byId.get(id)?.name)
      stack.add(id)
      for (const next of links(byId.get(id)!)) walk(next)
      stack.delete(id)
      done.add(id)
    }
    for (const n of nodes) walk(n.id)
  }
  const missing = requireCoverage ? items.filter((i) => !covered.has(i.id)) : []
  if (missing.length) throw new Error('知识网未覆盖：' + missing.map((i) => i.label).join('、'))
}

export function scopedPack(scope: ScopeSpec, raw: unknown[], packId: string): Pack {
  validateScope(scope)
  if (!Array.isArray(raw)) throw new Error('AI 未返回可用的考点列表。')
  if (raw.length > 100) throw new Error('生成的节点过多，请缩小学习范围。')
  const nodes: KNode[] = raw.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('生成结果含有无效考点。')
    const n = item as Record<string, unknown>
    if (typeof n.id !== 'string' || typeof n.name !== 'string' || (n.parentId !== null && typeof n.parentId !== 'string')) {
      throw new Error('生成结果缺少有效的考点 ID、名称或父级。')
    }
    const strings = (value: unknown) => Array.isArray(value) ? value.map(String) : []
    return {
      id: n.id, name: n.name.trim().slice(0, 80), parentId: n.parentId,
      kind: n.kind === 'root' || n.kind === 'skill' ? n.kind : 'concept',
      examWeight: typeof n.examWeight === 'number' && Number.isFinite(n.examWeight) ? Math.max(0, Math.min(1, n.examWeight)) : 0.5,
      weightSource: 'ai', brief: typeof n.brief === 'string' ? n.brief.slice(0, 240) : '',
      scopeIds: strings(n.scopeIds), supplementary: n.supplementary === true,
      prereq: strings(n.prereq), confusable: strings(n.confusable)
    }
  })
  const pack: Pack = {
    packId, title: scope.topic, subject: scope.subject, totalScore: 150, source: '按确认范围生成',
    meta: { exam: '', subject: scope.subject, chapter: scope.topic }, scope, nodes, relations: relationships(nodes)
  }
  validateGraph(pack)
  return pack
}
