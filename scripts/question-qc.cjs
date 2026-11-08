/**
 * 题目质量闸门（纯函数，proxy 与离线脚本共用）。
 *
 * 由来：一道化学判断题「C4H10 两种异构体的一氯代物分别是 2 种和 2 种」
 * 被判成 false，而它的解析里明写着「所以说法正确」。
 * 出题和复核用的是同一个模型，两次都答 false，于是双双放行。
 *
 * 这里补两件事：
 *   ① 复核不再「再做一遍」，而是强制先把中间结果列出来（见 verifyPromptFor）
 *   ② 解析自洽检查：解析的结论方向必须和 answer 一致（qcProblems）
 */

/** 结论词：注意"不正确"要算否定，不能只看"正确"两个字 */
const CONCL_RE = /(不正确|不对|不成立|有误|错误|正确无误|正确|成立|无误)/g

function polarityOf(word) {
  return /^(不|有误|错误)/.test(word) ? 'false' : 'true'
}

/**
 * 从一段解析里读出"最终结论"的方向。
 * 取最后一次出现的结论词——解析的结论一般在末尾。
 * @returns {'true'|'false'|null}
 */
function conclusionPolarity(text) {
  const s = String(text ?? '')
  if (!s) return null
  let last = null
  CONCL_RE.lastIndex = 0
  let m
  while ((m = CONCL_RE.exec(s)) !== null) {
    last = polarityOf(m[1])
  }
  return last
}

/** 归一化：去空白与标点，用于宽松比对 */
function flat(s) {
  return String(s ?? '')
    .replace(/\s+/g, '')
    .replace(/[，。；：、,.;:'"“”‘’（）()【】\[\]]/g, '')
    .toLowerCase()
}

/** 判断题的答案统一成 'true' / 'false'（也接受中文写法） */
function judgeAnswerIsTrue(v) {
  const t = String(v ?? '').trim().toLowerCase()
  if (['true', 't', '正确', '对', '是', '√', 'yes'].includes(t)) return true
  if (['false', 'f', '错误', '错', '否', '×', 'no'].includes(t)) return false
  return null
}

/**
 * 解析里"共 N 种 / N 个"这类计数，和同一句里枚举出来的条目数对不上。
 * 只认"括号内用、或，分隔"这种高置信写法，避免误杀。
 */
function countMismatch(text) {
  const s = String(text ?? '')
  const re = /(\d+)\s*(种|个|条|项)[^。；;]{0,40}?[（(]([^（）()]{2,80})[）)]/g
  let m
  while ((m = re.exec(s)) !== null) {
    const claimed = Number(m[1])
    const items = m[3]
      .split(/[、,，]/)
      .map((x) => x.trim())
      .filter(Boolean)
    if (items.length >= 2 && Number.isFinite(claimed) && items.length !== claimed) {
      return `解析里写"${claimed}${m[2]}"，但只列出了 ${items.length} 项：${items.join('、')}`
    }
  }
  return null
}

/**
 * 题目自洽检查。返回问题描述数组，空数组 = 通过。
 * 只放高置信规则：宁可漏，不可误杀。
 */
function qcProblems(q) {
  const out = []
  if (!q || typeof q !== 'object') return ['不是对象']

  // ① 判断题：解析的结论方向必须和 answer 一致
  if (q.type === 'judge') {
    const expect = judgeAnswerIsTrue(q.answer) // boolean | null
    const concl = conclusionPolarity(q.solution) // 'true' | 'false' | null
    const conclBool = concl === null ? null : concl === 'true'
    if (expect !== null && conclBool !== null && expect !== conclBool) {
      out.push(`解析结论与答案矛盾：answer=${expect ? '正确' : '错误'}，解析结论=${conclBool ? '正确' : '错误'}`)
    }
  }

  // ② 计数自相矛盾（任意题型）
  const cm = countMismatch(q.solution)
  if (cm) out.push(cm)

  return out
}

/**
 * 复核提示词：按题型强制"先列中间结果，再下结论"。
 *
 * 为什么不继续用「独立再做一遍」：
 * 同一道 C4H10 判断题，让模型直接判真假它答 false（和出题一样错）；
 * 要求它先把每种一氯代物名字列出来，它就列成 2+2，然后只能答 true。
 * 差别不在上下文，在于错误有没有地方藏。
 */
function verifyPromptFor(q) {
  const opt =
    q.type === 'single' ? `\n选项：${(q.options || []).map((o, i) => `${'ABCD'[i]}. ${o}`).join('  ')}` : ''

  if (q.type === 'judge') {
    return `题目：${q.stem}${opt}

先做两步，再判断：
1) 把命题涉及的每个对象/每种情况**逐一列出**（名称或数量写清楚，不要省略）
2) 数一数它们是否与命题里说的数目一致
最后判断命题真假，answer 输出 "true" 或 "false"。

输出：{"steps":"逐项列出的内容","answer":"true","ambiguous":false}`
  }

  if (q.type === 'single') {
    return `题目：${q.stem}${opt}

先把 A/B/C/D **逐个**说明它对在哪或错在哪，再给出正确选项。
answer 只写正确选项的字母 A、B、C 或 D。

输出：{"steps":"逐项判断","answer":"B","ambiguous":false}`
  }

  return `题目：${q.stem}

先写出关键中间步骤（每一步算出什么），再给最终答案。
答案用学生可直接输入的最简纯文本，如 3/2、sqrt(2)、H2O。

输出：{"steps":"中间步骤","answer":"最终答案","ambiguous":false}`
}

module.exports = { conclusionPolarity, judgeAnswerIsTrue, countMismatch, qcProblems, verifyPromptFor, flat }
