// The stage-1 helper set an agent's script sees. Each is bound to one session's guest through `deps`;
// each sets ctx.at first so a failure names it. Stage 2 adds snapshot/screenshot, stage 3 the acting
// helpers, in this same shape.
import { agentOpenTarget } from '../../core/agentBrowser/urls'
import { WAIT_TIMEOUT_MS, withTimeout, type LogSink } from '../../core/agentBrowser/script'
import type { RunContext } from '../../core/agentBrowser/scriptRunner'
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
}

export interface HelperDeps {
  /** The session's guest, or null before its tab exists. */
  guest(): GuestDriver | null
  /** The guest, creating the tab first when there is none; rejects when it does not appear in time. */
  ensureGuest(url: string): Promise<GuestDriver>
  buffers(): AgentBuffers | null
  closeTab(): void
  /** The text `help()` returns — browser-guide.md. `RunsDeps.guide` is a getter and the wiring reads
   *  the file through it on every run: the skills directory is only known once the orchestration
   *  server has booted, which is after the wiring runs, so a value captured there would be `''`
   *  forever. */
  guide: string
}

const NO_PAGE = 'no page open — call open(url) first'

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
    async open(url: unknown): Promise<void> {
      ctx.at = 'open'
      const target = agentOpenTarget(String(url))
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
    help(name?: unknown): string {
      ctx.at = 'help'
      if (name === undefined) return deps.guide
      return section(deps.guide, String(name)) ?? `no helper named ${String(name)} — run help() for the list`
    }
  }
}
