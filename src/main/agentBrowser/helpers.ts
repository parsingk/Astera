// The helper set an agent's script sees. Each is bound to one session's guest through `deps`; each
// sets ctx.at first so a failure names it. Reading the page (snapshot/screenshot) and acting on it
// (click/fill/press/waitFor) are here too, in the same shape.
//
// Nothing here may import `electron`, directly or transitively: this file's tests run under vitest's
// node environment, where `electron` cannot load. That is why `savePng` lives in an Electron-free
// module and why `GuestDriver` describes what a WebContents must offer structurally.
import { agentOpenTarget } from '../../core/agentBrowser/urls'
import { Interrupted, WAIT_TIMEOUT_MS, withTimeout, type LogSink } from '../../core/agentBrowser/script'
import type { RunContext } from '../../core/agentBrowser/scriptRunner'
import { clampSnapshot, type Snapshot } from '../../core/agentBrowser/snapshot'
import { clickScript, fillScript, pressScript, snapshotScript, waitForScript } from '../../core/agentBrowser/guestScripts'
import { sanitizeUrl } from '../../core/preview/pick/payload'
import { savePng, type CapturedImage } from '../preview/shots'
import type { AgentBuffers } from './buffers'

type Listener = (...a: unknown[]) => void

/** What the helpers ask of Electron's WebContents — structural, so the tests drive a fake. */
export interface GuestDriver {
  loadURL(url: string): Promise<void>
  reload(): void
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  once(event: 'did-finish-load' | 'did-fail-load' | 'did-stop-loading', cb: Listener): unknown
  removeListener(event: string, cb: Listener): unknown
  /** Runs an expression in the page and resolves with its value. Rejects while the frame is
   *  navigating, and when the page throws. */
  executeJavaScript(code: string): Promise<unknown>
  /** The visible page as an image. Only a page that is being **drawn** can be photographed, and a
   *  guest whose tab is in the background is not drawn at all: the answer is then a zero-size image,
   *  a viz error, or nothing at all — so callers make the tab paintable, retry, and race it. */
  capturePage(): Promise<CapturedImage>
}

/** A dev server the project has running, as far as Astera can tell: a Run that printed a loopback
 *  address. `name` is the run configuration's name — what the user sees in the Run list. */
export interface DevServer {
  name: string
  url: string
  /** The user marked this Run's page as the one to preview (the Run configuration's preview address).
   *  That is the user saying "this is the page" — it settles which server `open()` means when the
   *  project runs several. */
  preview: boolean
}

export interface HelperDeps {
  /** The session's guest, or null before its tab exists. */
  guest(): GuestDriver | null
  /** The guest, creating the tab first when there is none; rejects when it does not appear in time. */
  ensureGuest(url: string): Promise<GuestDriver>
  buffers(): AgentBuffers | null
  closeTab(): void
  /** The project's running dev servers, from Astera's Run — what `open()` with no address opens. Astera
   *  cannot tell which localhost port is this project's any other way: the only ports it knows are the
   *  ones its own Run started and saw printed. A server the agent started in its own terminal is not
   *  here, and does not need to be — the agent saw that address itself. */
  devServers(): DevServer[]
  /** The text `help()` returns — browser-guide.md. `RunsDeps.guide` is a getter and the wiring reads
   *  the file through it on every run: the skills directory is only known once the orchestration
   *  server has booted, which is after the wiring runs, so a value captured there would be `''`
   *  forever. */
  guide: string
  /** Where screenshot() writes — the same folder the Claude session was spawned with --add-dir for,
   *  so the path it returns opens without a permission prompt. */
  shotsDir: string
}

const NO_PAGE = 'no page open — call open(url) first'

/** How long a screenshot may take before it is called off. Measured in Electron 41.7.1 on Windows:
 *  a guest made paintable answers on the first or second try, 17-166 ms — but one made paintable
 *  while the window is **minimised** held a single capturePage pending for 100 s before answering.
 *  The script deadline would end such a run eventually; this names the cause instead. */
export const SHOT_TIMEOUT_MS = 5_000

/** How long to wait before asking for another frame. A guest that has just been made paintable
 *  answers UnknownVizError, or an image with no pixels, for a frame or two first. */
const SHOT_RETRY_MS = 50

const refused = (at: string, err: unknown): Error =>
  new Error(`${at}: the page refused the call (${err instanceof Error ? err.message : String(err)})`)

/** How often a pre-wait asks the guest whether it is still loading. */
const LOADING_POLL_MS = 25

/** Waits until the guest stops reporting itself as loading, by **asking** rather than by waiting for
 *  a load event. Bounded by WAIT_TIMEOUT_MS and reporting the same `Interrupted` as every other wait
 *  here, so the deadline's wording and `at` do not change.
 *
 *  The distinction from `loadEnds` is the whole point, and getting it wrong broke the first sequence
 *  in the guide. `loadEnds` belongs where this code *starts* a navigation — open, reload, waitForLoad
 *  — because there an event is genuinely still to come. A pre-wait starts nothing: it only wants to
 *  know whether the guest is busy right now. And `isLoading()` keeps reading true for a moment after
 *  `did-finish-load` has already fired, so a pre-wait built on the event armed a listener for a load
 *  that was already in the past and then sat out the full deadline — `await open(); await snapshot()`
 *  failed after 30 s against a page that was complete and answering. Asking cannot miss an event,
 *  because it does not depend on one. */
function loadSettles(g: GuestDriver, at: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = new Promise<void>((resolve) => {
    const tick = (): void => {
      if (!g.isLoading()) {
        resolve()
        return
      }
      timer = setTimeout(tick, LOADING_POLL_MS)
    }
    tick()
  })
  // Whichever way this settles, the poll stops. A deadline that fired would otherwise leave a timer
  // re-arming itself against the guest for the rest of the session — the same reason loadEnds
  // removes its listeners on every exit path.
  return withTimeout(settled, WAIT_TIMEOUT_MS, at).finally(() => clearTimeout(timer))
}

/** Asks the guest for frames until one has pixels, or the deadline passes.
 *
 *  Only a page that is being **drawn** can be photographed, and the agent's tab is a background tab
 *  by design — the agent must never take the tab or the window the user is on. The renderer answers
 *  that by drawing the tab, invisibly, for as long as a script is running (PaneGrid's browser slots),
 *  so by the time a script calls screenshot() the page is usually already producing frames. It is not
 *  always: a guest that has just become paintable answers UnknownVizError, or an image with no
 *  pixels, for a frame or two first — measured in Electron 41.7.1 on Windows, where a guest inside a
 *  display:none slot answers 0x0 for as long as it stays there (stayHidden makes no difference and a
 *  frame subscription delivers no frames at all), and one just made paintable answered on the first
 *  or second try, 17-166 ms. So a viz error and an empty frame are both "not yet", not failures.
 *
 *  Every capturePage is raced separately against what is left of the deadline: a single call can hang
 *  far past it — 100 s, measured, for a guest made paintable while the window was minimised — and a
 *  loop that only checked the clock between calls would sit inside that one call. */
async function firstFrame(g: GuestDriver, at: string): Promise<CapturedImage> {
  const deadline = Date.now() + SHOT_TIMEOUT_MS
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) throw new Interrupted(at, `${at} did not finish within ${SHOT_TIMEOUT_MS} ms`)
    try {
      const image = await withTimeout(g.capturePage(), left, at)
      const { width, height } = image.getSize()
      if (width > 0 && height > 0) return image
    } catch (err) {
      // The deadline is the one rejection that ends this; anything else the guest says is "not yet".
      if (err instanceof Interrupted) throw err
    }
    await new Promise((r) => setTimeout(r, SHOT_RETRY_MS))
  }
}

/** Runs one guest-side script for a helper. Waits for a load in progress first — executeJavaScript
 *  rejects while the frame is navigating, which is exactly the state a click() that navigates leaves
 *  for the next helper.
 *
 *  A rejection is then one of two things Electron does not distinguish: the page threw, or the script
 *  already ran and its own side effect navigated, tearing the frame down before the reply could be
 *  serialised. Re-sending is right for the second and wrong for the first — a resent pressScript is a
 *  second requestSubmit(), a resent clickScript can click a nav link that the destination page has
 *  too. The message cannot tell them apart (Electron says "Script failed to execute…" for both), so
 *  the guest's own state does: it is retried only when the guest is navigating by the time the
 *  rejection lands. isLoading() is the signal; the address is checked as well because a fast
 *  localhost navigation can already have committed by then. */
async function inGuest(g: GuestDriver, at: string, script: string): Promise<unknown> {
  if (g.isLoading()) await loadSettles(g, at)
  const before = g.getURL()
  try {
    return await g.executeJavaScript(script)
  } catch (first) {
    if (!g.isLoading() && g.getURL() === before) throw refused(at, first)
    if (g.isLoading()) await loadSettles(g, at)
    try {
      return await g.executeJavaScript(script)
    } catch (second) {
      // Two refusals across a navigation: the page has answered.
      throw refused(at, second)
    }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Which helpers return a value rather than a promise. `runs.ts` needs this and cannot work it out
 *  for itself: a run that has been cut off parks its helpers on a promise that never settles, which
 *  is what stops an abandoned script without spinning the main thread — and a synchronous helper
 *  cannot park, because its caller is not awaiting anything. So those throw instead. The list lives
 *  here, beside the helpers it describes, so adding a synchronous one cannot silently leave it stale. */
export const SYNCHRONOUS_HELPERS = new Set(['help'])

/** Resolves when the guest's current load ends; rejects with the failure when it fails. Bounded.
 *  Whichever way this settles — success, failure, or the WAIT_TIMEOUT_MS deadline — both listeners
 *  are removed before it returns, so a wait that times out does not leave a listener on the guest
 *  for the rest of the session.
 *
 *  `fresh` is set by the one caller that has just had the tab built for it. A new tab starts on
 *  about:blank and finishes loading it, and that `did-finish-load` lands after `dom-ready` — which is
 *  when the renderer registers the guest and so when this wait is armed. Taking it as the answer made
 *  `open` return with the guest still blank, and everything the script read next described a page
 *  that had not loaded. Caught in the dev app on the tab-creating open, half the time. */
function loadEnds(g: GuestDriver, at: string, url: string, fresh = false): Promise<void> {
  let onDone!: Listener
  let onFail!: Listener
  const cleanup = (): void => {
    // Removing a listener that already fired (or was never armed) is a no-op, so this is safe to
    // call unconditionally on every exit path.
    g.removeListener('did-finish-load', onDone)
    g.removeListener('did-fail-load', onFail)
  }
  const ended = new Promise<void>((resolve, reject) => {
    onDone = (): void => {
      // Only ever true for a tab that was just built: about:blank is where it starts, never where a
      // script asked to go, so the load that matters has not finished yet.
      if (fresh && g.getURL() === 'about:blank') { g.once('did-finish-load', onDone); return }
      resolve()
    }
    onFail = (_e, code, description, failedUrl, isMainFrame) => {
      if (isMainFrame === false) {
        // A sub-frame's failure says nothing about the page load this wait is for. `once` already
        // unregistered this listener before calling it, so re-arm or a real main-frame failure
        // arriving afterwards would go unseen and fall through to the timeout instead.
        g.once('did-fail-load', onFail)
        return
      }
      // -3 is ABORTED — another navigation replaced this one. Resolving here said the load had
      // finished when the replacement had not even landed: a tab is created pointing at the address,
      // `open` then loads it again, the first load aborts, and `open` returned with the guest still
      // on about:blank. Everything the script read next described the wrong page. So keep waiting for
      // the load that does land — whichever of the two it is, both are going to the same address, and
      // the deadline around this promise still bounds the wait.
      if (code === -3) { g.once('did-fail-load', onFail); return }
      reject(new Error(`${at}: ${failedUrl ?? url} failed to load (${description})`))
    }
    g.once('did-finish-load', onDone)
    g.once('did-fail-load', onFail)
  })
  return withTimeout(ended, WAIT_TIMEOUT_MS, at).finally(cleanup)
}

/** Which address `open()` means with no argument. The question it answers is "which localhost port is
 *  mine?" — with several projects open, each running a dev server, an agent that guessed could read
 *  another project's page as its own and diagnose it. So with exactly one candidate that is the
 *  answer; with none, or several, it refuses and says so, listing the several by their Run's name
 *  so the agent can pass one. Refusing is deliberate: opening "one of them" quietly is the failure
 *  this exists to prevent. */
function projectDevServer(servers: DevServer[]): string {
  // A Run the user marked for preview is the page, whatever else is running — that is the user's own
  // answer to the question, made once for the preview button and inherited here. Only when nothing
  // is marked does what happened to print an address decide.
  const marked = servers.filter((s) => s.preview)
  const pool = marked.length > 0 ? marked : servers
  if (pool.length === 0) {
    throw new Error(
      "open: no dev server has been started from Astera's Run for this project — pass the address, e.g. open('http://localhost:5173/')"
    )
  }
  if (pool.length > 1) {
    const list = pool.map((s) => `${s.name} ${s.url}`).join(', ')
    throw new Error(
      marked.length > 1
        ? `open: several of this project's Runs mark a preview page — pass one of them: ${list}`
        : `open: this project has several dev servers running — pass one of them, or set the preview address on the Run that is the page: ${list}`
    )
  }
  // Already a loopback address (that is how it got here), normalised the same way an explicit one is
  return agentOpenTarget(pool[0].url) ?? pool[0].url
}

/** The first thing `help()` says, when there is something to say: the project's dev server(s), so the
 *  agent knows before it reads anything else. Empty when Astera knows of none — a session in a project
 *  that does not use Run should not read a line about Run. */
function devServerHeader(servers: DevServer[]): string {
  const marked = servers.filter((s) => s.preview)
  const pool = marked.length > 0 ? marked : servers
  if (pool.length === 0) return ''
  if (pool.length === 1) {
    const how = pool[0].preview ? 'the page its Run marks for preview' : 'as started from Astera\'s Run'
    return `This project's dev server, ${how}: ${pool[0].url} — open() with no address opens it.\n\n`
  }
  const list = pool.map((s) => `${s.name} ${s.url}`).join(', ')
  return `This project has several dev servers running from Astera's Run: ${list} — pass one to open().\n\n`
}

/** `help('reload')` → the `## reload()` section of the guide, by the name before the parenthesis. */
function section(guide: string, name: string): string | null {
  const lines = guide.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).split('(')[0].trim() === name)
  if (start < 0) return null
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  if (end < 0) end = lines.length
  return lines.slice(start, end).join('\n').trimEnd()
}

export function stage1Helpers(deps: HelperDeps, ctx: RunContext, _log: LogSink): Record<string, unknown> {
  const need = (): GuestDriver => {
    const g = deps.guest()
    if (!g) throw new Error(NO_PAGE)
    return g
  }
  return {
    async open(url?: unknown): Promise<void> {
      ctx.at = 'open'
      const target = url === undefined ? projectDevServer(deps.devServers()) : agentOpenTarget(String(url))
      if (!target) throw new Error(`open: only this machine may be opened (got ${String(url)})`)
      const had = deps.guest() !== null
      const g = await deps.ensureGuest(target)
      const ended = loadEnds(g, 'open', target, !had)
      await g.loadURL(target).catch(() => {
        /* the failure arrives on did-fail-load, which ended() reports */
      })
      await ended
    },
    async reload(): Promise<void> {
      ctx.at = 'reload'
      const g = need()
      const ended = loadEnds(g, 'reload', g.getURL())
      g.reload()
      await ended
    },
    async url(): Promise<string> {
      ctx.at = 'url'
      return need().getURL()
    },
    async title(): Promise<string> {
      ctx.at = 'title'
      return need().getTitle()
    },
    async waitForLoad(): Promise<void> {
      ctx.at = 'waitForLoad'
      const g = need()
      if (!g.isLoading()) return
      await loadEnds(g, 'waitForLoad', g.getURL())
    },
    async consoleErrors(): Promise<unknown[]> {
      ctx.at = 'consoleErrors'
      need()
      return deps.buffers()?.console.sinceMark() ?? []
    },
    async networkErrors(): Promise<unknown[]> {
      ctx.at = 'networkErrors'
      need()
      return deps.buffers()?.network.sinceMark() ?? []
    },
    async close(): Promise<void> {
      ctx.at = 'close'
      deps.closeTab()
    },
    async snapshot(): Promise<Snapshot> {
      ctx.at = 'snapshot'
      const g = need()
      const snap = clampSnapshot(await inGuest(g, 'snapshot', snapshotScript()))
      if (!snap) throw new Error('snapshot: the page returned nothing readable')
      return snap
    },
    async screenshot(): Promise<{ path: string; width: number; height: number }> {
      ctx.at = 'screenshot'
      const g = need()
      if (g.isLoading()) await loadSettles(g, 'screenshot')
      let image: CapturedImage
      try {
        image = await firstFrame(g, 'screenshot')
      } catch (err) {
        // Interrupted here is this helper's own deadline, not a Stop. The deadline is interpolated so
        // changing SHOT_TIMEOUT_MS cannot leave the message lying.
        if (err instanceof Interrupted) throw new Error(`screenshot: the page did not paint within ${SHOT_TIMEOUT_MS / 1000} s — the window may be minimised`)
        throw err
      }
      const saved = await savePng(image, deps.shotsDir)
      // savePng answers null for an image with no pixels, which is the one thing firstFrame does not
      // return — so this is the type narrowing rather than a state a capture can reach.
      if (!saved) throw new Error('screenshot: the capture came back empty')
      return saved
    },
    async click(sel: unknown): Promise<void> {
      ctx.at = 'click'
      const g = need()
      const s = String(sel)
      const first = await inGuest(g, 'click', clickScript(s, false))
      if (!isRecord(first) || first.found !== true) throw new Error(`click: nothing matches ${s}`)
      if (typeof first.href === 'string') {
        // The page reports a link and does not follow it; whether it may be followed is decided here,
        // by the one loopback rule, and the will-navigate guard in preview/guest.ts stays the backstop.
        if (!agentOpenTarget(first.href)) {
          // An href this machine may not open is only a link that *leaves* this machine when it is a
          // page address at all. sanitizeUrl answers '' for anything but http(s), and `javascript:` —
          // the ordinary way to spell a button as an anchor — is not a navigation this rule governs:
          // refusing it named no address and gave a reason that was untrue. So only an http(s) href
          // is refused; the rest fall through and are clicked plainly.
          //
          // Two things this decision leans on, neither of them visible from here. It needs a
          // **resolved absolute** address from the guest — clickRuntime sends `a.href`, not the
          // attribute, and the comment there says why: a protocol-relative `//example.com/x` is not
          // an http(s) address as written, so the attribute would fall through to the plain click
          // below. And it reads sanitizeUrl's '' as "not an http(s) address", which is what that
          // function answers for every other scheme and for anything that does not parse.
          const address = sanitizeUrl(first.href)
          if (address !== '') throw new Error(`click: the link leaves this machine (${address})`)
        }
        await inGuest(g, 'click', clickScript(s, true))
      }
    },
    async fill(sel: unknown, text: unknown): Promise<void> {
      ctx.at = 'fill'
      const g = need()
      const s = String(sel)
      const r = await inGuest(g, 'fill', fillScript(s, String(text)))
      if (!isRecord(r) || r.found !== true) throw new Error(`fill: nothing matches ${s}`)
      // fillRuntime reports 'no option has that value' or 'not an input, textarea, select or editable
      // element'; these two branches turn them into the messages the guide documents.
      if (typeof r.error === 'string') {
        throw new Error(r.error === 'no option has that value' ? `fill: ${s} has no option with that value` : `fill: ${s} is ${r.error}`)
      }
    },
    async press(key: unknown): Promise<void> {
      ctx.at = 'press'
      const g = need()
      if (typeof key !== 'string' || key === '') throw new Error('press: key must be a non-empty string')
      await inGuest(g, 'press', pressScript(key))
    },
    async waitFor(selOrMs: unknown): Promise<void> {
      ctx.at = 'waitFor'
      const g = need()
      if (typeof selOrMs === 'number' && Number.isFinite(selOrMs)) {
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(selOrMs, WAIT_TIMEOUT_MS))))
        return
      }
      if (typeof selOrMs !== 'string' || selOrMs === '') throw new Error('waitFor: expects a selector or a number of milliseconds')
      const r = await inGuest(g, 'waitFor', waitForScript(selOrMs, WAIT_TIMEOUT_MS))
      if (!isRecord(r) || r.found !== true) throw new Error(`waitFor: nothing matched ${selOrMs} within ${WAIT_TIMEOUT_MS} ms`)
    },
    help(name?: unknown): string {
      ctx.at = 'help'
      if (name === undefined) return devServerHeader(deps.devServers()) + deps.guide
      return section(deps.guide, String(name)) ?? `no helper named ${String(name)} — run help() for the list`
    }
  }
}
