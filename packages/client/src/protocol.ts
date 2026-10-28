// The messages a client and the Host say to each other to connect and to run one command (Astera Host slice 1
// design §6, host control plane design §5): the part of the Host protocol @astera-app/client speaks. The app's own
// unions (src/core/host/protocol.ts) name these types, so both sides compile against one definition.

/** Bumped whenever a message changes shape. A Host and an app that disagree do not talk (design §6).
 *  2 added the pty-* messages: the Host owns the terminals now. 3 added pty-note — an older Host
 *  answers a message it does not know by logging it and carrying on, so an app that kept talking to
 *  one would have every note update silently dropped and would adopt its sessions from stale notes,
 *  which is exactly the wrong behaviour the version guard exists to make impossible.
 *
 *  **Still 3 with the proc-* family.** Those messages are additive and the app sends them only to a
 *  Host that announced the feature in its `hello` (`features: ['proc']`, HOST_FEATURE_PROC in the app's
 *  src/core/host/protocol.ts; `hostSpeaksProcs` in main/host/outdated.ts is the check). A capability, not an age: an outdated
 *  Host is exactly the one the automatic replacement must still reach, and it cannot answer a
 *  proc-list. A bump would put the new app on a new pipe name and leave the old Host's terminals
 *  invisible to it, which is the one thing the guard must never cause (chat-sessions design §6.5).
 *
 *  **4 added the Host's proof** (`hello.nonce` answered by `hello.proof`, hostKey.ts): on Windows
 *  another account can create the pipe first, and a client has no other way to tell. Unlike a feature
 *  announced in `hello.features` this cannot be additive: a client that must refuse a Host without a proof would
 *  refuse a 3 Host it has no way to tell from a squatter, so the number moves, the address moves with
 *  it, and `retireOlderHosts` sends the 3 Host away. Its terminals end with it, once, on the update that
 *  brings this in (decided 2026-09-30: supporting Windows machines several people use is worth it). */
export const HOST_PROTOCOL = 4

/** Request receipts — `orch-call.request`, the `requests-show` command, and the replay that makes a
 *  retry safe (request receipts design §8). Announced in the Host's hello `features`, like every
 *  capability added after protocol 3: the protocol number stays, because bumping it retires a Host that
 *  is running perfectly well and kills its terminals with it.
 *
 *  **Why a feature flag is not optional for this one.** A Host from before it destructures
 *  `{cmd, args, session}` and runs the command *unprotected* while the caller believes otherwise —
 *  the silent drop this whole design is built against. So the CLI splits: a **presented**
 *  `--request-id` against a Host that does not announce this is refused with exit 9 (the caller asked
 *  for protection and is not getting it), while an **auto-minted** id is dropped and the command runs
 *  exactly as it did before receipts existed. We refuse to break a promise we made, and we never
 *  refuse over one we did not. */
export const HOST_FEATURE_REQUESTS = 'requests'

/** The `orch-call`/`orch-result` pair (host control plane design §5): one RPC channel for every
 *  orchestration command instead of a message type per command. Announced in the Host's hello
 *  `features`, so the protocol number stays: a Host from before it answers an `orch-call` the way it
 *  answers any message it does not know, logged and ignored, and a client that sends one anyway waits
 *  for an answer that never comes. The CLI, the MCP link and @astera-app/client check for it first. */
export const HOST_FEATURE_ORCH = 'orch'

/** `events-poll` (SDK 1d): the Host keeps a public event log beside its state and answers reads of it. A Host from
 *  before it answers the command 501; @astera-app/client checks for this first and says what to update. */
export const HOST_FEATURE_EVENTS = 'events'

/** `app` is a version string: the app (`main/host/client.ts`) sends its version, the CLI (through
 *  connect.ts) its own, and @astera-app/client `sdk-<version>`. The first two can be the identical
 *  string, so it cannot say *what* is connecting. `role` does.
 *
 *  **Absent means `'cli'`, and that default is the careful one.** The Host sends `orch-act` only to
 *  a client that called itself the app; an older app that sends no role is therefore refused with
 *  APP_REQUIRED rather than handed an `orch-act` it has never heard of and cannot answer, which
 *  would leave the caller waiting for a reply that is never coming. Additive, so HOST_PROTOCOL
 *  stays 3 — bumping it retires a running Host and takes its terminals with it.
 *
 *  **`yields` names the duties this app hands to the Host** (host S3 ruling R4, §7.2): with
 *  HOST_YIELD_WORKTREES in it, the Host forks, merges and removes Job worktrees itself while this
 *  app is attached. Absent means none, which is what an S2 app sends: the Host then keeps sending
 *  that work to it, because such an app writes worktrees.json whole and would erase an entry the
 *  Host made behind it. An older Host ignores the field, so a new app in front of one keeps S2's
 *  behaviour. Additive, so HOST_PROTOCOL stays 3.
 *
 *  **`pid` is the app's own process id** (leftovers Task 1, S6-3). The Host keeps the last one an app
 *  gave and asks whether it lives when the profile's `app.pid` names no live app (a profile the app
 *  could not write). Absent from an older app and from the CLI, and then `app.pid` alone answers, as
 *  before. Additive, so HOST_PROTOCOL stays 3.
 *
 *  **`nonce`** (protocol 4): the Host answers it with `proof` (hostKey.ts), and the client
 *  sends nothing more until that proof checks out.
 *
 *  **`client`** is the MCP client an `mcp` socket serves, as its MCP `initialize` named itself (MCP
 *  spec §29). The Host keeps it per socket and journals it on that socket's rows, cleaned again on
 *  arrival (core/continuity/actor.ts `mcpClientOf`), and ignores it from any other role. Additive, so
 *  HOST_PROTOCOL stays 4.
 *
 *  **`remote`** is the network address of the caller an `mcp` socket serves when it came over HTTP
 *  (`astera mcp http`, MCP HTTP design §5); absent over stdio. Additive, so HOST_PROTOCOL stays 4. */
export interface ClientHelloMessage {
  t: 'hello'
  protocol: number
  app: string
  role?: 'app' | 'cli' | 'mcp'
  yields?: string[]
  /** What this client reads beyond the base protocol (`pty-seq`, remote runtime design §3.7). Unknown names are
   *  ignored, so a newer client can ask for more than an older Host offers. */
  features?: string[]
  pid?: number
  nonce?: string
  client?: { name: string; version?: string }
  remote?: string
}

/** One RPC call, routed by `cmd` (host control plane design §5). Answered only for a socket that has said hello — the
 *  Host's `greetedSockets` guard (design §9) — the same rule every other reply already follows. */
export interface OrchCallMessage {
  t: 'orch-call'
  /** The caller's own correlation id: one socket can have several `orch-call`s outstanding at once, so the reply names
   *  which one it answers. */
  call: string
  cmd: string
  /** Today's HTTP body, carried unchanged. */
  args: Record<string, unknown>
  /** Today's `x-astera-session` header, carried unchanged. */
  session?: string
  /** The caller's own id for the *request*, as opposed to `call`, which is its id for this attempt on this socket
   *  (request receipts design §8). It rides the envelope rather than `args` because it is not an argument to any command:
   *  no `case` in `handleCommand` reads it, and the Host decides from it alone whether this call is a first attempt or a
   *  retry of one it has already answered. Additive, so HOST_PROTOCOL stays 3 — a Host from before it destructures
   *  `{cmd, args, session}` and runs the command unprotected, which is why the CLI must not send a *presented* id to a
   *  Host that has not announced the feature. */
  request?: string
  /** The calling session's workload token (its `ASTERA_GATEWAY_TOKEN`). A Host that knows it reads the session from the
   *  token and ignores `session`, and refuses a token it does not hold with status 401. An older Host does not know the
   *  field and uses `session`, so the CLI sends both. */
  token?: string
}

export interface HostHelloMessage {
  t: 'hello'
  protocol: number
  host: string
  pid: number
  startedAt: string
  /** What this Host can do beyond protocol 3's original set. Optional because older Hosts do not
   *  send it — absent means none. Additive on purpose: the protocol stays 3 (see HOST_PROTOCOL's
   *  comment). */
  features?: string[]
  /** True while an app 1.3.25 or older is attached (leftovers Task 5): one whose hello carried no
   *  role. `astera host status` says so and asks for the update. Absent otherwise, and from an
   *  older Host. Additive, so HOST_PROTOCOL stays 3. */
  legacyApp?: true
  /** HMAC of the client's `nonce` under the profile's Host key (core/host/hostKey.ts). Sent only
   *  in answer to a nonce. */
  proof?: string
  /** A random value this Host made for this connection alone, sent only in answer to a hello that named `role: 'app'`
   *  (sandbox follow-ups, item 1). The socket is a CLI until it answers with `app-proof`, the HMAC of this under the
   *  profile's app key (hostKey.ts `appProof`), which the Host checks once, on this connection only. Absent from an
   *  older Host, which takes the role on its word. Additive, so HOST_PROTOCOL stays 4. */
  challenge?: string
  /** A random 128-bit value this Host process made once at start (remote runtime design §3.2, N11): a client that
   *  sees it change knows every counter it holds came from a Host that is gone. Absent from an older Host. */
  bootId?: string
}

export interface ProtocolMismatchMessage { t: 'protocol-mismatch'; protocol: number }

/** Answers one `orch-call`, carrying its `call` back so the asker can match the reply to the
 *  request that made it. `status`/`body` are today's HTTP status and body, unchanged.
 *
 *  **`replayed` says this answer came out of a receipt rather than out of a run of the command**
 *  (request receipts design §8). Present only when the `request` this call carried had already
 *  taken effect on this Host: the command was not run a second time, and the CLI puts the same
 *  word at the top level of the envelope it prints.
 *
 *  **`observed` is the other kind of answer to a repeated id, and it is deliberately not the same
 *  word** (design §7). A command that committed and then waited is replayed by *observing*: the
 *  commit is not repeated, but the command does run again and the body is what is true now — for
 *  `check --ack <id> --wait` that is a fresh poll, which can open a new delivery the caller has
 *  never seen. Calling that `replayed` would publish a sentence ("the command was not run a second
 *  time") that is false for it, and a caller that skips a body it believes it has already handled
 *  would drop that batch and its delivery id. So an older reader, which knows only `replayed`, sees
 *  no marker at all here and treats the answer as the first answer it is.
 *
 *  Both are absent rather than `false` when they do not apply, so no older Host has to learn to
 *  send them and a reader can test for them with `?.`. */
export interface OrchResultMessage { t: 'orch-result'; call: string; status: number; body: unknown; replayed?: true; observed?: true }
