/// <reference lib="dom" />
// What runs inside the agent's page. Each function is stringified with Function.prototype.toString()
// and injected with executeJavaScript (guestScripts.ts), so each is self-contained: no imports, and
// no reference to anything outside its own body — a neighbouring constant is `undefined` in the guest.
// That is why `selectorOf` below is a copy of the one in src/renderer/src/lib/pickRuntime.ts rather
// than an import, and why the budgets arrive as an argument. Change one copy, change the other.
//
// Core is compiled under tsconfig.node.json without the DOM lib; the reference above brings the DOM
// types in for this file only. Verified to compile on 2026-09-07 before this file was written.
//
// These functions return plain data. Main clamps and redacts it (snapshot.ts) before the script
// sees it, and main — not the page — decides whether a link may be followed (helpers.ts).

export interface SnapshotBudgets {
  interactive: number
  text: number
  name: number
  selector: number
  heading: number
  summary: number
}

/** The page as text. Headings, landmarks, interactive elements with stable selectors, then the
 *  visible text. Excludes what a person cannot see and what should never leave the page: script and
 *  style bodies, hidden inputs, elements hidden by CSS, and the Design Mode picker's own overlay
 *  (data-astera-pick) when both are on the same page. */
export function snapshotRuntime(budgets: SnapshotBudgets): unknown {
  function selectorOf(el: Element): string {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + el.id
    const parts: string[] = []
    let cur: Element | null = el
    let depth = 0
    while (cur && cur !== document.documentElement && depth < 5) {
      const tag = cur.tagName.toLowerCase()
      const parent: Element | null = cur.parentElement
      let part = tag
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, function (c: Element) { return c.tagName === cur!.tagName })
        if (same.length > 1) part += ':nth-of-type(' + (Array.prototype.indexOf.call(same, cur) + 1) + ')'
      }
      parts.unshift(part)
      cur = parent
      depth += 1
    }
    return parts.join(' > ')
  }
  function visible(el: Element): boolean {
    if (el.closest('[data-astera-pick]')) return false
    const cs = window.getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 || r.height > 0
  }
  function nameOf(el: Element): string {
    const aria = el.getAttribute('aria-label')
    if (aria) return aria
    const labelled = el.getAttribute('aria-labelledby')
    if (labelled) {
      const t = labelled.split(/\s+/).map(function (id) { const n = document.getElementById(id); return n ? n.textContent || '' : '' }).join(' ')
      if (t.trim()) return t
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el.labels && el.labels.length) return el.labels[0].textContent || ''
      const ph = el.getAttribute('placeholder')
      if (ph) return ph
    }
    if (el instanceof HTMLImageElement && el.alt) return el.alt
    return el.getAttribute('title') || ''
  }
  const skipText = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'])
  function textOf(root: Node, max: number): string {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        const p = n.parentElement
        if (!p || skipText.has(p.tagName) || !visible(p)) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      }
    })
    let out = ''
    for (let n = walker.nextNode(); n && out.length < max + 1000; n = walker.nextNode()) {
      const t = (n.textContent || '').replace(/\s+/g, ' ')
      if (t.trim()) out += t + ' '
    }
    return out
  }
  const headings: { level: number; text: string }[] = []
  document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(function (h) {
    if (!visible(h)) return
    headings.push({ level: Number(h.tagName.charAt(1)), text: (h.textContent || '').slice(0, budgets.heading) })
  })
  const landmarks: { tag: string; summary: string }[] = []
  document.querySelectorAll('nav,main,header,footer,aside,form').forEach(function (l) {
    if (!visible(l)) return
    landmarks.push({ tag: l.tagName, summary: (l.textContent || '').replace(/\s+/g, ' ').trim().slice(0, budgets.summary) })
  })
  const interactive: unknown[] = []
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role],[tabindex]:not([tabindex="-1"])'
  document.querySelectorAll(sel).forEach(function (el) {
    if (interactive.length >= budgets.interactive + 50) return // main counts the overflow; a little slack is enough
    if (!visible(el)) return
    const entry: Record<string, unknown> = {
      tag: el.tagName,
      selector: selectorOf(el).slice(0, budgets.selector),
      name: nameOf(el).slice(0, budgets.name),
      text: (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, budgets.name),
      disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true'
    }
    const role = el.getAttribute('role')
    if (role) entry.role = role
    if (el instanceof HTMLAnchorElement) entry.href = el.href
    interactive.push(entry)
  })
  return {
    title: document.title,
    url: location.href,
    headings: headings,
    landmarks: landmarks,
    interactive: interactive,
    text: textOf(document.body, budgets.text)
  }
}

/** Finds the element. If it is, or sits inside, a link and `followLink` is false, returns the link's
 *  address without clicking — main decides whether that address may be followed (the loopback rule
 *  lives in one place, core/agentBrowser/urls.ts) and calls again with `followLink` true. */
export function clickRuntime(sel: string, followLink: boolean): unknown {
  const el = document.querySelector(sel) as HTMLElement | null
  if (!el) return { found: false }
  const a = el.closest('a[href]') as HTMLAnchorElement | null
  if (a && !followLink) return { found: true, href: a.href }
  el.scrollIntoView({ block: 'center', inline: 'center' })
  el.focus()
  el.click()
  return { found: true, clicked: true }
}

/** Sets a value the way typing would, so frameworks that listen for input events see it. The native
 *  value setter is used on purpose: React overrides the element's own setter to track the value, and
 *  writing through the override does not fire its onChange. */
export function fillRuntime(sel: string, text: string): unknown {
  const el = document.querySelector(sel) as HTMLElement | null
  if (!el) return { found: false }
  el.focus()
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    if (desc && desc.set) desc.set.call(el, text)
    else el.value = text
  } else if (el instanceof HTMLSelectElement) {
    el.value = text
    if (el.value !== text) return { found: true, error: 'no option has that value' }
  } else if (el.isContentEditable) {
    el.textContent = text
  } else {
    return { found: true, error: 'not an input, textarea, select or editable element' }
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { found: true, filled: true }
}

/** A key on the focused element: keydown then keyup, with the codes a keyboard would send for the
 *  named keys. Synthetic key events do not trigger the browser's own default actions; the one that a
 *  form-filling agent relies on — Enter submitting the form the focused field belongs to — is done
 *  here when the page did not preventDefault the keydown. */
export function pressRuntime(key: string): unknown {
  const target = (document.activeElement as HTMLElement | null) || document.body
  const codes: Record<string, string> = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ' ': 'Space' }
  const code = codes[key] || (key.length === 1 ? 'Key' + key.toUpperCase() : key)
  const init: KeyboardEventInit = { key: key, code: code, bubbles: true, cancelable: true }
  const down = target.dispatchEvent(new KeyboardEvent('keydown', init))
  target.dispatchEvent(new KeyboardEvent('keyup', init))
  if (down && key === 'Enter') {
    const form = (target as HTMLInputElement).form || target.closest('form')
    if (form && target instanceof HTMLInputElement) form.requestSubmit()
  }
  return { pressed: true, target: target.tagName.toLowerCase() + (target.id ? '#' + target.id : '') }
}

/** Resolves when the selector matches, polling; `{ found: false }` when `ms` pass first. */
export function waitForRuntime(sel: string, ms: number): Promise<unknown> {
  return new Promise(function (resolve) {
    const start = Date.now()
    function tick(): void {
      if (document.querySelector(sel)) { resolve({ found: true }); return }
      if (Date.now() - start >= ms) { resolve({ found: false }); return }
      setTimeout(tick, 100)
    }
    tick()
  })
}
