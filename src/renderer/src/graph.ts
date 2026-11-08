import type { KNode, Mastery, Relation } from '../../shared/types'
import { band as masteryBand, masteryScore } from '../../shared/mastery'
import { forceStep, hasOverlap, separateBoxes, textWidth, type ForceEdge, type ForceNode } from '../../main/domain/layout'
import { PHYSICS_DEFAULTS, type PhysicsParams } from './physics'

export type GraphMode = 'structure' | 'gap'

const NS = 'http://www.w3.org/2000/svg'

/** 逻辑画布：按节点数自适应，避免 fit 之后字缩成蚂蚁 */
let W = 1000
let H = 660

/** 颜色只编码掌握度这一件事 */
const COLOR: Record<string, string> = {
  red: 'var(--c1)',
  orange: 'var(--c2)',
  yellow: 'var(--c3)',
  green: 'var(--c5)',
  self: 'var(--self)',
  unmeasured: 'var(--c0)'
}

const LABEL_FONT = 12.5
const LABEL_GAP = 7
const MAX_LABEL_W = 132
const DOT_R = 7
const ROOT_R = 10

/**
 * 色带直接复用 shared 里的 band()，避免两处各写一套判断。
 * 之前这里自己实现了一遍，加了「自评」这一档之后就会出现两边不一致。
 */
function bandOf(m: Mastery | undefined, now: number): string {
  if (!m) return 'unmeasured'
  return masteryBand(m, now)
}

/** 文字太长就截断加省略号——标签只做"认得出"，完整名字在右栏 */
function fitLabel(name: string): string {
  const raw = [...String(name ?? '')]
  const chars = raw.length ? raw : ['?']
  let out = ''
  for (const ch of chars) {
    if (textWidth(out + ch, LABEL_FONT) > MAX_LABEL_W - LABEL_FONT) {
      return out + '…'
    }
    out += ch
  }
  return out
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag)
  for (const k in attrs) e.setAttribute(k, String(attrs[k]))
  return e
}

export interface GraphHandlers {
  onSelect: (id: string | null) => void
  onMoveNode?: (id: string, x: number, y: number) => void
  onContextMenu?: (id: string, event: MouseEvent) => void
}

/**
 * 一个节点 = 一个小圆点 + 旁边一行字。
 * 碰撞箱不是圆点本身，而是"圆点 + 文字"的整体矩形——
 * 否则字会互相压，那比圆点重叠更难读。
 */
interface NodeBox extends ForceNode {
  id: string
  node: KNode
  label: string
  /** 圆点半径 */
  r: number
  /** 碰撞箱中心到圆点的水平偏移（文字在右侧，所以是正数） */
  dx: number
  /** 文字宽度 */
  labelW: number
}

interface EdgeSpec {
  a: string
  b: string
  kind: 'tree' | 'pre' | 'con'
  why?: string
}

export class KnowledgeGraph {
  private svg: SVGSVGElement
  private cam: SVGGElement
  private gEdge: SVGGElement
  private gNode: SVGGElement

  private nodes: KNode[] = []
  private boxes = new Map<string, NodeBox>()
  private edges: EdgeSpec[] = []
  private mastery: Record<string, Mastery> = {}
  private now = Date.now()
  private selected: string | null = null
  private focusIds = new Set<string>()
  private focusVisible = new Set<string>()
  private mode: GraphMode = 'structure'
  private fold = false
  private handlers: GraphHandlers

  private k = 1
  private tx = 0
  private ty = 0

  private dragNode: { id: string; grabX: number; grabY: number } | null = null
  /** 拖动目标位置：指针只负责改这个，节点由模拟循环去跟，避免被事件频率带飞 */
  private dragTarget: { id: string; x: number; y: number } | null = null
  /** 指针最后真正移动的时刻：按住不动时应当冷却，否则力一直在推 = 高频震动 */
  private dragMovedAt = 0
  private simRaf = 0
  private simFrames = 0
  /** 温度：1 = 剧烈，接近 0 = 冷却静止。交互时重新加热（和 Obsidian 一样） */
  private alpha = 1
  private panFrom: { x: number; y: number; tx: number; ty: number } | null = null
  private downAt: { x: number; y: number } | null = null
  private edgeEls: { spec: EdgeSpec; path: SVGPathElement; label?: SVGTextElement }[] = []

  constructor(svg: SVGSVGElement, handlers: GraphHandlers) {
    this.svg = svg
    this.handlers = handlers
    this.cam = el('g')
    this.gEdge = el('g')
    this.gNode = el('g')
    const defs = el('defs')
    defs.innerHTML =
      '<marker id="arw" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0,0.5 L9,5 L0,9.5 z" fill="var(--pre)"/></marker>'
    this.svg.append(defs, this.cam)
    this.cam.append(this.gEdge, this.gNode)

    this.svg.addEventListener('wheel', this.onWheel, { passive: false })
    this.svg.addEventListener('pointerdown', this.onDown)
    this.svg.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('pointermove', this.onMove)
    window.addEventListener('pointerup', this.onUp)
  }

  destroy(): void {
    this.svg.removeEventListener('wheel', this.onWheel)
    this.svg.removeEventListener('pointerdown', this.onDown)
    this.svg.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('pointerup', this.onUp)
  }

  /* ---------------- 数据 ---------------- */

  setData(nodes: KNode[], mastery: Record<string, Mastery>, now = Date.now(), relations: Relation[] = []): void {
    this.mastery = mastery
    this.now = now
    if (this.nodes === nodes) {
      this.render()
      return
    }
    this.nodes = nodes
    this.resizeCanvas(nodes.length)
    this.edges = this.buildEdges(nodes, relations)
    this.measure()
    this.layout()
    this.render()
  }

  private resizeCanvas(n: number): void {
    // 画布给得比节点需要的宽裕得多：用户要能把节点拖到很远的地方慢慢摆。
    // 注意 fit() 按"节点包围盒"算缩放，所以画布变大不会让字变小，只是可活动区域变大。
    W = Math.round(Math.max(1800, Math.min(3600, Math.sqrt(Math.max(1, n)) * 300)))
    H = Math.round(W / 1.55)
  }

  private buildEdges(nodes: KNode[], relations: Relation[]): EdgeSpec[] {
    const ids = new Set(nodes.map((n) => n.id))
    const out: EdgeSpec[] = []
    const seen = new Set<string>()
    for (const n of nodes) if (n.parentId && ids.has(n.parentId)) out.push({ a: n.parentId, b: n.id, kind: 'tree' })
    for (const r of relations) {
      if (!ids.has(r.a) || !ids.has(r.b)) continue
      const key = `${r.kind}:${(r.kind === 'prereq' ? [r.a, r.b] : [r.a, r.b].sort()).join('|')}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ a: r.a, b: r.b, kind: r.kind === 'prereq' ? 'pre' : 'con', why: r.why })
    }
    return out
  }

  private depthOf(id: string): number {
    const byId = new Map(this.nodes.map((n) => [n.id, n]))
    let cur = byId.get(id)
    let d = 0
    const guard = new Set<string>()
    while (cur && cur.parentId && !guard.has(cur.id)) {
      guard.add(cur.id)
      cur = byId.get(cur.parentId)
      d++
      if (d > 12) break
    }
    return d
  }

  private visibleNodes(): KNode[] {
    if (!this.fold) return this.nodes
    return this.nodes.filter((n) => n.kind === 'root' || this.depthOf(n.id) <= 2 || this.focusVisible.has(n.id))
  }

  /** 量出"圆点 + 文字"的整体碰撞箱 */
  private measure(): void {
    for (const n of this.nodes) {
      const r = n.kind === 'root' ? ROOT_R : DOT_R
      const label = fitLabel(n.name)
      const labelW = textWidth(label, LABEL_FONT)
      const boxW = r * 2 + LABEL_GAP + labelW + 8
      const boxH = Math.max(r * 2 + 8, LABEL_FONT * 1.6)
      const dx = boxW / 2 - r
      const old = this.boxes.get(n.id)
      this.boxes.set(n.id, {
        id: n.id,
        node: n,
        label,
        r,
        dx,
        labelW,
        x: old?.x ?? 0,
        y: old?.y ?? 0,
        w: boxW,
        h: boxH,
        vx: 0,
        vy: 0,
        pinned: old?.pinned,
        anchor: old?.anchor
      })
    }
    for (const id of [...this.boxes.keys()]) if (!this.nodes.some((n) => n.id === id)) this.boxes.delete(id)
  }

  private physicsEdges(visIds: Set<string>): ForceEdge[] {
    return this.edges
      .filter((e) => visIds.has(e.a) && visIds.has(e.b))
      .map((e) => ({ a: e.a, b: e.b, strength: e.kind === 'tree' ? 2.4 : 0.6 }))
  }

  private listOfVisible(): NodeBox[] {
    return this.visibleNodes()
      .map((n) => this.boxes.get(n.id))
      .filter((b): b is NodeBox => !!b)
  }

  /** 力场参数：向心力 / 斥力 / 弹簧长度，和 Obsidian 关系图那几个滑杆是一回事 */
  private params(n: number): PhysicsParams & { w: number; h: number } {
    void n
    return {
      w: W,
      h: H,
      ...this.tuning
    }
  }

  /** 用户在"力学"面板里调过的参数 */
  private tuning: PhysicsParams = { ...PHYSICS_DEFAULTS }

  /** 应用一组参数：立刻加热跑一小段，让人马上看到变化 */
  setPhysics(next: Partial<PhysicsParams>): void {
    this.tuning = { ...this.tuning, ...next }
    this.alpha = Math.max(this.alpha, 0.6)
    this.startSim()
  }

  applyPhysicalBatch(next: PhysicsParams): void {
    this.tuning = { ...next }
    this.alpha = 1
    const list = this.listOfVisible()
    const edges = this.physicsEdges(new Set(list.map((b) => b.id)))
    const p = this.params(list.length)
    for (let i = 0; i < 220; i++) {
      forceStep(list, edges, { ...p, alpha: this.alpha })
      this.alpha += (0 - this.alpha) * 0.0228
    }
    separateBoxes(list, 16, 30)
    this.alpha = 0
    this.render()
    this.fit()
  }

  private layout(iterations = 340): void {
    const vis = this.visibleNodes()
    const list: NodeBox[] = []
    // 根节点钉在中心：整棵树从这个锚点往外长，而不是所有节点都被吸向中心
    const root = vis.find((n) => n.kind === 'root')
    const rootBox = root ? this.boxes.get(root.id) : undefined
    if (rootBox && (rootBox.x === 0 && rootBox.y === 0)) {
      rootBox.x = W / 2
      rootBox.y = H / 2
      rootBox.pinned = true
    }
    vis.forEach((n, i) => {
      const b = this.boxes.get(n.id)
      if (!b) return
      if (b.x === 0 && b.y === 0) {
        const ring = n.kind === 'root' ? 0 : this.depthOf(n.id)
        const rad = 60 + ring * Math.min(W, H) * 0.16
        const a = (i / Math.max(1, vis.length)) * Math.PI * 2 + ring * 0.6
        b.x = W / 2 + Math.cos(a) * rad
        b.y = H / 2 + Math.sin(a) * rad
      }
      list.push(b)
    })
    if (!list.length) return
    const edges = this.physicsEdges(new Set(list.map((b) => b.id)))
    const p = this.params(list.length)

    // 初始布局：温度从 1 一路冷到接近 0，和图打开时的"冷却"过程一致
    this.alpha = 1
    for (let i = 0; i < iterations; i++) {
      forceStep(list, edges, { ...p, alpha: this.alpha })
      if (i % 20 === 0) separateBoxes(list, 14, 6, undefined, 0.8)
      this.alpha += (0 - this.alpha) * 0.0228
    }
    separateBoxes(list, 16, 40)
    this.alpha = 0
  }

  setPositions(pos: Record<string, [number, number]>): void {
    let any = false
    for (const [id, [x, y]] of Object.entries(pos ?? {})) {
      const b = this.boxes.get(id)
      if (!b) continue
      // 存的是圆点坐标，碰撞箱中心要加回偏移
      b.x = x + b.dx
      b.y = y
      // 关键：读到的位置是"软锚"不是"钉子"——
      // 之前这里设 pinned，导致拖过一次的节点永久冻住，邻居怎么动它都不动。
      b.anchor = { x, y }
      any = true
    }
    if (any) {
      const list = this.listOfVisible()
      const edges = this.physicsEdges(new Set(list.map((b) => b.id)))
      const p = this.params(list.length)
      this.alpha = 1
      for (let i = 0; i < 140; i++) {
        forceStep(list, edges, { ...p, alpha: this.alpha })
        this.alpha += (0 - this.alpha) * 0.0228
      }
      separateBoxes(list, 16, 24)
      this.alpha = 0
      this.render()
    }
  }

  /* ---------------- 交互 ---------------- */

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const r = this.svg.getBoundingClientRect()
    this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016))
  }

  private toGraph(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.svg.getBoundingClientRect()
    return { x: (clientX - r.left - this.tx) / this.k, y: (clientY - r.top - this.ty) / this.k }
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    const t = e.target as Element
    const nodeEl = t.closest?.('.node') as SVGGElement | null
    this.downAt = { x: e.clientX, y: e.clientY }
    if (nodeEl) {
      const id = nodeEl.getAttribute('data-id') ?? ''
      const b = this.boxes.get(id)
      if (b) {
        const p = this.toGraph(e.clientX, e.clientY)
        // 抓的是圆点，不是碰撞箱中心
        const dotX = b.x - b.dx
        this.dragNode = { id, grabX: p.x - dotX, grabY: p.y - b.y }
        b.pinned = true
        nodeEl.classList.add('dragging')
      }
      return
    }
    this.panFrom = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty }
  }

  private onContextMenu = (event: MouseEvent): void => {
    const id = (event.target as Element)?.closest('.node')?.getAttribute('data-id')
    if (!id || !this.handlers.onContextMenu) return
    event.preventDefault()
    this.handlers.onContextMenu(id, event)
  }

  private onMove = (e: PointerEvent): void => {
    if (this.dragNode) {
      const b = this.boxes.get(this.dragNode.id)
      if (!b) return
      const p = this.toGraph(e.clientX, e.clientY)
      const dotX = Math.max(b.r, Math.min(W - b.r, p.x - this.dragNode.grabX))
      const dotY = Math.max(b.h / 2, Math.min(H - b.h / 2, p.y - this.dragNode.grabY))
      // 只记目标，不直接落位：模拟循环按固定节奏去跟，手感才稳
      const prev = this.dragTarget
      this.dragTarget = { id: this.dragNode.id, x: dotX, y: dotY }
      if (!prev || Math.hypot(prev.x - dotX, prev.y - dotY) > 1) this.dragMovedAt = performance.now()
      this.startSim()
      return
    }
    if (!this.panFrom) return
    this.tx = this.panFrom.tx + (e.clientX - this.panFrom.x)
    this.ty = this.panFrom.ty + (e.clientY - this.panFrom.y)
    this.applyCam()
  }

  private onUp = (e: PointerEvent): void => {
    if (e.button !== 0) return
    const moved = this.downAt ? Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) : 0
    if (this.dragNode) {
      const b = this.boxes.get(this.dragNode.id)
      const id = this.dragNode.id
      this.dragNode = null
      this.dragTarget = null
      this.gNode.querySelector('.dragging')?.classList.remove('dragging')
      if (b) {
        // 松手：解除硬钉，换成软锚——它会留在你放的地方，但邻居还能挤动它
        b.pinned = false
        if (moved >= 4) {
          b.anchor = { x: b.x - b.dx, y: b.y }
          this.handlers.onMoveNode?.(id, Math.round(b.x - b.dx), Math.round(b.y))
          this.startSim()
        }
      }
      // 按下去又松开、几乎没移动 = 点选（不是拖），选中它才看得到前置/易混
      if (moved < 4) this.handlers.onSelect(id)
      this.panFrom = null
      this.downAt = null
      return
    }
    if (this.panFrom && this.downAt && this.selected) {
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y)
      const onNode = !!(e.target as Element)?.closest?.('.node')
      if (moved < 4 && !onNode) this.handlers.onSelect(null)
    }
    this.panFrom = null
    this.downAt = null
  }

  /* ---------------- 模拟循环 ---------------- */

  private startSim(): void {
    if (this.simRaf) return
    this.simFrames = 0
    this.simRaf = requestAnimationFrame(this.simTick)
  }

  private simTick = (): void => {
    this.simRaf = 0
    if (this.simStep()) this.simRaf = requestAnimationFrame(this.simTick)
  }

  /**
   * 一帧的模拟。三个关键点决定了"力场感"：
   *  1. 固定 60Hz，跟指针事件频率无关（否则拖得越快，算得越多，越容易炸）
   *  2. 单步位移限幅 4.5px —— 邻居是"被推开"，不是"瞬移过去"
   *  3. 分离器只推 35% —— 留出回弹，看起来像弹簧不是硬碰撞
   */
  private simStep(): boolean {
    const list = this.listOfVisible()
    if (!list.length) return false
    const byId = new Map(list.map((b) => [b.id, b]))

    if (this.dragTarget) {
      const b = byId.get(this.dragTarget.id)
      if (b) {
        b.x = this.dragTarget.x + b.dx
        b.y = this.dragTarget.y
        b.vx = 0
        b.vy = 0
        // 只在拖动当下钉住；松手立刻解除，换成软锚
        b.pinned = true
      }
    }
    // 除了正在拖的那个，其余节点的 pinned 一律清掉（根节点除外，它是锚点）
    if (!this.dragTarget) {
      const rootId = this.nodes.find((n) => n.kind === 'root')?.id
      for (const b of list) {
        if (b.id !== rootId && b.pinned) b.pinned = false
      }
    }

    // 关键：只有指针**真的在移动**时才加热。
    // 按住不动还保持高温，力会一直在推、分离器一直在顶，就表现为高频抖动。
    const pointerMoving = !!this.dragTarget && performance.now() - this.dragMovedAt < 120
    if (pointerMoving) this.alpha = Math.max(this.alpha, 0.35)
    else this.alpha += (0 - this.alpha) * 0.0228

    const ids = new Set(list.map((b) => b.id))
    const edges = this.physicsEdges(ids)
    const p = this.params(list.length)
    forceStep(list, edges, { ...p, alpha: this.alpha })

    // 分离只推一部分：拖动时软推（像磁铁），松手后加力收敛
    const settling = !this.dragTarget
    const pinned = list.filter((b) => b.pinned).map((b) => ({ b, x: b.x, y: b.y }))
    separateBoxes(list, 12, settling ? 3 : 1, { w: W, h: H }, settling ? 0.8 : 0.3)
    for (const pin of pinned) {
      pin.b.x = pin.x
      pin.b.y = pin.y
    }

    this.syncAll()

    // 注意：这里不再"一检测到重叠就重新加热"。
    // 之前那样做，只要有一对箱子轻微重叠，温度就永远降不下来，
    // 力一直在推、分离器一直在顶，视觉上就是高频抖动。
    const overlapping = hasOverlap(list, 6)
    const busy = this.alpha > 0.006 || overlapping || pointerMoving
    if (!busy) return false
    if (this.simFrames++ > 900) {
      this.simFrames = 0
      return false
    }
    return true
  }

  private applyCam(): void {
    this.cam.setAttribute('transform', `translate(${this.tx},${this.ty}) scale(${this.k})`)
  }

  zoomAt(mx: number, my: number, factor: number): void {
    const nk = Math.max(0.2, Math.min(3, this.k * factor))
    this.tx = mx - (mx - this.tx) * (nk / this.k)
    this.ty = my - (my - this.ty) * (nk / this.k)
    this.k = nk
    this.applyCam()
  }

  fit(ids?: ReadonlySet<string>): void {
    const vis = this.listOfVisible().filter((box) => !ids || ids.has(box.id))
    if (!vis.length) return
    const r = this.svg.getBoundingClientRect()
    const pad = 44
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const b of vis) {
      minX = Math.min(minX, b.x - b.w / 2)
      minY = Math.min(minY, b.y - b.h / 2)
      maxX = Math.max(maxX, b.x + b.w / 2)
      maxY = Math.max(maxY, b.y + b.h / 2)
    }
    const raw = Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY))
    this.k = Math.max(ids ? 0.2 : 0.62, Math.min(1.6, raw))
    this.tx = r.width / 2 - ((minX + maxX) / 2) * this.k
    this.ty = r.height / 2 - ((minY + maxY) / 2) * this.k
    this.applyCam()
  }

  select(id: string | null): void {
    if (this.selected === id) {
      this.applyDim()
      return
    }
    this.selected = id
    this.applyDim()
  }

  setFocus(ids: ReadonlySet<string>): void {
    const byId = new Map(this.nodes.map((node) => [node.id, node]))
    const valid = new Set([...ids].filter((id) => byId.has(id)))
    if (valid.size === this.focusIds.size && [...valid].every((id) => this.focusIds.has(id))) return
    this.focusIds = valid
    this.svg.dataset.focus = valid.size ? 'plan' : ''
    this.focusVisible = new Set()
    for (const id of valid) {
      let node = byId.get(id)
      while (node && !this.focusVisible.has(node.id)) {
        this.focusVisible.add(node.id)
        node = node.parentId ? byId.get(node.parentId) : undefined
      }
    }
    if (this.fold) this.render()
    else this.applyDim()
  }

  setMode(mode: GraphMode): void {
    this.mode = mode
    this.svg.dataset.mode = mode
    this.applyDim()
  }

  setFold(fold: boolean): void {
    this.fold = fold
    this.render()
  }

  isFolded(): boolean {
    return this.fold
  }

  /** 清掉所有软锚和拖拽位置，重新排一次——"我把图拖乱了"的逃生口 */
  resetLayout(): void {
    for (const b of this.boxes.values()) {
      b.anchor = undefined
      b.pinned = false
      b.vx = 0
      b.vy = 0
    }
    this.measure()
    this.layout(360)
    this.render()
    this.fit()
  }

  /* ---------------- 渲染 ---------------- */

  private dotPos(b: NodeBox): { x: number; y: number } {
    return { x: b.x - b.dx, y: b.y }
  }

  /**
   * 边的几何：
   *  - 起点从圆点边缘出发、终点停在圆点边缘外，箭头才不会被节点盖住
   *  - 前置/易混用弧线：直线会横穿整张图，弧线既避开别的节点，也能和结构线区分开
   */
  private edgeGeometry(a: NodeBox, b: NodeBox, kind: EdgeSpec['kind']): { d: string; mid: { x: number; y: number } } {
    const pa = this.dotPos(a)
    const pb = this.dotPos(b)
    const dx = pb.x - pa.x
    const dy = pb.y - pa.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    // 起点留出 a 的半径，终点留出 b 的半径 + 箭头长度
    const padA = a.r + 2
    const padB = b.r + (kind === 'pre' ? 9 : 3)
    const x1 = pa.x + ux * Math.min(padA, len / 2)
    const y1 = pa.y + uy * Math.min(padA, len / 2)
    const x2 = pb.x - ux * Math.min(padB, len / 2)
    const y2 = pb.y - uy * Math.min(padB, len / 2)

    // 前置往一侧弯，易混往另一侧弯，两条同时出现也不会叠在一起
    const bow = kind === 'pre' ? 0.18 : kind === 'con' ? -0.18 : 0
    const cx = (x1 + x2) / 2 + -uy * len * bow
    const cy = (y1 + y2) / 2 + ux * len * bow
    // 标签沿曲线中点再往弯的外侧推一点，避免压在线上或压到别的节点
    const nx = -uy * Math.sign(bow || 1)
    const ny = ux * Math.sign(bow || 1)
    const mid = { x: (x1 + 2 * cx + x2) / 4 + nx * 14, y: (y1 + 2 * cy + y2) / 4 + ny * 14 }
    const d = bow === 0 ? `M${x1},${y1} L${x2},${y2}` : `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`
    return { d, mid }
  }

  render(): void {
    this.gEdge.innerHTML = ''
    this.gNode.innerHTML = ''
    this.edgeEls = []

    const vis = this.visibleNodes()
    const visIds = new Set(vis.map((n) => n.id))

    for (const spec of this.edges) {
      if (!visIds.has(spec.a) || !visIds.has(spec.b)) continue
      const a = this.boxes.get(spec.a)
      const b = this.boxes.get(spec.b)
      if (!a || !b) continue
      const geo = this.edgeGeometry(a, b, spec.kind)
      const g = el('g', { class: 'edge', 'data-a': spec.a, 'data-b': spec.b })
      const path = el('path', { class: `e-${spec.kind}`, d: geo.d })
      if (spec.kind === 'pre') path.setAttribute('marker-end', 'url(#arw)')
      g.append(path)
      // 关系边的"为什么"：只有选中相关节点时才显示，否则满屏字。
      // 太长会互相压，截到 14 个字，完整意思在右栏。
      if (spec.why && spec.kind !== 'tree') {
        const t = el('text', { class: 'elab', x: geo.mid.x, y: geo.mid.y })
        t.textContent = spec.why.length > 14 ? spec.why.slice(0, 14) + '…' : spec.why
        g.append(t)
      }
      this.gEdge.append(g)
      this.edgeEls.push({ spec, path, label: spec.why && spec.kind !== 'tree' ? (g.querySelector('.elab') as SVGTextElement) : undefined })
    }

    for (const n of vis) {
      const b = this.boxes.get(n.id)
      if (!b) continue
      const band = n.kind === 'root' ? 'root' : bandOf(this.mastery[n.id], this.now)
      const p = this.dotPos(b)
      const g = el('g', { class: `node ${n.kind === 'root' ? 'root' : band}`, 'data-id': n.id, transform: `translate(${p.x},${p.y})` })
      const fill = n.kind === 'root' ? 'var(--ink)' : COLOR[band] ?? COLOR.unmeasured

      // 命中区：圆点 + 文字整块都能点，不然小圆点太难点中
      g.append(
        el('rect', {
          class: 'hit',
          x: -b.r - 4,
          y: -b.h / 2,
          width: b.w - 2,
          height: b.h,
          rx: 6,
          fill: 'transparent'
        })
      )
      g.append(el('circle', { class: 'dot', r: b.r, fill }), el('circle', { class: 'plan-ring', r: b.r + 4 }))
      const t = el('text', { x: b.r + LABEL_GAP, y: 0, 'font-size': LABEL_FONT, 'font-weight': n.kind === 'root' ? 700 : 500 })
      t.textContent = b.label
      g.append(t)
      this.gNode.append(g)
    }

    this.applyDim()
  }

  /** 拖动过程中把位置同步到 DOM（不重建节点，避免闪烁） */
  private syncAll(): void {
    for (const [id, b] of this.boxes) {
      const g = this.gNode.querySelector(`.node[data-id="${CSS.escape(id)}"]`) as SVGGElement | null
      if (!g) continue
      const p = this.dotPos(b)
      g.setAttribute('transform', `translate(${p.x},${p.y})`)
    }
    for (const { spec, path, label } of this.edgeEls) {
      const a = this.boxes.get(spec.a)
      const c = this.boxes.get(spec.b)
      if (!a || !c) continue
      const geo = this.edgeGeometry(a, c, spec.kind)
      path.setAttribute('d', geo.d)
      if (label) {
        label.setAttribute('x', String(geo.mid.x))
        label.setAttribute('y', String(geo.mid.y))
      }
    }
  }

  private applyDim(): void {
    const focus = this.selected
    const planning = this.focusIds.size > 0
    this.gEdge.querySelectorAll('.edge').forEach((e) => {
      const a = e.getAttribute('data-a') ?? ''
      const b = e.getAttribute('data-b') ?? ''
      const within = planning && this.focusIds.has(a) && this.focusIds.has(b)
      const on = !planning && !!focus && (a === focus || b === focus)
      e.classList.toggle('ctx', on)
      e.classList.toggle('plan-edge', within)
      e.classList.toggle('dim', planning ? !within : !!focus && !on)
    })
    this.gNode.querySelectorAll('.node').forEach((n) => {
      const id = n.getAttribute('data-id') ?? ''
      let dim = planning ? !this.focusIds.has(id) : !!focus && id !== focus
      if (!planning && !focus && this.mode === 'gap') {
        const m = this.mastery[id]
        const weak = !m || m.n === 0 || masteryScore(m, this.now) < 0.4
        dim = !weak
      }
      n.classList.toggle('dim', dim)
      n.classList.toggle('sel', id === focus)
    })
  }

  snapshotPositions(): Record<string, [number, number]> {
    const out: Record<string, [number, number]> = {}
    for (const [id, b] of this.boxes) {
      const p = this.dotPos(b)
      out[id] = [Math.round(p.x), Math.round(p.y)]
    }
    return out
  }
}
