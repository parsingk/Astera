# Request receipts: telling a retry from a repeat

Written 2026-09-23 against `develop` at `1a3f093`, after the Host became the control plane
(`docs/2026-09-22-host-control-plane-design.md`) and the public CLI shipped
(`docs/2026-09-22-public-cli-design.md`). It designs one thing: a caller that did not get an answer
should be able to find out whether its command landed, instead of guessing.

A peer product, Orca, solved this, and this design deliberately takes its shape: an idempotency key
on the way in, a lookup command on the way out, three answers, and a careful third. Section 2 records
what Orca actually does, read from its source rather than its documentation. Every place this design
departs from it is argued.

## 1. The hole, and exactly where it is

`src/cli/run.ts`'s `callHost` ends three ways and two of them are silence:

```ts
if ('stuck' in r) { … process.exit(exitCodeFor(SILENT_HOST_CODE)) }   // 7
if ('unreachable' in r) return withoutHost(r.unreachable)             // 3, for a mutation
```

`unreachable` is the socket closing before `orch-result` arrives; `stuck` is the client's own
deadline passing. Neither says anything about whether the Host committed, and the Host commits before
it answers. `handleCommand` does `await deps.setState(...)` and then returns a `Reply` that still has
to cross the pipe, so the whole window between `fs.rename` landing in `OrchestrationStore.writeNow`
and the `orch-result` line being written is a window in which the command happened and the caller was
told nothing.

The code already knows this. `run.ts` says so where it decides *not* to queue a report on a timeout,
"보고는 이미 적용됐을 수 있으므로 적어 두지 않는다" (the report may already have been applied), and
`src/main/ipc.ts` says it again at `failPendingOrchCalls`: "the Host may well have done the work, but
nothing is coming back on a socket that is gone". The app has a repair for its half, the re-mirror on
the next handshake. The CLI has none, because the CLI process exits.

**Why this matters more here than in most CLIs.** The caller is usually an agent in a loop, working
from `resources/skills/orchestration-guide.md`, which tells it what to do with each exit code and
cannot tell it what to do with these two. And since the Host outlives the app, `astera` now runs with
nobody watching, where a double `worker-start` is two agents in one worktree: the exact fault
`worker-release` and `worker-stop` have comments written to prevent, arriving by a different road.

**One class of command already has an answer, and it is the model for this one.** A worker's
`worker_done` that cannot be delivered is written to the pending-reports queue and applied later, and
`src/core/orchestration/pendingReports.ts` states the doctrine that makes an at-least-once channel
safe: "Nothing that could act twice belongs here." Only two message types may be queued, because
`applyWorkerDone` answers the idempotent `alreadyReported` and an `escalation` only appends a line.
Receipts are that doctrine extended to the commands that *can* act twice.

## 2. What Orca actually does

Read from the clone at HEAD `9ece2730`, v1.4.197. They call it the **durable mutation ledger**. The
survey found one thing worth saying first: **the public CLI documentation does not mention this
feature at all.** `docs/site/content/docs/cli/*.mdx` has no occurrence of `retry-request`,
`request-show`, `idempot` or `receipt`. It is documented only in the agent-facing skill guides and in
each command's `--help` notes. Where their prose and their code disagreed, the code won below.

**Storage is SQLite and it survives a restart.** One table, `mutation_receipts`, with
`PRIMARY KEY (caller_fingerprint, request_id)` and columns `method`, `payload_hash`,
`state CHECK(state IN ('pending','completed'))`, `receipt TEXT`, plus timestamps. Two phases: a claim
(`BEGIN IMMEDIATE`, insert `pending`) before the handler, an `UPDATE … SET state='completed',
receipt=?` after it. For the case that matters most, `worker-start`, the receipt row is written
**inside the same transaction that creates the Dispatch**, so the claim and the effect are one atomic
step. That is the sharpest thing in their design, and §4 explains why we cannot copy it.

**Retention is 30 days or 10,000 rows, and only `completed` rows are ever evicted.** The prune runs
on insert, never on a timer and never at startup. A `pending` row is never aged out, so a table full
of unresolved claims makes the next mutation fail outright:

```
  74	    throw new OrchestrationError(
  75	      'mutation_ledger_full',
  76	      'The durable mutation ledger is full of unresolved operations. Resolve or inspect them before starting another mutation.'
```

**Caller identity has two derivations, and the local one is not what the name suggests.** A paired or
remote client is fingerprinted by `sha256` of its server-validated bearer token, never by anything
the request claims. A local CLI caller gets
`getOrCreateLocalMutationCallerFingerprint()`: a single 32-byte random secret minted once per
`orchestration.db` and shared by **every local caller on that machine**. So locally there is one
namespace, and one agent can replay another local agent's request id.

**A retry arriving mid-flight joins and waits.** An in-memory `Map` of in-flight promises sits over
the durable ledger. If the row says `pending` and the promise is in this process, the second caller
does `return attachMutationReceipt(await active.promise, requestId, true)`: it blocks for as long as
the first takes, then gets the identical payload with `replayed: true`. If the row says `pending` and
there is no promise, that is a crash remnant from a previous process, and it is **fenced** with a
distinct error code:

```
 201	            ? `Worker start ${requestId} was accepted as Dispatch ${recovery.dispatchId} before restart. Inspect that Dispatch; do not start another worker.`
```

carrying `data.recoveryCommand` with the exact `worker-show` line to run. Two methods are exempt and
resume instead: `workerRelease`, declared idempotent, and a `worker_done` whose receipt equals an
"effect-free checkpoint" sentinel.

**The recorded response is the whole payload, and a replay returns it byte for byte** with one field
flipped: `mutation: { requestId, replayed: true }`. The guard is a `payload_hash`, a sha256 over a
canonicalized `{ method, params }` with keys sorted, `undefined` dropped, and **volatile arguments
normalized away**: `waitSubmitMs` is deleted and terminal handles are rewritten to a stable key, so a
re-minted handle still replays. A mismatch is `request_mismatch`, an error, not a silent wrong answer.

**A failed mutation deletes its pending row**, so it reads back as `absent` rather than as a failed
receipt. Two exceptions keep it: a terminal prompt that already passed the write boundary, and an
error already coded `operation_unknown`. Validation errors never create a row at all, because Zod
parsing runs in the dispatcher before the executor is reached.

**Which commands take it is a named set, twice over**: `ORCHESTRATION_MUTATION_METHODS` on the RPC
contract and `allowedFlags` on 18 CLI command specs. And the named set has already leaked. Both
`orchestration dispatch` and `orchestration check` list `retry-request` in `allowedFlags`, but
`isOrchestrationMutation` returns false for `dispatch --dry-run` and for `check --peek`, and in that
case `client.ts` sets `orchestrationRequestId = undefined`, so **the user-supplied id is dropped with
no error and no warning.** No documentation mentions it. §3 is built on that finding.

**The CLI mints a key whether or not you pass one.** `randomUUID()` on every durable mutation;
`--retry-request` only *reuses* an id. That is what lets the ambiguous-failure path rewrite its own
error to carry the id and the two commands to run next, which is the best idea in their design.

**The three answers are produced from the row's `state` column, with `absent` meaning "no row", and
all three exit 0.** The honest reading ships *with* the row rather than being re-derived by each
caller, which is a deliberate choice they wrote down:

```
  15	  // Why: `absent` is genuinely ambiguous, so the honest reading ships with the row
  16	  // instead of being re-derived (and softened) by every caller.
```

and the sentence itself:

```
  32	  return `No receipt for request ${requestId} under this caller identity. It never reached this Orca runtime, failed before recording anything, or its receipt was pruned. Absent is not proof that nothing happened.`
```

**Where their docs and their code disagree**, three that matter here. The skill guide says a `pending`
row means "replay it with `--retry-request`", but for most methods a `pending` row with no in-process
promise is refused with `operation_unknown` rather than replayed; following the guidance literally
produces an error. The guide's three causes of `absent` omit a fourth, a receipt recorded under a
different caller identity, which the runtime's own generated sentence does cover. And the key format
is validated as a UUID on the client only, while the runtime enforces nothing and Orca's own
federation code writes non-UUID ids such as `relay_ack_<dispatchId>_<cursor>`.

## 3. Which commands take a key, and why the answer is "all of them"

Orca names the set. We should not, and the reason is sitting in their own source: `check --peek`
accepts `--retry-request` and silently drops it. That is the one failure mode a design like this
cannot afford, because the caller's whole reason for passing the flag is a belief about what happens
next.

**Naming the set means keeping a list of commands, and this codebase has measured what that costs.**
`src/core/orchestration/cliUsage.ts` opens with it: "The table is hand-kept, and it cannot be derived.
The flags a command takes are declared nowhere." There is no read/write classification of the forty
`case` labels in `handleCommand`, and putting one beside a switch statement gives the same silent
failure Orca has: a mutation added later and not added to the list accepts the key and ignores it.
`FROM_FILE` and `cliPublic.ts` are allowlists precisely because their silent failure runs the other
way, toward refusing rather than toward pretending.

**So every command accepts the key, and the Host decides after the fact whether there was anything to
record.** The rule, in one sentence: *a receipt is recorded when the command committed, or called a
dependency that changes something outside the state.*

**This rule is also what makes auto-minting (§8) affordable.** Every command arrives with an id, and
the ones that changed nothing — every read, and every command rejected before it acted — leave no
receipt behind. What is stored is proportional to what was done, not to how much was asked.

Both halves are already observable at one place. `src/host/orch.ts` builds its dependencies per call
and already threads a flag through them for exactly this kind of after-the-fact decision:

```ts
const refused = { app: false }
const depsFor = (refused: { app: boolean }): OrchServerDeps => hostOrchDeps({ … })
```

`setState` is one of the seven `OWNED` members, so the commit half is a line in a wrapper that
already exists. The other half is `hostOrchDeps`'s single funnel: every app-side action goes through
`a.act(name, args)`, and that file already classifies every dependency by name into `OWNED`,
`PROPAGATES`, `NESTED`, `DEGRADES`, `SWALLOWED` and `FIRE_AND_FORGET`, with a compiler check that
stops the build when one is unclassified:

```ts
type _everyDependencyIsClassified = NothingLeft<Unlisted<OrchServerDeps, Classified>>
```

A `Record<Classified, boolean>` saying which of those names *changes something* rides that same
check: add a dependency and the build stops until both its group and its effectfulness are declared.
That is the `USAGE: Record<PublicCommand, CommandUsage>` trick this repo already plays twice, applied
to a question that would otherwise be answered by a list nobody maintains.

**What that rule gets right that a command list would get wrong.** Four commands act without
committing anything. `run-merge` runs a git merge and returns `okBody({merged, uncommitted})` with no
`setState` anywhere in its path. `worker-release` kills a session. `handoff` writes a memo.
`browser-js` runs a script in a real browser. A list assembled by reading command names would have
missed at least the first two. And the rule excludes what should be excluded, for free: a pure read
records nothing, and so does a command rejected before it acted, because `bad('--task is required')`
is deterministic and repeating it is correct rather than dangerous.

**What makes a command need a key is not "does it write".** It is: *would a second identical call
leave something a single call could not have left?* Three families qualify here.

1. **It mints an id.** `newId()` is `Math.random()` four times over, so `run-create`, `task-create`,
   `run-start`, `run-spawn`, `gate-create`, `ask` without `--resume`, `send` and `reply` each produce
   a second, different object on a second call.
2. **It starts or ends a process.** `worker-start` spawns a session; `worker-stop`, `worker-abandon`
   and `worker-release` end one.
3. **It touches the disk outside the state.** `run-merge`, and `run-delete --remove-worktrees`.

**And the commands that are already idempotent still take a key, because idempotent-in-state is not
idempotent-in-answer.** `run-delete` twice is 200 and then 404: the state is right, and a retrying
agent reads exit 4 as "that run never existed" and reports a lie. `send --type worker_done` twice is
`accepted` and then `alreadyReported`: the state is right, and the two bodies are different values a
script branches on. A receipt makes the second call return what the first returned, which is what the
caller was actually asking for when it retried.

## 4. Where the receipt lives

Orca chose SQLite. We choose memory, and the argument is not cost. It is that the property their
storage buys is one ours cannot buy at any price.

**Atomicity is the whole value of durability here, and we cannot have it.** Orca's `worker-start`
writes its receipt row inside the same `BEGIN IMMEDIATE` transaction that inserts the Dispatch, so
"the effect happened" and "the receipt exists" are one fact. Our effect is
`OrchestrationStore.save`, a `JSON.stringify` of the whole state into a temp file and a rename, and
the receipt's recorded response is not known until `handleCommand` returns. Worse, `worker-start`
commits up to three times: `openDispatch`, then either a rollback or a patch of
`sessionId`/`cwd`/`specPath`. There is no single commit to be atomic with.

So a durable receipt here would be written *after* the effect, in a commit of its own. That costs a
second whole-file write per keyed call and a second `version` bump the app has to absorb
(`reserveVersion`, ruling F56), and it does not close the crash window, it moves it. It would be a
promise of durability that is not kept, which is worse than no promise.

**A sidecar file has the same non-atomicity plus a store to own.** `<profileDir>/orch/` already holds
`continuity.sqlite` and the pending reports, so there is a place to put one. What it would need is
its own corruption policy, its own migration, and its own pruning, invented from scratch for a record
whose loss is survivable. The state file's whole-file `.bak` recovery exists because its entries
reference each other; nothing about that reasoning transfers.

**So: in memory, in `createHostOrch`**, beside `version`, `bootHandedOut` and `loadResult`. It costs a
Host restart. Every receipt is gone, and every retry after one is answered `absent`.

**Why that is acceptable, and what makes it honest rather than a shrug.** A socket drops for three
reasons. The caller's own process was killed, and the Host is fine and the receipt is there. The pipe
broke with both ends alive, same. Or the Host died: `host stop`, a retire on version skew, a crash,
the machine going off. Only the third loses receipts, and only there would an unqualified `absent` be
dangerous.

So it is not unqualified. `hello` already carries `startedAt` (`src/core/host/protocol.ts`), the CLI
already holds it in `conn.hello`, and `requests show` answers with it. The rule the guide can then
state is exact: *if this Host started after you sent your request, this Host never saw it, and the one
that did is gone.* That converts a silence into a fact, which is more than a non-atomic durable
receipt would have given.

**Memory also removes a whole state Orca had to invent machinery for.** Their durability creates a
fourth condition, a `pending` row belonging to a process that no longer exists, which they fence with
a distinct `operation_unknown` error code, a bespoke recovery message per method, and two hand-listed
exemptions that resume instead. We have ten exit codes and are not adding an eleventh. In memory that
condition cannot arise: a claim and the process that holds it die together, and what the caller sees
is `absent`, which the discipline of §6 already covers. This is the clearest case in the design where
the simpler storage is also the simpler contract.

**Two more things fall out for free.** Receipts are not part of the state, so `reset` cannot wipe
them; Orca had to write that rule down explicitly ("retain mutation receipts so a lost reset response
cannot replay as a new mutation"). And the response body is bounded by a retention policy rather than
by a file that is rewritten in full on every commit, which matters because `worker-read` returns a
tail of worker output and `inbox` returns up to fifty messages.

**Retention.** Claims live as long as the call, which for `runs wait` is an hour. Completed receipts
are capped per caller by count and overall by age, swept lazily on write. Proposed: 200 per caller,
one hour, and a ceiling across all callers so a Host that is up for a fortnight cannot grow without
bound. **These three numbers are calibration, not design**; §12 says what would set them.

Auto-minting (§8) is what puts real pressure on them, and it lands unevenly: every caller with no
`ASTERA_SESSION` shares the `''` bucket (§5), so a shell loop and a CI job fill one caller's 200
between them while a worker session barely touches its own. A per-caller cap that is fair to sessions
is not automatically fair to `''`, which is the first thing to look at when the numbers are set.

**One thing about Orca's retention that we should not copy under any circumstances**:
`mutation_ledger_full`, which refuses to start a new mutation when the table is full of unresolved
claims. Bookkeeping that refuses real work is a worse failure than the one it guards against. Our
claims are in memory and are released when the call ends, so the condition cannot occur; if a future
durable version brings it back, the answer is to evict claims, never to refuse commands.

## 5. Who a caller is

Orca scopes by caller, and the survey found that locally their scope is a single per-database secret
shared by every CLI invocation on the machine. That is a defensible choice for them and the wrong one
for us.

Three candidates here:

- **The pipe connection.** Useless. The CLI connects, sends one command and exits, so a retry is a
  new process on a new socket and a connection-scoped receipt is never found by the caller that wants
  it.
- **The `role: 'app' | 'cli'` a client announces at `hello`.** Too coarse to be a scope: every CLI
  caller shares one bucket, and the app never reaches `handleCommand` anyway, its whole outbound
  vocabulary being `state-get` and `state-put`, as `commitHook.ts` spells out.
- **The session id**, `caller.sessionId`, which is `ASTERA_SESSION` for anything the app spawned and
  `''` for a person or a script at a shell. This is the scope.

**Why scope at all, and why Orca's machine-wide local bucket is not good enough here.** Replaying a
receipt hands back a recorded response, and a response can contain another worker's private
conversation. That is exactly why `inbox` is in `COORDINATOR_ONLY`: "a single `inbox --limit 200` lets
a worker read another worker's question, the body of the coordinator's reply … and the spec and
results of other Tasks". A machine-wide receipt store is a second door into that room, opened by
guessing a request id. Orca's local callers are one person at one machine; ours include worker agents
that the product deliberately walls off from each other.

**What happens when two agents share one identity.** They do, in two ways. Every caller with no
`ASTERA_SESSION` shares the `''` bucket: a person at a shell, a CI job, a worker whose environment was
never planted. And a sub-agent running inside a session inherits that session's `ASTERA_SESSION`.
Scoping does nothing for either.

So scoping is not what makes a collision safe. **The argument fingerprint is**, and this part is
copied from Orca more or less whole. A receipt records a sha256 over the command name and a
canonicalized copy of its arguments, and a retry whose fingerprint does not match is refused with 400,
exit 2, naming the command the id was first used for. Two scripts that both pick `req-1` for different
`run-create` calls get an error rather than each other's answer.

Auto-minting (§8) narrows what the fingerprint has to defend without removing the need for it. A
minted id is `randomUUID()` and never collides with another, so the ordinary path cannot produce a
mismatch at all. What is left for the fingerprint is exactly the ids a caller chose deliberately, and
those are the ones that collide: a hand-written `req-1`, or a CI step that derives its id from a build
number and reuses it across two commands.

Canonicalization sorts object keys and drops `undefined`, as theirs does, and excludes two arguments,
each for a stated reason. `requestId` itself, because it is the key. And `timeoutMs`, because it
changes how long we are willing to wait and not what we do: Orca deletes `waitSubmitMs` from its hash
for the same reason.

The guide's advice on picking a key follows this repo's own convention, which already exists one layer
down for the same problem. `src/main/chat/adapterCore.ts` gives client request ids "a per-instance
random prefix (`a<8 hex>-<n>`)" so a reply meant for a previous process can never match. A caller
should do the same: random per process, counter per call. **We do not require a UUID.** Orca's client
does and its own server does not, and its own federation code writes ids that would fail its client's
check, which is a rule that exists in one place and is violated in another.

**Validation**: non-empty, at most 200 characters, no control characters, since the map key is
`${sessionId}\u0000${requestId}` and a NUL in the id would forge a scope. Anything else is 400, exit 2.

## 6. The three answers, and the discipline of the third

`astera requests show --id <requestId>` answers with one of three states and **exits 0 for all
three**, as Orca's does. The answer is data, not a failure, and this is the shape `check --wait` and
`ask` already have, where the guide says "A timeout response … is a success, so the exit code is `0`
… do not treat a timeout as an error based on `$?`; read `data.timedOut`."

Notably it is *not* exit 4. `NOT_FOUND` means "it is there and does not know that id", and the guide
says "Do not retry a `4`", which is the precise opposite of what a caller should conclude from
`absent`.

**Copied from Orca: the honest reading ships with the answer.** Their comment is the argument, that
`absent` is genuinely ambiguous "so the honest reading ships with the row instead of being re-derived
(and softened) by every caller". So the reply carries an `interpretation` sentence, and the guide and
the runtime cannot drift, because the guide quotes the runtime.

The words, as they would go in both:

> **`completed`** means the Host ran this request and this is what it answered. `data.response` is the
> reply your command would have printed. Treat it exactly as if you had received it the first time:
> the run id in it is a run that exists, the dispatch id is a dispatch that is open. Do not send the
> command again.
>
> **`pending`** means a Host is running this request right now. Nothing is lost and nothing is
> decided. Wait and ask again. Do not send the command again; if you do, it is refused with `6` and
> the same message.
>
> **`absent`** means this Host holds no receipt for this id under your caller identity. **That is not
> proof that nothing happened.** There are four ways to see it and only one of them means "nothing
> happened".
>
> 1. The request never reached a Host. Retrying is correct.
> 2. It reached a Host that has since restarted. Compare `data.hostStartedAt` with when you sent it:
>    if the Host started later, the Host that took your request is gone and took its receipts with it.
> 3. You are asking under a different identity than the one that sent it, a different
>    `ASTERA_SESSION`, or none.
> 4. The command changed nothing, so there was nothing to record: a read, or a command rejected before
>    it acted. Retrying is correct and gets the same answer.
>
> **Before retrying on an `absent`, look at the state, not at the receipt.** The state is the only
> record that survives everything: does the run exist (`astera runs list --job <j>`), is the dispatch
> open (`dispatch-show --task <t>`), is the question already answered (`questions get --id <q>`). The
> receipt exists to save you that lookup when it can. When it cannot, it says so rather than guessing
> on your behalf.

Cause 3 is the one Orca's prose omits and its runtime sentence covers; we write it in both. Cause 4 is
ours alone, a direct consequence of §3's "the Host decides after the fact". It is worth the extra
line, because without it a caller that keys a read sees `absent` and concludes something about a Host
that is behaving perfectly.

## 7. A retry that arrives mid-flight

Orca joins: the second caller awaits the first's promise and receives the identical payload with
`replayed: true`. **We refuse, with 409 and exit 6**, and this is the largest deliberate departure in
the design.

The reason is that three of our commands are long polls. `ask` holds for ten minutes, `check --wait`
for five, `runs wait` for an hour, all riding the socket by design (host control plane design §5).
A retry that joins holds a caller for up to an hour on a call it already believes has failed, which is
worse than the failure it was trying to recover from. Orca pays a smaller version of this bill and it
shows in their own code: their long-poll admission caps run *before* the dedupe check, "so a joined
replay of an `ask` still consumes a long-poll slot". Two callers, one slot, one of them waiting on a
result it did not ask to wait for.

Reusing `CONFLICT` rather than asking for an eleventh exit code is the same decision the Host control
plane design already made twice: "§26's ten are a closed set, and inventing an eleventh for a state
that disappears at S4 is worse than reusing the one that already means 'the current state makes this
impossible'". A request already in flight is exactly that.

**The claim has to be taken in the same synchronous step as the check that precedes it.** Check the
map, and if it is free insert the claim, before the first `await` in the Host's `call` handler. This
is `reserveVersion`'s discipline, stated in `src/host/orch.ts` for the same class of bug: "Called at
accept time, in the same synchronous step as the check that precedes it, never after the write has
landed." A claim taken after an `await` lets two `orch-call`s both find the key free.

**The claim is discarded, not completed, when the command turns out not to have acted.** Otherwise a
keyed read would leave a claim that never completes and `requests show` would answer `pending` forever
about a command that finished. This matches Orca, which deletes the pending row on failure so a failed
mutation reads back as `absent`.

### Commit, then wait: the replay that must be observed rather than returned

The first draft asked only whether `ask` should take a key at all, on the grounds that
`ask --resume <questionId>` already does the job and two overlapping mechanisms is how a guide gets
ignored. Reading both settled it the other way, and then a review found a second command of the same
shape and a worse one. So the rule is stated first and the members follow from it, rather than the
other way round — a set named by listing its members is a set that falls behind, which is §3's
argument applied to this design's own machinery.

**The rule.** *A receipt is replayed verbatim unless the command committed and then waited. When it
did, its replay is **observed**: the Host answers with what is true now, never with what was true at
the moment some earlier call gave up waiting.*

The reason is one sentence. A recorded `timedOut: true` is not a fact about the world; it is a fact
about how long one call waited. Handing it back to a caller that is retrying *because it wants to
keep waiting* gives it neither half of what it asked for: the commit it must not repeat is correctly
not repeated, and the wait it actually wanted is answered instantly out of somebody else's
stopwatch. Do that and the caller is in a loop that cannot end, which is worse than the lost answer
it was recovering from.

This is Orca's `shouldObserveCompletedMutation`, the one piece of their replay machinery the first
draft had not planned to copy, and their reason transfers exactly — a stored observation "only
describes the incarnation the prompt was written to".

**The two members, and why each is in.**

- **`ask` without `--resume`.** It commits `createQuestion` and then long-polls for up to ten
  minutes. Only the commit is a duplicate hazard, and it is a bad one: a retried `ask` creates a
  *second* question, a person sees the same thing asked twice, answers one, and the worker goes on
  waiting on the other. So `ask` needs the key more than most commands do, not less — and its
  recorded body, `{answered: false, timedOut: true, questionId}`, is exactly the observation that
  must not come back.
- **`check --ack <id> --wait`.** The `--ack` branch commits `ackDelivery` **before** the poll
  (`command.ts`'s `check` case), and a poll that reaches its deadline answers
  `{count: 0, messages: [], timedOut: true}`. So `setState` ran, the receipt is recorded, and what it
  records is a stale timeout. **This is the worse of the two**, because the orchestration guide
  already tells an agent that a `check --wait` timeout is a checkpoint and to call again: every later
  presentation of that id returns the same instant `{count: 0}` while real messages pile up behind an
  ack that has already landed. And §8's own error message is what hands the caller that id, precisely
  because no answer arrived. `check`'s usage line advertises the very combination.

**The boundary, which is what makes the rule checkable.** `check --wait` *without* `--ack` commits
nothing and calls nothing effectful, so it leaves no receipt at all: the claim is discarded and the
retry polls afresh, which is already right. `runs wait` and `jobs wait` are pure reads and are the
same. It is the *combination* of a commit and a wait inside one command that puts a command in this
set, and nothing else does.

**So a command joins this set by its shape, not by being added to a list.** A command that commits
and grows a wait is in; a command that waits and grows a commit is in. The line is held by a test
phrased over the shape rather than over the names (step 6): for every command that both commits and
polls, a receipt holding `timedOut: true` must not be handed back as such.

**The rule says what the replay must answer; how it is observed is each command's own.** `ask`
re-reads the question the receipt names, because re-running it would create a second question.
`check --ack` re-runs, because `ackDelivery` on an already-acked delivery returns the state unchanged
(`state.ts`) — so the ack is a no-op the second time and the poll, which is the whole of what the
caller wants, runs fresh. No new field and no new shape either way: the caller gets what that command
has always returned.

**What this buys over pointing at `--resume`, in `ask`'s case, is that the caller has lost the id it
would need.** A worker whose `ask` ended `unreachable` does not know the `questionId`; it knows its
request id, because §8's error message just told it. Retrying with that id creates no second question
and reports whether the answer has since arrived. So the two instruments end up with two jobs and no
overlap: **`--resume` is for a timeout you expected and are continuing; the key is for an answer you
lost.** The guide says exactly that sentence.

**This has to be built before auto-minting or the replay marker ships**, and §13 orders the steps
that way rather than leaving it to whoever picks the next one up. Without it, the first id anybody
ever presents to a `check --ack --wait` is the id that locks that caller into an instant stale
answer — and auto-minting is the step that puts an id on every call.

## 8. The CLI surface

**The flag is `--request-id <id>`, not Orca's `--retry-request <id>`.** Two reasons, both ours.

`worker-start` already takes `--retry-of <dispatchId>`, and the guide spends four paragraphs on it
("`--retry-of <dsp>` does not inherit placement"). A line reading `worker-start --task t --retry-of
dsp_9 --retry-request req_3` puts two unrelated retries one word apart in the same command, for an
audience that reads the guide end to end and then writes the command from memory.

And the name describes only half of what the flag does. Since the CLI mints an id for every command
(below), the flag is never needed to *create* one; it is used either to present an id an earlier
error handed back, which is the retry case Orca's name covers, or to choose one up front so that a CI
step is idempotent by construction, which it does not. `--request-id` names both uses, and it is the
name that will still be right if the auto-minting decision is ever revisited.

```text
astera requests show --id <requestId>
```

`requests` becomes a noun in `NOUNS` (`src/core/orchestration/cliArgs.ts`) with one verb. That is what
puts it on the public noun-and-verb surface and, more usefully, what makes the compiler demand a
`USAGE` entry in `cliUsage.ts` and the doc guard demand a line in `docs/cli.md`'s
`## Command reference`. Orca's `orchestration request-show --request <id>` does not fit a surface
where every command is a noun and a verb.

**A note on work in flight.** At the time of writing, `develop`'s working tree carries an unlanded
`astera agent-context`, which prints the whole command surface as JSON from a hand-kept table of all
58 commands and their flags (`src/core/orchestration/cliAgentContext.ts`). It does not classify
commands as reads or mutations, so §3's argument is unchanged; but it is a third hand-kept table that
a per-command flag would have to be written into 58 times. `--request-id` belongs in its
`globalFlags`, which is the same statement §3 makes: every command takes it.

**The envelope.** `requests show` is `ok: true` with the state in `data`:

```json
{ "ok": true, "data": { "id": "a3f19c02-7", "state": "completed", "cmd": "run-create",
  "at": "2026-09-23T04:11:08.221Z", "hostStartedAt": "2026-09-23T03:02:44.010Z",
  "interpretation": "Request a3f19c02-7 already took effect (run-create). …",
  "response": { "ok": true, "data": { "id": "run_1a2b3c4d" } } } }
```

`response` is present only for `completed`, and it is the envelope the original command would have
printed, including the error envelope when what the Host recorded was a failure.

**A replayed command carries a marker.** When `--request-id` matches a completed receipt, the CLI
prints the recorded envelope with one field added at the top level:

```json
{ "ok": true, "replayed": true, "data": { "id": "run_1a2b3c4d" } }
```

Top level rather than inside `data`, because `data`'s shape is the command's own published contract
and adding a field to it would change what `run-create` returns. Additive, so `CLI_PROTOCOL` stays 1:
its own comment says a bump is for "읽는 쪽이 고쳐야 하는 변화", a change readers must react to, and
"칸을 더하는 것은 올리지 않는다". Orca puts the same fact in a `mutation: {requestId, replayed}` object
merged into the result, which is the same idea inside the payload rather than beside it; ours stays
outside because our `data` is already normalized per command by `dataFor`.

**And the exit code is the original's**, not 0. A replayed 404 exits 4, because the point of a replay
is that it is indistinguishable from having received the first answer.

**The ten codes, unchanged.** `completed` replays whatever the original was. `pending` is 6. A
malformed id, or one reused for a different command, is 2. `requests show` itself is 0 for all three
states, 3 with no Host, and 9 against a Host that does not speak this.

**When an answer is lost, the error says what to do next.** This is copied from Orca and it is the
cheapest good idea in their design. When a keyed command ends `unreachable` or `stuck`, the CLI's
error carries the request id and the two commands to run, in `details`:

```json
{ "ok": false, "error": { "code": "TIMEOUT", "message": "…",
  "details": { "requestId": "a3f19c02-7",
    "queryCommand": "astera requests show --id a3f19c02-7",
    "retryCommand": "astera worker-start --task tsk_1 … --request-id a3f19c02-7" } } }
```

An agent that reads `error.details` gets the recovery path without having read the guide.

**The CLI mints a request id for every command, whether or not the caller passed one.** This is
copied from Orca, where `client.ts` calls `randomUUID()` on every durable mutation and
`--retry-request` only ever *reuses* an id.

**This is a reversal of this document's first draft, and the reversal is worth recording.** The first
draft declined to auto-mint on three grounds: that a caller who passes no key should cost nothing,
that memory storage should not hold response bodies for all traffic, and that a protection a caller
does not know it has is not honest. The ruling that overturned it is one sentence: **a receipt's
value is highest exactly where the caller did not plan for failure.** A caller who thought to pass
`--request-id` is a caller who has already thought about retries. The caller who did not is the one
who, when the answer is lost, has nothing to check, and that caller is the reason this feature
exists. Declining to mint leaves the protection with the people who needed it least.

The three grounds answered in turn. *Cost*: auto-minting changes no success path, because a replay
happens only when an id is **presented again**, and an auto-minted id is only ever presented again by
a caller that read it out of an error message and chose to retry with it. Nobody gets a different
answer for not having asked. *Storage*: bounded by the retention policy that already has to exist,
and this is a desktop app's orchestration traffic; if the bound is wrong, the bound is the thing to
change. *Honesty*: it is not invisible protection, it is an id in the error message the caller is
already reading, beside the two commands designed to go there.

That last point is the whole shape. **Without auto-minting, the ambiguous-failure error above cannot
name an id**, and that sentence — here is your request id, here is how to check it, here is how to
retry it — is the sentence the feature exists to write.

**An auto-minted receipt is an ordinary receipt.** It records the full response body like any other,
because the flow it serves ends in a replay. There is deliberately no cheaper receipt for the
auto-minted case: two kinds of receipt would mean a caller could not tell which kind it had, and
`completed` would stop meaning one thing.

**What the flag means, now that it no longer creates the id.** `--request-id` *presents* an id: one
the caller was handed by an earlier error, or one it chose up front so that a CI step is idempotent by
construction. Orca's `--retry-request` names only the first use. Ours names both, and it still avoids
sitting one word away from `worker-start`'s existing `--retry-of`.

**The wire, and why a feature flag is not optional here.** The request id travels as its own field on
`orch-call`, beside `session`, exactly as Orca carries `orchestrationRequestId` on its envelope rather
than inside `params`:

```ts
| { t: 'orch-call'; call: string; cmd: string; args: Record<string, unknown>; session?: string; request?: string }
```

Additive, so `HOST_PROTOCOL` stays 3 for the reason `protocol.ts` gives about every other addition:
bumping it "retires a Host that is running perfectly well and kills its terminals with it". The
feature is announced as `HOST_FEATURE_REQUESTS = 'requests'`.

**Auto-minting forces two different degradations against a Host that does not announce it, and the
split is the whole point.** A **presented** key is refused with exit 9, the same shape and code as the
existing `HOST_FEATURE_ORCH` check in `run.ts`, because silence there is dangerous: an older Host
destructures `{cmd, args, session}`, ignores an unknown field, and would run the command unprotected
while the caller believed otherwise. An **auto-minted** id is dropped silently and the command runs
exactly as it does today, because refusing there would break every command against every older Host
over a protection nobody asked for. The rule in one line: we refuse to break a promise we made, and
we never refuse over one we did not. Orca hit the same wall from the other side and
answered it in the handler, translating `method_not_found` into `incompatible_runtime` "because it
reads as a bug rather than a version gap on the very path a lost response sends you down".

`requests-show` needs no such check. It never reaches `handleCommand`, so a Host that does not know it
answers 501 and `codeForStatus` turns that into 9 for free.

**It is not answerable from the state file.** `FROM_FILE` in `stateFile.ts` is an allowlist and
`requests-show` is not on it, so with no Host the CLI exits 3. That is right and worth a sentence in
the guide: with no Host there is no receipt to have, and the question "did my command land" is
answered by reading the state.

## 9. What it costs when nobody uses it

Auto-minting (§8) means "nobody uses it" no longer means "nothing happens", so the requirement has to
be stated precisely rather than waved at. **No caller gets a different answer, a different exit code,
a different commit or a different order for not having passed a key.** That is the promise, and what
makes it hold is that a replay is only ever triggered by an id being *presented again*: an
auto-minted id is minted, sent once, and never sent a second time by the CLI itself.

What a caller who never passes a key actually pays: one `randomUUID()` per invocation, 36 bytes on
the wire, and, if the command acted, one bounded entry in a map that nothing reads. Nothing on disk,
nothing in the state file, no extra round trip, and no branch inside the command that ran.

The rest of the mechanism lives entirely outside `handleCommand`.

- **The parser.** `parseArgs` already turns any `--foo bar` into `args.foo`, so `--request-id` needs no
  entry in `NUMERIC`, `JSON_ARRAY` or `REPEATABLE`. Lifting it out of `args` onto the message is two
  lines in `run.ts`.
- **The Host.** For a keyed call, one map lookup before `handleCommand` — which for a minted id
  always misses — and one conditional insert after it. For a call with **no** `request` field, one
  comparison against `undefined` and nothing else: no lookup, no insert, and no branch inside the
  command that ran. The per-call flags object is the one `depsFor` already built, so the two new
  marks are two more fields on an object that existed. What is genuinely added is one `onEffect`
  closure beside the thirty-odd wrapper closures `hostOrchDeps` already builds per call, and one
  `Set` membership test per forwarded action — so "not even an allocation" is not the claim; the
  claim is the one below, that no caller gets a different answer, and it is exact. A Host that is
  asked something by a client too old to send a `request` at all takes that same no-key branch, which
  is also what a test harness calling `call()` directly does.
- **The state file.** Untouched. No new field, no migration, `isValidState` unchanged, so a state
  written by a build with receipts is read by one without and the other way round.
- **The command layer.** Not one line of `src/core/orchestration/command.ts` changes. The three
  hundred existing command tests keep passing without being edited, which is the argument the Host
  control plane design made for itself: "`handleCommand` itself needs no new tests: it does not
  change."
- **The file-read fallback and the pending-report queue.** Untouched. A keyed command sent while no
  Host is running still exits 3, or still queues if it is one of the two report types. A key does not
  protect that queue and does not need to, because only the two idempotent types may go on it.

**And one risk auto-minting removes rather than adds.** A caller that invents its own scheme and
reuses one constant key across different commands collides with itself and collects 400s. With the id
minted per invocation, the common path never reuses a key at all, and the fingerprint of §5 is left
guarding only the ids a caller chose deliberately.

The regression that proves all of this is not a new test. It is the existing CLI and command suites
run unchanged against a build that mints: every reply byte-identical, every exit code the same.

## 10. Job Continuity: independent, and the one word they must not share

This repo already keeps a journal of orchestration transitions for a recovery reconciler
(`src/main/continuity/`, `src/main/recovery/`). Receipts must **stay independent of it**, and the
reasons are structural rather than aesthetic.

**It runs in the wrong process.** The journal is a SQLite file opened by the app,
`new ContinuityJournal(path.join(app.getPath('userData'), 'orch', 'continuity.sqlite'))` in
`src/main/ipc.ts`, written from `createOrchCommitHook` on the app's own commits and on `orch-state`
pushes. With the app closed, which is the case the CLI exists for and the case where a double
`worker-start` has nobody watching, nothing is journaled at all. A receipt has to be answerable
exactly then.

**It is off by default.** `continuity` is "Non-null only while the toggle is on: off means no file is
opened and nothing is written". A correctness mechanism cannot sit behind a feature toggle.

**It records a different kind of fact.** `deriveEvents(prev, next, at)` compares two states, chosen so
"no command can forget one". That is the right design for its question and the wrong one for this: it
cannot see a command that acted without committing (`run-merge`), it cannot see who asked, and it
cannot see a request that arrived and was refused.

**The ordering requirements are opposed.** `commitHook.ts` moved the journal write to *after* the
commit, deliberately, for ruling F56: "a `state-put` the Host rejects as stale leaves rows describing
a transition that never happened, and `RecoveryReconciler` reasons from exactly those rows". A receipt
needs the opposite, a claim taken *before* the command, because that claim is what answers `pending`
and what stops the concurrent duplicate.

**And the one thing that must not be reused is a word.** `journal_events` already has a column called
`idempotency_key TEXT UNIQUE`, inserted with `OR IGNORE`, and it means something else entirely: a
deterministic key per *derived observation*, so the same diff never lands twice. Putting
caller-supplied request ids in that column would give one name two meanings in one table and make the
`UNIQUE` constraint collide across them. Whatever else happens, the receipt's key is called a request
id and lives nowhere near that column.

**What they do share is a hand-off, and it belongs in the guide rather than in code.** When a receipt
cannot answer, which is the qualified `absent` of §6, the thing that repairs a Job whose worker was
lost in that same restart is the reconciler, and the thing that answers "did it land" is the state.
Two records of two different truths, meeting at the state file, which is the only thing either of them
treats as authoritative.

## 11. What this does not solve

Said plainly, because a receipt reads like a transaction and is not one.

**A receipt does not make a half-applied command whole,** and `worker-start` is the worked example.
It commits `openDispatch` with `sessionId: 'pending:<hex>'`, calls `startWorker`, then commits a patch
carrying the real `sessionId`, `cwd` and `specPath`. A Host that dies between the spawn and the patch
leaves a Dispatch pointing at a placeholder while a real agent works in a real worktree. No answer
from `requests show` describes that state, and the repair is the recovery reconciler's. **This is the
one place Orca's storage buys something we cannot have**: their claim and their Dispatch insert are
one SQLite transaction, so their equivalent window is narrower. §4 says why we cannot follow, and this
is the price of that decision, stated rather than hidden.

**It gives at-most-once, for one Host.** Not exactly-once, and not across a restart. §4 says what that
costs and §6 says what the caller does about it.

**It does nothing about two different keys.** A caller that retries with a fresh id gets two runs, and
should. The key is the caller's statement that two calls are one request, and we cannot infer it.

**It does not protect the pending-reports queue**, which is at-least-once by design and safe because
`QUEUEABLE_TYPES` has two entries.

**It does not touch the app's `state-put` path**, which has its own answer in ruling F56's version
check, and which is a whole-state write rather than a command.

**Auto-minting protects a caller that never passed a key, but only if it reads the error.** §8 mints
an id for everyone and puts it in the failure message beside the two commands to run. What it cannot
do is act on the caller's behalf: an agent that treats exit 3 or 7 as "it failed, do it again" and
never looks at `error.details` gets no benefit from a receipt it never presents. The mechanism can
only make the recovery available and obvious; reading it is still the caller's move, which is why the
guide's exit-code section is part of this design (§13, step 12) and not a nicety after it.

## 12. What is still open, and what is only uncalibrated

Two lists, kept apart on purpose. The first is design: questions where the shape of the thing is not
settled and someone still has to choose. The second is calibration: numbers and boundaries that are
decided in principle and wrong only if a measurement says so. **A number nobody has measured must not
be dressed as a decision**, and a decision must not be filed as a number.

**Open in design.**

1. **Durability, reopened only by measurement.** §4 chose memory because a durable receipt here
   cannot be made atomic with the commit, and because durability buys a fourth state that then needs
   fencing. What would reopen it is one number nobody has: of the `orch-call`s that end with no
   answer, what fraction end with the Host still alive? A line in the Host's log at
   `failPendingOrchCalls` and at the CLI's `unreachable` produces it in a week of ordinary use. If
   Hosts die mid-call far more often than assumed, the trade changes and §4 should be re-argued rather
   than patched.
2. **Whether `requests show` should be readable by any session or only by the receipt's owner.** §5
   scopes lookups by caller for `COORDINATOR_ONLY`'s reason, which means a coordinator cannot check on
   a request its own worker made. That may be right and it may be the first thing someone asks for.
   Orca's local callers all share one identity and have the opposite problem.
3. **Whether the app should carry keys.** It does not reach `handleCommand` today. When S4 moves the
   dispatch loop into the Host, something in the Host will be issuing commands on its own behalf, and
   that caller has no session id at all, so §5's scope has no answer for it yet.

**Decided, pending calibration.**

4. **The three retention numbers**: 200 completed receipts per caller, one hour, and a global ceiling.
   The policy is decided — evict, never refuse (§4) — and only the numbers are open. What sets them is
   a count of how many acting commands a coordinator issues per minute in a busy Run, and how fast the
   shared `''` bucket fills under auto-minting.
5. **Whether the recorded body needs a size cap.** `worker-read` returns a tail of worker output and
   `inbox` up to fifty messages. The policy is decided: a receipt records the whole response, because
   two kinds of receipt would make `completed` mean two things (§8). If memory turns out to be the
   binding constraint, the lever is the receipt *count*, not the body, and only a measurement says
   whether the lever is needed at all.
6. **The fingerprint's two exclusions**, `requestId` and `timeoutMs`. The principle is decided and is
   Orca's: exclude what changes how long we wait, never what changes what we do. Whether the set is
   exactly those two is a question about how agents actually retry, and the only way to learn it is to
   ship and watch for `request_mismatch` in the log. A mismatch is loud by design, which is what makes
   this safe to calibrate in the open.

## 13. The plan

Twelve steps. Each names what it changes and, more importantly, **what would prove it**, because most
of these are invisible from outside and a step whose proof is "it compiles" has not been done.

Two of them are deliberately not merged. Step 5 puts the flag on the command line; step 2 makes a
retry replay. Shipping them as one step means the first time anyone exercises the flag is also the
first time anyone exercises the replay, and a fault in either reads as a fault in the other.

**Two orderings are load-bearing rather than editorial, and the list below is arranged around them.**
Both concern step 8, auto-minting, because that is the step after which every call carries an id and
so every hazard below becomes reachable by an ordinary caller who asked for nothing.

- **Step 6 (the observed replay) before step 8, and before step 10's replay marker.** The moment an
  id rides every call, the first `check --ack --wait` that loses its answer is a caller locked into
  an instant stale `{count: 0, timedOut: true}` forever, with an ack already landed behind it (§7).
  Shipping the marker first would make that livelock the *documented* behaviour of a replay.
- **Step 7 (retention) before step 8.** The store is in memory, holds whole response bodies, and has
  no sweep until step 7 — `inbox` returns up to fifty messages and `worker-read` a tail of worker
  output. Before auto-minting, only a caller that deliberately passed a key can put anything in it;
  after it, a long-lived Host gets one entry per acting invocation and nothing ever removes them.

Neither is a preference about tidiness. Each is a step whose absence turns the *next* step into a
defect, so the order is part of the design and not part of the scheduling.

**Step 2 is the one that matters.** Everything else is plumbing around a single claim: *a retry with
the same id does not do the thing twice.* If step 2's proof does not hold, nothing after it is worth
building.

1. **Detection and recording, with no replay and no CLI.** `createHostOrch` grows a map keyed by
   `${sessionId}\u0000${requestId}`; `orch-call` carries `request`; `depsFor`'s per-call object gains
   `committed`, set by the `setState` wrapper, and `hostOrchDeps` gains the compiler-held `EFFECTFUL`
   record that sets `acted` inside `a.act`.
   *Proved by*: in `src/host/orch.test.ts`, a keyed `run-create` leaves a receipt; a keyed `jobs-list`
   leaves none; a keyed `worker-start` rejected at `--task is required` leaves none; a keyed
   `run-merge`, which never calls `setState`, leaves one. That last case is the whole argument of §3
   and is the one a command list would have got wrong. No caller can observe anything yet.

2. **Replay. A retry with the same id does not do the thing twice.**
   *Proved by*, and this is the acceptance test of the design: with a counting `startWorker` double,
   send `worker-start` with an id, then send the identical call with the same id. `startWorker` is
   called **once**, the second reply is byte-identical to the first, and the committed state holds
   **one** Dispatch. The same shape for `run-create` (one Run, the same run id returned twice) and for
   `ask` (one question in `state.messages`). And the negative, which matters as much: the same two
   calls with two *different* ids do it twice, because that is what the caller said and we must not
   silently dedupe on our own initiative.

3. **Mid-flight refusal.**
   *Proved by*: a dependency double that blocks on a deferred promise; the first call in flight, the
   second with the same id returns 409 naming the id, and the double is not touched a second time;
   releasing the first lets it answer normally. Plus the ordering proof: two `orch-call`s dispatched
   in the same tick, one wins the claim, which is what pins the "same synchronous step" rule of §7.

4. **`requests show`, in the Host beside `state-get` and `state-put`.**
   *Proved by*: all three states reachable; `interpretation` present on each; `absent` carrying
   `hostStartedAt`; a receipt written under session A reading `absent` to session B; a keyed read
   reading `absent` (§6's fourth cause); and, in `run.test.ts`, exit 3 with no Host.

5. **The flag, the noun, and the three tables.** `--request-id` lifted out of `args` onto the message;
   `requests: ['show']` in `NOUNS`; `--request-id` added once to `agent-context`'s `globalFlags`
   rather than to 58 command entries; a line in `docs/cli.md`'s `## Command reference`.
   *Proved by*: `cliUsage.test.ts`'s doc guard passing, which is what stops the table and the document
   drifting; `astera requests show --help` answering with no Host and exiting 0; and `agent-context`
   listing the flag once, not per command.

6. **The observed replay, for every command that commits and then waits** (§7). Two today, `ask`
   without `--resume` and `check --ack <id> --wait`.
   *Proved by*, and the two halves are different tests because the two observations are produced
   differently: a keyed `ask` that times out, then an answer arriving, then the same id replayed
   returning `answered: true` with the answer rather than the recorded `timedOut: true`, with still
   exactly one question in the state; and a keyed `check --ack dlv --wait` that times out, then a
   message arriving, then the same id replayed returning that message rather than the recorded
   `{count: 0, timedOut: true}`, with the delivery acked exactly once. **Plus the one that holds the
   rule rather than its members**: a guard over the command layer that every command which both
   commits and polls is in the observed set, so the next one is covered by the sentence instead of by
   a third exemption. The livelock all of this prevents is invisible without these tests.
   **Before step 8, for the reason given above the list.**

7. **Retention.** The lazy sweep and the three caps.
   *Proved by*: past the per-caller cap, the oldest completed receipt reads `absent` while the newest
   replays; a claim is never evicted however full the store is; and, explicitly, that **no path
   refuses a command because the store is full** — the test that pins the one Orca behaviour we
   refuse to ship.
   **Before step 8, for the reason given above the list**: after auto-minting there is no invocation
   that cannot add to the store, and until this step nothing ever takes anything out of it.

8. **Auto-minting.** The CLI mints `randomUUID()` when no `--request-id` was given.
   *Proved by*: the existing `run.test.ts` and command suites passing **unchanged** against the
   minting build, which is the literal form of §9's promise that nobody gets a different answer for
   not having asked; plus one new test that the id reaches the wire on an unkeyed call, and one that
   the CLI never sends the same minted id twice.

9. **Feature negotiation, and its two degradations.** `HOST_FEATURE_REQUESTS`, announced by the Host.
   *Proved by*: against a fake `hello` without the feature, a **presented** `--request-id` exits 9 and
   nothing is sent; an **auto-minted** id is dropped and the command runs and succeeds exactly as
   today. Both halves, in one test file, because shipping only the first would break every command
   against every older Host.

10. **The replay marker, the original exit code, and the recovery details.** `replayed: true` at the
    top level of the envelope; a replayed error exiting with its original code; `error.details`
    carrying `requestId`, `queryCommand` and `retryCommand` on an `unreachable` or `stuck` ending.
    *Proved by*: a replayed 404 exiting 4 rather than 0; and the round trip, which is the test worth
    writing — take the `retryCommand` string out of `details`, parse it back through `parseArgs`, run
    it, and get the replay. That proves the sentence §8 says the feature exists to write.

11. **The fingerprint.**
    *Proved by*: the same id with different `--objective` answering 400 and exit 2, naming the first
    command; the same id with a different `--timeout-ms` replaying; and key order inside a `--deps`
    JSON array not changing the hash.

12. **The guide and `docs/cli.md`.** §6's three paragraphs, the `absent` discipline, the split between
    `--resume` and the key from §7, and one line in the orchestration guide's exit-code section naming
    the two codes that mean "I do not know".
    *Proved by*: a test that the guide's `absent` paragraph is quoted from the runtime's own
    `interpretation` strings, so the two cannot drift. Orca's guide and Orca's runtime disagree about
    `pending` today (§2), and that test is the cheapest way not to repeat it.
