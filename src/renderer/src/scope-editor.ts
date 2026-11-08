import type { KNode, Pack, ScopeSpec } from '../../shared/types'
import { primaryBranch } from '../../main/domain/learning'
import { archiveNode, legacyScope, relationships, scopedPack, scopeItems, validateGraph, validateScope } from '../../main/domain/scope'
import { draftScope, endpointStatus, generatePack } from './ai'
import { helpTip } from './help-tip'

type Options = {
  pack?: Pack
  builtin?: () => void
  close: () => void
  apply: (pack: Pack) => void | Promise<void>
}

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]!))
const uid = (prefix: string) => prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)

function signature(node: KNode) {
  return JSON.stringify([node.name, node.parentId, node.prereq, node.scopeIds, node.supplementary, node.examWeight, node.weightLocked])
}

function remap(nodes: KNode[], replacements: Map<string, string>): KNode[] {
  const id = (key: string) => replacements.get(key) ?? key
  return nodes.map((n) => ({
    ...n, id: id(n.id), parentId: n.parentId && id(n.parentId),
    prereq: n.prereq.map(id), confusable: n.confusable.map(id)
  }))
}

export function openScopeEditor(box: HTMLElement, options: Options): void {
  const existing = options.pack
  let scope: ScopeSpec = existing ? legacyScope(existing) : {
    version: 0, source: 'confirmed', stage: '', subject: '', topic: '', goal: '', depth: '',
    include: [], exclude: [], foundations: []
  }
  let request = ''
  let question = ''
  let answer = ''
  let candidate: Pack | undefined
  let preview = false
  let busy = false
  let error = ''
  let generated = false
  const token = uid('editor')
  box.dataset.scopeEditor = token

  const live = () => box.dataset.scopeEditor === token && box.classList.contains('open')
  const field = (id: string) => box.querySelector<HTMLInputElement | HTMLTextAreaElement>('#' + id)
  const value = (id: string) => field(id)?.value.trim() ?? ''
  const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 30) : []
  const details = ['stage', 'subject', 'topic', 'goal', 'depth'] as const
  const detailLabels = ['学段', '学科', '主题', '学习目标', '学习深度']

  function syncScope() {
    request = value('scope-request')
    answer = value('scope-answer')
    const editable = scope.source
    scope = { ...scope, source: editable, ...Object.fromEntries(details.map((key) => [key, value('scope-' + key)])),
      include: scopeItems(value('scope-include'), scope.include, () => uid('i')),
      foundations: scopeItems(value('scope-foundations'), scope.foundations, () => uid('f')),
      exclude: value('scope-exclude').split(/\r?\n/).map((v) => v.trim()).filter(Boolean)
    }
  }

  function fromCurrent(): Pack {
    const pack = existing!
    const previousScope = legacyScope(pack)
    const subject = scope.subject || pack.subject
    const topic = scope.topic || previousScope.topic
    const valid = new Set([...scope.include, ...scope.foundations].map((item) => item.id))
    const nodes = pack.nodes.map((node) => {
      const branch = primaryBranch(node.id, pack.nodes)
      const inherited = previousScope.include.find((item) => item.id === 'scope-' + branch)?.id
      const scopeIds = (node.scopeIds ?? (inherited ? [inherited] : [])).filter((id) => valid.has(id))
      return { ...node, scopeIds }
    })
    return { ...pack, scope: { ...scope, subject, topic, source: 'confirmed' }, subject,
      title: topic, meta: { exam: pack.meta?.exam ?? '', subject, chapter: topic }, nodes }
  }

  async function run(action: () => Promise<void>) {
    if (busy) return
    busy = true
    error = ''
    render()
    try { await action() } catch (e) { error = e instanceof Error ? e.message : '操作失败，请重试。' }
    finally {
      busy = false
      if (live()) render()
    }
  }

  const bind = (id: string, callback: () => void) => box.querySelector('#' + id)?.addEventListener('click', callback)

  function syncNodes() {
    if (!candidate || preview) return
    const byId = new Map(candidate.nodes.map((n) => [n.id, n]))
    for (const row of box.querySelectorAll<HTMLElement>('[data-edit-node]')) {
      const node = byId.get(row.dataset.editNode!)!
      const prior = signature(node)
      node.name = row.querySelector<HTMLInputElement>('[name=name]')!.value.trim()
      if (node.kind !== 'root') {
        node.parentId = row.querySelector<HTMLSelectElement>('[name=parent]')!.value
        node.prereq = [...row.querySelector<HTMLSelectElement>('[name=pre]')!.selectedOptions].map((o) => o.value)
        node.scopeIds = [...row.querySelector<HTMLSelectElement>('[name=items]')!.selectedOptions].map((o) => o.value)
        node.supplementary = row.querySelector<HTMLInputElement>('[name=supplementary]')!.checked
        const weight = row.querySelector<HTMLSelectElement>('[name=weight]')!.value
        if (weight) {
          node.examWeight = Number(weight)
          node.weightSource = 'manual'
          node.weightLocked = true
        }
      }
      if (prior !== signature(node)) node.edited = true
    }
    candidate.relations = relationships(candidate.nodes, candidate.relations)
  }

  function render() {
    const ai = endpointStatus()
    const status = !ai.reachable ? 'AI 代理离线，内置板块与手动编辑仍可使用。'
      : !ai.supportsOptionalScope ? 'AI 代理版本过旧，请关闭旧启动窗口并重新运行 start.bat。'
        : 'AI 代理' + (ai.proxyVersion ? ' v' + ai.proxyVersion : '') + ' 已连接。实时生成只发送当前描述、范围和必要结构。'
    const shownScope = candidate?.scope ?? scope
    const items = [...shownScope.include, ...shownScope.foundations]
    const originals = new Map(existing?.nodes.map((n) => [n.id, n]))
    const active = new Set(candidate?.nodes.map((n) => n.id))
    const archived = existing?.nodes.filter((n) => !active.has(n.id)) ?? []
    const protectedChange = (node: KNode) => {
      const original = originals.get(node.id)
      return !!original && ((original.weightLocked && (node.examWeight !== original.examWeight || !node.weightLocked)) ||
        (original.edited && signature(original) !== signature(node)))
    }
    const needsConsent = generated && (archived.some((n) => n.edited || n.weightLocked) || candidate?.nodes.some(protectedChange))
    const disabled = busy ? 'disabled' : ''
    const textarea = (id: string, label: string, v: string, options?: { required?: boolean; help?: string }) => {
      const help = options?.help ? helpTip(label + '用法', options.help) : ''
      return '<div class="scope-textfield"><div class="scope-field-head"><label for="' + id + '">' + esc(label) + '</label>' + help +
        '</div><textarea class="sinput" id="' + id + '" rows="2"' + (options?.required ? ' required' : '') + '>' + esc(v) + '</textarea></div>'
    }
    const selector = (name: string, options: { id: string; label: string }[], selected: string[], multi = false) =>
      '<select name="' + name + '" ' + (multi ? 'multiple size="3"' : '') + '>' + options.map((o) =>
        '<option value="' + esc(o.id) + '" ' + (selected.includes(o.id) ? 'selected' : '') + '>' + esc(o.label) + '</option>').join('') + '</select>'
    const draftForm =
      textarea('scope-request', existing ? '描述你要怎样调整范围和知识网（选填）' : '用一句话说明想学的内容（必填）', request, { required: !existing }) +
      (question ? textarea('scope-answer', question, answer) : '') +
      '<p class="gsub">' + (existing ? '可直接生成新预览，也可以手动调整已有知识网。' : '填完一句话就能生成，下面的范围可以留空，之后也可调整。') + '</p>' +
      '<div class="scope-actions"><button class="primary" id="scope-generate" ' + disabled + '>确认并生成</button>' +
      '<button id="scope-draft" ' + disabled + '>拟定范围草案</button>' +
      (options.builtin ? '<button id="scope-builtin">打开内置板块</button>' : '') + '</div>' +
      '<div class="col-title">学习范围（选填）</div>' +
      '<div class="scope-fields">' + details.map((key, i) =>
        '<label>' + detailLabels[i] + '<input class="sinput" id="scope-' + key + '" value="' + esc(scope[key]) + '"></label>').join('') +
      textarea('scope-include', '纳入项', scope.include.map((item) => item.label).join('\n'), {
        help: '写下这次一定想学的内容，每行一项。例如「一次函数图像」「斜率」。留空时由 AI 根据描述选择。'
      }) +
      textarea('scope-exclude', '排除项', scope.exclude.join('\n'), {
        help: '写下这次想跳过的内容，每行一项。例如只学一次函数时，可以写「二次函数」。留空即可。'
      }) +
      textarea('scope-foundations', '必要前置', scope.foundations.map((item) => item.label).join('\n'), {
        help: '写下希望先复习的基础，每行一项。例如学一次函数前先复习「平面直角坐标系」。'
      }) + '</div>' +
      (existing ? '<div class="scope-actions"><button id="scope-manual" ' + disabled + '>手动调整知识网</button></div>' : '')
    const graphForm = candidate && !preview ? candidate.nodes.map((node) => {
      const other = candidate!.nodes.filter((n) => n.id !== node.id).map((n) => ({ id: n.id, label: n.name }))
      return '<div class="card" data-edit-node="' + esc(node.id) + '"><label>名称 <input name="name" class="sinput" value="' + esc(node.name) + '"></label>' +
        (node.kind === 'root' ? ' · 根节点' : '<div class="scope-fields"><label>父级' + selector('parent', other, [node.parentId ?? '']) +
          '</label><label>必要前置（可多选）' + selector('pre', other.filter((n) => n.id !== candidate!.nodes.find((r) => r.kind === 'root')?.id), node.prereq, true) +
          '</label><label>关联范围（可多选）' + selector('items', items, node.scopeIds ?? [], true) +
          '</label><label>重要性' + selector('weight', [
            { id: '', label: node.weightLocked ? '保持已锁定值' : '保留原值' }, { id: '0.85', label: '高并锁定' },
            { id: '0.55', label: '中并锁定' }, { id: '0.25', label: '低并锁定' }
          ], ['']) + '</label></div><label><input name="supplementary" type="checkbox" ' + (node.supplementary ? 'checked' : '') +
          '> 补充基础</label><div class="scope-actions"><button data-archive="' + esc(node.id) + '">归档</button>' +
          (originals.has(node.id) ? '<button data-reidentify="' + esc(node.id) + '">含义变化，使用新 ID</button>' : '') + '</div>') + '</div>'
    }).join('') + '<div class="scope-actions"><button id="scope-add">新增考点</button><button class="primary" id="scope-preview">检查并预览差异</button></div>' : ''
    const diff = candidate && preview ? '<p>' + esc(details.map((key) => shownScope[key]).filter(Boolean).join(' · ')) +
      '</p><p>纳入 ' + esc(shownScope.include.map((i) => i.label).join('、') || '按学习描述确定') + '　排除 ' + esc(shownScope.exclude.join('、') || '未指定') +
      '　必要前置 ' + esc(shownScope.foundations.map((i) => i.label).join('、') || '未指定') + '</p>' +
      (existing ? '<p>原范围 ' + esc(legacyScope(existing).include.map((i) => i.label).join('、') || '未指定纳入项') + '</p>' : '') +
      '<ol>' + candidate.nodes.map((node) => {
        const old = originals.get(node.id)
        const parent = candidate!.nodes.find((n) => n.id === node.parentId)
        const pre = candidate!.nodes.filter((n) => node.prereq.includes(n.id))
        return '<li>' + esc(node.name) + ' · ' + (!old ? '新增' : signature(old) === signature(node) ? '保留' : '调整，保留 ID') +
          (parent ? ' · 父级 ' + esc(parent.name) : '') + (pre.length ? ' · 前置 ' + esc(pre.map((n) => n.name).join('、')) : '') +
          (node.supplementary ? ' · 补充基础' : '') + ' · ' + esc(items.filter((i) => node.scopeIds?.includes(i.id)).map((i) => i.label).join('、')) + '</li>'
      }).join('') + '</ol>' +
      (archived.length ? '<p>将归档 ' + esc(archived.map((n) => n.name).join('、')) + '。历史题目、作答和收藏保留。</p>' : '') +
      '<p class="gsub">引用与覆盖已经过结构检查。请核对知识内容是否越界，含义变化的考点须用新 ID。</p>' +
      (needsConsent ? '<label><input type="checkbox" id="scope-consent"> 同意替换已手工编辑的结构或锁定重要性</label>' : '') +
      '<div class="scope-actions"><button id="scope-back" ' + disabled + '>返回调整</button><button class="primary" id="scope-apply" ' +
      disabled + '>' + (existing ? '应用修订' : '保存并查看知识网') + '</button></div>' : ''
    box.innerHTML = '<div class="gsheet scope-sheet"><div class="ghead"><div><h2>' + (existing ? '调整学习范围与知识网' : '新建学习板块') +
      '</h2><p class="gsub">' + esc(status) + (scope.source === 'legacy' ? ' 当前草案由旧板块整理。' : '') +
      '</p></div><button id="scope-close" ' + (box.dataset.scopeApplying ? 'disabled' : '') + '>取消</button></div>' +
      (error ? '<p class="badline" role="alert">' + esc(error) + '</p>' : '') +
      (busy ? '<p class="wz-progress" role="status">正在处理，请稍候…</p>' : '') +
      (candidate ? '<button id="scope-return" ' + disabled + '>返回范围草案</button>' + (preview ? diff : graphForm) : draftForm) + '</div>'
    box.classList.add('open')

    bind('scope-close', options.close)
    bind('scope-builtin', () => options.builtin?.())
    bind('scope-draft', () => {
      syncScope()
      void run(async () => {
        if (!request) throw new Error('请先描述学习目标。')
        const reply = await draftScope(request + (question && answer ? '\n' + question + '\n' + answer : ''), scope)
        if (!live()) return
        for (const key of details) if (typeof reply[key] === 'string' && reply[key]?.trim()) scope[key] = reply[key]!
        if (Array.isArray(reply.include)) scope.include = scopeItems(list(reply.include).join('\n'), scope.include, () => uid('i'))
        if (Array.isArray(reply.foundations)) scope.foundations = scopeItems(list(reply.foundations).join('\n'), scope.foundations, () => uid('f'))
        if (Array.isArray(reply.exclude)) scope.exclude = list(reply.exclude)
        if (question && answer) request += '\n' + question + '\n' + answer
        question = typeof reply.question === 'string' ? reply.question : ''
        answer = ''
      })
    })
    bind('scope-generate', () => {
      syncScope()
      void run(async () => {
        if (!existing && !request) throw new Error('请先用一句话说明想学的内容。')
        const description = request + (question && answer ? '\n' + question + '\n' + answer : '')
        const topic = scope.topic || (!request && existing ? legacyScope(existing).topic : '')
        const raw = await generatePack({ scope: { ...scope, topic }, request: description, current: existing?.nodes })
        if (!live()) return
        const confirmed: ScopeSpec = {
          ...scope, source: 'confirmed', version: scope.version + 1,
          subject: scope.subject || raw.subject || existing?.subject || '',
          topic: topic || raw.chapter || request.slice(0, 60)
        }
        const next = scopedPack(confirmed, raw.nodes, existing?.packId ?? uid('ai'))
        if (existing) {
          if (next.meta && existing.meta) next.meta.exam = existing.meta.exam
          const ids = new Map(next.nodes.filter((node) => !originals.has(node.id)).map((node) => [node.id, uid('n')]))
          next.nodes = remap(next.nodes, ids).map((node) => {
            const old = originals.get(node.id)
            return old ? { ...node, edited: old.edited, weightLocked: old.weightLocked,
              examWeight: old.weightLocked ? old.examWeight : node.examWeight,
              weightSource: old.weightLocked ? old.weightSource : node.weightSource } : node
          })
          next.relations = relationships(next.nodes)
        }
        candidate = next
        generated = true
        preview = true
      })
    })
    bind('scope-manual', () => {
      syncScope()
      void run(async () => {
        const next = fromCurrent()
        validateScope(next.scope!)
        candidate = next
        generated = false
        preview = false
      })
    })
    bind('scope-return', () => { candidate = undefined; preview = false; error = ''; render() })
    bind('scope-back', () => { preview = false; error = ''; render() })
    bind('scope-add', () => {
      syncNodes()
      if (!candidate) return
      candidate.nodes.push({ id: uid('u'), name: '新考点', parentId: candidate.nodes.find((n) => n.kind === 'root')!.id,
        kind: 'concept', examWeight: 0.5, weightSource: 'manual', edited: true, prereq: [], confusable: [] })
      render()
    })
    box.querySelectorAll<HTMLButtonElement>('[data-archive],[data-reidentify]').forEach((button) => button.addEventListener('click', () => {
      syncNodes()
      const id = button.dataset.archive ?? button.dataset.reidentify
      const node = candidate?.nodes.find((n) => n.id === id)
      if (!candidate || !node) return
      if (button.dataset.archive) candidate = archiveNode(candidate, node.id)
      else {
        candidate.nodes = remap(candidate.nodes, new Map([[node.id, uid('u')]]))
        candidate.relations = relationships(candidate.nodes, candidate.relations)
      }
      render()
    }))
    bind('scope-preview', () => {
      syncNodes()
      try { validateGraph(candidate!); preview = true; error = '' }
      catch (e) { error = (e as Error).message }
      render()
    })
    bind('scope-apply', () => {
      if (!candidate || (needsConsent && !box.querySelector<HTMLInputElement>('#scope-consent')?.checked)) {
        error = '请先确认对手工编辑内容的替换。'
        render()
        return
      }
      const next = candidate
      box.dataset.scopeApplying = '1'
      void run(async () => {
        try {
          validateGraph(next)
          await options.apply(next)
        } finally { delete box.dataset.scopeApplying }
      })
    })
  }

  render()
}
