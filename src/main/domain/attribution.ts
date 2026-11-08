import type { AttemptRecord, ErrorReason, KNode, Mastery } from '../../shared/types'
import { masteryScore } from '../../shared/mastery'
import { assessNode } from './learning'
import { primaryAttemptNode } from './attempt-log'

/** 错因的唯一列表，界面按这个顺序排按钮 */
export const REASONS: { key: Exclude<ErrorReason, null>; label: string; hint: string }[] = [
  { key: 'calc', label: '算错了', hint: '思路对，只是手滑' },
  { key: 'misread', label: '看错题', hint: '漏了条件或看串了' },
  { key: 'formula', label: '公式记错', hint: '用错了公式/定理' },
  { key: 'concept', label: '概念不清', hint: '这个点本身没搞明白' },
  { key: 'method', label: '方法不会', hint: '不知道该用哪套办法' },
  { key: 'guess', label: '蒙的', hint: '基本靠猜' }
]

type ReasonKey = Exclude<ErrorReason, null>

/**
 * 同一套 key，不同学科换说法。
 *
 * key 不能变——掌握度的惩罚系数是按 key 定的（算错了扣得少、概念不清扣得多）。
 * 变的是给人看的标签：英语卷子上不会出现"公式记错"这种选项。
 */
const BY_SUBJECT: Record<string, Partial<Record<ReasonKey, { label: string; hint: string }>>> = {
  数学: {}, // 默认就是数学口径
  物理: {
    calc: { label: '算错了', hint: '式子列对了，数字或代数出错' },
    formula: { label: '公式记错', hint: '用错了公式或适用条件' },
    method: { label: '模型建错', hint: '受力/过程分析没理清' },
    misread: { label: '看错题', hint: '漏了条件，或单位、方向搞反' }
  },
  化学: {
    calc: { label: '计算错', hint: '物质的量、浓度这类算错' },
    formula: { label: '方程式写错', hint: '配平、条件、产物不对' },
    method: { label: '推断断了', hint: '思路走到一半推不下去' },
    misread: { label: '条件漏看', hint: '漏了"过量""标况"这类前提' }
  },
  生物: {
    calc: { label: '算错了', hint: '遗传比例一类算错' },
    formula: { label: '概念记混', hint: '把相近的过程记串了' },
    method: { label: '不会分析', hint: '不知道怎么从题干推结论' },
    misread: { label: '图/表看错', hint: '曲线、表格的趋势读反了' }
  },
  英语: {
    calc: { label: '粗心', hint: '明明会，手滑选错' },
    formula: { label: '语法点不熟', hint: '时态、从句这类没掌握' },
    concept: { label: '词义不认识', hint: '单词或短语不认识' },
    method: { label: '句子没读懂', hint: '长难句结构没理清' },
    misread: { label: '审题偏差', hint: '问的和他答的不是一回事' },
    guess: { label: '凭语感猜的', hint: '说不出依据' }
  },
  语文: {
    calc: { label: '笔误', hint: '写错字、抄错' },
    formula: { label: '手法记混', hint: '表现手法、文体知识记错' },
    concept: { label: '文言字词不懂', hint: '实词、虚词、句式没过关' },
    method: { label: '没踩到点', hint: '答题角度不对，答不到给分点' },
    misread: { label: '审题偏差', hint: '问的是"分析"，答成了"概括"' }
  }
}

/** 学科对不上时的说法，避免出现明显不属于该学科的词 */
const GENERIC: Record<ReasonKey, { label: string; hint: string }> = {
  calc: { label: '粗心算错', hint: '思路对，只是手滑' },
  misread: { label: '看错题', hint: '漏了条件或看串了' },
  formula: { label: '知识点记错', hint: '该用的定理/规则记错了' },
  concept: { label: '概念不清', hint: '这个点本身没搞明白' },
  method: { label: '方法不会', hint: '不知道该用哪套办法' },
  guess: { label: '蒙的', hint: '基本靠猜' }
}

/**
 * 按学科取错因选项。
 * @param subject 学科名（"数学"/"英语"…），缺省或未知时用中性说法
 */
export function reasonsFor(subject?: string): { key: ReasonKey; label: string; hint: string }[] {
  const s = String(subject ?? '').trim()
  // 没给学科 = 内置章节（数学），保持数学口径
  if (!s) return REASONS
  // 支持"高中英语""英语（新高考）"这类带前缀的写法
  const hit = Object.keys(BY_SUBJECT).find((k) => s.includes(k))
  return REASONS.map((r) => {
    // 学科认不出来：一律退回中性说法，绝不硬套数学
    if (!hit) return { key: r.key, ...GENERIC[r.key] }
    // 数学本身就是默认口径，原样返回
    if (hit === '数学') return r
    const over = BY_SUBJECT[hit][r.key]
    return { key: r.key, ...(over ?? GENERIC[r.key]) }
  })
}

export const REASON_LABEL: Record<string, string> = Object.fromEntries(
  REASONS.map((r) => [r.key, r.label])
)

export interface ReasonCount {
  reason: Exclude<ErrorReason, null>
  count: number
}

/** 某个考点上，错因各出现过几次（只看错题，且用户填了原因） */
export function errorBreakdown(attempts: AttemptRecord[], nodeId: string): ReasonCount[] {
  const acc = new Map<Exclude<ErrorReason, null>, number>()
  for (const a of attempts) {
    if (a.nodePrimary !== nodeId || a.correct || !a.errorReason) continue
    const r = a.errorReason as Exclude<ErrorReason, null>
    acc.set(r, (acc.get(r) ?? 0) + 1)
  }
  return [...acc.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
}

export function dominantReason(attempts: AttemptRecord[], nodeId: string): ReasonCount | null {
  return errorBreakdown(attempts, nodeId)[0] ?? null
}

export interface Suggestion {
  text: string
  /** 建议先去看哪个考点（点一下跳过去） */
  goto?: string
}

/**
 * 错因 → 下一步动作。这是"归因"真正的价值：
 * 同样是错，算错和概念不清要吃完全不同的药。
 */
export function suggestionFor(
  reason: Exclude<ErrorReason, null>,
  node: KNode,
  mastery: Record<string, Mastery>,
  nodes: KNode[],
  now: number,
  attempts: AttemptRecord[] = []
): Suggestion {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const weakPre = node.prereq.filter((id) => byId.has(id))
    .map((id) => ({ id, assessment: assessNode({ mastery, attempts }, id, now) }))
    .find((p) => p.assessment.label !== '稳定')
  const preName = weakPre ? (byId.get(weakPre.id)?.name ?? weakPre.id) : ''

  switch (reason) {
    case 'calc':
      return { text: '思路是对的，别刷题，下次把计算步骤写全、回头验算一遍。' }
    case 'misread':
      return { text: '读题时先把关键词圈出来（「至少」「非负」「整数」），再动笔。' }
    case 'formula':
      return { text: '把这个公式和它的适用条件单独记一张卡，明天再自测一次。' }
    case 'method':
      return { text: '这是"方法不会"，需要先看一遍标准解法的步骤模板，再练两道同类题。' }
    case 'guess':
      return { text: '回看解题依据，再用一道不同的题验证。' }
    case 'concept':
    default:
      if (weakPre) {
        const latest = [...new Map(attempts.filter((a) => !a.guessed && primaryAttemptNode(a) === weakPre.id)
          .sort((a, b) => a.submittedAt - b.submittedAt).map((a) => [a.questionId, a])).values()]
          .sort((a, b) => b.submittedAt - a.submittedAt).slice(0, 2)
        if (weakPre.assessment.action === 'gap' && latest.length === 2 && latest.every((a) => !a.correct)) {
          return { text: `必要前置「${preName}」在两道不同的题上连续出错，优先补这一块。`, goto: weakPre.id }
        }
        return { text: `先验证必要前置「${preName}」，再判断从哪里补起。`, goto: weakPre.id }
      }
      return { text: '这个考点本身没打牢，建议回看讲解，然后从最简单的题重新做起。' }
  }
}

/** 面板用：一句话总结这个考点"主要错在哪" */
export function attributionLine(
  node: KNode,
  attempts: AttemptRecord[],
  mastery: Record<string, Mastery>,
  nodes: KNode[],
  now: number
): { reason: Exclude<ErrorReason, null>; label: string; count: number; total: number; suggestion: Suggestion } | null {
  const dom = dominantReason(attempts, node.id)
  if (!dom) return null
  const total = errorBreakdown(attempts, node.id).reduce((s, r) => s + r.count, 0)
  return {
    reason: dom.reason,
    label: REASON_LABEL[dom.reason] ?? dom.reason,
    count: dom.count,
    total,
    suggestion: suggestionFor(dom.reason, node, mastery, nodes, now, attempts)
  }
}

/** 掌握度分档的辅助：给热力表/面板判断"是不是缺口" */
export function isGap(m: Mastery, now: number): boolean {
  return masteryScore(m, now) < 0.4
}
