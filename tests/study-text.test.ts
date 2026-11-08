import { describe, expect, it } from 'vitest'
import { renderStudyText } from '../src/renderer/src/study-text'

describe('学习内容公式排版', () => {
  it('识别 Markdown 和 LaTeX 定界符，保留周围正文与换行', () => {
    const html = renderStudyText(String.raw`已知 $x^2$，计算 \(\sqrt{2}\)。
$$\frac{1}{2}$$
\[\sum_{i=1}^{n}i\]`)
    expect(html).toContain('<msup>')
    expect(html).toContain('<msqrt>')
    expect(html).toContain('<mfrac>')
    expect(html.match(/class="study-math-block"/g)).toHaveLength(2)
    expect(html).toContain('。\n')
  })

  it('排版旧题中的函数、括号指数、分式和对数底数', () => {
    const html = renderStudyText('若 y = 2^(x−1)，求 1/(x + 1) 和 log₂8、√(x + 3)。', '数学')
    for (const tag of ['msup', 'mfrac', 'msub', 'msqrt']) expect(html).toContain('<' + tag + '>')
    expect(html).toContain('，求 ')
  })

  it('排版化学下标、电荷及反应式，保留普通英文缩写', () => {
    const html = renderStudyText(String.raw`比较 SO₄²⁻ 和 Ca(OH)2；反应为 2H2 + O2 -> 2H2O；离子 \ce{Fe^{3+}}；DNA。`, '化学')
    expect(html).toContain('<msub>')
    expect(html).toContain('<msup>')
    expect(html).toContain('2H2 + O2 -&gt; 2H2O')
    expect(html).toContain('DNA。')
    expect(html.match(/class="katex"/g)).toHaveLength(4)
    expect(renderStudyText('Fe3+，NH4+', '化学')).toContain('\\ce{Fe^{3+}}')
    expect(renderStudyText('Fe3+，NH4+', '化学')).toContain('\\ce{NH4+}')
  })

  it('原样显示货币、无效公式与普通文本，转义 HTML', () => {
    expect(renderStudyText('It costs $5 and $10.\n<img src=x>', '英语')).toBe('It costs $5 and $10.\n&lt;img src=x&gt;')
    expect(renderStudyText(String.raw`公式 $\frac{1}$`)).toBe(String.raw`公式 $\frac{1}$`)
    expect(renderStudyText(String.raw`$\href{javascript:alert(1)}{click}$`)).not.toContain('href="javascript:')
  })
})
