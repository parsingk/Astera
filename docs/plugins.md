# Astera plugins

A plugin is a small Node program that Astera runs beside its Host, the process that owns your Jobs, Runs, Tasks and
questions. It starts when the Host starts and stops when the Host stops, and it reaches Astera through `ctx.astera`,
a client from [the SDK](sdk.md) that the Host answers within the permissions you granted the plugin. Use one to post
Astera's events somewhere, to react to a failed Run, or to connect Astera to a tool of your own, without keeping a
script running yourself.

Where it stands:

- A plugin is installed from a folder or from npm, and runs in the background: Astera calls its `activate` and lets it
  work. An event plugin is also handed each of Astera's events ([Event plugins](#event-plugins)), a notification
  plugin each thing worth telling a person ([Notification plugins](#notification-plugins)), and a job source is asked
  for the tickets a Job can be made from ([Job source plugins](#job-source-plugins)), and a completion check plugin is
  asked whether a Task's work passes, when a Task names it among its checks as `plugin:<id>`
  ([Completion check plugins](#completion-check-plugins)).
- `@astera-app/plugin-sdk` holds the plugin's types and `definePlugin`. A plugin needs nothing from it to run:
  [the sample](../examples/plugins/webhook-notifier) is plain JavaScript and uses its types for the editor only.
- The Plugin API is version `1`.

## Plugins are trusted code

**Plugins run trusted code on this machine: a plugin can do anything you can, and its permissions limit only what it asks Astera for.**

A plugin is a process running as you. It can read and write your files, open network connections and start other
programs, whatever permissions it was granted. Its permissions decide what `ctx.astera` may ask the Host for, so an
honest plugin cannot reach further into Astera than you allowed; they are not a sandbox, and they do not stop a plugin
that means harm. Install plugins you trust, as you would any program, and read the code of one you are not sure of.
Astera shows this warning, with what the plugin asks for, before you approve an install: in the app every time, and
from `astera plugins install` without `--yes`.

## Quick start

A plugin is a folder with a `package.json`. Make a folder named `hello-astera` with this `package.json`:

```json
{
  "name": "hello-astera",
  "version": "0.1.0",
  "type": "module",
  "astera": {
    "apiVersion": "1",
    "entry": "index.js",
    "permissions": ["projects.read"]
  }
}
```

and this `index.js` beside it:

```js
export default {
  async activate(ctx) {
    const { items } = await ctx.astera.projects.list()
    ctx.log.info(`Astera has ${items.length} projects`)
  }
}
```

With the Astera app running and the `astera` command installed ([from Settings → CLI](cli.md#install)), install it
from a terminal of your own (on Windows, macOS and Linux alike) and read its log:

```sh
astera plugins install --path ./hello-astera --yes
astera plugins logs --id hello-astera
```

Without `--yes`, `install` shows what the plugin is and asks for, and installs nothing. The log shows Astera starting
it, what it wrote, and that it is running:

```text
2026-10-13T09:12:01.120Z [host] started pid 4120
2026-10-13T09:12:01.402Z [info] Astera has 2 projects
2026-10-13T09:12:01.405Z [host] running
```

`astera plugins list` shows it as `running`. The app's Settings → Plugins does the same: install from a folder,
approve, and open its log there. Run these commands in a terminal of your own: inside an Astera session
(`ASTERA_SESSION` is set) changing plugins is refused with exit 5, so an agent cannot install one on its own.

## The manifest

The manifest is `package.json`: npm's own fields, and an `astera` field for Astera.

| Field | |
|---|---|
| `name` | The plugin's id, which every command names it by: an npm package name, scoped or not (`@acme/astera-jira`). |
| `version` | A semver version. |
| `displayName` | Optional. What the app shows, up to 64 characters. |
| `description` | Optional. Shown when you install it: its first 500 characters. |
| `astera.apiVersion` | The Plugin API it is written for: `"1"`. |
| `astera.entry` | The file Astera starts, relative to the folder: an ES module (`.mjs`, or `.js` with `"type": "module"`) or CommonJS. |
| `astera.permissions` | What it asks Astera for ([Permissions](#permissions)). A person may grant fewer. |
| `astera.settingsSchema` | Optional. The settings a person gives it ([Settings and secrets](#settings-and-secrets)). |
| `astera.minAsteraVersion` | Optional. The oldest Astera it runs on; an older one installs it and does not run it. |
| `astera.capabilities` | Optional. `["event"]` for a plugin Astera hands its events ([Event plugins](#event-plugins)), `["notification"]` for one it sends notifications ([Notification plugins](#notification-plugins)), `["job-source"]` for one it asks for tickets ([Job source plugins](#job-source-plugins)), `["completion-check"]` for one it asks to check a Task's work ([Completion check plugins](#completion-check-plugins)). |

The entry's default export is the plugin: an object with an `activate` and, if it needs one, a `deactivate` (and an
`onEvent` for an event plugin, a `send` for a notification plugin, `listItems`, `getItem` and `buildJobContext` for a
job source, and a `runCheck` for a completion check). A CommonJS entry sets `module.exports` to it.
`definePlugin` from the SDK returns the object it is given, so a plain object is the same plugin.

## Permissions

Each permission opens these methods of `ctx.astera` to the plugin. A call without its permission is refused with
`PERMISSION_DENIED` (an `AsteraError`, exit code 5 in the SDK's terms), and a command the table does not list is
refused to every plugin, `call()` included, as `agentProfiles.list` and `agentProfiles.get` are: no permission opens
the agent profiles to a plugin. `call('requests-show', ...)` needs no permission: it reads only the plugin's own request
receipts.

| Permission | Lets the plugin call |
|---|---|
| `projects.read` | `projects.list`, `projects.get` |
| `jobs.read` | `jobs.list`, `jobs.get`, `jobs.wait` |
| `jobs.create` | `jobs.create` |
| `jobs.run` | `jobs.run` |
| `runs.read` | `runs.list`, `runs.get`, `runs.wait`, `runs.follow` |
| `runs.control` | `runs.stop`, `runs.resume` |
| `tasks.read` | `tasks.list`, `tasks.get` |
| `tasks.write` | `tasks.create` |
| `questions.read` | `questions.list`, `questions.get` |
| `questions.answer` | `questions.answer` |
| `completion.read` | `completion.get` |
| `events.subscribe` | `events.list`, `events.cursor`, `events.subscribe` |
| `github.read` | nothing yet |
| `github.write` | nothing yet |
| `how-it-works.read` | nothing yet |

`jobs.create` given a `projectId`, and `jobs.list` filtered by one, read that project first, so they need
`projects.read` too.
`events.subscribe` hands a plugin every event, session events included, and with them the titles and folders of your
sessions and the text of the questions agents ask: grant it to a plugin you would show those to.
Ask for what the plugin needs and no more: a person sees the list before installing, and may uncheck any of it.
`ctx.permissions` is what was granted, so a plugin can leave out what it was not given rather than fail at it.

## The context

`activate(ctx)` gets everything the plugin has from Astera:

| | |
|---|---|
| `ctx.astera` | A client of the Host ([the SDK](sdk.md)), answered within the plugin's permissions. Astera closes it when the plugin stops. |
| `ctx.settings` | The settings a person gave it, with the manifest's defaults, secret ones included. Read once at the start: a change restarts the plugin. |
| `ctx.secrets` | `get`, `set` and `delete` on the plugin's own secret store ([Settings and secrets](#settings-and-secrets)). |
| `ctx.plugin` | Its `id`, `version` and `dir`, the installed copy it runs from. |
| `ctx.permissions` | The permissions granted, out of those it asked for. |
| `ctx.log` | `info`, `warn` and `error`, to the plugin's log ([Logs](#logs)). |
| `ctx.signal` | An `AbortSignal` that aborts when Astera stops the plugin. Pass it to whatever waits: a subscription, a `fetch`, a timer. In a handler (`onEvent`, `send`, `listItems`, `getItem`, `buildJobContext`, `runCheck`) it also aborts when that call runs past its time limit (30 seconds for an event or a notification, 15 for a job source, 30 minutes for a check). |

## Lifecycle

**Start.** The Host starts every enabled plugin when it starts, and starts a plugin when it is installed or enabled.
It runs the entry in a process of its own and calls `activate(ctx)`, which must finish within 30 seconds;
the plugin counts as running when it has. Work that goes on (a subscription, a timer) is started from `activate`
and not awaited, as the example in [TypeScript, and bundling](#typescript-and-bundling) does; an event plugin is
handed its events instead ([Event plugins](#event-plugins)). The process keeps running after `activate` returns,
until Astera stops it.

**Stop.** Disabling, removing or installing a plugin again stops it, and the Host leaving stops every plugin.
Configuring a running plugin restarts it; a `failed` one stays stopped until `astera plugins enable` starts it. To
stop a plugin, Astera aborts `ctx.signal` and calls `deactivate()`, and the process ends as soon as `deactivate`
finishes, at once when there is none: cleanup that must finish (a last post, a file closed) goes inside `deactivate`,
not in a listener of the signal. It has 5 seconds to finish before Astera ends the plugin and the processes it
started. A plugin does not keep the Host running.

**Crash.** Any end Astera did not ask for is a crash: an uncaught exception, an unhandled rejection, `process.exit()`,
an `activate` that throws or does not finish in time. A plugin that crashes is started again after 1, then 2 seconds;
the third crash without 30 seconds of steady running marks it `failed`, and it stays stopped until
`astera plugins enable` starts it again or the Host restarts. A plugin that cannot go on (say its subscription was
refused) can end its own process with a failure to hand itself to this policy, as the example in
[TypeScript, and bundling](#typescript-and-bundling) does.

## Event plugins

A plugin that names the `event` capability is handed each of Astera's events ([the list](sdk.md#events)) in its
`onEvent`, in order, one at a time. Beside the capability it asks for `events.subscribe`, the permission the events
need:

```json
{
  "capabilities": ["event"],
  "permissions": ["events.subscribe"]
}
```

A manifest that names the capability and not the permission is refused ("the event capability needs the
events.subscribe permission"), and so is an install that does not grant it.

```ts
import type { PluginDefinition } from '@astera-app/plugin-sdk'

export default {
  async onEvent(event, ctx) {
    if (event.type === 'gap') return ctx.log.warn('some events were lost before the next one')
    if (event.type === 'run.failed') ctx.log.warn(`Run ${event.payload.id} of job ${event.payload.jobId} failed`)
  }
} satisfies PluginDefinition
```

- **From where it left off.** Astera keeps the plugin's place in its events, in
  `<profile>/plugins/cursors/<folder>.json`. A plugin is handed the events after it first starts (a plugin waiting for
  a required setting has not started), and what happened while it was stopped (disabled, starting again after a
  crash, the Host not running) is handed to it when it runs again, as far back as Astera's event log keeps: up to its
  most recent 2000 events, fewer when events are large or the Host has started again since. Removing the plugin
  removes its place too.
- **One at a time, in order.** The next event waits until `onEvent` settles, so a slow plugin holds up only itself.
  `onEvent` is called only while the plugin runs, once `activate` has finished. When a call runs past 30 seconds
  Astera stops waiting and aborts that call's `ctx.signal`: pass it to what the handler waits on. A handler that does
  not stop goes on beside the event's next try, so one that can take that long must not mind running twice at once.
- **A failure is tried again.** When `onEvent` throws, rejects or has not settled within 30 seconds, Astera hands the
  same event over again after 1 second, then 2, 4 and so on up to 5 minutes. An event that keeps failing is given up
  after an hour, and the next one follows. The plugin's log has the first failure of an event, then a line every 10
  tries, and the event given up.
- **At least once.** An event can come twice, after a crash or a stop in the middle of one: `event.id` never repeats,
  so drop one you have seen.
- **A gap.** When events the plugin had not had were lost (older than the log keeps), `onEvent` gets
  `{ type: 'gap' }` first, then the oldest event the log holds.
- **A missing handler.** A plugin that names `event` and whose entry has no `onEvent` does not start: it shows as
  `failed`, and its log says why.

`ctx.astera.events.subscribe` inside `activate` still works, as [TypeScript, and bundling](#typescript-and-bundling)
shows; it starts from the moment it subscribes, and keeps no place across a stop.

## Notification plugins

A plugin that names the `notification` capability is sent, in its `send`, each thing worth telling a person: already
worded by Astera, in the language the app is set to, so a notifier posts the title and the body as they are. Its
notifications come from Astera's events, so it asks for `events.subscribe` as an event plugin does:

```json
{
  "capabilities": ["notification"],
  "permissions": ["events.subscribe"]
}
```

```ts
import { defineNotificationProvider } from '@astera-app/plugin-sdk'

export default defineNotificationProvider({
  async send(notification, ctx) {
    // Posted as it is: a kind this plugin does not know reads the same way
    ctx.log.info(`[${notification.level}] ${notification.title}: ${notification.body}`)
  }
})
```

`defineNotificationProvider` returns the provider it is given, as `definePlugin` does. A notification is
`{ id, kind, level, title, body, occurredAt, event }`: `id` is its event's id, `kind` its event's type, and `event`
the whole event, for its ids and detail. There are seven kinds (`NOTIFICATION_KINDS` in the SDK), with their English
sentences:

| `kind` | `level` | `title` | `body` |
|---|---|---|---|
| `question.created` | `action` | the Job's objective | Waiting for an answer: {question} |
| `session.input_needed` | `action` | the session's title | Waiting for permission. / Waiting for an answer to a question. / Waiting for input. |
| `run.failed` | `error` | the Job's objective | Run {ordinal} failed ({done} of {total} Tasks done). |
| `completion.exhausted` | `error` | the Job's objective | The completion checks of {task} used every repair. |
| `session.limit_waiting` | `warning` | the session's title | Stopped at a usage limit; trying again at {time}. / Stopped at a usage limit. |
| `run.completed` | `info` | the Job's objective | Run {ordinal} finished. |
| `session.account_switched` | `info` | the session's title | Continuing on the {label} account. |

- **Titles.** A Job's is the title of the ticket it was made from, when it was made from one, else the first line of
  its objective that holds something, as it stands when the notification is made, or the Job's id once the Job is
  gone; a session's is its title, else the last part of its folder, else Astera.
  A value set into a sentence is cut at 500 characters and a title at 120, with `…`.
- **Every kind is sent.** Choosing what to hear is the plugin's: offer a setting for the kinds it leaves out, as the
  Discord sample's `skip` does. A later Astera may send a kind this list does not name yet: post a kind it does not
  know by its title and body.
- **Delivered as events are.** From where it left off, one at a time, and sent again when `send` throws, rejects or
  has not settled within 30 seconds ([Event plugins](#event-plugins)). A plugin that names both capabilities gets
  `onEvent`, then `send`, for each event: `onEvent` and `send` share the 30 seconds, and when `send` fails the whole
  event is handed over again, `onEvent` included.
- **Not stale.** A notification older than an hour when its turn comes is not sent: a notifier enabled the morning
  after does not post last night's prompts. Its log counts the ones skipped, in one line.
- **A gap** (events lost before the next one) sends nothing: a line in its log says so.
- **No link, and no focus rule.** A notification carries no link into the app, and it is sent even for the session
  you are looking at: Astera does not know what is on your screen, and a channel is for when you are away.

[The Discord sample](../examples/plugins/discord-notifier) posts each notification as an embed coloured by its level.

## Job source plugins

A plugin that names the `job-source` capability is a source of Jobs: Astera asks it for tickets, in its `listItems`,
`getItem` and `buildJobContext`, when a person looks for one to make a Job from (the app's Jobs view,
`astera sources`, the MCP tools), and makes the Job itself. It only answers Astera, so it needs no permission:

```json
{
  "capabilities": ["job-source"],
  "permissions": []
}
```

```ts
import { defineJobSourceProvider } from '@astera-app/plugin-sdk'

const tickets = [{ id: 'T-1', title: 'Fix the login page', body: 'It fails on Safari.' }]

const ticket = (id: string) => {
  const found = tickets.find((t) => t.id === id)
  if (!found) throw new Error(`there is no ticket ${id}`)
  return found
}

export default defineJobSourceProvider({
  listItems({ query }) {
    const found = tickets.filter((t) => query === undefined || t.title.includes(query))
    return { items: found.map(({ id, title }) => ({ id, title })) }
  },
  getItem(id) {
    const { title, body } = ticket(id)
    return { id, title, body }
  },
  buildJobContext(id) {
    const { title, body } = ticket(id)
    return { objective: title, sourceLabel: `Tickets ${id}`, evidence: [{ label: 'Description', content: body }] }
  }
})
```

`defineJobSourceProvider` returns the provider it is given, as `definePlugin` does. Each function is handed the
plugin's context last, as `onEvent` is, for its settings (an API key, say):

- **`listItems({ query, cursor })`** answers a page, `{ items, nextCursor }`. An item is
  `{ id, title, status?, url?, summary? }`, its `id` your own, opaque id (`ENG-123`). `query` is what the person
  searched for, and `cursor` the `nextCursor` of the page before; a page with no `nextCursor` is the last.
- **`getItem(id)`** answers one item read whole: the item's fields with a `body`, and `fields`, short name and value
  pairs shown beside it. Throw for an id you do not know.
- **`buildJobContext(id)`** answers what a Job made from the item is to do:
  `{ objective, sourceLabel, sourceUrl?, evidence?, metadata? }`, where `evidence` is a list of `{ label, content }`.

A plugin that names `job-source` and lacks any of the three does not start, and its log names the one missing.

**Astera checks and cuts what it answers.** The plugin is trusted code, but the ticket inside its answer was written by
someone else, and a page of any size must not slow the window it lands in:

- An item's `id` is 1 to 200 characters with no control character, or the answer is refused. Its `title` is cut at
  300 characters, its `status` at 100 and its `summary` at 1,000, and a `url` that is not http or https is dropped. A
  page keeps 100 items, and a `nextCursor` longer than 2,000 characters is refused.
- A `body` is cut at 20,000 characters, and `fields` keep 50 pairs.
- An `objective` is cut at 20,000 characters and a `sourceLabel` at 200. `evidence` keeps 20 entries, each cut at
  20,000 characters and 100,000 in all, and `metadata` keeps 50 pairs.

An answer of the wrong shape is refused, saying what is wrong ("the Linear source answered with something that is not
a page of items: item 0 has no id"). Text past a limit is cut, with `…`, and a list or an item that was cut says so
with `cut: true`.

**Errors reach the person.** Each call has 15 seconds. A function that throws or rejects answers 502 with its message
("the Linear source could not list items: 401 Unauthorized"), so throw the sentence a person should read. Past 15
seconds the answer is 504, and the call's `ctx.signal` aborts. A plugin that is not running (disabled, failed, or waiting to restart) is not asked, and
the answer is 503 with its status and reason. The plugin's log has the same line, its secrets hidden. Astera tries
nothing again: the person does.

**Astera writes the Job's objective, not the plugin.** It is a first line of Astera's own,
`Resolve <sourceLabel> (<sourceUrl>).`, a sentence saying that what follows is the item's content quoted as data and
not instructions, then a block between `<<<SOURCE <tag>` and `SOURCE <tag>>>>` holding your `objective`, each
`evidence` entry under its label and the `metadata` as `name: value` lines. The tag is made from the content, so the
content cannot close the block, and a line of it that starts like a marker is pushed off it by a space. The whole is
cut at 60,000 characters. Your `objective` goes inside the block too: the plugin is trusted, but that sentence came
from the ticket.

**The Job keeps its source.** A Job made from an item carries `source`, `{ id, itemId, label, title, url }`: the
plugin's id, the item's id, your `sourceLabel`, the first line of your `objective` (at most 300 characters), and your
`sourceUrl`. The app names the Job by that `title` and shows the label as a link to the ticket, and `jobs.get` and
the `job.created` event carry it. Only Astera sets it. A second Job from the same item is allowed, and each item lists
the Jobs already made from it.

`github` is the id of the source Astera has built in (GitHub issues), so a plugin by that name is not listed as a
source.

[The Linear sample](../examples/plugins/linear-source) lists a team's Linear issues with a personal API key.

## Completion check plugins

A plugin that names the `completion-check` capability checks a Task's work. A Task names it among its checks as
`plugin:<id>`, beside its run configurations and in their order (`astera tasks add --validate npm-test,plugin:<id>`).
When the Task's worker says it is done, Astera runs the checks one after another, stopping at the first that fails,
and at this one it asks the plugin, in its `runCheck`. Installing a plugin adds no check: only an id a person put in a
Task's list runs. It only answers Astera, so it needs no permission:

```json
{
  "capabilities": ["completion-check"],
  "permissions": []
}
```

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { defineCompletionCheckProvider } from '@astera-app/plugin-sdk'

const run = promisify(execFile)

export default defineCompletionCheckProvider({
  async runCheck({ workspace }) {
    // The migrations the Task changed, deleted or renamed since its work started, named from its folder as they are
    // on disk. A new migration is how to change the schema, so an added one is not listed.
    const args = ['-c', 'core.quotepath=false', 'diff', '--name-only', '--relative', '--diff-filter=MDR', workspace.base ?? 'HEAD', '--', 'migrations/']
    const listed = await run('git', args, { cwd: workspace.root }).catch((e: { stderr?: string }) => {
      // git's first line, the sentence a person reads in the question
      throw new Error(`git could not list the changes: ${String(e.stderr ?? '').trim().split('\n')[0] || 'git failed'}`)
    })
    const touched = listed.stdout.split('\n').filter((file) => file !== '')
    if (touched.length === 0) return { status: 'passed', summary: 'no migration was changed' }
    return {
      status: 'failed',
      summary: `${touched.length === 1 ? 'a migration was' : `${touched.length} migrations were`} changed: add a new one instead`,
      diagnostics: touched.map((file) => ({ file, message: 'changes a migration that may have run already' }))
    }
  }
})
```

`defineCompletionCheckProvider` returns the provider it is given, as `definePlugin` does. `runCheck(input, ctx)` is
asked with:

- `jobId`, `runId`, `taskId`, `projectId` when the Job has a project, and `task.title`;
- `workspace.root`, the folder the Task's checks run in (its worktree, or the project folder), and `workspace.base`
  and `workspace.head`, the commit the Task's work started from and the one its last attempt reached, when Astera
  recorded them. A check configured per project reads the project's own files under `root`; the plugin's settings are
  the rest of its configuration.

**A check plugin runs outside any sandbox, for every Task.** It is trusted code running as you
([Plugins are trusted code](#plugins-are-trusted-code)). A Task whose workers ran in their CLI's sandbox has its run
configuration checks run in that sandbox too ([docs/cli.md](cli.md), agent profiles), but Astera does not put a
plugin there. A plugin that runs a linter, a test or a build in `workspace.root` runs files a sandboxed worker may have
written, as you. Write such a plugin to read the folder, or to run what it runs in a sandbox of its own.

It answers `{ status, summary?, diagnostics?, diagnosticsTotal?, externalUrl? }`. `status` is `passed`, `failed` (the code's fault) or
`error` (the check could not be made: a service down, a missing token). A diagnostic is a finding,
`{ file?, line?, message, severity? }`, `severity` `error` or `warning`. A plugin that names `completion-check` and has
no `runCheck` does not start, and its log says why.

**Astera checks and cuts what it answers.** The plugin is trusted code, but its answer reaches a worker's instructions
and a person's screen. `summary` is cut at 1,000 characters, and is the status word when there is none. `diagnostics`
keep the first 20, and the result's `diagnosticsTotal` then says how many there were: a check that found thousands
sends its first 20 and its own `diagnosticsTotal` rather than all of them, and gives the whole report as `externalUrl`.
A `passed` check keeps its summary and link and none of its findings, as a passed run configuration keeps none of its
output. Each `message` is required and cut at 1,000 characters, each `file` at 500, a `line` that is not a positive
integer is dropped, and so is a `severity` that is not one of the two. An `externalUrl` that is not http or https, or is longer than 2,048 characters, is dropped. An answer
of the wrong shape counts as `error`, saying why ("the plugin answered with something that is not a check result:
status must be passed, failed or error").

**Each call has 30 minutes**, as a run configuration's check has. A `runCheck` that throws or rejects counts as `error`
with its message ("runCheck threw: git is not installed"), so throw the sentence a person should read. A call past 30
minutes (its `ctx.signal` then aborts: pass it to the build or the request you start), a plugin that is not running (disabled, failed, or waiting to restart) and a plugin that crashes mid call
count as `error` too, each saying so. A plugin that is starting is waited for, up to a minute. The same check of the
same Task, asked twice at once (by the app and the Host both, say), is asked of the plugin once.

**A failed check goes to the repair loop.** In a Job with `--convergence`, the Task's repair request names the check
and gives its summary, its first 20 findings as `file:line message`, and its link, as it gives a run configuration's
output; the recheck runs the Task's checks again. In a Job without it the Task fails, and its coordinator is told, as
for any check. The plugin runs no loop of its own: Astera keeps the retries and the repairs.

**A check that could not be made goes to a person.** An `error` is asked again at once. A second one is not the code's
fault: no repair is sent and none is spent. The Task waits on a question of kind `check-unavailable`, "The check could
not be made: <plugin>: <reason>", whose answers are its `options`: `retry` runs the Task's checks again, `skip-check`
lets this round go on without the check (the result keeps `skipped: true`, and the checks after it run), and
`mark-failed` fails the Task. The app, `astera questions answer` and MCP's `answer_question` answer it; any other
answer is refused.

**A missing plugin is refused before a Run starts.** `tasks add`, `jobs run` and `run-start` refuse a check list that
names a plugin that is not installed, does not offer completion checks, or is disabled, with
`PLUGIN_CAPABILITY_MISSING` and a sentence saying which. A Job on a paired Runtime runs its checks there, so the plugin
must be installed on the Runtime.

**A pass skips nothing else.** A plugin's `passed` counts for its own check only, and the Task's check list is part of
its completion policy, so changing it shows as a changed policy.

The result is a check like any other in `astera runs checks` (its `--human` lines show a failed plugin check's first
findings, and one that could not run as "could not run: <reason>"), in MCP's `get_completion`, in the SDK's
`completion.get` and in the `completion.*` events, with its `configId` `plugin:<id>` and its `name` the plugin's
display name.

[The debug-leftovers sample](../examples/plugins/debug-leftovers) fails a Task whose changes add a `console.log`, a
`debugger`, a `TODO` or a `FIXME`, naming each at its file and line.

## Logs

`astera plugins logs --id <id>` prints the last lines of the plugin's log (`--lines <n>` for more), and the app opens it
from Settings → Plugins. It is a file, `<profile>/plugins/logs/<folder>.log`: `<profile>` is Astera's data folder,
which `astera host status` names, and the folder is the id with a scope's `/` written as `+`. It is kept to 2 MiB,
with one older file beside it. Each line has its time, and holds:

- what the plugin wrote with `ctx.log`, as `[info]`, `[warn]` or `[error]`;
- anything the plugin, or a child process that shares its output, printed on stdout or stderr, as it was printed;
- Astera's own lines, as `[host]`: started, running, exited, restarting, failed and why;
- the launcher's, as `[launcher]`: an entry that could not be loaded, or an `activate` that threw, with its stack.

The log takes up to 1,000 lines or 1,048,576 characters a second of what a plugin prints, its `ctx.log` lines and the
launcher’s included, as Astera reads each line on the thread that also serves your terminals. Past that, lines are
dropped and counted: a `[host]` line says how many once the second is over, and when the plugin ends, the last 20 it
dropped are written after it, so a crash at the end of a flood keeps its stack. Astera’s own `[host]` lines are never
dropped.

**Secrets are hidden.** Every secret setting, and every secret the plugin read or set, is replaced by `[redacted]` in
the log and in the reason `plugins list` gives, each line of a secret that runs over several lines too; a value shorter
than 4 characters is not hidden, as it would take ordinary words out of every line. Only the value itself is found: a
token the plugin encodes, splits or puts in a URL of its own is not, so do not log secrets in any form.

## Settings and secrets

**Settings** are what a person gives the plugin: a URL, a project, a token. The manifest declares them in
`astera.settingsSchema`, a small part of JSON Schema:

```json
"settingsSchema": {
  "type": "object",
  "properties": {
    "baseUrl": { "type": "string", "title": "Jira URL", "description": "Such as https://acme.atlassian.net" },
    "token": { "type": "string", "title": "API token", "secret": true },
    "intervalMinutes": { "type": "integer", "title": "Check every", "default": 5, "enum": [1, 5, 15, 60] }
  },
  "required": ["baseUrl", "token"]
}
```

- A setting's type is `string`, `number`, `integer` or `boolean`.
- Its keywords are `type`, `title` (up to 64 characters), `description` (up to 500), `default`, `enum` (up to 50
  choices, not for a boolean) and `secret` (`true`, for a string). Any other keyword is refused, so a manifest that
  uses one does not install.
- A key is a letter, then letters, digits or `_`, at most 64 characters; two keys that differ only in case are
  refused. A manifest declares at most 50 settings.

A person sets them with `astera plugins configure --id <id> --set key=value`, or `--stdin key` for a secret so it stays
off the command line, or in the app's form for the plugin. A running plugin starts again with the new values. A plugin
missing a required setting does not start: it waits, and `plugins list` says which settings it needs.

A **secret setting** is kept apart from the others, in the plugin's own store under the profile: it is never shown
back (`plugins settings` says only whether it is set), no other plugin can read it through Astera, and it is hidden in
the log. It is a file under the profile, readable by any program running as you, as [any plugin is](#plugins-are-trusted-code).

**Secrets** the plugin keeps itself (a token it was given in exchange for another, say) go in the same store, through
`ctx.secrets`. A name is letters, digits, `_`, `-` and `.`, at most 73 characters, not starting or ending with `.`,
and `Token` is the same name as `token`. A value is text of at most 65,536 characters. A secret is hidden in the log
from the moment the plugin reads or sets it.

Removing a plugin deletes its settings and secrets. Astera keeps nothing else for a plugin: its installed copy is
replaced when it is installed again, so a plugin that must remember something across restarts keeps it in a folder of
its own.

## The Node a plugin runs on

A plugin runs on the Node its Host runs on, so the computer needs no Node install. On Windows that is a Node Astera
ships for its Host, `astera-host.exe`; on macOS and Linux it is Astera's own executable run as Node, from Electron 41.
Both are Node 24.15, with Node's own modules and globals (`fetch`, `WebSocket`, `AbortSignal.any` and the rest). The
plugin starts in its installed copy, with the Host's environment less Astera's own variables.

**`process.execPath` is not a `node` to count on.** On macOS and Linux it is Astera itself: a child started from it
without `ELECTRON_RUN_AS_NODE=1` in its environment starts as Astera rather than Node. On Windows it is the Host's
Node, where the variable does nothing. Set it either way, and `fork()` needs the same `env`. Do not count on a `node`
on the `PATH` either: the computer may have none.

```js
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url))
const child = spawn(process.execPath, [worker], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit'
})
```

With `stdio: 'inherit'` the child's output goes to the plugin's log. Worker threads (`node:worker_threads`) need
nothing of this.

**Native addons.** An addon built on Node-API loads on every platform, as most prebuilt ones are. One built for a
particular Node version loads on Windows only if it was built for Node 24, and not on macOS or Linux, where Electron's
Node numbers its version differently: use Node-API. Astera runs no install script, so an addon that is compiled when
it is installed is never built: ship its prebuilt binaries for each platform in the package, or do without it.
`astera plugins doctor` warns about each `.node` file it finds.

## Packaging

### From a folder

`astera plugins install --path <folder>` copies the folder into `<profile>/plugins/installed`, so later edits to it
do nothing until you install it again. The copy holds plain files and folders:

- `node_modules` is copied as it is, so the dependencies `npm install` puts there (hoisted, npm's default) work;
  their dev tools are copied too, unless you install with `npm install --omit=dev` first.
- A link that stays inside the folder is followed and what it leads to is copied. A link that leads outside it,
  leads nowhere or loops stops the install. `npm install <a folder>` makes such a link: install a packed copy of that
  package (`npm pack` there, then `npm install` the `.tgz`), or bundle.
- Dependencies installed with pnpm's isolated layout (`node_modules/.pnpm`) or npm's linked strategy
  (`node_modules/.store`) find each other through links a copy cannot keep, so they stop the install: install them
  hoisted (`node-linker=hoisted`), or bundle.
- `.git` at the top is left out.

### From npm

Publish the package to npm (or a registry of your own) with its `astera` field, and install it by name:

```sh
astera plugins install --npm @acme/astera-jira
astera plugins install --npm "@acme/astera-jira@^1.2"
```

A range goes in quotes, as here: cmd.exe takes `^` for its escape character and drops it.

Astera fetches it with `npm pack` and unpacks it itself, refusing a package that holds a link, a path outside it, a
file name Windows cannot keep, two names that differ only in case, or more than 20,000 entries or 256 MiB. Its
`dependencies` and `optionalDependencies` are installed with
`npm install --omit=dev --ignore-scripts --no-bin-links --no-package-lock`, in a folder of Astera's, hoisted, and
moved into its `node_modules`; what the package bundles stays as it shipped. So `devDependencies` are not installed,
no install script runs, neither the package's nor a dependency's, no command links are made, and your
`package-lock.json` is not used: each install resolves the ranges afresh, within its `overrides`. Pin what must not
move, or bundle. Keep the package small with `files` in `package.json`. Astera runs your own npm when Node.js is installed, so your `.npmrc` (registries,
scopes, tokens) applies; without it, Astera fetches an npm of its own ([the `astera` command](cli.md#plugins) says
how).

### TypeScript, and bundling

Install the plugin SDK for its types, as a dev dependency. npm installs `@astera-app/client` beside it, whose types
`ctx.astera` has:

```sh
npm install --save-dev @astera-app/plugin-sdk typescript @types/node
```

A plugin uses Node's globals (`process` below), whose types are `@types/node`'s: put `"types": ["node"]` in the
`compilerOptions` of its `tsconfig.json`, which a new one leaves empty. Import the types only and export a plain
object, so the plugin needs nothing of the SDK when it runs: an install from npm leaves dev dependencies out.

```ts
import type { PluginContext, PluginDefinition } from '@astera-app/plugin-sdk'

async function watch(ctx: PluginContext): Promise<void> {
  for await (const event of ctx.astera.events.subscribe({ types: ['run.failed'], signal: ctx.signal })) {
    if (event.type === 'run.failed') ctx.log.warn(`Run ${event.payload.id} of job ${event.payload.jobId} failed`)
  }
}

export default {
  activate(ctx) {
    // Not awaited: activate must finish soon, and this runs until Astera stops the plugin
    watch(ctx).catch((e: unknown) => {
      if (ctx.signal.aborted) return
      ctx.log.error(`stopped: ${String(e)}`)
      // Once the line above has left: ctx.log writes to stderr, which a pipe may write later
      process.stderr.write('', () => process.exit(1))
    })
  }
} satisfies PluginDefinition
```

Compile it with `tsc` and point `astera.entry` at the output. A plugin with dependencies is often simplest bundled
into one file, which installs from a folder or from npm with no `node_modules` at all:

```sh
npx esbuild src/index.ts --bundle --platform=node --format=cjs --outfile=dist/index.cjs
```

Bundle to CommonJS, as here, and point `astera.entry` at `dist/index.cjs`. Many dependencies are CommonJS and
`require()` Node's modules, which an ES module bundle cannot do: it loads, then fails with
`Dynamic require of "events" is not supported`.

## Developing a plugin

Edit, install again, read the log:

```sh
astera plugins install --path . --yes
astera plugins logs --id <id>
astera plugins doctor --id <id>
```

Installing the same plugin again replaces its copy, asks for your approval again (`--yes` gives it), and starts the
new copy. `plugins doctor` checks what could keep it from running: the manifest, whether this Astera runs it, the
entry file, native addons, its settings, and how it last ran. It exits 1 when anything would.

Start from [the sample](../examples/plugins/webhook-notifier), an event plugin that posts Astera's events to a
webhook: plain JavaScript with no dependency, typed against the SDK by JSDoc comments, with tests that run it in
Astera's plugin runtime.

## Troubleshooting

`astera plugins list` gives each plugin's status, and the reason when there is one.

**`incompatible`.** This Astera will not run it, and the reason says why: a Plugin API it does not speak, a
`minAsteraVersion` newer than this Astera, or a capability it does not run yet. Update Astera, or take the
capability out of the manifest.

**`stopped`, needs settings.** A required setting has no value. Set it with `astera plugins configure`.

**`failed`.** It kept crashing ([Lifecycle](#lifecycle)). `astera plugins logs` shows why: the `[launcher]`
and `[error]` lines, and the `[host]` lines saying how it ended. Fix it (its code, or its settings with
`astera plugins configure`), then run `astera plugins enable --id <id>`: configuring it alone does not start it again.
Installing it again starts it too.

**`<command> needs the <permission> permission, which plugin <id> was not granted` in its log.** That is the Host's
answer to a call the plugin made, refused with `PERMISSION_DENIED`: the person who installed it did not grant that
permission. Install it again and grant it.

**The install stops on a link, pnpm or `.store`.** See [From a folder](#from-a-folder).

**An npm install fails.** The answer carries npm's last lines, with registry tokens taken out. When Astera could not
fetch an npm of its own (a company network, a firewall or a proxy may block registry.npmjs.org), the answer says so:
install Node.js, or install from a folder. [The `astera` command](cli.md#plugins) has the details.

**A child process starts Astera** (on macOS or Linux). It was started from `process.execPath` without
`ELECTRON_RUN_AS_NODE=1` ([The Node a plugin runs on](#the-node-a-plugin-runs-on)).

## Not yet

- The `github` and `how-it-works` commands for plugins, which their permissions are already named for.
- A folder for each plugin's own data, and a development mode that reloads a plugin as you edit it.
