// The Host's orchestration: the real command layer over the real store (host control plane design
// §5, §6). This is what replaces the wire slice's `version`-only stub — `server.ts` calls
// `OrchCall.call` and did not change when it did.
import path from 'node:path'
import { handleCommand, type OrchServerDeps } from '../core/orchestration/command'
import { OrchestrationStore, isValidState, type OrchLoadResult } from '../core/orchestration/store'
import { readPendingReports } from '../core/orchestration/pendingDrain'
import { PENDING_REPORTS_DIR, reportedDispatchIdsOf } from '../core/orchestration/pendingReports'
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
  /** The sessions this Host is still running, by the app's own id for each — its registry's live
   *  entries whose note says `kind: 'session'`, mapped to `meta.id`.
   *
   *  **That is literally a `Dispatch.sessionId`.** An adopted session keeps the id it had before the
   *  restart (`src/main/host/reattach.ts`), so a stored Dispatch pointing at one of these is pointing
   *  at a worker that is still working. **And it is never `'unknown'`**: the app had to ask another
   *  process and could be told nothing, and design §6 says that answer cannot exist inside the Host —
   *  "we asked and got no answer" is not a state a process can be in about itself. */
  aliveSessionIds(): ReadonlySet<string>
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
   *  The load happens at the first call that needs the state — and, once the app has pushed its state
   *  with `state-put`, never at all. Lazy because a Host that nobody asks anything of has no reason to
   *  touch the file, and memoized because the restart cleanup inside `load` must run exactly once. */
  let loading: Promise<void> | null = null
  /** What that one load found. Handed to the app once, with `state-get` — see `stateGet`. */
  let loadResult: OrchLoadResult | null = null
  const ready = (): Promise<void> =>
    (loading ??= (async () => {
      // **The two pieces of evidence the app used to gather, gathered here instead** (design §6).
      //
      // - The live sessions are this Host's own registry, so `'unknown'` — the answer that closed
      //   nothing — has no meaning here any more. A process is not in the dark about itself.
      // - The undelivered reports are the third reason a Dispatch stays open, and the case that
      //   matters most is the one where nothing survived to be alive: the machine was turned off
      //   after a worker had already finished and written its report down. Closing that Dispatch
      //   here would throw the report away (`applyWorkerDone` answers `alreadyReported` for a
      //   Dispatch that already has `endedAt`) and hand the reconciler a lost worker to replace.
      //
      // Reading the queue cannot throw — `readPendingReports` swallows its own failures, a missing
      // folder being the ordinary case — and `reportedDispatchIdsOf` is pure. A queue that cannot be
      // read costs the reports in it, never the load. **Reading is all that happens here**: applying
      // a report reaches session spawning, which is the app's, and the app still drains the same
      // queue at its own boot.
      const queued = await readPendingReports({ dir: path.join(a.profileDir, 'orch', PENDING_REPORTS_DIR), log: a.log })
      loadResult = await store.load({
        aliveSessionIds: a.aliveSessionIds(),
        reportedDispatchIds: reportedDispatchIdsOf(queued.map((q) => q.report))
      })
    })())

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
    // **The file is not read after this.** This is a whole state, so a load would be reading an older
    // copy of what we were just given, and it would run the restart cleanup a second time. In the
    // ordinary case the load has already happened — the app fills its mirror with `state-get` before
    // it can write anything at all — and a load already in flight is waited for rather than raced:
    // its own assignment would otherwise land after this one.
    if (loading) await loading
    else loading = Promise.resolve()
    await store.save(state)
    // To the others and not back to the sender: the state came from there, and an app that received
    // its own push would write its own state back over itself.
    from.toOthers({ t: 'orch-state', state })
    return { status: 200, body: { ok: true } }
  }

  /** Whether the load's findings have already been handed to somebody. See `stateGet`. */
  let bootHandedOut = false

  /**
   * The app filling its mirror (design §5, §6). Not part of `handleCommand` for the same reasons
   * `state-put` is not: nobody types it, and it answers with the whole state rather than a view of it.
   *
   * **Why the load's findings ride along.** `store.load` is where the restart cleanup happens, and
   * half of what that cleanup starts is the app's: journalling every worker the restart lost (Job
   * Continuity), restarting the validations and reviews it interrupted, and saying in the log what
   * was written off. The app used to have those findings because it was the process that loaded. Now
   * the Host loads, so they travel.
   *
   * **Once, and only to a caller that asked for them.** Two rules, and they cover the two ways this
   * could go wrong. Only `boot: true` is answered with them, so the app's re-mirror after a reconnect
   * cannot consume findings that belong to the next app start. And only the first such caller gets
   * them, because an app restarting against a Host that has been up for hours would otherwise be
   * handed a cleanup that happened long ago — re-journalling a diff spanning everything since, and
   * restarting validations for Tasks that have moved on. `null` is the honest answer there: nothing
   * was lost, because the Host never went away.
   */
  const stateGet = async (args: Record<string, unknown>): Promise<{ status: number; body: unknown }> => {
    await ready()
    const wantsBoot = args.boot === true && !bootHandedOut
    if (wantsBoot) bootHandedOut = true
    return { status: 200, body: { state: store.get(), boot: wantsBoot ? loadResult : null } }
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
        // Not restricted to the app: it is a read, and every CLI client can already read all of this
        // through `jobs-list` and its neighbours. A refusal here would be a new one nobody needs.
        if (cmd === 'state-get') return await stateGet(args)
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
