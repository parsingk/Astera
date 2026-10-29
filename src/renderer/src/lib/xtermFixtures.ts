// The real @xterm/xterm Terminal, run in node for tests of its keyboard and IME input.
//
// **The library is the file the renderer ships**: node_modules/@xterm/xterm/lib/xterm.mjs (Vite resolves the package's
// "module" field, and out/renderer's bundle carries that build's CompositionHelper), with the repository's
// patches/@xterm+xterm+6.0.0.patch applied to it as postinstall's patch-package applies it. A node_modules installed
// without its scripts — or a worktree sharing another checkout's — holds the stock file, so the patch is applied to the
// text here when it is not there yet; a file that is neither stock nor patched throws, which is the signal to redo the
// patch for a new xterm.
//
// **The DOM is a fake** just large enough for Terminal.open(): the repository has no jsdom (vitest runs in node), and
// input needs nothing of the DOM but event dispatch and a textarea's value. Nothing rendered is ever looked at.
//
// **The IME is a driver** that dispatches what Chromium dispatches for the Microsoft Korean IME on Windows, read from
// Chromium 146.0.7680.216 — the one Electron 41.7.1 runs — ui/base/ime/win/tsf_text_store.cc:
// - TSF reports every key down (OnKeyTraceDown, :992-1003; "Called when a key down event occurs",
//   https://learn.microsoft.com/en-us/windows/win32/api/msctf/nf-msctf-itfkeytraceeventsink-onkeytracedown), and
//   Chromium dispatches it as a keydown with VK_PROCESSKEY, keyCode 229 (DispatchKeyEvent, :1017-1045);
// - during a composition that keydown goes out at once, before the IME's edit;
// - outside one it is held and goes out only when the IME's edit starts a composition, right before that composition's
//   events (RequestLock, :737-744) — so a 229 keydown outside a composition is always followed by compositionstart;
// - a commit is TextInputClient::InsertText of the committed text (CommitTextAndEndCompositionIfAny, :1494-1599):
//   the textarea holds the text, then `input`, then compositionend; a new syllable's composition follows it
//   (StartCompositionOnNewText, :1601-1642);
// - a key the IME does not eat — space, Enter, punctuation after a syllable — then reaches the window as itself and
//   goes out as an ordinary keydown with its own keyCode (input_method_win_base.cc, DispatchKeyEvent, :182-243), after
//   the commit. That the Korean IME commits on space and Enter and lets the key through is how Korean is typed (one
//   press gives the syllable and the space) and is not in any document; `imeSpace` also covers an IME that eats the
//   space and inserts it itself.
// keyCode 229 is VK_PROCESSKEY: https://learn.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Terminal } from '@xterm/xterm'

const require = createRequire(import.meta.url)
const xtermDir = path.dirname(require.resolve('@xterm/xterm/package.json'))
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
/** The patch postinstall applies, and the file in it this loader runs. */
export const XTERM_PATCH = path.join(repoRoot, 'patches', '@xterm+xterm+6.0.0.patch')
const LIB = 'node_modules/@xterm/xterm/lib/xterm.mjs'

type Hunk = { oldStart: number; oldLines: string[]; newStart: number; newLines: string[] }

/** The hunks a git-style patch holds for one file. */
function hunksFor(patch: string, file: string): Hunk[] {
  const lines = patch.split('\n')
  const hunks: Hunk[] = []
  let inFile = false
  let hunk: Hunk | null = null
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      inFile = line === `diff --git a/${file} b/${file}`
      hunk = null
      continue
    }
    if (!inFile) continue
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (head) {
      hunk = { oldStart: Number(head[1]), oldLines: [], newStart: Number(head[2]), newLines: [] }
      hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (line.startsWith(' ')) {
      hunk.oldLines.push(line.slice(1))
      hunk.newLines.push(line.slice(1))
    } else if (line.startsWith('-')) hunk.oldLines.push(line.slice(1))
    else if (line.startsWith('+')) hunk.newLines.push(line.slice(1))
  }
  return hunks
}

const matchesAt = (text: string[], at: number, want: string[]): boolean => want.every((l, i) => text[at + i] === l)

/** `source` with the patch's hunks for `file` applied; unchanged when they already are. Throws on anything else. */
export function applyPatchText(source: string, patch: string, file: string): string {
  const hunks = hunksFor(patch, file)
  if (hunks.length === 0) throw new Error(`the patch has no hunk for ${file}`)
  const lines = source.split('\n')
  if (hunks.every((h) => matchesAt(lines, h.newStart - 1, h.newLines))) return source
  let shift = 0
  for (const h of hunks) {
    const at = h.oldStart - 1 + shift
    if (!matchesAt(lines, at, h.oldLines)) {
      throw new Error(`${file} is neither the stock file the patch was made from nor the patched one: redo the patch`)
    }
    lines.splice(at, h.oldLines.length, ...h.newLines)
    shift += h.newLines.length - h.oldLines.length
  }
  return lines.join('\n')
}

// ---- the fake DOM ----

type Listener = { type: string; fn: (ev: FakeEvent) => void; capture: boolean }

/** An event as the code under test reads it: whatever fields its init gave, plus cancellation. */
export class FakeEvent {
  [field: string]: unknown
  type: string
  target: FakeElement | null = null
  defaultPrevented = false
  stopped = false
  constructor(type: string, init: Record<string, unknown> = {}) {
    Object.assign(this, init)
    this.type = type
  }
  preventDefault(): void {
    this.defaultPrevented = true
  }
  stopPropagation(): void {
    this.stopped = true
  }
  stopImmediatePropagation(): void {
    this.stopped = true
  }
  getModifierState(): boolean {
    return false
  }
}

const RECT = { x: 0, y: 0, left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400 }

class FakeElement {
  [field: string]: unknown
  tagName: string
  children: FakeElement[] = []
  parentElement: FakeElement | null = null
  ownerDocument: FakeDocument | null
  value = ''
  textContent = ''
  readOnly = false
  tabIndex = -1
  isConnected = true
  style: Record<string, unknown> = { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' }
  private readonly classes = new Set<string>()
  private readonly attrs = new Map<string, string>()
  private readonly listeners: Listener[] = []
  classList = {
    add: (...c: string[]): void => c.forEach((x) => this.classes.add(x)),
    remove: (...c: string[]): void => c.forEach((x) => this.classes.delete(x)),
    contains: (c: string): boolean => this.classes.has(c),
    toggle: (c: string, force?: boolean): boolean => {
      const on = force ?? !this.classes.has(c)
      if (on) this.classes.add(c)
      else this.classes.delete(c)
      return on
    }
  }
  constructor(tag: string, owner: FakeDocument | null) {
    this.tagName = tag.toUpperCase()
    this.ownerDocument = owner
  }
  get childNodes(): FakeElement[] {
    return this.children
  }
  get parentNode(): FakeElement | null {
    return this.parentElement
  }
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null
  }
  setAttribute(k: string, v: unknown): void {
    this.attrs.set(k, String(v))
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k)
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k)
  }
  appendChild<T extends FakeElement>(child: T): T {
    // A fragment hands its children over, as the DOM's does
    const moved = child.tagName === '#FRAGMENT' ? child.children.splice(0) : [child]
    for (const c of moved) {
      c.parentElement = this
      this.children.push(c)
    }
    return child
  }
  insertBefore<T extends FakeElement>(child: T): T {
    return this.appendChild(child)
  }
  removeChild<T extends FakeElement>(child: T): T {
    const i = this.children.indexOf(child)
    if (i >= 0) this.children.splice(i, 1)
    child.parentElement = null
    return child
  }
  replaceChildren(...c: FakeElement[]): void {
    this.children.splice(0)
    for (const x of c) this.appendChild(x)
  }
  remove(): void {
    this.parentElement?.removeChild(this)
  }
  contains(other: FakeElement | null): boolean {
    for (let x = other; x; x = x.parentElement) if (x === this) return true
    return false
  }
  addEventListener(type: string, fn: (ev: FakeEvent) => void, opts?: boolean | { capture?: boolean }): void {
    this.listeners.push({ type, fn, capture: opts === true || (typeof opts === 'object' && !!opts.capture) })
  }
  removeEventListener(type: string, fn: (ev: FakeEvent) => void): void {
    const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn)
    if (i >= 0) this.listeners.splice(i, 1)
  }
  /** Capture down the ancestors, then the target, then bubble up — what the code under test relies on. */
  dispatchEvent(ev: FakeEvent): boolean {
    ev.target = this
    const path: FakeElement[] = []
    for (let x = this.parentElement; x; x = x.parentElement) path.unshift(x)
    const run = (node: FakeElement, pick: (l: Listener) => boolean): void => {
      for (const l of node.listeners.filter((x) => x.type === ev.type && pick(x))) {
        if (ev.stopped) return
        l.fn.call(node, ev)
      }
    }
    for (const n of path) run(n, (l) => l.capture)
    run(this, () => true)
    for (const n of [...path].reverse()) run(n, (l) => !l.capture)
    return !ev.defaultPrevented
  }
  getBoundingClientRect(): typeof RECT {
    return RECT
  }
  getClientRects(): (typeof RECT)[] {
    return [RECT]
  }
  get clientWidth(): number {
    return RECT.width
  }
  get clientHeight(): number {
    return RECT.height
  }
  get offsetWidth(): number {
    return RECT.width
  }
  get offsetHeight(): number {
    return RECT.height
  }
  focus(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this
  }
  blur(): void {}
  select(): void {}
  setSelectionRange(): void {}
  querySelector(): null {
    return null
  }
  querySelectorAll(): FakeElement[] {
    return []
  }
  getRootNode(): FakeDocument | null {
    return this.ownerDocument
  }
  cloneNode(): FakeElement {
    return new FakeElement(this.tagName, this.ownerDocument)
  }
  getContext(): null {
    return null
  }
}

class FakeDocument extends FakeElement {
  activeElement: FakeElement | null = null
  body: FakeElement
  documentElement: FakeElement
  defaultView: Record<string, unknown> | null = null
  constructor() {
    super('#document', null)
    this.ownerDocument = this
    this.body = this.createElement('body')
    this.documentElement = this.createElement('html')
    this.documentElement.appendChild(this.body)
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this)
  }
  createElementNS(_ns: string, tag: string): FakeElement {
    return this.createElement(tag)
  }
  createDocumentFragment(): FakeElement {
    return this.createElement('#fragment')
  }
  createTextNode(text: string): FakeElement {
    const n = this.createElement('#text')
    n.textContent = text
    return n
  }
  queryCommandSupported(): boolean {
    return false
  }
  hasFocus(): boolean {
    return true
  }
}

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Loads the patched library into the fake DOM and returns its Terminal. Timers are the global ones read at each call,
 *  so vi.useFakeTimers() decides when xterm's setTimeout(…, 0) callbacks run. */
function loadTerminal(doc: FakeDocument): typeof Terminal {
  let source = readFileSync(path.join(xtermDir, 'lib', 'xterm.mjs'), 'utf8')
  if (existsSync(XTERM_PATCH)) source = applyPatchText(source, readFileSync(XTERM_PATCH, 'utf8'), LIB)
  const exported = /export\{([\w$]+) as Terminal\};/
  if (!exported.test(source)) throw new Error('lib/xterm.mjs no longer ends by exporting Terminal')
  const body = '"use strict";' + source.replace(exported, 'return $1;')
  const win: Record<string, unknown> = {
    document: doc,
    devicePixelRatio: 1,
    // A Chromium on Windows, which is what Astera's renderer is on the machine the bug was seen on
    navigator: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      platform: 'Win32',
      language: 'en',
      maxTouchPoints: 0
    },
    matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => new Proxy({}, { get: () => '' }),
    // Nothing is rendered; a frame that never comes keeps the renderer out of the timers under test
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    addEventListener() {},
    removeEventListener() {}
  }
  doc.defaultView = win
  // The free names the library reads, bound to the fake instead of node's globals. `process` is hidden so its
  // platform check (src/common/Platform.ts: isNode) reads the navigator above, as in a renderer.
  const names = ['process', 'window', 'self', 'document', 'navigator', 'MutationObserver']
  const values = [undefined, win, win, doc, win.navigator, NoopObserver]
  return new Function(...names, body)(...values) as typeof Terminal
}

export type Xterm = {
  term: Terminal
  textarea: FakeElement
  /** Everything onData emitted, in order — what TerminalView writes to the pty. */
  sent: string[]
  /** keydown with keyCode 229 from the IME (Chromium: VK_PROCESSKEY), as a key the IME takes is dispatched */
  imeKeyDown(code: string): void
  imeKeyUp(code: string): void
  compositionStart(): void
  /** The IME's new composition text: compositionupdate, the textarea changes, then input */
  compositionUpdate(text: string): void
  /** The IME commits `text`: the textarea holds it, input, then compositionend */
  compositionEnd(text: string): void
  /** Text the IME inserts with no composition: the textarea holds it, then input */
  imeInsert(text: string): void
  /** A key the IME leaves alone: keydown, then — unless a handler prevented it — keypress and the text it inserts, keyup */
  key(key: string, keyCode: number, mods?: { ctrlKey?: boolean; shiftKey?: boolean; code?: string }): void
  /** Hangul keys through the IME, one per entry: the composition's text after that key, e.g. ['ㅎ', '하', '한'].
   *  'committed|next' is a key that commits one syllable and starts the next in the same edit, as a key that cannot
   *  join the syllable does ('한|ㄱ'), and as a vowel does when it takes the final consonant ('핫|세').
   *  Returns one function per key, for the caller to decide what runs between them. */
  hangul(keys: string[]): (() => void)[]
  /** Space after a composition: keydown 229, the commit, then the space itself */
  imeSpace(opts?: { eaten?: boolean }): void
  /** Enter after a composition: keydown 229, the commit, then Enter */
  imeEnter(): void
  dispose(): void
}

/** A real Terminal opened in the fake DOM, with a driver for its textarea. */
export function openXterm(): Xterm {
  const doc = new FakeDocument()
  const XtermTerminal = loadTerminal(doc)
  const term = new XtermTerminal({ cols: 80, rows: 24 })
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  term.open(host as unknown as HTMLElement)
  const textarea = term.textarea as unknown as FakeElement
  const sent: string[] = []
  const data = term.onData((d) => sent.push(d))
  term.focus()

  let composing = false
  let compositionAt = 0
  /** The composition's text so far — what the IME commits when a key ends it */
  let composed = ''
  const fire = (type: string, init: Record<string, unknown> = {}): FakeEvent => {
    const ev = new FakeEvent(type, { bubbles: true, cancelable: true, composed: true, ...init })
    textarea.dispatchEvent(ev)
    return ev
  }
  const x: Xterm = {
    term,
    textarea,
    sent,
    imeKeyDown: (code) => void fire('keydown', { key: 'Process', code, keyCode: 229, which: 229, isComposing: composing }),
    imeKeyUp: (code) => void fire('keyup', { key: 'Process', code, keyCode: 229, which: 229, isComposing: composing }),
    compositionStart: () => {
      composing = true
      compositionAt = textarea.value.length
      composed = ''
      fire('compositionstart', { data: '' })
    },
    compositionUpdate: (text) => {
      fire('compositionupdate', { data: text })
      textarea.value = textarea.value.slice(0, compositionAt) + text
      composed = text
      fire('input', { inputType: 'insertCompositionText', data: text, isComposing: true })
    },
    compositionEnd: (text) => {
      textarea.value = textarea.value.slice(0, compositionAt) + text
      fire('input', { inputType: 'insertCompositionText', data: text, isComposing: true })
      composing = false
      composed = ''
      fire('compositionend', { data: text })
    },
    imeInsert: (text) => {
      textarea.value += text
      fire('input', { inputType: 'insertText', data: text, isComposing: false })
    },
    key: (key, keyCode, mods = {}) => {
      const init = { key, code: mods.code ?? '', keyCode, which: keyCode, ctrlKey: !!mods.ctrlKey, shiftKey: !!mods.shiftKey }
      const down = fire('keydown', { ...init, isComposing: false })
      if (!down.defaultPrevented && key.length === 1 && !mods.ctrlKey) {
        const code = key.charCodeAt(0)
        const press = fire('keypress', { ...init, keyCode: code, charCode: code, which: code })
        if (!press.defaultPrevented) {
          textarea.value += key
          fire('input', { inputType: 'insertText', data: key, isComposing: false })
        }
      }
      // What a textarea does with an Enter nobody prevented
      if (!down.defaultPrevented && key === 'Enter') {
        textarea.value += '\n'
        fire('input', { inputType: 'insertLineBreak', data: null, isComposing: false })
      }
      fire('keyup', init)
    },
    hangul: (keys) =>
      keys.map((k) => () => {
        x.imeKeyDown('KeyX')
        const [commit, next] = k.includes('|') ? k.split('|') : [null, k]
        if (commit !== null) x.compositionEnd(commit)
        if (!composing) x.compositionStart()
        x.compositionUpdate(next)
        x.imeKeyUp('KeyX')
      }),
    imeSpace: (opts = {}) => {
      x.imeKeyDown('Space')
      if (composing) x.compositionEnd(composed)
      if (opts.eaten) {
        x.imeInsert(' ')
        x.imeKeyUp('Space')
      } else x.key(' ', 32, { code: 'Space' })
    },
    imeEnter: () => {
      x.imeKeyDown('Enter')
      if (composing) x.compositionEnd(composed)
      x.key('Enter', 13, { code: 'Enter' })
    },
    dispose: () => {
      data.dispose()
      term.dispose()
    }
  }
  return x
}

/** Readable form of what onData sent: DEL and CR named. */
export const shown = (sent: string[]): string[] => sent.map((d) => d.replace(/\x7f/g, '<DEL>').replace(/\r/g, '<CR>'))
