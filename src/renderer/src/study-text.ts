import katex from 'katex'
import 'katex/contrib/mhchem'

const htmlEntities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (character) => htmlEntities[character])

function typeset(tex: string, original: string, displayMode = false): string {
  try {
    const html = katex.renderToString(tex, { displayMode, trust: false, strict: 'ignore', maxExpand: 400, maxSize: 20 })
    return displayMode ? '<span class="study-math-block">' + html + '</span>' : html
  } catch {
    return escapeHtml(original)
  }
}

const superscript = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻'
const superscriptText = (text: string): string => [...text].map((char) => '0123456789+-'[superscript.indexOf(char)]).join('')
const subscriptText = (text: string): string => [...text].map((char) => String(char.charCodeAt(0) - 0x2080)).join('')

const mathRun = /(?:[ \t0-9A-Za-zΑ-Ωα-ω()[\]{}.^_+*/=<>!≤≥≠×÷−±√∞∈∪∩→|₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻-]+|根号下?)+/g
const mathWord = /^(?:log|lg|ln|sin|cos|tan|lim|max|min|exp|abs|sqrt)$/
const parens = String.raw`\((?:[^()]|\([^()]*\))*\)`
const number = String.raw`\d+(?:\.\d+)?`
const atom = parens + '|' + number + '|[A-Za-zΑ-Ωα-ω]'
const simpleFraction = new RegExp(String.raw`(?<![\w^/).])` + '(' + parens + '|' + number + ')' +
  String.raw`[ \t]*/[ \t]*` + '(' + parens + '|' + number + ')' + String.raw`(?![\w.^/(])`, 'g')
const radical = new RegExp(String.raw`(?:sqrt(?=\()|√|根号下?)[ \t]*` + '(' + atom + ')', 'g')
const exponent = new RegExp(String.raw`\^(?!\{)([+\-]?` + '(?:' + atom + '))', 'g')
const ungroup = (value: string): string => value.startsWith('(') && value.endsWith(')') ? value.slice(1, -1) : value

function legacyMath(raw: string): string {
  const value = raw.trim()
  const words = value.match(/[A-Za-z]{2,}/g) ?? []
  if (words.some((word) => !mathWord.test(word)) ||
    !(/[0-9A-Za-zΑ-Ωα-ω]/.test(value) && /[=<>≤≥≠^_*/√₀-₉²³]|根号|sqrt\(/.test(value))) return escapeHtml(raw)

  const tex = value
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+/g, (part) => '^{' + superscriptText(part) + '}')
    .replace(/[₀-₉]+/g, (part) => '_{' + subscriptText(part) + '}')
    .replace(/−/g, '-')
    .replace(/<=|>=|!=/g, (operator) => ({ '<=': '\\le ', '>=': '\\ge ', '!=': '\\ne ' })[operator]!)
    .replace(radical, (_, arg: string) => '\\sqrt{' + ungroup(arg) + '}')
    .replace(simpleFraction, (_, a: string, b: string) => '\\frac{' + ungroup(a) + '}{' + ungroup(b) + '}')
    .replace(exponent, (_, arg: string) => '^{' + ungroup(arg) + '}')
    .replace(/\b(?:lg|log|ln|sin|cos|tan|lim|max|min|exp)\b/g, (word) => '\\' + (word === 'lg' ? 'log' : word) + ' ')

  if (/\^(?:\(|[+\-])|(?<!\\)sqrt|根号|[=<>+\-*/]$/.test(tex)) return escapeHtml(raw)
  return escapeHtml(raw.slice(0, raw.indexOf(value))) + typeset(tex, value) + escapeHtml(raw.slice(raw.indexOf(value) + value.length))
}

const elements = new Set(('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr ' +
  'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn ' +
  'Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split(' '))
const element = '[A-Z][a-z]?[0-9₀-₉]*'
const species = String.raw`(?:\d+[ \t]*)?(?:` + element + '|\\((?:' + element + String.raw`)+\)[0-9₀-₉]*)+` +
  String.raw`(?:\^(?:\{\d*[+-]\}|\d*[+-])|[⁰¹²³⁴⁵⁶⁷⁸⁹]*[⁺⁻]|[+-](?![A-Za-z0-9>]))?(?:\((?:s|l|g|aq)\))?`
const side = species + String.raw`(?:[ \t]*\+[ \t]*` + species + ')*'
const chemistryRun = new RegExp(String.raw`(?<![A-Za-z0-9])(?:` + side + String.raw`[ \t]*(?:->|<=>|→|⇌)[ \t]*` +
  side + '|' + species + ')(?![A-Za-z0-9])', 'g')

function legacyChemistry(value: string): string {
  const symbols = value.match(/[A-Z][a-z]?/g) ?? []
  if (!symbols.length || symbols.some((symbol) => !elements.has(symbol)) ||
    (symbols.length === 1 && !/[0-9₀-₉⁺⁻+-]/.test(value))) return escapeHtml(value)
  const tex = value.replace(/[₀-₉]+/g, subscriptText)
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]*[⁺⁻]/g, (charge) => '^{' + superscriptText(charge) + '}')
    .replace(/(^|[ \t+>])(\d*[ \t]*)(Fe|Cu|Zn|Mg|Al|Ca|Ba|Cr|Mn|Co|Ni)([1-9]\d*)\+(?![A-Za-z0-9])/g, '$1$2$3^{$4+}')
    .replace(/→/g, ' -> ').replace(/⇌/g, ' <=> ')
  return typeset('\\ce{' + tex + '}', value)
}

const opener = /(?<!\\)(?:\$\$|\\\[|\\\(|\\(?:ce|pu)(?=\{)|(?<!\$)\$(?![$\s]))/g

function closingAt(text: string, start: number, close: string): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (close === '$' && /[\r\n]/.test(text[i])) return -1
    if (depth === 0 && text.startsWith(close, i)) {
      if (close === '$' && (/\s/.test(text[i - 1] ?? '') || /[\d$]/.test(text[i + 1] ?? ''))) return -1
      return i
    }
    if (text[i] === '\\') i++
    else if (text[i] === '{') depth++
    else if (text[i] === '}') depth--
  }
  return -1
}

export function renderStudyText(value: unknown, subject = ''): string {
  const text = String(value ?? '')
  const chemistry = /化学|chemistry/i.test(subject)
  const mathematics = /数学|math/i.test(subject)
  const plain = (segment: string): string => {
    segment = segment.replace(/\\\$/g, '$')
    if (!chemistry && !mathematics) return escapeHtml(segment)
    let html = ''
    let cursor = 0
    for (const match of segment.matchAll(chemistry ? chemistryRun : mathRun)) {
      html += escapeHtml(segment.slice(cursor, match.index)) + (chemistry ? legacyChemistry(match[0]) : legacyMath(match[0]))
      cursor = match.index + match[0].length
    }
    return html + escapeHtml(segment.slice(cursor))
  }

  let html = ''
  let cursor = 0
  for (const match of text.matchAll(opener)) {
    if (match.index < cursor) continue
    const start = match[0]
    const chemistryCommand = start === '\\ce' || start === '\\pu'
    const close = chemistryCommand ? '}' : start === '\\(' ? '\\)' : start === '\\[' ? '\\]' : start
    const body = match.index + start.length + Number(chemistryCommand)
    const end = closingAt(text, body, close)
    if (end < 0 || end === body) continue
    const raw = text.slice(match.index, end + close.length)
    const tex = chemistryCommand ? raw : text.slice(body, end)
    html += plain(text.slice(cursor, match.index)) + typeset(tex, raw, start === '$$' || start === '\\[')
    cursor = end + close.length
  }
  return html + plain(text.slice(cursor))
}
