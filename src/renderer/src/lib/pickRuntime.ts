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
  pending: { resolve: (v: unknown) => void; reject: (e: Error) => void } | null
  onMove: ((e: MouseEvent) => void) | null
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
    const push = function (n: Element | null) {
      if (!n || n === el || out.length >= 10) return
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

  function extract(el: Element): unknown {
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
    S = { overlay: null, box: null, label: null, hovered: null, pending: null, onMove: null, onClick: null, onKey: null, cancel: function () {} }
    w[KEY] = S
  }
  const state: PickState = S

  function teardown(): void {
    if (state.onMove) document.removeEventListener('mousemove', state.onMove, true)
    if (state.onClick) document.removeEventListener('click', state.onClick, true)
    if (state.onKey) document.removeEventListener('keydown', state.onKey, true)
    state.onMove = null; state.onClick = null; state.onKey = null
    for (const n of [state.overlay, state.box, state.label]) if (n && n.parentNode) n.parentNode.removeChild(n)
    state.overlay = null; state.box = null; state.label = null; state.hovered = null
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
    overlay.style.cssText = 'position:fixed;inset:0;z-index:' + Z + ';cursor:crosshair;background:transparent;'
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

    state.onMove = function (e: MouseEvent) {
      const stack = document.elementsFromPoint(e.clientX, e.clientY)
      let target: Element | null = null
      for (let i = 0; i < stack.length; i += 1) if (!ownNode(stack[i], state) && stack[i] !== document.documentElement) { target = stack[i]; break }
      state.hovered = target
      if (!target || !state.box || !state.label) return
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
    state.onClick = function (e: MouseEvent) {
      if (e.button !== 0) return
      e.preventDefault(); e.stopPropagation()
      const target = state.hovered
      const p = state.pending
      if (!target || !p) return
      state.pending = null
      let payload: unknown = null
      try { payload = extract(target) } catch (err) { p.reject(err instanceof Error ? err : new Error(String(err))); return }
      p.resolve(payload)
    }
    state.onKey = function (e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); state.cancel() }
    }
    document.addEventListener('mousemove', state.onMove, true)
    document.addEventListener('click', state.onClick, true)
    document.addEventListener('keydown', state.onKey, true)
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
export function badgesRuntime(markers: { seq: number; rectPage: { x: number; y: number; width: number; height: number }; rectViewport: { x: number; y: number; width: number; height: number }; isFixed: boolean }[]): void {
  const KEY = '__asteraBadges'
  const w = window as unknown as Record<string, unknown>
  interface BadgeState { root: HTMLDivElement | null; markers: typeof markers; onUpdate: (() => void) | null; raf: number }
  let S = w[KEY] as BadgeState | undefined
  if (!S) { S = { root: null, markers: [], onUpdate: null, raf: 0 }; w[KEY] = S }
  const state: BadgeState = S
  state.markers = markers

  if (markers.length === 0) {
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
        const d = document.createElement('div')
        d.textContent = String(m.seq)
        d.style.cssText = 'position:absolute;left:' + (x - 10) + 'px;top:' + (y - 10) + 'px;width:20px;height:20px;border-radius:50%;background:#4c7ef3;color:#fff;font:700 12px/20px system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.4);'
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
