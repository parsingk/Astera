/// <reference lib="dom" />
// What runs inside the agent's page. Each function is stringified with Function.prototype.toString()
// and injected with executeJavaScript (guestScripts.ts), so each is self-contained: no imports, and
// no reference to anything outside its own body — a neighbouring constant is `undefined` in the guest.
// That is why `selectorOf` below is a copy of the one in src/renderer/src/lib/pickRuntime.ts rather
// than an import, and why the budgets arrive as an argument. Change one copy, change the other.
//
// This file needs the DOM types; the reference above declares that need explicitly. Right now
// tsconfig.node.json names no `lib` of its own, so TypeScript's default inference already supplies
// DOM for the whole program and the line is redundant in practice — but that is an accident of the
// current config, not something this file should rely on. A later change that adds an explicit `lib`
// there (to narrow it for some other reason) would silently drop DOM from this file too if the line
// above were not here to supply it directly.
//
// These functions return plain data. Main clamps and redacts it (snapshot.ts) before the script
// sees it, and main — not the page — decides whether a link may be followed (helpers.ts).
//
// One rule for anything added below: a runtime may throw **before** it acts, never after. Main
// re-sends a script whose reply was lost to a navigation (helpers.ts, `inGuest`) and cannot tell that
// case from a page throw, so only the pure reads are re-sent at all — snapshotRuntime and
// waitForRuntime, which act on nothing, so the worst a re-send can do is read the newer page. A
// runtime that changes the page is sent once. A read that acted first and then threw would have that
// action applied twice.

export interface SnapshotBudgets {
  interactive: number
  headings: number
  landmarks: number
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
  /** The visible text cut to `max`, and how long all of it is. The walk cannot stop at the cut: the
   *  length is what tells the agent how much of the page it is not reading, and a walk that stopped
   *  just past the cut could never report more than that — whatever the page's real length. */
  function textOf(root: Node, max: number): { text: string; length: number } {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        const p = n.parentElement
        if (!p || skipText.has(p.tagName) || !visible(p)) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      }
    })
    let out = ''
    let length = 0
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent || '').replace(/\s+/g, ' ')
      if (!t.trim()) continue
      length += t.length + 1
      if (out.length < max) out += t + ' '
    }
    return { text: out, length: length }
  }
  // Each list is counted whole and sent capped, in the one pass that decides what to keep. The count
  // is what the agent makes a decision on — "is there another button below?" — and main can only count
  // what arrived, which is how a page with 5,000 controls came back as "200 shown, 50 more". The caps
  // are also what bounds this: an uncapped list of a few thousand items cost main seconds of clamping
  // and over a megabyte of IPC per snapshot.
  const headings: { level: number; text: string }[] = []
  let headingCount = 0
  document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(function (h) {
    if (!visible(h)) return
    headingCount += 1
    if (headings.length < budgets.headings) headings.push({ level: Number(h.tagName.charAt(1)), text: (h.textContent || '').slice(0, budgets.heading) })
  })
  const landmarks: { tag: string; summary: string }[] = []
  let landmarkCount = 0
  document.querySelectorAll('nav,main,header,footer,aside,form').forEach(function (l) {
    if (!visible(l)) return
    landmarkCount += 1
    if (landmarks.length < budgets.landmarks) landmarks.push({ tag: l.tagName, summary: (l.textContent || '').replace(/\s+/g, ' ').trim().slice(0, budgets.summary) })
  })
  const interactive: unknown[] = []
  let interactiveCount = 0
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role],[tabindex]:not([tabindex="-1"])'
  document.querySelectorAll(sel).forEach(function (el) {
    if (!visible(el)) return
    interactiveCount += 1
    if (interactive.length >= budgets.interactive) return
    // A password field is listed like any other — the agent has to know it is there — but its value
    // is never read. The redaction main applies cannot help here: a password a person chose looks
    // like ordinary text to it, and the design lets the user type in the agent's tab, so this would
    // be their own password on its way into the agent's context and its provider's logs. Design Mode
    // has no such exposure (pickRuntime.ts reads attributes, where a typed value never appears).
    const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? (el.type === 'password' ? '' : el.value) : el.textContent || ''
    const entry: Record<string, unknown> = {
      tag: el.tagName,
      selector: selectorOf(el).slice(0, budgets.selector),
      name: nameOf(el).slice(0, budgets.name),
      text: value.replace(/\s+/g, ' ').trim().slice(0, budgets.name),
      disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true'
    }
    const role = el.getAttribute('role')
    if (role) entry.role = role
    if (el instanceof HTMLAnchorElement) entry.href = el.href
    // The current state of a form control, so the agent can check a fill() it just made without a
    // screenshot. A password's value is never read (the comment above says why); its checkbox and
    // radio siblings report `checked` rather than a value. `text` keeps its meaning, so a select
    // still lists its option texts and `value` says which one is chosen.
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') entry.checked = el.checked
      else if (el.type !== 'password') entry.value = el.value
    } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      entry.value = el.value
    }
    interactive.push(entry)
  })
  const visibleText = textOf(document.body, budgets.text)
  return {
    title: document.title,
    url: location.href,
    headings: headings,
    headingCount: headingCount,
    landmarks: landmarks,
    landmarkCount: landmarkCount,
    interactive: interactive,
    interactiveCount: interactiveCount,
    text: visibleText.text,
    textLength: visibleText.length
  }
}

/** Finds the element. If it is, or sits inside, a link and `followLink` is false, returns the link's
 *  address without clicking — main decides whether that address may be followed (the loopback rule
 *  lives in one place, core/agentBrowser/urls.ts) and calls again with `followLink` true. */
export function clickRuntime(sel: string, followLink: boolean): unknown {
  const el = document.querySelector(sel) as HTMLElement | null
  if (!el) return { found: false }
  // el.click() on a disabled control dispatches nothing at all, so answering `clicked` for one would
  // be a false success — the agent spends a round wondering why the page did not change. Checked
  // before the link below because a disabled control does not reach an enclosing link either: a
  // browser dispatches no click event for it, so there is nothing to follow.
  //
  // ':disabled' rather than the `disabled` property, which reflects only the element's own attribute:
  // a control inside a <fieldset disabled> reads false there while click() still returns early for it.
  // aria-disabled is deliberately not included, though snapshot() reports it as disabled — an
  // aria-disabled element really does receive the click, and refusing it would refuse a click the page
  // itself handles.
  if (el.matches(':disabled')) return { found: true, disabled: true }
  const a = el.closest('a[href]') as HTMLAnchorElement | null
  // `a.href` — the resolved DOM property — and not getAttribute('href'), which is security-relevant
  // rather than incidental: main refuses an href only when it reads as an off-machine http(s)
  // address, and clicks anything else plainly. A protocol-relative attribute such as `//example.com/x`
  // is not an http(s) address as written, so reporting the attribute would send that off-machine
  // navigation past the check; resolved against the document it is one, and is refused.
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
  // A single letter or digit maps to the real `code` a keyboard would send; anything else is a name
  // this function cannot verify, so it says so with '' rather than guessing wrong — 'Key,' for a
  // comma is a lie an event.code listener would act on, where '' is honestly "unknown".
  const code = codes[key] || (/^[a-zA-Z]$/.test(key) ? 'Key' + key.toUpperCase() : /^[0-9]$/.test(key) ? 'Digit' + key : '')
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
