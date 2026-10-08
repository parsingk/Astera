// A live terminal per pty (remote runtime design §3.7, C3 X1-02). Every ring event is applied to an `@xterm/headless`
// terminal in order, and after each write callback the terminal's **watermark** is the seq of the last event it
// applied. A checkpoint is that terminal serialized with `@xterm/addon-serialize` (both buffers, cursor, attributes,
// the modes the addon covers) at its watermark, plus the text of an escape sequence still open there (escapeState.ts):
// a client that writes `state`, then `pending`, then every event after the watermark sees what a continuously attached
// terminal shows. Made on demand, never stored on disk.
//
// The packages are CommonJS and loaded lazily, as sessions.ts's render did: under Node's dynamic import their exports
// arrive on `default` only, while the test runner hands back named exports.
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { SerializeAddon as Serializer } from '@xterm/addon-serialize'
import type { SessionScreen } from '../core/orchestration/command'
import type { PtyEvent } from './ptyRing'
import { createEscapeTracker } from './escapeState'

/** Rows kept above the screen (DC-7): what `sessions-read` returns at most. */
export const TERMINAL_SCROLLBACK = 1_000

export interface PtyCheckpoint {
  /** The seq of the last event in `state`. */
  watermark: number
  cols: number
  rows: number
  /** The terminal serialized at the watermark. */
  state: string
  /** An escape sequence open at the watermark, written after `state`: '' when none is. */
  pending: string
  /** Present once the exit event was applied. */
  exitCode?: number | null
}

export interface LiveTerminal {
  apply(e: PtyEvent): void
  /** True once the terminal could not take an event (xterm discards writes past 50,000,000 waiting units): its screen
   *  is no longer the pty's, and the owner builds a new one (registry.ts). Never thrown out of `apply`, which runs
   *  inside node-pty's data callback (Phase 8 review I2). */
  broken(): boolean
  watermark(): number
  checkpoint(): Promise<PtyCheckpoint>
  /** The screen and up to `lines` rows above it (at most TERMINAL_SCROLLBACK), as `sessions-read` answers. */
  read(lines: number): Promise<SessionScreen>
  dispose(): void
}

type Mods = { Terminal: typeof HeadlessTerminal; SerializeAddon: typeof Serializer }

/** The xterm internals the addon does not serialize (Phase 8 review I1), read from `_core`. @xterm/headless is pinned to
 *  6.0.0; liveTerminal.test.ts fails if a field moves. */
type Core = {
  buffer: { scrollTop: number; scrollBottom: number; savedX?: number; savedY?: number }
  coreService: { isCursorHidden: boolean; decPrivateModes: { origin: boolean } }
  _charsetService: { glevel: number; _charsets: Array<object | undefined> }
}
const coreOf = (t: HeadlessTerminal): Core | null => {
  const c = (t as unknown as { _core?: Core })._core
  return c?.buffer && c.coreService && c._charsetService ? c : null
}
/** Each charset table xterm holds, by the final byte that designates it: the table objects are shared, so a scratch
 *  terminal designating each one names them. */
const DESIGNATORS = '0AB4C5RQKYE6ZH7=`'
let charsetNames: Map<object, string> | null = null
const charsetName = (T: typeof HeadlessTerminal, table: object): string | null => {
  if (!charsetNames) {
    charsetNames = new Map()
    const scratch = new T({ cols: 2, rows: 1, allowProposedApi: true })
    const core = coreOf(scratch)
    for (const ch of DESIGNATORS) {
      ;(scratch as unknown as { _core: { _inputHandler: { selectCharset(id: string): void } } })._core._inputHandler.selectCharset(`(${ch}`)
      const got = core?._charsetService._charsets[0]
      if (got) charsetNames.set(got, ch)
    }
    scratch.dispose()
  }
  return charsetNames.get(table) ?? null
}

/** What `state` needs after it so a fresh terminal stands where this one does: the scroll region, the saved cursor, the
 *  designated charsets and the one shifted in, origin mode, the cursor's place and whether it shows. */
function stateSuffix(T: typeof HeadlessTerminal, t: HeadlessTerminal): string {
  const core = coreOf(t)
  if (!core) return ''
  const E = String.fromCharCode(27)
  let out = ''
  const { scrollTop, scrollBottom, savedX, savedY } = core.buffer
  if (scrollTop !== 0 || scrollBottom !== t.rows - 1) out += `${E}[${scrollTop + 1};${scrollBottom + 1}r`
  // DECSC remembers where it was; placed there and saved again, with origin mode still off so the place is absolute.
  if (savedX !== undefined && savedY !== undefined && (savedX !== 0 || savedY !== 0)) out += `${E}[${savedY + 1};${savedX + 1}H${E}7`
  const cs = core._charsetService
  for (let g = 0; g < 4; g++) {
    const table = cs._charsets[g]
    const name = table ? charsetName(T, table) : null
    if (name) out += `${E}${'()*+'[g]}${name}`
  }
  if (cs.glevel === 1) out += String.fromCharCode(14)
  else if (cs.glevel === 2) out += `${E}n`
  else if (cs.glevel === 3) out += `${E}o`
  const origin = core.coreService.decPrivateModes.origin
  if (origin) out += `${E}[?6h`
  const buf = t.buffer.active
  const row = buf.cursorY - (origin ? scrollTop : 0)
  out += `${E}[${row + 1};${Math.min(buf.cursorX, t.cols - 1) + 1}H`
  if (core.coreService.isCursorHidden) out += `${E}[?25l`
  return out
}
let mods: Promise<Mods> | null = null
const load = (): Promise<Mods> =>
  (mods ??= (async () => {
    const h: typeof import('@xterm/headless') & { default?: typeof import('@xterm/headless') } = await import('@xterm/headless')
    const s: typeof import('@xterm/addon-serialize') & { default?: typeof import('@xterm/addon-serialize') } = await import('@xterm/addon-serialize')
    return { Terminal: (h.default ?? h).Terminal, SerializeAddon: (s.default ?? s).SerializeAddon }
  })())

export function createLiveTerminal(o: { cols: number; rows: number }): LiveTerminal {
  let term: HeadlessTerminal | null = null
  let serializer: Serializer | null = null
  let disposed = false
  let mark = 0
  let exited = false
  let exitCode: number | null = null
  const tracker = createEscapeTracker()
  let lost = false
  /** Events applied before the packages loaded, in order. */
  const early: PtyEvent[] = []

  const applySafely = (t: HeadlessTerminal, e: PtyEvent): void => {
    if (lost) return
    try {
      applyNow(t, e)
    } catch {
      lost = true
    }
  }
  const applyNow = (t: HeadlessTerminal, e: PtyEvent): void => {
    // The tracker and the watermark move in the write callback, so both stand where the parser stands.
    if (e.kind === 'data')
      t.write(e.data, () => {
        tracker.feed(e.data)
        mark = e.seq
      })
    // A resize and the exit keep their place in the order: after the writes before them have been parsed.
    else if (e.kind === 'resize')
      t.write('', () => {
        if (!disposed) t.resize(Math.max(1, e.cols), Math.max(1, e.rows))
        mark = e.seq
      })
    else
      t.write('', () => {
        exited = true
        exitCode = e.code
        mark = e.seq
      })
  }

  let T: typeof HeadlessTerminal | null = null
  const ready: Promise<HeadlessTerminal> = load().then((m) => {
    T = m.Terminal
    const t = new m.Terminal({ cols: Math.max(1, o.cols), rows: Math.max(1, o.rows), scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true })
    serializer = new m.SerializeAddon()
    t.loadAddon(serializer)
    term = t
    for (const e of early.splice(0)) applySafely(t, e)
    if (disposed) t.dispose()
    return t
  })
  /** Resolves inside a write callback queued after every event applied so far: the terminal stands at the watermark. */
  const settled = <T>(f: (t: HeadlessTerminal) => T): Promise<T> =>
    ready.then(
      (t) =>
        new Promise<T>((resolve, reject) => {
          if (lost) return reject(new Error('the live terminal lost its place (write backlog)'))
          try {
            t.write('', () => resolve(f(t)))
          } catch (e) {
            lost = true
            reject(e)
          }
        })
    )

  return {
    apply: (e) => {
      if (disposed) return
      if (term) applySafely(term, e)
      else early.push(e)
    },
    broken: () => lost,
    watermark: () => mark,
    checkpoint: () =>
      settled((t) => ({
        watermark: mark,
        cols: t.cols,
        rows: t.rows,
        state: serializer ? serializer.serialize({ scrollback: TERMINAL_SCROLLBACK }) + stateSuffix(T as typeof HeadlessTerminal, t) : '',
        pending: tracker.pending(),
        ...(exited ? { exitCode } : {})
      })),
    read: (lines) =>
      settled((t) => {
        const want = Math.max(0, Math.min(TERMINAL_SCROLLBACK, Math.floor(lines)))
        const buf = t.buffer.active
        const row = (y: number): string => buf.getLine(y)?.translateToString(true) ?? ''
        // A row the terminal wrapped onto from the one above (a line wider than the tab): a reader joins them to get
        // the line back, as the MCP layer does before it redacts.
        const wrapped = (y: number): boolean => buf.getLine(y)?.isWrapped ?? false
        const screen: string[] = []
        const screenWrapped: boolean[] = []
        for (let y = buf.baseY; y < buf.baseY + t.rows; y++) {
          screen.push(row(y))
          screenWrapped.push(wrapped(y))
        }
        // The rows below the last thing painted are not content: a shell prompt sits at the top of an otherwise empty
        // screen.
        while (screen.length > 0 && screen[screen.length - 1] === '') {
          screen.pop()
          screenWrapped.pop()
        }
        const scrollback: string[] = []
        const scrollbackWrapped: boolean[] = []
        for (let y = Math.max(0, buf.baseY - want); y < buf.baseY; y++) {
          scrollback.push(row(y))
          scrollbackWrapped.push(wrapped(y))
        }
        return { cols: t.cols, rows: t.rows, screen, scrollback, screenWrapped, scrollbackWrapped }
      }),
    dispose: () => {
      if (disposed) return
      disposed = true
      early.length = 0
      term?.dispose()
    }
  }
}
