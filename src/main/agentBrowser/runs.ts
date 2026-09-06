// One `astera browser js` from one session, start to finish: find or make the tab, run the script
// against it, say when the tab is busy. Serial per session — two scripts driving one page is not a
// case worth handling, so the second is refused rather than queued.
import { createLog, Interrupted, WAIT_TIMEOUT_MS, type RunResult } from '../../core/agentBrowser/script'
import { runScript, type RunContext } from '../../core/agentBrowser/scriptRunner'
import type { AgentBuffers } from './buffers'
import { stage1Helpers, type GuestDriver, type HelperDeps } from './helpers'
import type { AgentGuestRegistry, GuestLike } from './registry'

export type RunOutcome =
  | { ok: true; result: RunResult }
  | { ok: false; status: 404 | 409; error: string }

export interface RunsDeps {
  registry: AgentGuestRegistry<GuestDriver & GuestLike>
  buffersOf(sessionId: string): AgentBuffers | null
  /** The session's cwd, which is its project root — or null when main knows no such session. */
  cwdOf(sessionId: string): string | null
  /** Ask the renderer for the session's tab, first address `url`. */
  requestTab(sessionId: string, cwd: string, url: string): void
  closeTab(sessionId: string): void
  setBusy(sessionId: string, busy: boolean): void
  guide: string
  /** How long `open` waits for a requested tab's guest to register. */
  tabWaitMs?: number
  /** The whole-script deadline, defaulting to SCRIPT_TIMEOUT_MS. A seam for the tests, which cannot
   *  wait a minute to watch a run be cut off — the same reason `tabWaitMs` is one. */
  scriptTimeoutMs?: number
}

/** Each stage1Helpers function sets `ctx.at` to its own name before its first await, but never sets
 *  it back — from its own point of view it either finishes or throws, and either way it is done with
 *  `ctx.at` (helpers.ts, `stage1Helpers`'s doc comment). A helper that finishes cleanly is no longer
 *  "running", though, so once one returns, `ctx.at` is reset to 'script': a Stop that lands afterward
 *  — the script sitting between two helper calls, or on its own await — is reported at 'script'
 *  rather than still naming the helper that already returned. A helper that throws or rejects is left
 *  alone, so `shapeError` still attributes the failure to the helper that caused it.
 *
 *  It is also the one place an **abandoned** script is stopped. The runner races the script body
 *  against the deadline and against Stop, but losing a race stops nothing: the async body inside the
 *  vm goes on running and goes on calling helpers, so `while (true) { await reload() }` reported a
 *  clean timeout at 60 s and then reloaded the user's dev server for as long as the app lived. `run`
 *  aborts its own controller in its `finally`, so success, error, deadline and Stop all arrive here
 *  the same way, and a helper entered after that never touches the tab.
 *
 *  An entered helper **parks** — it returns a promise that never settles — rather than failing, and
 *  the difference is the whole point. Failing it does not work, either way round: a synchronous
 *  `throw` means the `await` in front of the call is never evaluated, and a rejected promise resumes
 *  the body on a microtask. Neither hands the thread back, so `while (true) { try { await reload() }
 *  catch {} }` — "retry, ignoring errors", a very plausible thing for an agent to write — would spin
 *  the main process flat: no IPC, no UI, no other session, no recovery short of killing the app. The
 *  sandbox has no `setTimeout`, so a helper is the only thing such a loop can ever yield on. Parking
 *  suspends the abandoned body for good instead, and it stops doing anything at all. The cost is
 *  real and it is the cheaper one: a parked body keeps its vm context until the app exits, which is
 *  the same retention the abandoned body was already causing. `help` is the only synchronous helper,
 *  and a synchronous function cannot park, so it keeps the throw — a loop that catches `help()` does
 *  still freeze, as any synchronous infinite loop inside a script does, and nothing at this layer can
 *  reach that.
 *
 *  What this does **not** do is cancel a helper that is already inside its body when the abort lands:
 *  only entry is gated. An `open()` parked in `ensureGuest`'s `waitFor`, for instance, can resume
 *  after the run has returned and call `loadURL` once. That single action is the bound — it cannot
 *  start another, because the next helper call parks. */
function withAtReset(raw: Record<string, unknown>, ctx: RunContext, signal: AbortSignal): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'function') {
      wrapped[name] = value
      continue
    }
    wrapped[name] = (...args: unknown[]) => {
      if (signal.aborted) {
        // `help` is the one helper a script may call without `await`, so it is the one that throws;
        // every other helper parks (see this function's doc comment for why failing them is worse).
        if (name === 'help') throw new Interrupted(ctx.at, 'stopped')
        return new Promise<never>(() => {})
      }
      const result = (value as (...a: unknown[]) => unknown)(...args)
      if (result instanceof Promise) {
        return result.then((v) => {
          ctx.at = 'script'
          return v
        })
      }
      ctx.at = 'script'
      return result
    }
  }
  return wrapped
}

export class AgentBrowserRuns {
  private readonly inFlight = new Map<string, AbortController>()

  constructor(private readonly deps: RunsDeps) {}

  async run(sessionId: string, script: string): Promise<RunOutcome> {
    const cwd = this.deps.cwdOf(sessionId)
    if (cwd === null) return { ok: false, status: 404, error: 'no such session' }
    if (this.inFlight.has(sessionId)) return { ok: false, status: 409, error: 'a script is already running' }

    const ac = new AbortController()
    this.inFlight.set(sessionId, ac)
    const ctx: RunContext = { at: 'script' }
    const log = createLog()
    const helperDeps: HelperDeps = {
      guest: () => this.deps.registry.guestOf(sessionId),
      ensureGuest: async (url) => {
        const now = this.deps.registry.guestOf(sessionId)
        if (now) return now
        this.deps.requestTab(sessionId, cwd, url)
        const g = await this.deps.registry.waitFor(sessionId, this.deps.tabWaitMs ?? WAIT_TIMEOUT_MS)
        if (!g) throw new Error('open: the browser tab did not appear')
        return g
      },
      buffers: () => this.deps.buffersOf(sessionId),
      closeTab: () => this.deps.closeTab(sessionId),
      guide: this.deps.guide
    }
    this.deps.setBusy(sessionId, true)
    try {
      const helpers = withAtReset(stage1Helpers(helperDeps, ctx, log), ctx, ac.signal)
      const result = await runScript(script, helpers, log, ctx, {
        signal: ac.signal,
        timeoutMs: this.deps.scriptTimeoutMs
      })
      return { ok: true, result }
    } finally {
      // Every exit — finished, threw, deadline, Stop — ends the run the same way, so the script body
      // that outlived the race cannot keep driving the tab (withAtReset's doc comment).
      ac.abort()
      this.inFlight.delete(sessionId)
      this.deps.setBusy(sessionId, false)
    }
  }

  /** Stage 3's Stop, and any cleanup that must end a run. */
  stop(sessionId: string): boolean {
    const ac = this.inFlight.get(sessionId)
    if (!ac) return false
    ac.abort()
    return true
  }
}
