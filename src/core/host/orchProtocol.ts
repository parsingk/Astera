// What answers `orch-call` (host control plane design §5). One message pair carries every command
// instead of a type per command — see protocol.ts's `orch-call`/`orch-result` — and this file is the
// shape of the thing behind that pair, not the thing itself: the real one is `createHostOrch` in
// src/host/orch.ts, which runs the command layer over the Host's own store.
//
// `server.ts` calls only `OrchCall.call`, which is why swapping the stub below for that did not
// change a line of its routing.
import { HOST_PROTOCOL, type HostMessage } from './protocol'

/** An action could not be put to the app: none is attached, the one that was went away, or it held
 *  the question past the deadline.
 *
 *  **A type rather than a sentence to match on.** What decides the CONFLICT status has to be the fact
 *  that the app could not be reached, never a substring of a message — most error bodies here echo
 *  ids and titles a caller supplied, so matching text turns "unknown dispatch: APP_REQUIRED-ish-id"
 *  into a conflict and a script reads exit 6 where exit 4 is the truth. */
export class AppUnreachable extends Error {}

/**
 * Tags `err`: thrown before this call closed, removed or created anything at all (Host S3 fix round 1,
 * I2). `worktrees.ts`'s up-front refusals — an app running but not attached, or a damaged
 * `worktrees.json` — tag themselves this way before any folder is touched.
 *
 * **Why the tag lives on the error and not in `orchDeps.ts`.** Whether a given `AppUnreachable` or
 * `RepairNeeded` means "nothing happened yet" or "some of it already did" depends on where in the
 * local call it was thrown, which only the thing that threw it knows; guessing from the error's class
 * or message at the command layer would be right by accident. A caller may keep no receipt over a
 * tagged refusal — a retry once the reason clears (the app quits, the file is repaired) still has
 * everything left to do, unlike a refusal that comes after some of the work already happened, which
 * keeps its receipt like any other failure that acted.
 *
 * Returns a tagged copy and leaves `err` as it was (`taggedCopy`, below).
 */
export function refusedBeforeActing<E extends Error>(err: E): E {
  return taggedCopy(err, { beforeActing: true })
}

/**
 * **A copy for this call, never the caught object itself** (Host S3 follow-up round, m1). An error
 * can be shared: a `once()` setup promise in the Host spawner hands every start waiting on it the
 * same rejection. A tag written onto that object would be read by every other start that caught it,
 * so a start whose fork is still on disk could read as having left nothing. The copy keeps the class
 * (`instanceof` still decides CONFLICT for `RepairNeeded`, `HostRetiring`, `AppUnreachable`), the
 * message, the stack, the cause and every field of its own, such as `RepairNeeded.file`, plus any tag
 * the original already carried.
 */
function taggedCopy<E extends Error>(err: E, tag: { beforeActing?: true; undone?: true }): E {
  const copy = Object.create(Object.getPrototypeOf(err)) as E
  for (const key of Reflect.ownKeys(err)) {
    const d = Object.getOwnPropertyDescriptor(err, key)
    if (d) Object.defineProperty(copy, key, d)
  }
  // V8 keeps `stack` behind an accessor bound to the original, which answers nothing on the copy.
  Object.defineProperty(copy, 'stack', { value: err.stack, writable: true, configurable: true, enumerable: false })
  return Object.assign(copy, tag)
}

/** Whether `err` carries that tag. */
export function wasRefusedBeforeActing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { beforeActing?: unknown }).beforeActing === true
}

/**
 * Tags `err`: this call did act, and then undid what it did before it threw, so nothing it made is
 * left (Host S3 follow-up A36). The Host's `startWorker` is the one user: a `--worktree new` fork
 * whose spawn then failed is removed again, and no process was started.
 *
 * **A different tag from `refusedBeforeActing`, because the claim is different.** That one says the
 * call never got as far as touching anything, and a caller that marks an effect only after the call
 * (`MARKS_AFTER_ACTING`) relies on exactly that. This one says the call touched something and put it
 * back, so it is only good for withdrawing a mark already made, which is what `orchDeps.ts` does with
 * it. `leftNothingBehind` below reads either.
 */
export function undoneBeforeFailing<E extends Error>(err: E): E {
  return taggedCopy(err, { undone: true })
}

/** Whether `err` says the call leaves nothing behind: it was refused before acting, or it undid itself. */
export function leftNothingBehind(err: unknown): boolean {
  return (
    wasRefusedBeforeActing(err) ||
    (typeof err === 'object' && err !== null && (err as { undone?: unknown }).undone === true)
  )
}

/** The client behind one `orch-call`. Supplied by `server.ts`, which is the only place that knows
 *  which socket asked — the command table cannot work it out from `{cmd, args}`. */
export interface OrchCaller {
  /** What this client called itself in its `hello`. Absent there means `'cli'` (protocol.ts's
   *  `hello` says why the careful default is that one and not the other). */
  role: 'app' | 'cli'
  /** Pushes a message to every greeted socket **except this one**. What `state-put` answers with: the
   *  state came from this client, so sending it back would be an echo — and the app that pushed it
   *  would then write its own state back over itself. */
  toOthers(m: HostMessage): void
}

/** What `orch-call` is answered by. `{cmd, args}` is today's HTTP body and `sessionId` is today's
 *  `x-astera-session` header (design §5) — the real command layer implements this exact shape, so
 *  `server.ts`'s wiring does not change when the stub below is swapped for it. */
export interface OrchCall {
  call(a: {
    cmd: string
    args: Record<string, unknown>
    sessionId: string
    /** Absent for a caller that has no socket behind it (tests, and the stub below). A command that
     *  needs to know who is asking refuses when it is missing rather than assuming the app. */
    from?: OrchCaller
    /** The caller's own id for this *request* (request receipts design §5). Absent means the caller
     *  did not ask for a receipt, and then nothing about this call changes: no lookup, no record,
     *  and the same reply in the same order as before the mechanism existed (§9). */
    request?: string
  }): Promise<{
    status: number
    body: unknown
    /** This answer came out of a receipt: the `request` had already taken effect here and the
     *  command was not run a second time (request receipts design §8). `server.ts` puts it on
     *  `orch-result` and the CLI puts it at the top of the envelope it prints, so a caller can tell
     *  a replay from a first answer without the exit code or the body changing. */
    replayed?: true
    /** The `request` had already taken effect and the command **was** run again, because what the
     *  receipt held was a stopwatch reading rather than a fact about the world (design §7). The
     *  commit is not repeated; the body is what is true now. Its own word rather than `replayed`,
     *  for the reason `orch-result` gives in protocol.ts. */
    observed?: true
  }>
}

/** One command, `version`, answering the Host's own version and protocol — and nothing else.
 *
 *  **Kept now that `createHostOrch` exists, as what the wire's own tests talk to.** They are about
 *  correlation, greeting and framing, and giving them a real command layer would put a store and a
 *  temp profile behind every one of them.
 *
 *  **Everything else answers 501, not 404.** That is the split the real command layer already uses
 *  (`src/core/orchestration/command.ts`'s `bad`/`notFound`/501-default, mapped by
 *  `cliOutput.ts`'s `codeForStatus` to `VERSION_MISMATCH`): 404 means an id that does not exist, 501
 *  means this Host does not know the command at all — which is what a CLI newer than the Host looks
 *  like, not a typo to report the same way as a missing id. */
export function versionOnlyOrchCall(deps: { version: string }): OrchCall {
  const table: Record<string, () => { status: number; body: unknown }> = {
    version: () => ({ status: 200, body: { version: deps.version, protocol: HOST_PROTOCOL } })
  }
  return {
    call: async ({ cmd }) => {
      const entry = table[cmd]
      return entry ? entry() : { status: 501, body: { error: `unknown command: ${cmd}` } }
    }
  }
}
