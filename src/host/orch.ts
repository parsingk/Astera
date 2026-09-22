// The Host's orchestration: the real command layer over the real store (host control plane design
// §5, §6). This is what replaces the wire slice's `version`-only stub — `server.ts` calls
// `OrchCall.call` and did not change when it did.
import path from 'node:path'
import { handleCommand, type OrchServerDeps } from '../core/orchestration/command'
import { OrchestrationStore, isValidState, type OrchLoadResult } from '../core/orchestration/store'
import { readPendingReports } from '../core/orchestration/pendingDrain'
import { pendingReportsDirIn, reportedDispatchIdsOf } from '../core/orchestration/pendingReports'
import type { OrchState } from '../core/orchestration/state'
import { runningRunCount } from '../core/orchestration/running'
import type { OrchCall, OrchCaller } from '../core/host/orchProtocol'
import { hostOrchDeps } from './orchDeps'

export interface HostOrch extends OrchCall {
  /** Loads the state, once. Lazy and memoized on purpose — see `createHostOrch`. */
  ready(): Promise<void>
  /** Runs with work actually in flight — what `astera host stop` refuses over and names (ruling F57,
   *  docs/cli.md).
   *
   *  **Synchronous, and it deliberately does not load.** Not merely to stay cheap: loading is not a
   *  read. `store.load` runs the restart cleanup — it writes off open Dispatches, opens Gates and
   *  saves — and triggering that from `host stop`, whose whole point is to disturb nothing, would be
   *  worse than any answer it could produce.
   *
   *  **And 0 is the true answer for a Host that has not loaded**, not a convenient one. For a Run to
   *  be running *here*, some command must have gone through `handleCommand`, which awaits `ready()` —
   *  so a Host that has never loaded has never dispatched anything. A file that still says a Run is
   *  `dispatched` is describing work from a process that is gone; refusing to stop over it would
   *  leave `host stop` permanently refusing until somebody cleaned the file up by hand. Work this
   *  Host really holds from before a load is a live pty, and that is counted as a session. */
  runningRuns(): number
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
  /** Called with the state every commit leaves behind, so the Host can push it to the app — and with
   *  the version that commit is, which the app quotes back on its own writes (ruling F56). */
  onState(s: OrchState, version: number): void
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
      // read costs the reports in it, never the load.
      //
      // **Nothing is applied here**: applying a report reaches session spawning, which is the app's,
      // and the app still reads and drains this same queue at its own boot. So two processes read
      // this folder, and **reading it is not read-only** — `readPendingReports` also sweeps abandoned
      // `.json.tmp` files and renames unreadable reports aside. Why the two sweeps cannot destroy
      // anything between them: the swept set (`.json.tmp`) and the read set (`.json`) are disjoint by
      // suffix; a working file is swept only after an hour untouched (`WORKING_FILE_TTL_MS`), so a
      // write in flight in the other process is never the one swept; and both the `rm` and the
      // `rename` are guarded, so the loser of a race does nothing rather than failing. The one
      // visible effect is cosmetic and belongs to this side: if the app's drain deletes a `.json` it
      // has just applied, between this `readdir` and its `readFile`, the log below says "setting
      // aside … — it is not a report this app can read" about a report that applied perfectly well.
      const queued = await readPendingReports({ dir: pendingReportsDirIn(a.profileDir), log: a.log })
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
        // Reserved before the write, for `reserveVersion`'s reason and for one that is this path's
        // own: a `state-put` arriving while this commit is still writing would otherwise read the
        // pre-commit number, pass the check, and land a whole state that does not contain this
        // commit — the exact loss ruling F56 is about, with the Host as the losing side.
        const committed = reserveVersion()
        await store.save(next)
        a.onState(next, committed)
      },
      now: a.now,
      runningSessions: a.runningSessions,
      appVersion: () => a.version,
      // `reset` 이 지우기 전에 파일을 옆으로 복사한다. **store 의 쓰기 큐를 통과하므로** 아직 땅에
      // 닿지 않은 저장을 앞지르지 않는다 — 앱이 이 복사를 대신하던 동안은 그 보장이 없었다.
      backup: () => store.backup(),
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
    //
    // **Ahead of the version check below, deliberately.** Everything from that check to the commit
    // has to be one synchronous step (see `reserveVersion`), and this is the last thing in this
    // function that can suspend.
    if (loading) await loading
    else loading = Promise.resolve()
    // **The write the app built is against a state this Host has since replaced** (ruling F56). It
    // carries a whole state, so landing it would erase every commit made in between — and the commit
    // most likely to be in between is a worker's `worker_done`, whose author has already exited.
    //
    // The current state travels with the refusal so the app can put its mirror right without a second
    // round trip: what it is holding is wrong by definition at this point, and leaving it wrong is
    // the second half of the same fault (it would go on reading a state the file does not have).
    //
    // **An omitted version is not a mismatch.** It means the caller has no version to quote — an app
    // built before this field, or one writing before its first `state-get` — and refusing those would
    // be a new failure in place of the one being fixed. The check is a safety net over a client that
    // opts into it, which is what keeps this additive and the protocol at 3.
    const sent = args.version
    if (typeof sent === 'number' && sent !== version)
      return {
        status: 409,
        body: {
          error: `the state moved on: this Host is at version ${version}, the write was built on ${sent}`,
          state: store.get(),
          version
        }
      }
    // Taken here, not after the write lands — the whole of `reserveVersion`'s note.
    const committed = reserveVersion()
    await store.save(state)
    // To the others and not back to the sender: the state came from there, and an app that received
    // its own push would write its own state back over itself.
    from.toOthers({ t: 'orch-state', state, version: committed })
    return { status: 200, body: { ok: true, version: committed } }
  }

  /** Whether the load's findings have already been handed to somebody. See `stateGet`. */
  let bootHandedOut = false

  /**
   * How many commits this Host has made. **The app quotes it back on `state-put` and a stale one is
   * refused** (ruling F56).
   *
   * `state-put` is a whole-state write, and the state the app built it from came out of a mirror that
   * a push can supersede while the app is awaiting. Without this, the sequence that costs work is one
   * click: a worker's `worker_done` commits B here and is pushed; a moment earlier the person pressed
   * Pause, so the app read S0, awaited, and its write of A lands after — and A does not contain B.
   * The worker has already exited, so its report, its dispatch closure and its task transition are
   * gone with nothing to reproduce them.
   *
   * **This is the detection half only.** Refusing the write turns silent data loss into something the
   * person is told about and the mirror recovers from; making the refused action succeed needs the
   * app's mutation to be re-appliable, and today it is not — it arrives here as a finished state, not
   * as a transform. That decision is deliberately left open rather than guessed at.
   *
   * Starts at 0, which no app can hold before its first `state-get`, so the first write of a session
   * always carries a version the Host has really issued.
   */
  let version = 0
  /**
   * Takes the next version. **Called at accept time, in the same synchronous step as the check that
   * precedes it — never after the write has landed.**
   *
   * Raising it after `await store.save` looks equivalent and is not, because the app's mirror raises
   * its own copy the moment it hands a write over (`mirrorStore`, ruling F56/d). Two overlapping app
   * writes therefore arrive quoting N and N+1, and a Host still at N while the first is on disk
   * refuses the second — a write that was built on the first and was never stale. That is the same
   * lost commit this check exists to prevent, moved to the other end of the window.
   *
   * **Why this rather than serialising `state-put`.** A queue would make the second write wait out
   * the first's disk write, so every app commit would pay the previous one's fsync before it could
   * even be judged — and worse, a refusal would then be able to mean "somebody is still writing"
   * instead of only ever meaning "somebody else committed". Ordering is not what is missing:
   * `OrchestrationStore.save` already moves memory synchronously and serialises the disk writes
   * behind its own queue, so the file lands in call order either way. What was missing is that the
   * number and the memory move together, which is exactly what the mirror does at the other end. Two
   * ends, one rule.
   */
  const reserveVersion = (): number => ++version

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
   * **Once, and only to the app asking for them.** Three rules, and they cover the three ways this
   * could go wrong. Only `boot: true` is answered with them, so the app's re-mirror after a reconnect
   * cannot consume findings that belong to the next app start. Only a client that called itself the
   * app is answered with them at all — **`boot: true` is not a read**: taking these findings
   * consumes them, so a CLI that asked for them, by mistake or otherwise, would leave the app booting
   * with nothing and the restart's interrupted validations never restarted. The plain read stays open
   * to anyone, because it really is one. And only the first such caller gets them, because an app
   * restarting against a Host that has been up for hours would otherwise be handed a cleanup that
   * happened long ago — re-journalling a diff spanning everything since, and restarting validations
   * for Tasks that have moved on. `null` is the honest answer there: nothing was lost, because the
   * Host never went away.
   */
  const stateGet = async (
    args: Record<string, unknown>,
    from: OrchCaller | undefined
  ): Promise<{ status: number; body: unknown }> => {
    await ready()
    // Not a 403: asking for the state is allowed, and this caller is getting it. What it is not
    // getting is the boot findings, and the honest way to say so is the same `boot: null` an app
    // that arrived second is told — there is nothing here for you.
    const wantsBoot = args.boot === true && from?.role === 'app' && !bootHandedOut
    if (wantsBoot) bootHandedOut = true
    // `version` rides along so the app's first write of this session can quote something the Host
    // really issued (ruling F56). Every later value comes from the pushes.
    return { status: 200, body: { state: store.get(), boot: wantsBoot ? loadResult : null, version } }
  }

  return {
    ready,
    runningRuns: () => runningRunCount(store.get()),
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
        // Open to anyone: reading the state is something every CLI client can already do through
        // `jobs-list` and its neighbours, so a refusal here would be a new one nobody needs. The half
        // of it that is not a read — the boot findings — is the app's alone, inside.
        if (cmd === 'state-get') return await stateGet(args, from)
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
