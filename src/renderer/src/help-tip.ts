import { escapeHtml as esc } from './study-text'

export function helpTip(label: string, text: string): string {
  return '<button type="button" class="help-icon" data-help aria-label="' + esc(label) +
    '" aria-description="' + esc(text) + '">?</button>'
}

export function bindHelpTips(tooltip: HTMLElement): void {
  let anchor: HTMLElement | null = null
  const fromEvent = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>('[data-help]') : null

  function hide(): void {
    anchor = null
    tooltip.hidden = true
    observer.disconnect()
  }

  const observer = new MutationObserver(() => { if (!anchor?.isConnected) hide() })

  function show(next: HTMLElement): void {
    if (next === anchor) return
    anchor = next
    const template = document.getElementById(next.dataset.helpTemplate ?? '')
    if (template instanceof HTMLTemplateElement) tooltip.replaceChildren(template.content.cloneNode(true))
    else tooltip.textContent = next.getAttribute('aria-description') ?? ''
    tooltip.hidden = false
    const trigger = next.getBoundingClientRect()
    const { width, height } = tooltip.getBoundingClientRect()
    tooltip.style.left = Math.max(8, Math.min(trigger.left, innerWidth - width - 8)) + 'px'
    const below = trigger.bottom + 6
    tooltip.style.top = (below + height <= innerHeight - 8 ? below : Math.max(8, trigger.top - height - 6)) + 'px'
    observer.observe(document.body, { childList: true, subtree: true })
  }

  document.addEventListener('pointerover', (event) => {
    const next = fromEvent(event.target)
    if (next && event.pointerType !== 'touch') show(next)
  })
  document.addEventListener('pointerout', (event) => {
    if (anchor && fromEvent(event.target) === anchor && fromEvent(event.relatedTarget) !== anchor) hide()
  })
  document.addEventListener('focusin', (event) => {
    const next = fromEvent(event.target)
    if (next?.matches(':focus-visible')) show(next)
  })
  document.addEventListener('focusout', (event) => {
    if (anchor && fromEvent(event.target) === anchor) hide()
  })
  document.addEventListener('scroll', hide, true)
  window.addEventListener('resize', hide)
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !anchor) return
    hide()
    event.stopPropagation()
  }, true)
}
