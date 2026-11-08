/**
 * 本地 AI 代理。
 *
 * 解决什么问题：浏览器（http://localhost 或 file://）直接调 api.deepseek.com 会被 CORS 拦掉，
 * 而 Electron 主进程没有这个限制。这个代理把"带密钥的跨域请求"搬到一个本地进程里，
 * 浏览器只跟 127.0.0.1 说话。
 *
 * 用法：node scripts/ai-proxy.cjs        （默认 127.0.0.1:3300）
 * 然后在本软件「设置 → AI 服务地址」里填 http://127.0.0.1:3300
 *
 * 密钥来源：环境变量 DEEPSEEK_API_KEY，或 ~/.dsh/.credentials.yaml（只读，不打印）
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { loadKey } = require('./deepseek-key.cjs')
const { qcProblems, verifyPromptFor } = require('./question-qc.cjs')
const { version } = require('../package.json')

const PORT = Number(process.env.AI_PROXY_PORT || 3300)
const HOST = '127.0.0.1'
const UPSTREAM = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-flash'
const FORMULA_FORMAT = '数学公式行内用 $...$，单独一行用 $$...$$。化学式和反应使用 $\\ce{2H2 + O2 -> 2H2O}$ 这样的格式。JSON 字符串内的反斜杠按 JSON 规则转义。'

function scopeContext(scope) {
  if (!scope || typeof scope !== 'object') return ''
  return '\n学习范围与偏好：' + JSON.stringify({
    stage: scope.stage, subject: scope.subject, topic: scope.topic, goal: scope.goal,
    depth: scope.depth, include: scope.include, exclude: scope.exclude, foundations: scope.foundations
  }).slice(0, 5000)
}

const KEY = loadKey()
if (!KEY) {
  console.error('[ai-proxy] 没找到 API key（环境变量 DEEPSEEK_API_KEY 或 ~/.dsh/.credentials.yaml）')
  process.exit(1)
}

/**
 * 出题/讲解用的身份与要求，必须跟着章节走。
 * 之前这里写死了"高考数学"，导致英语章节也会冒出导函数题。
 */
function teacherSystem(exam, subject, kind) {
  const who = [exam, subject].filter(Boolean).join(' ') || '高中'
  const role = kind === 'verify' ? '阅卷老师' : '命题老师'
  return `你是${who}${role}。只输出 JSON，不要任何解释文字。
题目必须答案唯一、可验证、不依赖图表、题干自成一体。
难度分级：1=课本例题，2=常规练习，3=考试中档，4=考试压轴，5=超纲/竞赛入门。
题目内容必须严格属于给定的章节，不要串到别的学科或别的章节。`
}

function verifySystem(exam, subject) {
  const who = [exam, subject].filter(Boolean).join(' ') || '高中'
  return `你是${who}阅卷老师。独立把题做一遍，不要相信题目给的答案，只输出 JSON。
如果题目有歧义、条件不足或多解，把 ambiguous 置为 true。`
}

/**
 * 答疑用的身份。之前这里直接引用了不存在的 SYSTEM 常量，
 * 导致 /chat 每次都是 500——右栏的"直接问 AI"和题目追问其实一直是坏的。
 */
function qaSystem(exam, subject) {
  const who = [exam, subject].filter(Boolean).join(' ') || '高中'
  return `你是${who}老师，正在给学生答疑。只输出 JSON，不要任何解释文字。
要求：
- 直接回答问题本身，不要客套、不要泛泛而谈
- 如果学生在问某道具体的题，就着那道题的题干和选项讲，不要换成别的例子
- 学生答错了，先指出他的误解出在哪一步，再给正确思路
- 讲不超过 180 字，能一句话说清就别写三句
- ${FORMULA_FORMAT}
输出格式：{"answer":"讲解正文","cards":[{"type":"conclusion|method|pitfall|formula","front":"正面问题","back":"背面答案"}]}
cards 最多 2 张，每张正面不超过 60 字、背面不超过 90 字，没必要时给空数组。`
}

/**
 * 带硬超时的上游请求。
 *
 * 为什么必须有：实测约 1/8 的请求会"连接挂住"——一个字节都不回。
 * Node 的 fetch（undici）默认 headersTimeout 是 300 秒，没有这层保护时
 * 一次挂起就会卡五分钟，用户点一下按钮等于卡死。
 */
async function upstream(body, timeoutMs = 25000) {
  const res = await fetch(UPSTREAM, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ ...body, model: MODEL, thinking: { type: 'disabled' } }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`上游 ${res.status}`)
    err.status = res.status
    err.detail = text.slice(0, 200)
    throw err
  }
  return JSON.parse(text)
}

/** 挂住时重试一次；再挂就交给调用方报错 */
async function upstreamRetry(body, timeoutMs = 25000, tries = 2) {
  let lastErr
  for (let i = 1; i <= tries; i++) {
    try {
      return await upstream(body, timeoutMs)
    } catch (e) {
      lastErr = e
      if (e.status) throw e // HTTP 错误不重试
      if (i < tries) await new Promise((r) => setTimeout(r, 300 * i))
    }
  }
  throw lastErr
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Max-Age', '600')
}

function json(res, code, body) {
  cors(res)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > 64 * 1024) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {})
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res)
    res.writeHead(204).end()
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, {
      ok: true, version, model: MODEL, routes: ['scope', 'chat', 'pack', 'questions', 'explain'],
      capabilities: ['optional-scope', 'full-question-text'], pid: process.pid
    })
    return
  }

  // 静态托管 out/web：让页面和接口同源，浏览器不会因为没有跨域头而拦住
  if (req.method === 'GET') {
    const root = path.resolve('out/web')
    if (!fs.existsSync(root)) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('还没构建前端。先运行：npm run build:web')
      return
    }
    let rel = decodeURIComponent((req.url || '/').split('?')[0])
    if (rel === '/') rel = '/index.html'
    let file = path.join(root, rel)
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden')
      return
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.ttf': 'font/ttf'
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
    return
  }

  if (req.method !== 'POST' || !['/scope', '/chat', '/pack', '/questions', '/explain'].includes(req.url)) {
    json(res, 404, { error: 'not found' })
    return
  }

  if (req.url === '/scope') {
    try {
      const body = await readBody(req)
      const request = String(body.request || '').trim().slice(0, 1600)
      if (!request) return json(res, 400, { error: '请描述学习目标或范围调整。' })
      const data = await upstreamRetry({
        temperature: 0.25, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '根据学生已经提供的信息拟定可编辑的学习范围，不重复询问已给出的信息。应考复习与章节补齐都是目标。存在影响范围的关键歧义时，只问一个问题。其余字段能推断则填写，否则留空。仅输出 JSON：{"stage":"学段","subject":"学科","topic":"主题","goal":"目标","depth":"深度","include":["纳入项"],"exclude":["排除项"],"foundations":["必要前置"],"question":"唯一追问或空字符串"}。若已有范围，保留用户未要求修改的部分，适用新描述。' },
          { role: 'user', content: request + scopeContext(body.scope) }
        ]
      })
      json(res, 200, JSON.parse(data.choices?.[0]?.message?.content ?? '{}'))
    } catch (e) {
      json(res, 502, { error: '范围草案生成失败：' + e.message })
    }
    return
  }

  /* ---------- 生成知识网 ---------- */
  if (req.url === '/pack') {
    try {
      const body = await readBody(req)
      const request = typeof body.request === 'string' ? body.request.trim().slice(0, 1600) : ''
      if (body.scope != null && (typeof body.scope !== 'object' || Array.isArray(body.scope))) {
        return json(res, 400, { error: '学习范围格式无效。' })
      }
      const scope = body.scope ?? (request ? {} : null)
      const exam = String(scope?.stage || body.exam || '').trim().slice(0, 40)
      const subject = String(scope?.subject || body.subject || '').trim().slice(0, 40)
      const chapter = String(scope?.topic || body.chapter || '').trim().slice(0, 60)
      if (scope ? !request && !chapter : !exam || !subject || !chapter) {
        return json(res, 400, { error: '请用一句话说明想学的内容。' })
      }

      const t0 = Date.now()
      const data = await upstreamRetry(
        {
          temperature: 0.4,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: scope ? `你是学科教研员。根据学生的一句话学习描述生成知识网。学段、学科、主题、目标、深度和范围条目均可留空。优先遵守填写的偏好，留空时按描述推断合适的学科、章节名称与内容，不追问。节点数随主题粒度，可只有一个考点和根。不要引入排除项。仅输出 JSON：{"subject":"学科","chapter":"简洁的章节名称","nodes":[{"id":"n1","name":"考点","kind":"root|concept|skill","parentId":null,"prereq":[],"confusable":[],"scopeIds":[],"supplementary":false,"examWeight":0.5,"brief":"一句话讲解"}]}。
根唯一且没有父级。其余节点有有效父级，并提供一句话讲解。每个填写的纳入项和必要前置都须被关联，只使用输入中的条目 ID。没有纳入项时，按描述自由选取核心内容，无对应条目的节点 scopeIds 留空。补充基础确有必要才加，标 supplementary=true。prereq 只填必学的前置 ID。父级和前置禁止成环。重要性按本次学习目标估计。修改已有图时，同一含义只改名或移动保留原 ID。含义改变或拆分合并时用新的 ID，旧 ID 从结果移除。保留未要求改变的手工节点和锁定权重。` : `你是学科教研员。把某个章节拆成一张可供学生自测的知识地图。
只输出 JSON，不要任何解释。节点数量 18–32 个，必须覆盖该章节的完整考点。
每个节点的 brief 一句话（30 字以内，说清"是什么/怎么考"）。
严格按此结构输出：
{"nodes":[{"id":"n1","name":"考点名","parentId":null,"kind":"root|concept|skill","examWeight":0.8,"prereq":[],"brief":"..."}]}
规则：
- 有且只有一个 kind=root 的根节点，parentId 为 null
- 其余节点的 parentId 必须是已有节点 id
- prereq 填"必须先学会"的节点 id（可为空数组）
- examWeight 取 0.2–1.0，表示该考点在本章里的相对重要性估计（**不是**历年考频统计，只是你的判断）
- kind=skill 表示"题型/方法"，kind=concept 表示"概念/定理"`
            },
            {
              role: 'user',
              content: scope ? '\n学习描述：' + request + scopeContext(scope) +
                '\n当前结构：' + JSON.stringify(body.current ?? []).slice(0, 12000) : `考试：${exam}\n科目：${subject}\n章节：${chapter}`
            }
          ]
        },
        30000
      )
      const content = data.choices?.[0]?.message?.content ?? '{}'
      let parsed
      try {
        parsed = JSON.parse(content)
      } catch {
        json(res, 502, { error: 'AI 没有返回合法 JSON' })
        return
      }
      const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : []
      if (nodes.length < (scope ? 2 : 5)) {
        json(res, 502, { error: `生成的节点太少（${nodes.length} 个）` })
        return
      }

      const metadata = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
      json(res, 200, {
        exam,
        subject: subject || metadata(parsed.subject, 40),
        chapter: chapter || metadata(parsed.chapter, 60) || metadata(nodes.find((node) => node?.kind === 'root')?.name, 60),
        nodes,
        ms: Date.now() - t0,
        tokens: (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0)
      })
    } catch (e) {
      json(res, 500, { error: String(e.message || e) })
    }
    return
  }

  /* ---------- 按需出题：只为"现在真的要做的那个考点"出题 ---------- */
  if (req.url === '/questions') {
    try {
      const body = await readBody(req)
      const nodeName = String(body.nodeName || '').slice(0, 60)
      const brief = String(body.brief || '').slice(0, 200)
      // 学科上下文必须由调用方带过来，否则会出成别的科目
      const exam = String(body.exam || '').slice(0, 30)
      const subject = String(body.subject || '').slice(0, 30)
      const chapter = String(body.chapter || '').slice(0, 60)
      const examWeight = Number(body.examWeight) || 0.6
      const need = Math.min(5, Math.max(1, Number(body.need) || 3))
      const diffs = Array.isArray(body.difficulties) && body.difficulties.length
        ? body.difficulties.slice(0, need).map((d) => Math.min(5, Math.max(1, Number(d) || 3)))
        : Array.from({ length: need }, (_, i) => Math.min(4, 2 + i))
      if (!nodeName) {
        json(res, 400, { error: '缺少 nodeName' })
        return
      }

      const t0 = Date.now()
      let tokens = 0

      const gen = await upstreamRetry(
        {
          temperature: 0.8,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: teacherSystem(exam, subject) + scopeContext(body.scope) },
            {
              role: 'user',
              content: `章节：${chapter || '（未提供）'}\n考点：${nodeName}\n简述：${brief || '（无）'}\n重要性估计：${examWeight}（0-1，主观判断，非考频统计）

出 ${need} 道题，难度严格按这个顺序：${diffs.join('、')}
题目必须属于「${nodeName}」这个考点，不要出成别的章节的内容。
题型从 single（四选一）/ blank（填空）/ judge（判断）里挑，不要全是同一种。
{"questions":[{"type":"single","difficulty":2,"stem":"...","options":["选项1","选项2","选项3","选项4"],"answer":"与某个选项完全一致","solution":"两三句话"}]}
注意：options 只写内容不要 A. 前缀。阅读题的 stem 必须包含完整文章和提问，段落之间用换行分隔。
题干、选项和解析中的公式按以下格式写。${FORMULA_FORMAT}
单选题的 answer 与选项原文完全一致。填空题的 answer 用学生可以直接键入的纯文本，如 3/2、sqrt(2)、H2O。`
            }
          ]
        },
        25000
      )
      tokens += (gen.usage?.prompt_tokens || 0) + (gen.usage?.completion_tokens || 0)

      let raw = []
      try {
        raw = JSON.parse(gen.choices?.[0]?.message?.content ?? '{}').questions ?? []
      } catch {
        raw = []
      }

      const keep = []
      const reject = []
      for (const q of raw) {
        if (keep.length >= need) break
        if (!q || !['single', 'blank', 'judge'].includes(q.type)) {
          reject.push(`题型非法:${q && q.type}`)
          continue
        }
        if (typeof q.stem !== 'string' || q.stem.trim().length < 6) {
          reject.push('题干太短')
          continue
        }
        if (typeof q.solution !== 'string' || q.solution.trim().length < 6) {
          reject.push('解析太短')
          continue
        }
        if (q.type === 'single') {
          if (!Array.isArray(q.options) || q.options.length !== 4) {
            reject.push(`选项数=${q.options ? q.options.length : '无'}`)
            continue
          }
          if (new Set(q.options.map((o) => String(o).trim())).size !== 4) {
            reject.push('选项重复')
            continue
          }
          if (!q.options.some((o) => String(o).trim() === String(q.answer).trim())) {
            reject.push(`答案不在选项里:${q.answer}`)
            continue
          }
        }
        if (q.type === 'judge') {
          // 模型经常写「正确/错误」而不是 true/false，先归一化再校验
          const t = String(q.answer ?? '').trim().toLowerCase()
          if (['正确', '对', '是', 'true', 't', '√', 'yes'].includes(t)) q.answer = 'true'
          else if (['错误', '错', '否', 'false', 'f', '×', 'no'].includes(t)) q.answer = 'false'
          else {
            reject.push(`判断题答案非法:${q.answer}`)
            continue
          }
        }

        // 独立复核：不一致就丢
        try {
          const v = await upstreamRetry(
            {
              temperature: 0,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: verifySystem(exam, subject) + scopeContext(body.scope) },
                { role: 'user', content: verifyPromptFor(q) }
              ]
            },
            20000
          )
          tokens += (v.usage?.prompt_tokens || 0) + (v.usage?.completion_tokens || 0)
          const ans = JSON.parse(v.choices?.[0]?.message?.content ?? '{}')
          if (ans.ambiguous) {
            reject.push('复核认为有歧义')
            continue
          }
          // 去掉 "A." / "选项B：" 这类前缀，去空格，再比
          const flat = (s) => String(s).replace(/^\s*(选项)?\s*[A-Da-d]\s*[.、．:：)）]\s*/, '').replace(/\s+/g, '').trim()
          const bare = String(ans.answer ?? '').trim()
          const letter = bare.replace(/^\s*(选项)?\s*([A-Da-d])\s*$/, '$2').toUpperCase()
          let agree = false
          if (q.type === 'single' && /^[A-D]$/.test(letter)) {
            agree = flat(q.options['ABCD'.indexOf(letter)]) === flat(q.answer)
          } else if (q.type === 'judge') {
            const t = bare.toLowerCase()
            const norm = ['正确', '对', '是', 'true', 't', '√'].includes(t) ? 'true' : ['错误', '错', '否', 'false', 'f', '×'].includes(t) ? 'false' : t
            agree = norm === String(q.answer)
          } else {
            agree = flat(bare) === flat(q.answer) || flat(bare).replace(/^y=/, '') === flat(q.answer).replace(/^y=/, '')
          }
          if (!agree) {
            reject.push(`复核不一致:${q.answer} vs ${bare}`)
            continue
          }
        } catch (e) {
          reject.push(`复核失败:${e.message}`)
          continue
        }

        // 第三道闸门：解析自洽（确定性检查，不依赖模型）
        const qc = qcProblems(q)
        if (qc.length) {
          reject.push(`自洽检查:${qc.join('；')}`)
          continue
        }

        keep.push({
          type: q.type,
          difficulty: Math.min(5, Math.max(1, Number(q.difficulty) || 3)),
          stem: q.stem,
          ...(Array.isArray(q.options) ? { options: q.options.map(String) } : {}),
          answer: q.answer,
          solution: q.solution,
          fullText: true
        })
      }

      json(res, 200, { nodeName, questions: keep, raw: raw.length, reject, ms: Date.now() - t0, tokens })
    } catch (e) {
      json(res, 502, { error: `出题失败：${e.message || e}` })
    }
    return
  }

  /* ---------- 详细讲解：按「定义+基础认知 / 涉及的考法 / 知识点」三段展开 ---------- */
  if (req.url === '/explain') {
    try {
      const body = await readBody(req)
      const nodeName = String(body.nodeName || '').slice(0, 60)
      const nodePath = String(body.nodePath || '').slice(0, 120)
      const brief = String(body.brief || '').slice(0, 300)
      const exam = String(body.exam || '').slice(0, 30)
      const subject = String(body.subject || '').slice(0, 30)
      const chapter = String(body.chapter || '').slice(0, 60)
      if (!nodeName) {
        json(res, 400, { error: '缺少 nodeName' })
        return
      }

      const who = [exam, subject].filter(Boolean).join(' ') || '高中'
      const t0 = Date.now()
      const data = await upstreamRetry(
        {
          temperature: 0.5,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `你是${who}老师，正在给一个学生写某个考点的**详细讲解**。只输出 JSON。${scopeContext(body.scope)}
要求：
- 讲透，不要泛泛而谈；每一句都要有信息量，不要复述题干
- 用学生能直接用的语言，必要处给具体条件、公式、判别步骤
- ${FORMULA_FORMAT}
- 涉及考法时要写清"以什么形式出现、怎么下手"，不要只写"常考"
- 没有把握的具体数据（教材页码、历年考频、真题年份）一律不要写
- 不要写"根据考纲""据统计"这类我们无法验证的说法`
            },
            {
              role: 'user',
              content: `章节：${chapter || '（未提供）'}
考点：${nodeName}（${nodePath || '无路径'}）
一句话简述：${brief || '（无）'}

按下面三段展开，JSON 结构：
{
  "definition": "定义与基础认知，150-260 字。讲清它是什么、边界在哪、和相邻概念怎么区分",
  "basics": ["基础认知要点，4-6 条，每条 20-40 字"],
  "exams": ["涉及的考法，4-6 条，每条写清"以什么形式考 + 第一步怎么做""],
  "keypoints": ["必须记住的知识点/结论/易错，4-6 条，每条 15-35 字"]
}`
            }
          ]
        },
        30000
      )
      const content = data.choices?.[0]?.message?.content ?? '{}'
      let parsed
      try {
        parsed = JSON.parse(content)
      } catch {
        parsed = { definition: String(content), basics: [], exams: [], keypoints: [] }
      }
      const arr = (v, max = 6) =>
        (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean).slice(0, max)

      json(res, 200, {
        definition: String(parsed.definition || ''),
        basics: arr(parsed.basics),
        exams: arr(parsed.exams),
        keypoints: arr(parsed.keypoints),
        ms: Date.now() - t0,
        tokens: (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0)
      })
    } catch (e) {
      json(res, 502, { error: `生成讲解失败：${e.message || e}` })
    }
    return
  }

  try {
    const body = await readBody(req)
    const question = String(body.question || '').slice(0, 800)
    const nodeName = String(body.nodeName || '').slice(0, 60)
    const nodePath = String(body.nodePath || '').slice(0, 120)
    const explain = String(body.explain || '').slice(0, 400)
    // 追问某道题时带来的题目上下文：题干、选项、学生答案、正确答案、解析
    const context = String(body.context || '')
    if (!question) {
      json(res, 400, { error: '缺少 question' })
      return
    }

    const t0 = Date.now()
    const data = await upstreamRetry(
      {
        temperature: 0.5,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: qaSystem(body.exam, body.subject) + scopeContext(body.scope) },
          {
            role: 'user',
            content: `${context ? `【学生刚做完的一道题】\n${context}\n\n（学生已经作答并看过解析，现在是针对这道题的追问）\n\n` : ''}考点：${nodeName}（${nodePath}）\n已有讲解：${explain}\n学生的提问：${question}`
          }
        ]
      },
      25000
    )
    const content = data.choices?.[0]?.message?.content ?? '{}'
    let parsed
    try {
      parsed = JSON.parse(content)
    } catch {
      parsed = { answer: content, cards: [] }
    }
    json(res, 200, {
      answer: String(parsed.answer || ''),
      cards: (Array.isArray(parsed.cards) ? parsed.cards : []).slice(0, 2).map((c) => ({
        type: ['conclusion', 'method', 'pitfall', 'formula'].includes(c.type) ? c.type : 'conclusion',
        front: String(c.front || ''),
        back: String(c.back || '')
      })),
      ms: Date.now() - t0,
      tokens: (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0)
    })
  } catch (e) {
    json(res, 500, { error: String(e.message || e) })
  }
})

server.on('error', (error) => {
  console.error(`[ai-proxy] 无法监听 ${HOST}:${PORT}（${error.code || error.message}）`)
  process.exitCode = 1
})

server.listen(PORT, HOST, () => {
  const address = server.address()
  const url = `http://${address.address}:${address.port}`
  console.log(`[ai-proxy] v${version} 已启动 ${url}  model=${MODEL}`)
  if (process.env.GAPGRAPH_RUN_DIR) {
    fs.writeFileSync(path.join(process.env.GAPGRAPH_RUN_DIR, 'ai.json'), JSON.stringify({ url, pid: process.pid }))
    return
  }
  const hasBuild = fs.existsSync(path.resolve('out/web/index.html'))
  if (hasBuild) {
    console.log(`[ai-proxy] 直接打开 ${url} 就是完整应用，实时问答自动可用`)
  } else {
    console.log('[ai-proxy] 提示：还没构建前端，先运行 npm run build:web')
  }
})
