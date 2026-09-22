// The Host's orchestration: the real command layer over the real store (host control plane design
// §5, §6). This is what replaces the wire slice's `version`-only stub — `server.ts` calls
// `OrchCall.call` and did not change when it did.
import path from 'node:path'
import { handleCommand } from '../core/orchestration/command'
import { OrchestrationStore, isValidState } from '../core/orchestration/store'
import type { OrchState } from '../core/orchestration/state'
import type { OrchCall, OrchCaller } from '../core/host/orchProtocol'
import { hostOrchDeps } from './orchDeps'

export interface HostOrch extends OrchCall {
  /** Loads the state, once. Lazy and memoized on purpose — see `createHostOrch`. */
  ready(): Promise<void>
}

/** The marker `orchDeps.ts` refuses with. Recognised here to give the refusal the status the design
 *  asks for, which is not the one the command that caught it would have chosen. */
const APP_REQUIRED = 'APP_REQUIRED'

/** 409 CONFLICT, and **not** whatever the command answered.
 *
 *  A remote dependency refuses by throwing, and each command turns a dependency failure into its own
 *  status: `worker-start` rolls its Dispatch back and answers 400 ("failed to start worker: ..."),
 *  which is right for a spawn that failed and wrong for this one — 400 tells a person their arguments
 *  were bad, and they were fine. The design says no app attached is CONFLICT (§5), which
 *  `cliOutput.ts`'s `codeForStatus` turns into exit 6, "the current state makes this impossible".
 *  Rewritten here rather than inside `handleCommand`, which must not learn that a dependency can be
 *  remote; the rollback each command already did is what makes rewriting the status safe. */
const withAppRequiredStatus = (r: { status: number; body: unknown }): { status: number; body: unknown } => {
  if (r.status < 400) return r
  const error = (r.body as { error?: unknown } | null)?.error
  return typeof error === 'string' && error.includes(APP_REQUIRED) ? { status: 409, body: r.body } : r
}

export function createHostOrch(a: {
  profileDir: string
  /** The Host's own version (`ASTERA_HOST_VERSION`) — what `status` and `version` answer with. */
  version: string
  now(): string
  runningSessions(): number
  act(name: string, args: unknown): Promise<unknown>
  hasApp(): boolean
  /** Called with the state every commit leaves behind, so the Host can push it to the app. */
  onState(s: OrchState): void
}): HostOrch {
  const store = new OrchestrationStore(path.join(a.profileDir, 'orchestration.json'))

  /** **Nothing is read at construction, and `host/index.ts` never calls `ready()`.**
   *
   *  Until the app cuts over it still builds an `OrchestrationStore` on this same path and still runs
   *  its boot cleanup, and `store.load()` writes. A load here at boot would be a second process
   *  running load-time recovery against one file. So the load happens at the first call that needs
   *  the state — and, once the app has pushed its state with `state-put`, never at all. */
  let loading: Promise<void> | null = null
  const ready = (): Promise<void> =>
    // `aliveSessionIds: 'unknown'` is the branch that closes nothing. The Host does know which ptys
    // it is running, but mapping a pty id to a `Dispatch.sessionId` is something the app does through
    // `liveWorkersFor` and reattach — guessing it wrong closes a live worker's Dispatch, and the
    // reconciler then starts a second agent in the worktree the first is still working in. The cost
    // of 'unknown' is the documented one: an open Dispatch stays open. The task that gives the app's
    // side over to the Host replaces this with the Host's own registry evidence plus the
    // pending-report queue (design §6).
    (loading ??= store.load({ aliveSessionIds: 'unknown' }).then(() => {}))

  const deps = hostOrchDeps({
    getState: () => store.get(),
    setState: async (next) => {
      await store.save(next)
      a.onState(next)
    },
    now: a.now,
    runningSessions: a.runningSessions,
    appVersion: () => a.version,
    act: a.act,
    hasApp: a.hasApp
  })

  /** The app handing over its whole state (design §5). Not part of `handleCommand`: it is not a
   *  command anybody types, it writes the state wholesale rather than through a transition, and only
   *  one kind of client may send it. */
  const statePut = async (
    args: Record<string, unknown>,
    from: OrchCaller | undefined
  ): Promise<{ status: number; body: unknown }> => {
    // A client that did not call itself the app — or one the server could not identify at all — is
    // not the owner of the state. 403 rather than 501: the command exists, this caller may not use it.
    if (from?.role !== 'app') return { status: 403, body: { error: 'state-put is the app’s to send' } }
    const state = args.state
    // The same check the store uses on the file, for the same reason: what arrives here is written to
    // that file, and a malformed state saved over a good one costs every Job in it.
    if (!isValidState(state)) return { status: 400, body: { error: 'state-put needs a whole orchestration state' } }
    // **The file is not read after this.** The app has just handed over everything that is in it, so
    // a load would be reading an older copy of what we were given — and it would run restart recovery
    // and write, which is the one thing that must not happen twice while the app still owns the file.
    // A load already in flight is waited for instead of raced: its own assignment would otherwise
    // land after this one.
    if (loading) await loading
    else loading = Promise.resolve()
    await store.save(state)
    // To the others and not back to the sender: the state came from there, and an app that received
    // its own push would write its own state back over itself.
    from.toOthers({ t: 'orch-state', state })
    return { status: 200, body: { ok: true } }
  }

  return {
    ready,
    call: async ({ cmd, args, sessionId, from }) => {
      if (cmd === 'state-put') return statePut(args, from)
      // Design §8: a call that arrives before the state is loaded waits, rather than failing.
      await ready()
      try {
        return withAppRequiredStatus(await handleCommand(deps, { sessionId }, cmd, args))
      } catch (err) {
        // **Nothing may escape.** `server.ts` answers `orch-call` from this promise and has no catch
        // of its own, so a rejection here would mean no `orch-result` at all and a caller waiting
        // forever. The HTTP shell has always turned a throw into a 500 the same way.
        const message = err instanceof Error ? err.message : String(err)
        return { status: message.includes(APP_REQUIRED) ? 409 : 500, body: { error: message } }
      }
    }
  }
}
