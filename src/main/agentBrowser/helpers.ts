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
  /** The text `help()` returns — browser-guide.md, read once at wiring time. */
  guide: string
}

const NO_PAGE = 'no page open — call open(url) first'

/** Resolves when the guest's current load ends; rejects with the failure when it fails. Bounded.
 *  Whichever way this settles — success, failure, or the WAIT_TIMEOUT_MS deadline — both listeners
 *  are removed before it returns, so a wait that times out does not leave a listener on the guest
 *  for the rest of the session. */
function loadEnds(g: GuestDriver, at: string, url: string): Promise<void> {
  let onDone!: Listener
  let onFail!: Listener
  const cleanup = (): void => {
    // Removing a listener that already fired (or was never armed) is a no-op, so this is safe to
    // call unconditionally on every exit path.
    g.removeListener('did-finish-load', onDone)
    g.removeListener('did-fail-load', onFail)
  }
  const ended = new Promise<void>((resolve, reject) => {
    onDone = (): void => resolve()
    onFail = (_e, code, description, failedUrl, isMainFrame) => {
      if (isMainFrame === false) {
        // A sub-frame's failure says nothing about the page load this wait is for. `once` already
        // unregistered this listener before calling it, so re-arm or a real main-frame failure
        // arriving afterwards would go unseen and fall through to the timeout instead.
        g.once('did-fail-load', onFail)
        return
      }
      // -3 is ABORTED — a navigation replaced by another, not a failure of the page
      if (code === -3) { resolve(); return }
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
      const g = await deps.ensureGuest(target)
      const ended = loadEnds(g, 'open', target)
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
