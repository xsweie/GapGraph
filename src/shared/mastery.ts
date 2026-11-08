import type { ErrorReason, Mastery, SelfLevel } from './types'

export const DAY = 86_400_000

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

export const SCHEMA_VERSION = 2

export function freshMastery(K = 0): Mastery {
  const selfLevel: SelfLevel = K >= 1 ? 'basic' : K >= 0.5 ? 'weak' : 'none'
  return {
    K,
    A: 0.3,
    s: 1,
    n: 0,
    nok: 0,
    W: 0,
    Aw: 0,
    misconception: 0,
    lastAt: null,
    evidence: K > 0 ? 'self' : 'none',
    schemaVersion: SCHEMA_VERSION,
    selfLevel,
    selfAt: null,
    abilityFrom: 'v2'
  }
}

/**
 * 这个掌握状态来自什么证据。
 *
 * 以 n/K 为准来推导，**不直接信任 `evidence` 字段**：
 * 字段只是写下来方便排查，一旦它和 n 打架（老存档、手工构造的 fixture），
 * 以"有没有真的答过题"为准，否则会出现 n=4 却自称"只是自评"的怪状态。
 */
export function evidenceOf(m: Mastery): 'none' | 'self' | 'tested' {
  if (m.n > 0) return 'tested'
  if (m.K > 0 || (m.selfLevel && m.selfLevel !== 'none' && m.selfLevel !== 'unknown')) return 'self'
  return 'none'
}

/** 自评档位（读的时候兼容老数据：没有 selfLevel 就看 K） */
export function selfLevelOf(m: Mastery): SelfLevel {
  if (m.selfLevel) return m.selfLevel
  if (m.K >= 1) return 'basic'
  if (m.K >= 0.5) return 'weak'
  return 'none'
}

/** 证据的半衰期：21 天。超过这个尺度，旧作答的影响开始明显变淡 */
export const EVIDENCE_TAU_DAYS = 21

/**
 * 按次数的衰减：同一天里刷 100 题，光靠"时间"分不出第 1 题和第 100 题，
 * 会让当天的一次爆发式进步被平均掉。每做一题把旧证据乘一次 0.93，
 * 等效记忆约 14 题 —— 比旧模型（约 3 题）稳，又比纯时间衰减灵敏。
 */
export const EVIDENCE_ATTEMPT_DECAY = 0.93

export function retention(m: Mastery, now: number): number {
  if (!m.lastAt) return 1
  const days = Math.max(0, (now - m.lastAt) / DAY)
  return Math.exp(-days / Math.max(m.s, 0.5))
}

/**
 * 自评的"展示参考值"。
 *
 * 注意：这**不是**能力估计，只用来在还没有任何答题证据时给个初始印象。
 * v2 起它不参与 masteryScore，也不再进优先级公式。
 */
export function selfPrior(K: number): number {
  if (K >= 1) return 0.3
  if (K >= 0.5) return 0.15
  return 0
}

/**
 * 综合掌握度 = 纯能力估计。
 *
 * v2 起做了两处减法：
 *   ① 不再乘 K —— 自评是主观报告，不该给能力封顶，也不该在"自评没学过"时把能力压成 0
 *   ② 不再乘 R —— 久没复习是"该复习了"，不是"变笨了"；
 *      记忆衰减只通过 isDue/复习调度起作用
 *
 * 所以：只有答题证据能改变这个数；没有证据时返回自评参考值（仅用于界面兜底）。
 */
export function masteryScore(m: Mastery, now: number): number {
  void now
  if (m.n === 0) return selfPrior(m.K)
  return clamp01(m.misconception ? m.A * 0.85 : m.A)
}

/**
 * 证据可信度：只反映"证据够不够、新不新鲜"，与能力高低无关。
 * 0 = 一点证据都没有，1 = 证据非常充分。
 */
export function confidence(n: number): number {
  return 1 - Math.exp(-n / 4)
}

/**
 * 取累加器：老存档 / 测试里手写的 Mastery 只有 n/nok，没有 W/Aw。
 * 缺了就按 n/nok 回填，等价于"这些证据都还算新鲜"，
 * 否则会被当成零证据，掌握度和置信度一起塌到地板上。
 */
function accum(m: Mastery): { W: number; Aw: number } {
  const W = typeof m.W === 'number' ? m.W : NaN
  const Aw = typeof m.Aw === 'number' ? m.Aw : NaN
  if (Number.isFinite(W) && Number.isFinite(Aw) && W > 0) return { W, Aw }
  const n = Math.max(0, m.n ?? 0)
  const nok = Math.max(0, m.nok ?? 0)
  return { W: n, Aw: Math.min(n, nok) }
}

/**
 * 有效证据量：时间衰减后的权重和。
 *
 * 和"做过多少题"不是一回事——几天不练就说明证据在变旧，
 * 哪怕历史累计做过 100 题，也不该还挂着 99% 的置信度。
 */
export function evidenceW(m: Mastery, now: number): number {
  const { W } = accum(m)
  if (!m.lastAt || W <= 0) return W
  const days = Math.max(0, (now - m.lastAt) / DAY)
  return W * Math.exp(-days / EVIDENCE_TAU_DAYS)
}

export function evidConfidence(m: Mastery, now: number): number {
  return confidence(evidenceW(m, now))
}

/**
 * 对外统一的四元组。
 *
 * v2 的重要变化：`eff` 不再向 0.3 收缩。
 * 旧公式 `conf*M + (1−conf)*0.3` 会把"证据少"直接翻译成"大概 0.3 分"，
 * 再拿这个假分数去排缺口——于是**没测过的节点被当成薄弱项排在前面**。
 * 现在 `known` 明确表示"有没有证据"，排序方必须自己决定怎么处理未知，
 * 不能再靠一个捏造的数字蒙混过去。
 */
export function effective(
  m: Mastery,
  now: number
): { M: number; conf: number; eff: number; known: boolean; retention: number } {
  const M = masteryScore(m, now)
  const conf = evidConfidence(m, now)
  return { M, conf, eff: M, known: m.n > 0, retention: retention(m, now) }
}

export interface AttemptEffect {
  difficulty: number
  correct: boolean
  weight: number
  sure: boolean
  /** 系统判定疑似蒙对（过快且正确） */
  guessed: boolean
  now: number
  /** 用户在答错后选的错因；决定这次错误该扣多狠 */
  errorReason?: ErrorReason | null
}

/**
 * 不同错因对"能力值"的惩罚系数。
 * 算错了 / 看错题：思路是对的，几乎不该降分；
 * 概念不清：最该降，因为下次照样会错。
 */
const PENALTY: Record<string, number> = {
  calc: 0.2,
  misread: 0.25,
  formula: 0.8,
  method: 0.9,
  concept: 1.0,
  guess: 0.5
}

/** 这几种错是"手滑"，不该让记忆稳定性崩掉 */
const SLIP: Record<string, true> = { calc: true, misread: true }

/**
 * 一次作答对单个考点的更新。
 * 疑似蒙对仅保留原始作答，不刷新能力、证据和复习时钟。
 * 「我很确定但答错」：标记 misconception，掌握度额外打八五折（手滑类不算）。
 */
export function applyAttempt(m: Mastery, e: AttemptEffect): Mastery {
  if (e.guessed && e.correct) {
    return m
  }

  const days = m.lastAt ? (e.now - m.lastAt) / DAY : 0
  const R = Math.exp(-Math.max(0, days) / Math.max(m.s, 0.5))
  const wDiff = 0.6 + 0.4 * ((e.difficulty - 1) / 4)
  const penalty = e.correct ? 1 : (PENALTY[e.errorReason ?? ''] ?? 0.8)

  /**
   * 能力值 A 改成"带绝对时间衰减的加权估计"。
   *
   * 旧做法是固定步长的滑动平均（A += 0.35·(obs−A)），两个毛病：
   *   ① 等效记忆只有约 3 题，一次手滑就掉三成，分数剧烈摆动
   *   ② 衰减看的是"距上次作答多久"，一天内连刷 100 题时全部权重相等，
   *      3 个月前那批错题和刚才的错题一样重
   *
   * 现在每次先把累加器按真实时间衰减，再叠加本次证据：
   *   W  = W·e^(−Δ/τ) + w      权重和（也就是有效样本量）
   *   Aw = Aw·e^(−Δ/τ) + w·答对  加权正确和
   *   A  = Aw / W
   * 于是"很久以前错的"会被稀释，"最近对的"占主导，
   * 而停止练习后 W 自己也会衰减，置信度跟着回落。
   */
  // 两种衰减叠加：时间（跨天变旧）+ 次数（同一天内也被后面的题压过去）
  const decay = Math.exp(-Math.max(0, days) / EVIDENCE_TAU_DAYS) * EVIDENCE_ATTEMPT_DECAY
  const w = wDiff * penalty

  /**
   * 先验：把"作答之前的 A"当成 1 个伪计数。
   * 没有它的话，第一次作答就会把 A 直接算成 0 或 1（Aw/W = 0/w），
   * 之前的自评、以及"一次失误不等于全盘不会"这件事全丢了。
   */
  const base = accum(m)
  const baseW = base.W > 0 ? base.W : 1
  const baseAw = base.W > 0 ? base.Aw : m.A

  const W = baseW * decay + w
  const Aw = baseAw * decay + w * (e.correct ? 1 : 0)
  const A = W > 0 ? clamp01(Aw / W) : m.A

  const slip = !e.correct && !!SLIP[e.errorReason ?? '']
  const s = e.correct ? m.s * (1 + 1.2 * (1 - R) * wDiff) : slip ? Math.max(1, m.s * 0.85) : Math.max(1, m.s * 0.45)
  const misconception: 0 | 1 = !e.correct && e.sure && !slip ? 1 : m.misconception

  // 旧字段 K 保持写回（历史兼容），但 v2 起不再参与任何计算。
  // 能力能不能抬，只看 A 有没有真的被证据推上去，不看"自评说过会"。
  let K = Math.max(m.K, 0.5)
  if (e.correct && A >= 0.6) {
    K = Math.min(1, Math.round((K + 0.2) * 100) / 100)
  }

  return {
    ...m,
    K,
    A,
    W,
    Aw,
    s,
    n: m.n + 1,
    nok: m.nok + (e.correct ? 1 : 0),
    misconception,
    lastAt: e.now,
    // 只要走过一次有效作答（蒙对被跳过，不会走到这里），状态就从"自评"升级为"有证据"
    evidence: 'tested',
    schemaVersion: SCHEMA_VERSION,
    abilityFrom: 'v2'
  }
}

/** 设置自评档位。自评只影响展示与建议，**不改能力估计** */
export function setSelfLevel(m: Mastery, level: SelfLevel, now: number): Mastery {
  const K = level === 'basic' ? 1 : level === 'weak' ? 0.5 : 0
  return {
    ...m,
    K, // 同步旧字段，老界面/老逻辑读 K 时不会错乱
    selfLevel: level,
    selfAt: now,
    evidence: m.n > 0 ? 'tested' : level === 'none' ? 'none' : 'self',
    schemaVersion: SCHEMA_VERSION
  }
}

export function isDue(m: Mastery, now: number): boolean {
  if (!m.lastAt || m.n === 0) return false
  return retention(m, now) < 0.7
}

export function dueUrgency(m: Mastery, now: number): number {
  return (0.7 - retention(m, now)) / 0.7
}

/**
 * 色带。
 * - unmeasured：什么信息都没有
 * - self：只有自评，还没做过题 —— 独立一档，避免"自评不会"被画成红色"塌了"
 * - 其余四档：有作答证据之后的掌握程度
 */
export type Band = 'red' | 'orange' | 'yellow' | 'green' | 'self' | 'unmeasured'

export function band(m: Mastery, now: number): Band {
  const ev = evidenceOf(m)
  if (ev === 'none') return 'unmeasured'
  // 自评还没被答题验证：单独一档，不参与"塌了/不稳"的判断
  if (ev === 'self') return 'self'
  const M = masteryScore(m, now)
  if (M < 0.25) return 'red'
  if (M < 0.4) return 'orange'
  if (M < 0.6) return 'yellow'
  return 'green'
}

/* ---------------- v1 → v2 迁移 ---------------- */

/**
 * 把旧 Mastery 迁移到 v2。
 *
 * 原则（对应任务书 B6）：
 * - 旧的 K 混了两种来源（自评 + 答对自动抬），**不能**直接当纯自评。
 *   但 `n === 0` 时 K 只可能来自自评（applyAttempt 一定会把 n 加一），
 *   这部分可以可靠还原成 selfLevel；
 *   n > 0 的一律标 'unknown'，宁可显示"未知"，也不编造用户的态度。
 * - 旧 A 是当时模型的估计，保留并标记 abilityFrom='v1'，
 *   不重算、不覆盖，等下一道有效答题再升级为 v2。
 * - s / lastAt / n / nok / W / Aw / misconception 原样保留。
 *
 * 幂等：已经 schemaVersion=2 的直接返回，重复执行不会改任何数。
 */
export function migrateMastery(m: Mastery): Mastery {
  if (m.schemaVersion === SCHEMA_VERSION) return m

  const n = Math.max(0, m.n ?? 0)
  let selfLevel: SelfLevel
  if (n > 0) selfLevel = 'unknown'
  else if ((m.K ?? 0) >= 1) selfLevel = 'basic'
  else if ((m.K ?? 0) >= 0.5) selfLevel = 'weak'
  else selfLevel = 'none'

  return {
    ...m,
    schemaVersion: SCHEMA_VERSION,
    selfLevel,
    // 迁移来的自评没有可信时间戳，留空而不是伪造一个
    selfAt: null,
    abilityFrom: m.n > 0 ? 'v1' : 'v2',
    evidence: n > 0 ? 'tested' : selfLevel === 'none' ? 'none' : 'self'
  }
}
