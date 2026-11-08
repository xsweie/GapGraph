import type { KNode, Pack } from '../../shared/types'
import { archiveNodeWithScope } from '../../main/domain/scope'

type Action = 'add' | 'child' | 'self'
type Apply = (original: Pack, candidate: Pack, focusId: string | null) => Promise<void>

const labels: Record<Action, string> = { add: '增加新子节点', child: '删除子节点', self: '删除本节点' }

export function bindNodeEditor(menu: HTMLElement, dialog: HTMLDialogElement, apply: Apply) {
  menu.innerHTML = Object.entries(labels).map(([action, label]) => `<button type="button" data-action="${action}">${label}</button>`).join('')
  const buttons = [...menu.querySelectorAll('button')]
  document.addEventListener('pointerdown', (event) => {
    if (!menu.contains(event.target as Node)) menu.hidden = true
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || menu.hidden) return
    menu.hidden = true
    event.stopPropagation()
  }, true)

  function openDialog(action: Action, pack: Pack, node: KNode, children: KNode[]): void {
    const adding = action === 'add'
    dialog.innerHTML = `
      <div class="ghead"><div><h2 id="node-edit-title">${labels[action]}</h2><p class="gsub" id="node-edit-context"></p></div></div>
      <form>
        ${adding ? `
          <label>考点名称<input class="sinput" name="name" maxlength="80" required autofocus></label>
          <label>一句话讲解（选填）<textarea class="sinput" name="brief" rows="2" maxlength="240"></textarea></label>
          <label id="node-edit-scope" hidden>关联范围<select name="scope"></select></label>` : `
          ${action === 'child' ? '<label>选择直接子节点<select name="child" autofocus></select></label>' : ''}
          <p id="node-edit-impact"></p>`}
        <p class="badline" role="alert" hidden></p>
        <div class="scope-actions">
          <button type="button" data-cancel ${action === 'self' ? 'autofocus' : ''}>取消</button>
          <button type="submit" class="primary">${adding ? '添加考点' : '确认删除'}</button>
        </div>
      </form>`
    dialog.querySelector('#node-edit-context')!.textContent = (adding ? '父节点 · ' : '当前节点 · ') + node.name
    const form = dialog.querySelector('form')!
    const confirm = form.querySelector<HTMLButtonElement>('button[type=submit]')!
    const cancel = form.querySelector<HTMLButtonElement>('[data-cancel]')!
    const error = form.querySelector<HTMLElement>('[role=alert]')!
    cancel.onclick = () => dialog.close()
    dialog.oncancel = (event) => { if (confirm.disabled) event.preventDefault() }
    let build: () => { candidate: Pack; focus: string | null }

    if (adding) {
      const name = form.querySelector<HTMLInputElement>('[name=name]')!
      const brief = form.querySelector<HTMLTextAreaElement>('[name=brief]')!
      const select = form.querySelector<HTMLSelectElement>('[name=scope]')!
      const items = [...(pack.scope?.include ?? []), ...(pack.scope?.foundations ?? [])]
      const inherited = items.filter((item) => node.scopeIds?.includes(item.id))
      if (items.length) {
        form.querySelector<HTMLElement>('#node-edit-scope')!.hidden = false
        select.required = !!pack.scope?.include.length
        if (inherited.length) select.add(new Option('沿用父节点范围（' + inherited.map((item) => item.label).join('、') + '）', 'inherit'))
        else select.add(new Option(select.required ? '请选择关联范围' : '暂不关联范围', ''))
        items.forEach((item, i) => select.add(new Option(item.label, String(i))))
        select.add(new Option('标记为补充基础', 'supplementary'))
      }
      build = () => {
        if (!name.value.trim()) throw new Error('请填写考点名称。')
        const selected = items[Number.parseInt(select.value, 10)]
        const scopeIds = select.value === 'inherit' ? inherited.map((item) => item.id) : selected ? [selected.id] : []
        const child: KNode = {
          id: 'u-' + crypto.randomUUID(), name: name.value.trim(), brief: brief.value.trim() || undefined,
          kind: 'concept', parentId: node.id, examWeight: 0.5, weightSource: 'manual', edited: true,
          prereq: [], confusable: [], scopeIds, supplementary: select.value === 'supplementary'
        }
        return { candidate: { ...pack, nodes: [...pack.nodes, child] }, focus: child.id }
      }
    } else {
      const select = form.querySelector<HTMLSelectElement>('[name=child]')
      for (const child of children) select?.add(new Option(child.name, child.id))
      const target = () => children.find((child) => child.id === select?.value) ?? node
      const impact = form.querySelector<HTMLElement>('#node-edit-impact')!
      const update = () => {
        const removed = target()
        const { candidate, removedItems } = archiveNodeWithScope(pack, removed.id)
        const moved = pack.nodes.filter((child) => child.parentId === removed.id).length
        impact.textContent = `将删除「${removed.name}」，保留历史作答和收藏。` +
          (moved ? ` ${moved} 个下级节点会上移一层。` : '') +
          (removedItems.length ? ' 学习范围同时移除：' + removedItems.map((item) => item.label).join('、') + '。' : '')
        build = () => ({ candidate, focus: removed.parentId })
      }
      select?.addEventListener('change', update)
      update()
    }

    form.onsubmit = async (event) => {
      event.preventDefault()
      confirm.disabled = cancel.disabled = true
      error.hidden = true
      try {
        const { candidate, focus } = build()
        await apply(pack, candidate, focus)
        dialog.close()
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : '无法保存考点，请重试。'
        error.hidden = false
      } finally {
        confirm.disabled = cancel.disabled = false
      }
    }
    dialog.showModal()
  }

  return (pack: Pack, id: string, event: MouseEvent): void => {
    const node = pack.nodes.find((entry) => entry.id === id)
    if (!node) return
    const children = pack.nodes.filter((entry) => entry.parentId === id)
    for (const button of buttons) {
      const action = button.dataset.action as Action
      const reason = action === 'self' && node.kind === 'root' ? '板块根节点不可删除' :
        action === 'child' && !children.length ? '这个节点没有子节点' :
        action !== 'add' && pack.nodes.length <= 2 ? '板块至少保留一个考点' : ''
      button.disabled = !!reason
      button.title = reason
      button.onclick = () => {
        menu.hidden = true
        openDialog(action, pack, node, children)
      }
    }
    menu.setAttribute('aria-label', node.name + '的节点操作')
    menu.hidden = false
    menu.style.left = Math.max(6, Math.min(event.clientX, innerWidth - menu.offsetWidth - 6)) + 'px'
    menu.style.top = Math.max(6, Math.min(event.clientY, innerHeight - menu.offsetHeight - 6)) + 'px'
    buttons[0].focus({ preventScroll: true })
  }
}
