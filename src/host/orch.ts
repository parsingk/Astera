// The Host's orchestration: the real command layer over the real store (host control plane design
// §5, §6). This is what replaces the wire slice's `version`-only stub — `server.ts` calls
// `OrchCall.call` and did not change when it did.
import path from 'node:path'
import { handleCommand, type OrchServerDeps } from '../core/orchestration/command'
import { OrchestrationStore, isValidState } from '../core/orchestration/store'
import type { OrchState } from '../core/orchestration/state'
import type { OrchCall, OrchCaller } from '../core/host/orchProtocol'
import { hostOrchDeps } from './orchDeps'

export interface HostOrch extends OrchCall {
  /** Loads the state, once. Lazy and memoized on purpose — see `createHostOrch`. */
  ready(): Promise<void>
}

export function createHostOrch(a: {
  profileDir: string
  /** The Host's own version (`ASTERA_HOST_VERSION`) — what `status` and `version` answer with. */
  version: string
  now(): string
  runningSessions(): number
  act(name: string, args: unknown[]): Promise<unknown>
  hasApp(): boolean
  /** Called with the state every commit leaves behind, so the Host can push it to the app. */
  onState(s: OrchState): void
  /** The Host's log. Handed to the command layer as well — see `hostOrchDeps`. */
  log(message: string): void
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

  /** **Built per call, and that is what makes the CONFLICT decision honest.**
   *
   *  A forwarded action refuses by throwing, and each command turns a dependency failure into its own
   *  status: `worker-start` rolls its Dispatch back and answers 400 ("failed to start worker: ..."),
   *  which is right for a spawn that failed and wrong for this one — 400 tells a person their
   *  arguments were bad, and they were fine. So the status is corrected on the way out, and what it
   *  is corrected on is this flag, set by the forwarder itself. It used to be a substring match on
   *  the reply body, which most error paths fill with ids and titles the caller supplied: an id with
   *  APP_REQUIRED in it turned a 404 into a 409 and a script read exit 6 where exit 4 was the truth.
   *
   *  One object literal per call costs nothing beside running a command, and a flag that lives no
   *  longer than the call it belongs to cannot be read by the next one. */
  const depsFor = (refused: { app: boolean }): OrchServerDeps =>
    hostOrchDeps({
      getState: () => store.get(),
      setState: async (next) => {
        await store.save(next)
        a.onState(next)
      },
      now: a.now,
      runningSessions: a.runningSessions,
      appVersion: () => a.version,
      act: a.act,
      hasApp: a.hasApp,
      log: a.log,
      onAppRequired: (name, why) => {
        refused.app = true
        a.log(`${name} could not be put to the app: ${why}`)
      }
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
      // **Everything is inside the try, including `state-put` and `ready()`.** `server.ts` answers
      // `orch-call` from this promise and has no catch of its own, so anything that escapes here is
      // not a 500 — it is no `orch-result` at all, a caller waiting forever, and an unhandled
      // rejection that takes the Host down with every terminal it owns. Both of the excluded halves
      // could reject for real: `store.save` is an unguarded mkdir/writeFile/rename, and `state-put`
      // is the app's first message after it connects. The HTTP shell has always turned a throw into
      // a 500 the same way.
      const refused = { app: false }
      try {
        if (cmd === 'state-put') return await statePut(args, from)
        // Design §8: a call that arrives before the state is loaded waits, rather than failing.
        await ready()
        const r = await handleCommand(depsFor(refused), { sessionId }, cmd, args)
        // Only an error reply is rewritten: a command that carried on past a refusal it swallowed
        // (the fire-and-forget ones) succeeded, and a success is not a conflict.
        return r.status >= 400 && refused.app ? { status: 409, body: r.body } : r
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { status: refused.app ? 409 : 500, body: { error: message } }
      }
    }
  }
}
