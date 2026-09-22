// The Host's answer to `orch-call` (host control plane design §5). One message pair carries every
// command instead of a type per command — see protocol.ts's `orch-call`/`orch-result` — and this
// file is the table behind that pair.
//
// This slice's table has exactly one entry, `version`, to prove the wire end to end before any
// orchestration state moves into the Host (design §11, step 3). A later task replaces
// `versionOnlyOrchCall` with the real command layer; `server.ts` calls only `OrchCall.call` and does
// not change when that happens.
import { HOST_PROTOCOL, type HostMessage } from './protocol'

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
  }): Promise<{ status: number; body: unknown }>
}

/** This slice's stub: one command, `version`, answering the Host's own version and protocol.
 *
 *  **Everything else answers 501, not 404.** That is the split the real command layer already uses
 *  (`src/main/orchestration/server.ts`'s `bad`/`notFound`/501-default, mapped by
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
