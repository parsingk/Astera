// The code that runs inside the previewed page. Four self-contained functions; pickScripts.ts
// stringifies them with Function.prototype.toString and injects the result with
// webview.executeJavaScript, so NOTHING here may reach outside its own body: no imports, no module
// constants, no helpers the bundler could hoist. Plain ES2020 — no object spread, no class fields.
//
// Why the main world and not an isolated one: an isolated world needs the debugger, and the pane's
// DevTools button must keep it. The page can therefore see these globals; it is the developer's own
// dev server.

/** What the picker keeps on window.__asteraPick between calls. */
interface PickState {
  overlay: HTMLDivElement | null
  box: HTMLDivElement | null
  label: HTMLDivElement | null
  hovered: Element | null
  /** The element under the pointer when the button went down. Set until the click that follows, or
   *  until the button is seen up again without one. */
  pressed: Element | null
  /** Where the pointer was last seen, so a scroll can ask what is under it now without a mousemove. */
  lastX: number | null
  lastY: number | null
  pending: { resolve: (v: unknown) => void; reject: (e: Error) => void } | null
  onMove: ((e: MouseEvent) => void) | null
  onScroll: (() => void) | null
  onDown: ((e: MouseEvent) => void) | null
  onClick: ((e: MouseEvent) => void) | null
  onKey: ((e: KeyboardEvent) => void) | null
  cancel: () => void
}

/** Arms the picker and returns a Promise for the next click's raw payload. Idempotent. */
export function pickerRuntime(): Promise<unknown> {
  const KEY = '__asteraPick'
  const w = window as unknown as Record<string, unknown>
  const STYLE_KEYS = ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'backgroundColor', 'border', 'borderRadius', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'textAlign', 'zIndex']
  const Z = 2147483647

  function ownNode(el: Element | null, S: PickState): boolean {
    return el === S.overlay || el === S.box || el === S.label
  }

  function shortName(el: Element): string {
    const tag = el.tagName.toLowerCase()
    if (el.id) return tag + '#' + el.id
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : []
    return cls.length ? tag + '.' + cls.join('.') : tag
  }

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

  function pathOf(el: Element): string {
    const parts: string[] = []
    let cur: Element | null = el
    let depth = 0
    while (cur && cur !== document.documentElement && depth < 10) {
      parts.unshift(shortName(cur))
      cur = cur.parentElement
      depth += 1
    }
    return parts.join(' > ')
  }

  function accessibleName(el: Element): string | null {
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return aria.trim()
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const text = by.split(/\s+/).map(function (id) { const n = document.getElementById(id); return n ? (n.textContent || '') : '' }).join(' ').trim()
      if (text) return text
    }
    const alt = el.getAttribute('alt') || el.getAttribute('title')
    if (alt && alt.trim()) return alt.trim()
    const tag = el.tagName.toLowerCase()
    if (tag === 'button' || tag === 'a' || tag === 'label' || tag === 'summary' || el.getAttribute('role') === 'button') {
      const t = (el.textContent || '').trim()
      if (t) return t
    }
    return null
  }

  function isFixed(el: Element): boolean {
    let cur: Element | null = el
    while (cur && cur !== document.documentElement) {
      const pos = getComputedStyle(cur).position
      if (pos === 'fixed' || pos === 'sticky') return true
      cur = cur.parentElement
    }
    return false
  }

  function nearbyText(el: Element): string[] {
    const out: string[] = []
    const seen: Record<string, boolean> = {}
    // What is not content: our own overlay and badges, and the elements whose text the page never
    // shows. `innerText` is empty for all of those, so the `textContent` fallback below used to reach
    // the stylesheet inside <head> and the bootstrap JSON inside a <script> — and a page's bootstrap
    // JSON is where its keys are. Seen on a real dev page: a `__NEXT_DATA__` body listed as nearby
    // text under all three annotations of one batch.
    const skip = { HEAD: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, LINK: 1, META: 1 } as Record<string, number>
    const push = function (n: Element | null) {
      if (!n || n === el || out.length >= 10) return
      if (skip[n.tagName] || n.hasAttribute('data-astera-pick')) return
      const t = ((n as HTMLElement).innerText || n.textContent || '').replace(/\s+/g, ' ').trim()
      if (t && !seen[t]) { seen[t] = true; out.push(t.slice(0, 200)) }
    }
    const parent = el.parentElement
    if (parent) {
      for (let i = 0; i < parent.children.length; i += 1) push(parent.children[i])
      const grand = parent.parentElement
      if (grand) for (let i = 0; i < grand.children.length && out.length < 10; i += 1) if (grand.children[i] !== parent) push(grand.children[i])
    }
    return out
  }

  function reactInfo(el: Element): { components: string | null; source: string | null } {
    let node: Element | null = el
    let fiber: Record<string, unknown> | null = null
    for (let hops = 0; node && hops < 4 && !fiber; hops += 1) {
      const keys = Object.keys(node)
      for (let i = 0; i < keys.length; i += 1) {
        if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) {
          fiber = (node as unknown as Record<string, Record<string, unknown>>)[keys[i]]
          break
        }
      }
      node = node.parentElement
    }
    if (!fiber) return { components: null, source: null }
    const names: string[] = []
    let source: string | null = null
    let cur: Record<string, unknown> | null = fiber
    let guard = 0
    while (cur && guard < 60 && names.length < 8) {
      const type = cur.type as Record<string, unknown> | ((...a: unknown[]) => unknown) | string | null
      if (type && typeof type !== 'string') {
        const t = type as Record<string, unknown>
        // Cast: the `unknown &&` branches make the inferred type widen to `{}` once narrowed by
        // the `if` below; the runtime value is unaffected, this only tells the checker what it is.
        const name = ((t.displayName as string) || (t.name as string) || (t.render && (((t.render as Record<string, unknown>).displayName as string) || ((t.render as Record<string, unknown>).name as string))) || (t.type && (((t.type as Record<string, unknown>).displayName as string) || ((t.type as Record<string, unknown>).name as string))) || null) as string | null
        if (name && names.indexOf(name) < 0) names.push(name)
      }
      const dbg = (cur._debugSource || (cur._debugOwner && (cur._debugOwner as Record<string, unknown>)._debugSource)) as Record<string, unknown> | undefined
      if (!source && dbg && typeof dbg.fileName === 'string' && typeof dbg.lineNumber === 'number') {
        const file = (dbg.fileName as string).replace(/^webpack:\/\/\/?/, '').replace(/^file:\/\//, '').replace(/^\.\//, '')
        source = file + ':' + dbg.lineNumber + (typeof dbg.columnNumber === 'number' ? ':' + dbg.columnNumber : '')
      }
      cur = cur.return as Record<string, unknown> | null
      guard += 1
    }
    return {
      components: names.length ? names.slice().reverse().map(function (n) { return '<' + n + '>' }).join(' ') : null,
      source: source
    }
  }

  function extract(el: Element, clickX: number, clickY: number): unknown {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const styles: Record<string, string> = {}
    for (let i = 0; i < STYLE_KEYS.length; i += 1) styles[STYLE_KEYS[i]] = cs.getPropertyValue(STYLE_KEYS[i].replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase() }))
    const attrs: Record<string, string> = {}
    for (let i = 0; i < el.attributes.length && i < 40; i += 1) attrs[el.attributes[i].name] = el.attributes[i].value
    const react = reactInfo(el)
    return {
      page: { url: location.href, title: document.title, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      tagName: el.tagName.toLowerCase(),
      selector: selectorOf(el),
      elementPath: pathOf(el),
      cssClasses: typeof el.className === 'string' ? el.className.trim() : '',
      textSnippet: ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      htmlSnippet: el.outerHTML.slice(0, 4096),
      attributes: attrs,
      accessibility: { role: el.getAttribute('role'), accessibleName: accessibleName(el) },
      // Where the pointer actually was, not where the element is: the comment box opens beside the
      // click, and on a wide element those are far apart.
      clickViewport: { x: clickX, y: clickY },
      rectViewport: { x: r.left, y: r.top, width: r.width, height: r.height },
      rectPage: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height },
      isFixed: isFixed(el),
      computedStyles: styles,
      nearbyText: nearbyText(el),
      reactComponents: react.components,
      sourceFile: react.source
    }
  }

  let S = w[KEY] as PickState | undefined
  if (!S) {
    S = { overlay: null, box: null, label: null, hovered: null, pressed: null, lastX: null, lastY: null, pending: null, onMove: null, onScroll: null, onDown: null, onClick: null, onKey: null, cancel: function () {} }
    w[KEY] = S
  }
  const state: PickState = S

  function teardown(): void {
    if (state.onMove) window.removeEventListener('mousemove', state.onMove, true)
    if (state.onScroll) { window.removeEventListener('scroll', state.onScroll, true); window.removeEventListener('resize', state.onScroll, true) }
    if (state.onDown) window.removeEventListener('mousedown', state.onDown, true)
    if (state.onClick) window.removeEventListener('click', state.onClick, true)
    if (state.onKey) window.removeEventListener('keydown', state.onKey, true)
    state.onMove = null; state.onScroll = null; state.onDown = null; state.onClick = null; state.onKey = null
    for (const n of [state.overlay, state.box, state.label]) if (n && n.parentNode) n.parentNode.removeChild(n)
    state.overlay = null; state.box = null; state.label = null; state.hovered = null; state.pressed = null; state.lastX = null; state.lastY = null
  }

  state.cancel = function () {
    const p = state.pending
    state.pending = null
    teardown()
    if (p) p.reject(new Error('cancelled'))
  }

  // Re-arm: a previous pending pick, if any, is superseded rather than left dangling
  if (state.pending) { const p = state.pending; state.pending = null; p.reject(new Error('re-armed')) }

  if (!state.overlay) {
    const overlay = document.createElement('div')
    overlay.setAttribute('data-astera-pick', '')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:' + Z + ';cursor:default;background:transparent;user-select:none;-webkit-user-select:none;'
    const box = document.createElement('div')
    box.setAttribute('data-astera-pick', '')
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:' + Z + ';border:2px solid #4c7ef3;background:rgba(76,126,243,.12);border-radius:2px;display:none;box-sizing:border-box;'
    const label = document.createElement('div')
    label.setAttribute('data-astera-pick', '')
    label.style.cssText = 'position:fixed;pointer-events:none;z-index:' + Z + ';background:#4c7ef3;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:1px 6px;border-radius:3px;display:none;max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
    document.documentElement.appendChild(overlay)
    document.documentElement.appendChild(box)
    document.documentElement.appendChild(label)
    state.overlay = overlay; state.box = box; state.label = label

    const targetAt = function (x: number, y: number): Element | null {
      const stack = document.elementsFromPoint(x, y)
      for (let i = 0; i < stack.length; i += 1) if (!ownNode(stack[i], state) && stack[i] !== document.documentElement) return stack[i]
      return null
    }
    const hide = function (): void {
      if (state.box) state.box.style.display = 'none'
      if (state.label) state.label.style.display = 'none'
    }
    const place = function (target: Element): void {
      if (!state.box || !state.label) return
      const r = target.getBoundingClientRect()
      state.box.style.display = 'block'
      state.box.style.left = r.left + 'px'; state.box.style.top = r.top + 'px'
      state.box.style.width = r.width + 'px'; state.box.style.height = r.height + 'px'
      state.label.style.display = 'block'
      state.label.textContent = shortName(target) + ' · ' + Math.round(r.width) + '×' + Math.round(r.height)
      const above = r.top - 22
      state.label.style.left = Math.max(0, r.left) + 'px'
      state.label.style.top = (above >= 0 ? above : r.bottom + 2) + 'px'
    }
    state.onMove = function (e: MouseEvent) {
      // While the button is down the pick is already decided — it is whatever was under the pointer
      // when it went down — so the box stays there rather than trailing the drag. A press on the
      // button that ended over the block below used to highlight everything in between and annotate
      // the block.
      if (state.pressed) {
        if (e.buttons & 1) return
        state.pressed = null // the button came back up somewhere no click followed from
      }
      state.lastX = e.clientX; state.lastY = e.clientY
      const target = targetAt(e.clientX, e.clientY)
      state.hovered = target
      // Over the scrollbar, or over nothing: no element to outline, so no outline. Leaving the last
      // one up is how a box ended up floating where an element used to be.
      if (!target) { hide(); return }
      place(target)
    }
    // The box is fixed to the viewport and the page moves under it. Without this it stayed where it
    // was drawn while the element scrolled away — the border "moved with the screen". A held press
    // keeps its element; otherwise the question is what is under the pointer now, which a scroll
    // changes without the pointer moving.
    state.onScroll = function () {
      if (state.pressed) { place(state.pressed); return }
      if (state.lastX === null || state.lastY === null) return
      const target = targetAt(state.lastX, state.lastY)
      state.hovered = target
      if (!target) { hide(); return }
      place(target)
    }
    // A press that is not stopped starts a text selection in the page, and dragging from it paints a
    // blue band across whatever the pointer crosses. Aiming at an element is a press and a small
    // movement, so this happened to anyone who did not click perfectly still.
    state.onDown = function (e: MouseEvent) {
      if (e.button !== 0) return
      e.preventDefault()
      state.pressed = targetAt(e.clientX, e.clientY)
    }
    state.onClick = function (e: MouseEvent) {
      if (e.button !== 0) return
      e.preventDefault(); e.stopPropagation()
      // The element that was pressed, not the one released over. The two differ exactly when the
      // pointer moved in between, and the press is where the user was aiming.
      const target = state.pressed || state.hovered
      state.pressed = null
      const p = state.pending
      if (!target || !p) return
      state.pending = null
      let payload: unknown = null
      try { payload = extract(target, e.clientX, e.clientY) } catch (err) { p.reject(err instanceof Error ? err : new Error(String(err))); return }
      p.resolve(payload)
    }
    state.onKey = function (e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); state.cancel() }
    }
    // On `window`, not `document`: capture starts at the window, so this runs before any listener the
    // page put on the document or below. It is not absolute — a page that registered its own
    // window-capture click listener first and calls stopImmediatePropagation() still wins, and then a
    // pick simply never resolves. Nothing can beat that from inside the page's own world, which is
    // where this has to run (an isolated world needs the debugger, and the pane's DevTools button owns
    // it). The escape hatch is that cancel() changes state directly instead of going through an event,
    // so the toolbar toggle and Escape keep working even then.
    window.addEventListener('mousemove', state.onMove, true)
    window.addEventListener('scroll', state.onScroll, true)
    window.addEventListener('resize', state.onScroll, true)
    window.addEventListener('mousedown', state.onDown, true)
    window.addEventListener('click', state.onClick, true)
    window.addEventListener('keydown', state.onKey, true)
  }

  return new Promise(function (resolve, reject) { state.pending = { resolve: resolve, reject: reject } })
}

/** Cancels a pending pick and removes the overlay. Safe when nothing is armed. */
export function cancelRuntime(): void {
  const w = window as unknown as Record<string, { cancel?: () => void } | undefined>
  const S = w.__asteraPick
  if (S && typeof S.cancel === 'function') S.cancel()
}

/** Numbered badges at the given rects, following scroll and resize. An empty list removes them. */
export function badgesRuntime(markers: { seq: number; rectPage: { x: number; y: number; width: number; height: number }; rectViewport: { x: number; y: number; width: number; height: number }; isFixed: boolean; hasComment: boolean }[]): void {
  const KEY = '__asteraBadges'
  // Declared here rather than shared: each of these functions is stringified on its own and runs in
  // the guest with nothing around it, so a constant from a neighbour would be undefined.
  const BADGE_H = 18
  const TAIL_H = 6
  const w = window as unknown as Record<string, unknown>
  interface BadgeState { root: HTMLDivElement | null; markers: typeof markers; onUpdate: (() => void) | null; raf: number }
  let S = w[KEY] as BadgeState | undefined
  if (!S) { S = { root: null, markers: [], onUpdate: null, raf: 0 }; w[KEY] = S }
  const state: BadgeState = S
  state.markers = markers

  if (markers.length === 0) {
    // The pending frame goes too. Leaving the handle set made the next paint skip itself: the new
    // onUpdate's dedup guard reads a non-zero handle from the cleared run and returns without scheduling.
    if (state.raf) { window.cancelAnimationFrame(state.raf); state.raf = 0 }
    if (state.onUpdate) { window.removeEventListener('scroll', state.onUpdate, true); window.removeEventListener('resize', state.onUpdate, true) }
    if (state.root && state.root.parentNode) state.root.parentNode.removeChild(state.root)
    state.root = null; state.onUpdate = null
    return
  }
  if (!state.root) {
    const root = document.createElement('div')
    root.setAttribute('data-astera-pick', '')
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;'
    document.documentElement.appendChild(root)
    state.root = root
    const paint = function () {
      const r = state.root
      if (!r) return
      while (r.firstChild) r.removeChild(r.firstChild)
      for (let i = 0; i < state.markers.length; i += 1) {
        const m = state.markers[i]
        const x = m.isFixed ? m.rectViewport.x : m.rectPage.x - window.scrollX
        const y = m.isFixed ? m.rectViewport.y : m.rectPage.y - window.scrollY
        // A speech bubble rather than a plain dot: the marker's job is to say a remark was left here,
        // and a numbered circle reads as an ordering. Blue once something has been written about it,
        // grey while the comment is still empty.
        const colour = m.hasComment ? '#4c7ef3' : '#6b7280'
        const above = y - (BADGE_H + TAIL_H) >= 0
        const d = document.createElement('div')
        d.style.cssText = 'position:absolute;left:' + (x - 4) + 'px;top:' + (above ? y - BADGE_H - TAIL_H : y + TAIL_H) + 'px;'
        const body = document.createElement('div')
        body.textContent = String(m.seq)
        body.style.cssText = 'min-width:' + BADGE_H + 'px;height:' + BADGE_H + 'px;padding:0 5px;box-sizing:border-box;' +
          'border-radius:' + (BADGE_H / 2) + 'px;background:' + colour + ';color:#fff;' +
          'font:700 11px/' + BADGE_H + 'px system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.4);'
        // The tail points at the corner the element starts from, so the bubble reads as belonging to it
        const tail = document.createElement('div')
        tail.style.cssText = 'position:absolute;left:5px;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;' +
          (above
            ? 'top:' + (BADGE_H - 1) + 'px;border-top:' + TAIL_H + 'px solid ' + colour + ';'
            : 'top:' + (1 - TAIL_H) + 'px;border-bottom:' + TAIL_H + 'px solid ' + colour + ';')
        d.appendChild(body)
        d.appendChild(tail)
        r.appendChild(d)
      }
    }
    state.onUpdate = function () {
      if (state.raf) return
      state.raf = window.requestAnimationFrame(function () { state.raf = 0; paint() })
    }
    window.addEventListener('scroll', state.onUpdate, true)
    window.addEventListener('resize', state.onUpdate, true)
  }
  if (state.onUpdate) state.onUpdate()
}

/** Hides or restores everything the picker injected. A capture is taken through the page the picker
 *  is standing on: without this the shot carried the highlight box's blue border and its 12% blue
 *  wash over the element, plus the numbered badges of every earlier annotation. The agent reading one
 *  described the border as part of the design. `visibility` rather than `display`, so nothing the
 *  page laid out around a badge moves between the two calls. */
export function chromeRuntime(hidden: boolean): void {
  const nodes = document.querySelectorAll('[data-astera-pick]')
  for (let i = 0; i < nodes.length; i += 1) (nodes[i] as HTMLElement).style.visibility = hidden ? 'hidden' : ''
}

/** Flashes one rect for about a second. */
export function highlightRuntime(rectPage: { x: number; y: number; width: number; height: number }, isFixed: boolean): void {
  const d = document.createElement('div')
  d.setAttribute('data-astera-pick', '')
  const x = isFixed ? rectPage.x : rectPage.x - window.scrollX
  const y = isFixed ? rectPage.y : rectPage.y - window.scrollY
  d.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;left:' + x + 'px;top:' + y + 'px;width:' + rectPage.width + 'px;height:' + rectPage.height + 'px;border:2px solid #4c7ef3;background:rgba(76,126,243,.18);box-sizing:border-box;transition:opacity .4s;'
  document.documentElement.appendChild(d)
  window.setTimeout(function () { d.style.opacity = '0' }, 600)
  window.setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d) }, 1000)
}
