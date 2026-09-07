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
  /** The visible page as an image. Never settles while the guest is not painting (window minimised
   *  or fully covered) — callers race it. */
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

/** How long a screenshot may take before it is called off. capturePage does not settle at all while
 *  the guest is not painting — the window minimised, or fully covered by another — measured at 7.8 s
 *  pending in Design Mode; the script deadline would end the run eventually, but this names the cause. */
export const SHOT_TIMEOUT_MS = 5_000

/** Runs one guest-side script for a helper: waits for a load in progress first, and if the page still
 *  refuses the call — executeJavaScript rejects while the frame is navigating, which is exactly the
 *  state a click() that navigates leaves for the next helper — waits for that load and tries once
 *  more. A second refusal is the page's answer. */
async function inGuest(g: GuestDriver, at: string, script: string): Promise<unknown> {
  if (g.isLoading()) await loadEnds(g, at, g.getURL())
  try {
    return await g.executeJavaScript(script)
  } catch {
    // The first refusal is the one the retry exists to absorb, so it is not bound: only the second
    // is reported, because only the second is the page's answer rather than the navigation's.
    if (g.isLoading()) await loadEnds(g, at, g.getURL())
    try {
      return await g.executeJavaScript(script)
    } catch (second) {
      const message = second instanceof Error ? second.message : String(second)
      throw new Error(`${at}: the page refused the call (${message})`)
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
      if (g.isLoading()) await loadEnds(g, 'screenshot', g.getURL())
      let image: CapturedImage
      try {
        image = await withTimeout(g.capturePage(), SHOT_TIMEOUT_MS, 'screenshot')
      } catch (err) {
        // Interrupted here is this helper's own deadline, not a Stop: a guest that is not painting
        // never answers at all, so the message names that cause rather than saying "timed out".
        if (err instanceof Interrupted) throw new Error('screenshot: the page did not paint within 5 s — is the window visible?')
        throw err
      }
      const saved = await savePng(image, deps.shotsDir)
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
        // by the one loopback rule, and the will-navigate guard stays the backstop.
        if (!agentOpenTarget(first.href)) throw new Error(`click: the link leaves this machine (${sanitizeUrl(first.href)})`)
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
