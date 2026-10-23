# Changelog

`@astera-app/client` is versioned apart from the Astera app. [docs/sdk.md](https://github.com/parsingk/Astera/blob/main/docs/sdk.md)
is the guide.

## 0.5.0

- Agent profiles (the Astera that ships agent profiles or later; an older one answers these with `VERSION_MISMATCH`):
  `agentProfiles.list()` and `agentProfiles.get(idOrName)` read the profiles a person made in Astera or with
  `astera agent-profiles`, each an `AgentProfile` (its accounts in order, the shared MCP servers it leaves out as
  `mcpExclude`, and its `permission`: `inherit`, `bypass` or `ask`).
- `jobs.create` and `tasks.create` take `agentProfileId`, an id or a name (the Astera that ships agent profiles or
  later; an older one ignores it on `jobs.create` and refuses `tasks.create` without `accountIds`). A Job's Tasks run
  as its profile unless a Task names its own, and the profile never picks the coordinator. A Task with a profile and no
  `accountIds` runs on the profile's accounts, so `tasks.create` no longer needs the Job's coordinator account for it.
- `Job.agentProfileId` and `Task.agentProfileId`: the profile they run as, by its id. A `Run`'s worker attempts
  (`TaskAttempt.agentProfileId`) carry it too.
- Token totals (the Astera that ships observe mode or later; an older one leaves them out): `runs.get` carries `tokens`,
  what the Run's Tasks' sessions spent, and `coordinatorTokens`, what its coordinator spent, apart; `tasks.get` carries
  the Task's `tokens`. Each is a `TokenTotals` (`input`, `output`, `total`), absent when the Host read none. No cost in
  money.

## 0.4.0

- The GitHub lifecycle (Astera 1.4.15 or later; an older one leaves these out): a Job's `github`
  (`GitHubLifecyclePolicy`: which CI checks decide, and the bounds of reruns and waits), a Run's `github`
  (`GitHubLifecycle`: the pull request Astera bound for its branch, its head, the CI checks of that head with a
  `verdict` and the check that failed first, and a `state`), and a GitHub issue source's `capturedBodyHash` and
  `capturedUpdatedAt` on `JobSource`.
- `GitHubLifecycle.failing.class` and `summary`: why the first failing check failed, as Astera classified it (test,
  build, lint, typecheck, infrastructure, timeout, permission, configuration, environment, cancelled, unknown).
- `GitHubLifecycle.state` also says where a Run's lifecycle Task stands while it works: `pr-ready`, `awaiting-push`,
  `repairing`, `reviewing`, `waiting-for-user`, `ci-infrastructure-failure` (a rerun of the head's CI in flight, or a
  question about one) and `exhausted`, and `merge-ready` once its review found the pull request ready (a script that
  switches on every state meets eight more). `GitHubLifecycle.mergeReady` holds the head and when while merge-ready
  holds, `invalidated` says why it was withheld or withdrawn, and `pr.reviewDecision` is GitHub's own review decision.
- `Task.kind`: `'lifecycle'` for the Task Astera adds once every other Task of a GitHub lifecycle Run is completed, to
  carry the Run through GitHub. It has no worker, and `tasks.create` on that Run is refused while it is open.
- Nine event types: `github.pr_bound`, `github.pr_created` (the pull request is one Astera opened), `github.head_changed`,
  `github.ci_passed`, `github.ci_failed`, `github.ci_rerun_requested` (a CI run of the head was rerun through Astera: by
  Astera itself when it failed for a reason outside the code, within the Job's `maxInfrastructureReruns`, or by a
  person's answer or command), `github.source_changed`, `github.merge_ready` (the review passed and the pull request is
  ready to merge) and `github.merge_ready_invalidated` (merge-ready withheld by the verdict or withdrawn since), each
  carrying the `Run` it moved. A script that switches on every `EventType` meets nine more.
- Seven `GateKind`s for the questions Astera asks about a GitHub lifecycle round: `github-no-ci` (no CI on the pushed
  head), `github-ci-cap` (the wait ran past `ciWaitMinutes`), `github-external-head` (a head Astera did not push),
  `github-pr-ambiguous` (several open pull requests), `github-pr-closed` (the bound pull request was closed or merged),
  `github-ci-outside` (CI failed for a reason outside the code, again for one Astera could not classify, or a repair
  fixed nothing) and `github-carry` (the round could not be taken to GitHub). Their `options` are among `wait`, `no-ci`, `continue`, `retry`, `rerun`, `mark-failed` and `pr-<n>`;
  `questions.answer` takes one of them.
- `GitHubLifecycle.pushedSha` (the commit Astera last pushed), `externalHead` (a head Astera did not push), `base` (the
  pull request's base as bound, with `reboundAt` after a retarget), `repair` (the lifecycle Task's repair attempt
  against the Job's budget, and while a repair runs its `subject`: GitHub CI, a local check, or the review's findings)
  and `noCi` (a person chose to go on without CI for the head).
- `GitHubLifecycle.review`: where Astera's review of the lifecycle Task stands, `running`, `passed`, or
  `found-issues` with the number of blocking issues the last review found.
- Ten `RunEventKind`s for a GitHub lifecycle Run's steps on its timeline (`runs.follow`): `github-pr-bound`,
  `github-pr-created`, `github-pushed`, `github-ci-started`, `github-ci-failed`, `github-ci-rerun`, `github-ci-passed`,
  `github-merge-ready`, `github-invalidated` and `github-source-changed`, each with the commit, check, pull request or
  reason (`github-invalidated`: the `GitHubInvalidatedReason`) in its `summary`, empty for `github-source-changed`. A
  script that switches on every `RunEventKind` meets ten more.

## 0.3.0

- A Job's `source`: the job source and the item it was made from (`{ id, itemId, label, title?, url? }`, `title` the item's own, at most 300 characters), when Astera made it
  from a ticket, a Linear issue or a GitHub issue, say. It needs Astera 1.4.14 or later; an older one leaves it out.
- `call()` of `jobs-create-from-source` answers with the Job's public fields, as `jobs.create` does.
- Completion check plugins: a Task's check list can name `plugin:<pluginId>`. `CheckResult` (and the completion read
  model's `CompletionCheckDetail`) gains the status `error`, a plugin's check that could not be made, and the optional
  `summary`, `diagnostics` (`CheckDiagnostic`: `file?`, `line?`, `message`, `severity?`; at most 20, none for a
  passed check), `diagnosticsTotal` (how many findings the plugin gave, when more than `diagnostics` holds), `externalUrl`
  and `skipped` (a person let the round go on without it; its status is `not-run`). Events (`task.*` and
  `completion.*`) carry a check's `diagnosticsTotal` and not its findings: `tasks.get` and `completion.get` read them.
  A script that switches on four statuses meets a fifth. The question a check that could not be made opens has the new `GateKind` `check-unavailable`, answered with
  `retry`, `skip-check` or `mark-failed`. It needs Astera 1.4.14 or later; an older one has no plugin checks.
- The error code `PLUGIN_CAPABILITY_MISSING` (exit 6): a Task's check names a plugin that is not installed, does not
  offer completion checks, or is disabled. `bodyCodeOf` reads it, and the remote codes, from a refusal's body. It
  comes from Astera 1.4.14 or later.

## 0.2.0

- Three session events in the public event log: `session.input_needed` (a session waits on a person, for a permission
  or a question), `session.limit_waiting` (it stops at a usage limit) and `session.account_switched` (it goes on under
  another account). Each carries the session it is about, typed `EventSession`, and names it in the event's new
  `sessionId`.

The session events need Astera 1.4.13 or later: an older one refuses them in `types` with `INVALID_ARGUMENTS`. The rest
needs Astera 1.4.12 or later, as 0.1.0 did.

## 0.1.0

The first release on npm. A client for the Astera Host on this machine, the one the desktop app, the `astera` command
and the MCP server reach:

- Projects, Jobs, Runs, Tasks, questions and completion as typed calls, and `call()` for any other Host command.
- `events.list`, `events.cursor` and `events.subscribe` on the Host's public event log.
- Stable error codes, request ids for calls that change something, and deadlines and cancellation on every call.
- ESM and CommonJS, with types, on Node 22 or later.

It needs Astera 1.4.12 or later.
