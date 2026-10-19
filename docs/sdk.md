# The Astera SDK

**Build integrations and automation on top of Astera's durable Host with the official TypeScript client.**

`@astera-app/client` is a TypeScript client for the Astera Host, the process that owns your Jobs, Runs, Tasks and
questions. It reaches the same Host as the desktop app, the [`astera` command](cli.md) and the
[MCP server](mcp.md), so a Job made through it shows up in the app and in `astera jobs list`, and keeps running when
your program exits. The CLI is for people and shell scripts, MCP for agents, the SDK for applications and
integrations: a CI step, a bot, a dashboard, a script of your own. To run code that Astera starts and stops with
its Host, write [a plugin](plugins.md): its `ctx.astera` is this client.

Where it stands:

- It is on npm as `@astera-app/client` ([Get it](#get-it)), versioned apart from the app.
- It talks to the Host on this machine only, over the Host's own pipe or socket. There is no HTTP mode and no Runtime
  target yet ([Not yet](#not-yet)).
- Node 22 or later, ESM and CommonJS, TypeScript types included. No browser build.
- It is 0.x, so a minor version may still change names; [its changelog](../packages/client/CHANGELOG.md) says what
  each version changed.

## Get it

You need Node 22 or later, and the Astera app installed and running (or a Host started with `astera host start`).

```bash
npm install @astera-app/client
```

It needs Astera 1.4.12 or later, the first whose Host keeps the public event log
([Host versions and features](#host-versions-and-features) says what an older one answers).

To try what this repository has before it is released, build the package from a clone:

```bash
git clone https://github.com/parsingk/Astera.git
cd Astera
npm ci --ignore-scripts
npm run build:packages
```

`--ignore-scripts` skips what only the desktop app needs (Electron's download and the native rebuilds), so a machine
without build tools can build the SDK too. Leave it out in a clone you also run the app from.

Then install it into your project by its folder:

```bash
npm install <path to the clone>/packages/client
```

That installs a link: after you pull and build again, your project sees the new build. To install a copy instead, run
`npm pack` in `packages/client` and install the `.tgz` it writes.

## Connect

```ts
import { createAsteraClient, isAsteraError } from '@astera-app/client'

try {
  const astera = await createAsteraClient()
  try {
    console.log(`connected to Astera ${astera.host.version}`)
    const { items } = await astera.jobs.list({ status: 'running' })
    for (const job of items) console.log(job.id, job.objective)
  } finally {
    astera.close()
  }
} catch (e) {
  if (isAsteraError(e) && e.code === 'HOST_NOT_RUNNING') console.error('Open the Astera app, or run `astera host start`.')
  else throw e
}
```

**Which Host.** The installed app's, the same one `astera` reaches (see
[Which Host, and which profile](cli.md#which-host-and-which-profile)):

- `ASTERA_PROFILE_DIR` names a profile folder, and its Host is the one used.
- `ASTERA_PROFILE=dev` picks the development app's profile when `ASTERA_PROFILE_DIR` is not set.
- `ASTERA_HOST` overrides the address of the profile found that way.
- The options `profileDir` and `address` override all three. An explicit `profileDir` without `address` is always
  that profile's own Host.

A script started inside a session Astera runs inherits that session's `ASTERA_PROFILE_DIR`, so it reaches the Host
that started the session. The client never starts a Host: with none running, `createAsteraClient()` rejects with
`HOST_NOT_RUNNING`.

| Option | Default | |
|---|---|---|
| `mode` | `'local'` | The only mode for now |
| `profileDir` | from the environment | The profile whose Host to reach |
| `address` | that profile's | The Host's pipe or socket |
| `connectTimeoutMs` | 5 s | How long the handshake may take |
| `callTimeoutMs` | 330 s | How long an ordinary command may take |
| `env` | `process.env` | The environment the profile is read from |
| `log` | silent | Where the handshake reports what it refused |

```ts
import { createAsteraClient } from '@astera-app/client'

const dev = await createAsteraClient({ env: { ...process.env, ASTERA_PROFILE: 'dev' }, connectTimeoutMs: 2000 })
console.log(dev.profileDir, dev.address)
dev.close()
```

`astera.host` says which Host answered: `version` (the app's version), `pid`, `startedAt`, and `host.features`, what
it can do beyond the base protocol. `hasFeature(name)` reads the same list.

**Closing.** `close()` ends the connection at once and frees the Host's side; calls still waiting fail with `FAILED`.
An idle client does not keep Node running, so a script that forgets `close()` still exits.

## A first script

Make a Job in a folder, run it and wait for it to end:

```ts
import { randomUUID } from 'node:crypto'
import { createAsteraClient } from '@astera-app/client'

const astera = await createAsteraClient()

const job = await astera.jobs.create(
  { cwd: process.cwd(), objective: 'Refactor authentication', coordinator: { provider: 'claude' } },
  { requestId: randomUUID() }
)
const run = await astera.jobs.run(job.id, { requestId: randomUUID() })
const result = await astera.runs.wait(run.id)

switch (result.state) {
  case 'completed':
    console.log('done')
    break
  case 'failed':
    console.log('failed:', (await astera.completion.get(result.runId)).state)
    break
  case 'waiting':
    console.log('a question needs an answer:', result.questionId)
    break
  default:
    console.log(result.state) // paused, limited or timeout
}
astera.close()
```

The coordinator (the default Claude account here) plans the work into Tasks and runs agents on them.
[run-a-job.ts](../examples/sdk/run-a-job.ts) is this script whole, exiting with the codes `astera runs wait` uses.

## What you can do

| Namespace | Methods | The same as |
|---|---|---|
| `projects` | `projects.list`, `projects.get` | `astera projects list`, `get` |
| `jobs` | `jobs.list`, `jobs.get`, `jobs.create`, `jobs.run`, `jobs.wait` | `astera jobs list`, `get`, `create`, `run`, `wait` |
| `runs` | `runs.list`, `runs.get`, `runs.wait`, `runs.follow`, `runs.stop`, `runs.resume` | `astera runs list`, `get`, `wait`, `follow`, `stop`, `resume` |
| `tasks` | `tasks.list`, `tasks.get`, `tasks.create` | `astera tasks list`, MCP's `get_task`, `astera tasks add` |
| `questions` | `questions.list`, `questions.get`, `questions.answer` | `astera questions list`, `get`, `answer` |
| `completion` | `completion.get` | MCP's `get_completion` |
| `events` | `events.list`, `events.cursor`, `events.subscribe` | no command ([Events](#events)) |

Answers come in the public shapes the CLI prints with `--json`, typed: `Project`, `Job`, `Run`, `Task`, `Question`,
`RunCompletion`, `AsteraEvent` and the rest are exported from the package. The words are the Host's: a question is
`open` or `resolved`, and a stop pauses a Run (`runs.resume` takes it back). There is no cancel.

A Job made with the GitHub lifecycle (`astera jobs create --github-lifecycle`, Astera 1.4.15 and `@astera-app/client`
0.4.0 and later) carries its
policy as `github` (`GitHubLifecyclePolicy`), and each of its Runs carries `github` (`GitHubLifecycle`): the pull
request Astera bound for the Run's branch, its head commit, the CI checks of that commit with the `verdict` (`pending`,
`passed`, `failed`, or `none` when the commit has no check and no workflow starting) and its `basis` (the required checks, every reported check,
or the Job's selection), the check that failed first with its link, its `class` and a one-line `summary` of why, and a
`state` that sums it up (`unbound`,
`pr-bound`, `ci-pending`, `ci-passed`, `ci-failed`, `pr-merged`, `pr-closed`, or `external-state-unavailable` while
GitHub cannot be read). While the Run's lifecycle Task works, `state` says where it stands instead: `pr-ready` (its local
checks run before the first push), `awaiting-push` (they run again after an earlier push: after a repair, or in a round a
person started again), `ci-pending` (CI is awaited), `repairing`, `reviewing`, `waiting-for-user` (a question is open on
it), `ci-infrastructure-failure` (CI failed for a reason a rerun can cure: a rerun of the head's CI is in flight, or a
question about rerunning it is open) or `exhausted` (its repair budget ran out, or it failed; once its pull request is
merged or closed, `pr-merged` or `pr-closed` instead). It is derived on every read, so `runs.get` always shows what Astera last read.

### Jobs and Runs

`jobs.create` takes an `objective`, and where the work happens: a `projectId` (a project registered in the app) or an
absolute `cwd`. A relative `cwd` is refused, because the Host would resolve it against its own folder. The rest is
optional: `coordinator` (`{ provider: 'claude' }`, `{ provider: 'codex' }` or `{ accountId }`), `concurrency`, and
`convergence` (`true` for the Host's repair defaults, or a policy). A Job with no coordinator runs only the Tasks you
add to it:

```ts
import { randomUUID } from 'node:crypto'

const job = await astera.jobs.create({ projectId, objective: 'Validate the signup form', convergence: { maxFixAttempts: 3 } }, { requestId: randomUUID() })
await astera.tasks.create(
  { jobId: job.id, title: 'Validation', spec: 'Reject an empty email and a short password on signup', accountIds: ['acc_1'], validate: ['npm-test'] },
  { requestId: randomUUID() }
)
const run = await astera.jobs.run(job.id, { requestId: randomUUID() })
console.log(`run ${run.ordinal} of ${job.id}: ${run.id}`)
```

A Job made from a job source's item (a ticket a person picked in the app, with `astera jobs create-from-source`, or
with MCP's `create_job_from_source`) carries `source`: `{ id, itemId, label, title?, url? }`, the source (`github`,
or a plugin's id), the item's id there, how a person names it (`Linear ENG-123`), the item's title (someone else's
text, at most 300 characters), and its link. Astera sets it, from 1.4.14
and `@astera-app/client` 0.3.0; `jobs.create` takes no such field. A GitHub issue's source also carries
`capturedBodyHash` (a sha256 of the issue's body when the Job was made) and `capturedUpdatedAt` (GitHub's `updated_at`
then), from 1.4.15: a GitHub lifecycle Run marks `github.sourceChanged` when the body changes after that, and the Job's
objective stays as it was. There is no namespace for job sources yet: make
such a Job with `call('jobs-create-from-source', { source, item, project })`, as the CLI does (`astera jobs
create-from-source`), with `jobs.create`'s coordinator and convergence arguments beside them; the answer is the Job.
[Job source plugins](plugins.md#job-source-plugins) says where the items come from.

`jobs.run` answers the Run it started. `runs.stop` releases the Run's workers and pauses it; `runs.resume` takes it
back.

### Waiting and following

`runs.wait` and `jobs.wait` answer how the Run ended. That is data, not an error:

| `state` | Means | Also carries |
|---|---|---|
| `completed` | every Task finished | `progress` |
| `failed` | the Run ended in failure | `progress` |
| `waiting` | a question waits for a person | `questionId`, `taskId` |
| `paused` | the Run was stopped | |
| `limited` | every worker waits for a usage limit to reset | `resetsAt` |
| `timeout` | the Host's deadline passed first; the Run goes on | `runId` (null when a Job had no Run yet) |

The Host waits 1 hour unless the call names `timeoutMs`:

```ts
const end = await astera.runs.wait(runId, { timeoutMs: 10 * 60_000 })
if (end.state === 'timeout') console.log('still going after ten minutes; the Run goes on')
```

`runs.follow` yields the Run's timeline as it happens, each event once, then one ending:

```ts
for await (const item of astera.runs.follow(runId)) {
  if ('event' in item) console.log(item.event.at, item.event.summary)
  else console.log('ended:', item.ending.state)
}
```

It throws `NOT_FOUND` when the Run is deleted and `HOST_NOT_RUNNING` when the Host goes away; it does not pick up again
by itself (an [events](#events) subscription does). Leaving the loop (`break`, `return()`) or aborting its `signal`
ends the call it is waiting on. [follow-a-run.ts](../examples/sdk/follow-a-run.ts) prints a Run this way.

### Questions

An agent that needs a person opens a question, and its Task waits for the answer:

```ts
const { items } = await astera.questions.list({ status: 'open' })
for (const q of items) {
  const answered = await astera.questions.answer(q.id, { answer: q.options?.[0] ?? 'yes' }, { requestId: `answer-${q.id}` })
  console.log(q.question, '->', answered.resolution)
}
```

When a question lists `options`, answer with one of them. The one a plugin's completion check opens when it could not
be made, `kind` `check-unavailable`, refuses any answer but `retry`, `skip-check` or `mark-failed` with
`INVALID_ARGUMENTS`: `retry` runs the Task's checks again, `skip-check` goes on without that check this round, and
`mark-failed` fails the Task; when that check is GitHub CI, `skip-check` is not offered. A question about a GitHub
lifecycle round (`kind` `github-no-ci`, `github-ci-cap`, `github-external-head`, `github-pr-ambiguous`,
`github-pr-closed`, `github-ci-outside` — also after a second failure Astera could not classify, or a repair that fixed
nothing — or `github-carry`) takes only the `options` it lists: `wait` waits again on
the same head, `no-ci` lets the round pass without CI, `continue` brings GitHub's commits in by fast-forward and
starts the checks again, `retry` starts the round again, `rerun` reruns the failed jobs of the CI run and waits for
its new attempt, `pr-<n>` binds pull request n, and `mark-failed` fails the Task.

A question someone already answered (in the app, say) keeps that answer, and `questions.answer` gives it back, so
compare `resolution` with what you sent. When a person takes a while to type, read the question again
(`questions.get`) right before sending: answered meanwhile in the same words, it would otherwise look like yours.
[answer-questions.ts](../examples/sdk/answer-questions.ts) answers questions from a terminal as they open.

### Tasks

`tasks.create` adds a Task to a Job's definition (`jobId`) or to a Run under way (`runId`): `spec` (what to do), and
optionally `title`, `deps` (Task ids it waits for), `parentId`, `accountIds` (the accounts to run it on, in failover
order), `validate` (run configuration ids that check the work, or `plugin:<id>` for a completion check plugin, in
the order the checks run) and `review`. Without `accountIds` it uses the Job's coordinator account, and is refused when
the Job has none. A `plugin:<id>` whose plugin is not installed, does not offer completion checks, or is disabled is
refused with `PLUGIN_CAPABILITY_MISSING` ([plugins.md](plugins.md#completion-check-plugins)). `tasks.list({ runId, status, ready, brief })` and
`tasks.get` read them. A Task with `kind: 'lifecycle'` is the one Astera adds once every other Task of a GitHub
lifecycle Run is completed, to carry the Run through GitHub: it has no worker, and `tasks.create` on that Run is
refused while it is open.

### Completion

`completion.get` says where each Task of a Run stands on its way to done:

```ts
const completion = await astera.completion.get(runId)
for (const t of completion.tasks) console.log(t.title, t.state, `${t.attempt}/${t.maxAttempts ?? '-'}`, t.failureSummary ?? '')
```

A Task is `not-started`, `working`, `checking`, `rechecking`, `reviewing`, `fixing`, `fixing-review`,
`waiting-for-user`, `exhausted`, `converged` or `failed`; the Run wears its most urgent Task's state. `attempt` counts
repairs against `maxAttempts`, and `failureSummary` and `lastFailure` say what failed. It is read only: whether the
work is done stays Astera's call.

A Task's `detail.checks` are its last round, each a check's `status` (`passed`, `failed`, `timed-out`, `not-run`, or
`error` for a plugin's check that could not be made) with its `exitCode` and output. A plugin's check, `configId`
`plugin:<id>`, carries its `summary`, its findings as `diagnostics` (`file?`, `line?`, `message`, `severity?`; the first
20, and none for a passed check), `diagnosticsTotal` when the plugin gave more, and a link as `externalUrl`; one a person
let the round go on without is `not-run` with `skipped: true`.

### Any other command

`call(cmd, args, options)` sends any Host command the typed methods do not cover, by the name `astera` sends it
under, and answers `{ body, replayed, observed }`:

```ts
const { body } = await astera.call('accounts-list', { agent: 'claude' })
console.log(body) // the public shape `astera accounts list --json` prints, untyped
```

## Events

The Host keeps a log of what happens to Jobs, Runs, Tasks, questions, completion and sessions. It is always on, it
outlives a Host restart, and `events` reads it. An event:

```text
{ id, type, sequence, occurredAt, projectId?, jobId?, runId?, taskId?, sessionId?, payload }
```

| Type | When | Payload |
|---|---|---|
| `job.created`, `job.updated` | a Job is made; one of its own fields changes (not its outcome or progress) | `Job` |
| `run.started` | a Run is made | `Run` |
| `run.completed`, `run.failed` | its Tasks' outcome leaves `running` | `Run` |
| `task.started` | a worker starts on a Task (a retry or a repair included), once it has its session | `Task` |
| `task.completed`, `task.failed` | a Task completes; fails (a failure it will retry included) | `Task` |
| `question.created`, `question.answered` | a question for a person opens; is answered | `Question` |
| `completion.started` | a Task's first check starts | `TaskCompletion` |
| `completion.failed` | a check or review round fails (a plugin's check that could not be made fails no round: its question, `question.created`, says the Task waits) | `TaskCompletion` |
| `completion.repair_started` | a repair of a failed check or review starts, once its worker has its session | `TaskCompletion` |
| `completion.converged`, `completion.exhausted` | a Task is done; its repairs ran out | `TaskCompletion` |
| `session.input_needed` | a session turns to waiting on a person (a permission, a question), once per turn into it | `{ session, prompt }` |
| `session.limit_waiting` | a session stops at a usage limit and waits for it to reset | `{ session, scope?, nextRetryAt? }` |
| `session.account_switched` | a session goes on under another account | `{ session, accountLabel }` |
| `github.pr_bound` | a GitHub lifecycle Run's branch was bound to a pull request Astera found (one Astera opened is `github.pr_created`) | `Run` |
| `github.pr_created` | Astera opened the draft pull request a GitHub lifecycle Run is bound to | `Run` |
| `github.head_changed` | that pull request's head moved | `Run` |
| `github.ci_passed` | CI passed for the head (`run.github.ci`) | `Run` |
| `github.ci_failed` | CI failed for the head; `run.github.failing` names the check | `Run` |
| `github.ci_rerun_requested` | a CI run of the head was rerun through Astera: by Astera itself (a failure outside the code) or by a person's answer or `github-ci-rerun --run` (a rerun made on GitHub's own page is not seen) | `Run` |
| `github.source_changed` | the GitHub issue the Job came from changed after it began | `Run` |

The payload is the object as it stood right after the change. A Task is cut like `tasks.list({ brief: true })` and its
checks carry no output; a plugin check, in a Task or a `TaskCompletion`, carries how many findings it has
(`diagnosticsTotal`) and not the findings, which `tasks.get` and `completion.get` read. The `get` methods read the whole
object.

A session event's `session` is `{ id, kind, title?, provider?, cwd? }`, as `astera sessions list` shows it; `prompt` is
`permission`, `question` or `null` when the Host cannot tell. They are what Astera's desktop notifications announce: a
Claude terminal or a chat waiting (a Codex terminal says nothing the Host can read), and the usage-limit waits and
account switches of Account Rolling. A Host records the sessions it runs; a paired Runtime's are in that Runtime's log,
and a Host that cannot start sessions records none. They need Astera 1.4.13 or later and client 0.2.0 or later. Named in
`types`, they are refused with `INVALID_ARGUMENTS` by an older Host, and by an older client before it asks; subscribed
to without `types`, an older client passes them on with no `sessionId` and an empty payload.

Events are notifications, not the state. Delivery is at least once and an `id` never repeats, so drop one you have
seen; `sequence` orders the events of one log.

```ts
for await (const e of astera.events.subscribe({ types: ['run.completed', 'run.failed'] })) {
  if (e.type === 'gap') continue // some were lost: see Gaps below
  console.log(e.type, e.payload.id, `${e.payload.progress.done}/${e.payload.progress.total}`)
}
```

- `events.subscribe({ after, types, signal })` yields events as they happen, from `after` (an event id or a cursor) or,
  without it, from the moment it starts. It never ends by itself.
- `events.list({ after, types, limit })` answers one page `{ items, nextCursor, gap }` from the oldest event the Host
  holds, without waiting. Pass `nextCursor` back to read on. Unlike the other lists, `nextCursor` is always set (it is
  where the next event will be); you have caught up when `items` comes back empty.
- `events.cursor()` answers where the next event will be, without reading any.

```ts
let after: string | undefined
for (;;) {
  const page = await astera.events.list({ after, limit: 500 })
  for (const e of page.items) console.log(e.sequence, e.type)
  if (page.items.length === 0) break
  after = page.nextCursor
}
```

### Read the state, then follow the changes

Take the cursor first, then read the objects, then subscribe from the cursor. Nothing that changes after the read is
missed; an object the read and an event both name comes twice, so drop the second by its id:

```ts
import type { Question } from '@astera-app/client'

const cursor = await astera.events.cursor()
const seen = new Set<string>()
const handle = (q: Question): void => {
  if (seen.has(q.id)) return
  seen.add(q.id)
  console.log('open question:', q.question)
}
for (const q of (await astera.questions.list({ status: 'open' })).items) handle(q)
for await (const e of astera.events.subscribe({ after: cursor, types: ['question.created'] })) {
  if (e.type === 'gap') for (const q of (await astera.questions.list({ status: 'open' })).items) handle(q)
  else handle(e.payload)
}
```

### Gaps

A `{ type: 'gap' }` from `subscribe` (or `gap: true` on a page) means events between your cursor and the next one are
gone. Either they are older than the Host keeps, or the cursor is from a log this Host does not hold (another
profile, say). The Host keeps two files of up to 1000 events or 4 MiB each, so between 1000 and 2000 events, fewer when
payloads are large (a Task's `result` or a Job's `objective` is not cut). After a gap, read the objects again.

### Across restarts

A subscription outlives a Host restart: a call that fails because the Host went away or did not answer is sent again
from the same cursor after 250 ms, 1 s, then every 5 s, and the new Host reads on from it. It ends only on `break` or
`return()`, its `signal`, or an error waiting cannot mend (a Host too old for events answers `VERSION_MISMATCH`).

To outlive a restart of your own program, save a cursor and pass it back as `after`: the id of the last event you
handled, and, while you are not handling one, the subscription's own `cursor`. That one also moves past the events your
`types` filter skips, so a program that watches a few types does not come back to a cursor the Host has dropped and
read a gap. Saved while you handle an event, it is where that event's page was read from, so that page comes again.
[notify-webhook.ts](../examples/sdk/notify-webhook.ts) does both, posting to a webhook.

Not produced yet: `run.cancelled` (there is no cancel; a stop pauses) and `runtime.*`.

## Errors

A refusal rejects with an `AsteraError`: a `code` for your program, a `message` for a person, and `details` when the
Host gave any. Test it with `isAsteraError(e)` (or `instanceof AsteraError`); both hold across the package's ESM and
CommonJS copies.

| Code | When | What to do |
|---|---|---|
| `FAILED` | something none of the codes below describes, or the client was closed | read `message` |
| `INVALID_ARGUMENTS` | the client or the Host refused an argument, before anything ran | fix the call |
| `HOST_NOT_RUNNING` | no Host answered | open the app or run `astera host start`; see the note below |
| `NOT_FOUND` | no such id | do not retry |
| `PERMISSION_DENIED` | refused for this caller, or something at the address could not prove it is the Host | check `ASTERA_HOST` |
| `CONFLICT` | refused because of the current state, such as a Job that is already running, or a `requestId` whose first call is still running | read the object again; for a request id, wait and send it again |
| `TIMEOUT` | a deadline passed with no answer | see the note below |
| `VERSION_MISMATCH` | the Host and this client do not speak the same version, or the Host lacks a feature the call needs | update the app |
| `WAITING_FOR_INPUT` | not thrown: the waits answer `waiting`, `paused` and `limited` as data | |
| `RUN_FAILED` | not thrown: the waits answer `failed` as data | |
| `PLUGIN_CAPABILITY_MISSING` | a Task's check names `plugin:<id>` and that plugin is not installed, does not offer completion checks, or is disabled | `astera plugins list`; install or enable it, or take the check out |

`EXIT_CODES` maps every code to the exit code `astera` uses for it, for a script that exits the same way
([run-a-job.ts](../examples/sdk/run-a-job.ts) does).

**`HOST_NOT_RUNNING` and `TIMEOUT` mean that no answer came back**, not that the command failed: the Host commits
before it answers, so a write may have happened. Find out before sending it again
([Retries and request ids](#retries-and-request-ids)).

An aborted `signal` rejects with the signal's reason (an `AbortError` by default), not an `AsteraError`; its numeric
`code` is not one of these, so check `isAsteraError` before reading `code`.

```ts
import { EXIT_CODES, isAsteraError } from '@astera-app/client'

try {
  await astera.runs.get(runId)
} catch (e) {
  if (!isAsteraError(e)) throw e
  if (e.code === 'NOT_FOUND') console.log('no such Run')
  process.exitCode = EXIT_CODES[e.code]
}
```

The `RUNTIME_*` and `REMOTE_*` codes come from a paired Runtime ([Error codes](remote-runtime.md#error-codes)); the
typed methods, which talk to this machine's Host, do not produce them.

## Retries and request ids

Every write method takes a `requestId`. Sent again with the same id after the first call finished, the command is not
run twice: the Host answers from its receipt, the answer the first call got. Sent while the first call is still
running, it is refused with `CONFLICT` (wait, then send it again); with other arguments or for another command, with
`INVALID_ARGUMENTS`. Reads never send one. A Host that keeps no receipts refuses a `requestId` with
`VERSION_MISMATCH` rather than ignoring it. (`call()` says `replayed: true` for an answer from a receipt; the typed
methods hand it over as it is.)

**A receipt does not last.** Receipts live in the Host's memory: each for 1 hour, at most the last 200 of every caller
outside an Astera session together (a shell, a CI job, every SDK client), and a restart of the Host forgets them all.
So:

- Use a fresh id for each thing you mean to do (`randomUUID()`), and the same id to send it again soon after.
- An id made from what you act on, such as `create-<issue>`, does not make the action happen once across days: after
  the hour, or a Host restart, the Host runs it again. Look at the state for that (does the Job exist?). Answering a
  question is safe to repeat for another reason: the Host keeps a question's first answer.
- After `HOST_NOT_RUNNING` or `TIMEOUT`, ask the Host what became of the id before sending it again.
  `call('requests-show', { id })` answers `completed` (it ran; `response` is what it answered), `pending` (still
  running: wait and ask again) or `absent`. `absent` from a Host whose `hostStartedAt` is later than your first try
  means the Host restarted and may have run it before it went: look at the state before sending it again.

```ts
import { randomUUID } from 'node:crypto'
import { isAsteraError, type Job } from '@astera-app/client'

/** Makes the Job once, or throws when it cannot tell whether the Host made it. */
async function createOnce(objective: string): Promise<Job> {
  const requestId = randomUUID()
  const sentAt = Date.now()
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await astera.jobs.create({ projectId, objective }, { requestId })
    } catch (e) {
      // No answer came back, or the first try is still running: anything else is an answer
      if (!isAsteraError(e) || !['HOST_NOT_RUNNING', 'TIMEOUT', 'CONFLICT'].includes(e.code)) throw e
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt))
    const { body } = await astera.call('requests-show', { id: requestId })
    const shown = body as { state: 'completed' | 'pending' | 'absent'; hostStartedAt: string }
    // A Host that started after the first try never saw it, and the one that did may have made the Job
    if (shown.state === 'absent' && Date.parse(shown.hostStartedAt) > sentAt)
      throw new Error(`the Host restarted after ${requestId} was sent: look for the Job before making it again`)
  }
  throw new Error(`no answer for ${requestId} after 5 tries`)
}
```

The [`astera` guide](cli.md#command-reference) says the same for the CLI, under `requests show`.

## Deadlines and cancellation

The handshake waits 5 s and an ordinary command 330 s (the CLI's deadlines). A command that waits on the Host
(`runs.wait`, `jobs.wait`, a follow window, an events window) waits past the Host's own deadline instead. On
`runs.wait`, `jobs.wait` and `runs.follow`, `timeoutMs` is that Host deadline (1 hour when not given), and the client
waits a little past it. On every other method, `timeoutMs` is how long that call waits for its answer, the connect
included. A method that looks something up first (`jobs.create` or `jobs.list` with a `projectId`, `tasks.create`
without `accountIds`) gives each of its two calls that long.

Every method takes a `signal`. Aborting it ends the wait for the answer, not the work:
**cancelling a call is not cancelling a Run.** The Host may still finish the command, and a Run goes on until you
stop it with `runs.stop`.

```ts
const controller = new AbortController()
setTimeout(() => controller.abort(), 30_000)
try {
  await astera.runs.wait(runId, { signal: controller.signal })
} catch (e) {
  if (!controller.signal.aborted) throw e
  console.log('stopped waiting; the Run goes on')
}
```

## Lists and paging

Lists answer `{ items, nextCursor }`. The Host answers whole lists today, so `nextCursor` is not set yet, except on
`events.list`, which pages and always sets it.

## Host versions and features

The protocol version is part of the Host's address, so a client built for another protocol than the app's looks for its
Host where none listens, and gets `HOST_NOT_RUNNING` even with the app open; pointed at the Host's own address
(`ASTERA_HOST` or `address`), it gets `VERSION_MISMATCH`. `host.features` lists what a Host of the same protocol can do
beyond it (`orch`, `requests` for request ids, `events` for the event log, and more). A method that needs a feature
the Host lacks refuses with `VERSION_MISMATCH` before it sends anything. Updating the app updates the Host.

```ts
if (!astera.hasFeature('events')) console.log(`Astera ${astera.host.version} keeps no event log: update the app`)
```

## Examples

[examples/sdk](../examples/sdk/README.md) has four scripts, each run with plain Node:

- [run-a-job.ts](../examples/sdk/run-a-job.ts) makes a Job in a folder, runs it and waits for it, exiting the way
  `astera runs wait` does.
- [follow-a-run.ts](../examples/sdk/follow-a-run.ts) prints a Run's timeline as it happens.
- [answer-questions.ts](../examples/sdk/answer-questions.ts) answers the questions agents ask a person, from a
  terminal, using the cursor recipe above.
- [notify-webhook.ts](../examples/sdk/notify-webhook.ts) posts Run endings, exhausted repairs and new questions to a
  webhook, and resumes where it stopped. A Slack incoming webhook takes its posts as they are; for Discord, give it
  the webhook URL with `/slack` added, Discord's Slack-compatible form.

After [building the package](#get-it) (`npm ci --ignore-scripts`, then `npm run build:packages`), run `npm install` in
`examples/sdk`, then `node run-a-job.ts ...`. Node runs TypeScript as it is from 22.18 on the 22 line and from 23.6;
Node 22.6 to 22.17 needs `--experimental-strip-types`; on anything else use `npx tsx`.

## Not yet

- An HTTP mode (`mode: 'http'`) for a Host on another machine, and Runtime targets (`runtimeId`).
- The `sessions`, `github`, `howItWorks` and `runtimes` namespaces. Use `call()` or the CLI meanwhile; a GitHub
  lifecycle Run's pull request and CI are already on `runs.get` (`github`).
- A Run cancel (`runs.cancel`, `run.cancelled`): a stop pauses.
- Paging done by the Host for the lists other than events.
- `runtime.*` events.
- A browser build.

## Troubleshooting

**`HOST_NOT_RUNNING` at connect.** Open the Astera app, or run `astera host start`. For the development app, set
`ASTERA_PROFILE=dev`. `astera host status` prints the profile the CLI resolves, which the client resolves the same way.
If the app is open, the client was built for another protocol version than the app's Host
([Host versions](#host-versions-and-features)): update the app, or build the client from the same version as the app.

**`PERMISSION_DENIED` at connect.** Something answers at the address but could not prove it is the Host of the profile.
Check `ASTERA_HOST`, or drop it.

**`VERSION_MISMATCH`.** The app's Host lacks a feature the call needs (or, reached by its address, speaks another
protocol): the app is older than the client. Update the app.

**A subscription that prints nothing** is waiting for events. `events.list()` shows what the Host holds, and a
`types` filter may be skipping what you expect.
