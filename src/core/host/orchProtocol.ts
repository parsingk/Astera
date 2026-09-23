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
