// `astera agent-context` — the whole command surface as JSON, printed by the binary that routes it.
//
// **Why it exists.** The first caller of this CLI is an agent, and until now it learned what it
// could do from prose: `docs/cli.md` for the public quarter of the surface and
// `resources/skills/orchestration-guide.md` for the rest. A document drifts from the program
// quietly, and an agent acts on a drifted document without checking. Emitting the surface from the
// binary makes the answer as new as the build that gives it.
//
// **It covers everything the CLI can route, not just the public commands.** The public ones are the
// 35 in `USAGE` (cliUsage.ts); the other 33 — `send`, `ask`, `check`, `worker-*`, `task-*`, `run-*`,
// `gate-*`, `session-task-*`, `handoff` — are what a coordinator or worker session actually calls,
// and their contract lives only in the guide's prose. Closing that gap is the point, so `public` is
// a field here rather than a filter.
//
// **What holds this honest, and what does not — the same split as cliUsage.ts.**
//
// 1. *The command set is held by the compiler, against `handleCommand` itself.* `SwitchedCommand`
//    below is `AgentCommand` minus the handful answered before the switch, and command.ts switches
//    on that type with a `never` check in its `default`. So a `case` added there with no entry in
//    this file does not compile ("not comparable to SwitchedCommand"), and an entry added here with
//    no `case` does not compile either (the `default` stops narrowing to `never`).
//    cliAgentContext.test.ts reads the `case` labels out of command.ts as a second witness, for the
//    day someone widens the type back to `string`.
// 2. *The flags are not held by anything.* They cannot be derived: no command declares them. Each
//    `case` reads what it wants out of `args` as it goes (`str(args.id)`, `args.ready === true`,
//    `typeof args.timeoutMs === 'number'`), and a few are read in the CLI before the call is made.
//    So the flags below are written by hand from those reads. For the public commands the doc guard
//    in cliUsage.test.ts checks them against `docs/cli.md`; **for the session-only commands there is
//    no second witness at all.** That is this file's standing risk, and it is the same one
//    cliUsage.ts carries: a flag list that has drifted is worse than none, because the caller acts
//    on it. Review is the only cover.
//
// **A local read.** No Host, no state file, exit 0 — the same footing as `--help`. A caller asking
// what the commands are must get an answer with nothing running.
import { CLI_ERROR_CODES, CLI_PROTOCOL, exitCodeFor, type CliErrorCode } from './cliOutput'
import { USAGE, invocationLine, type CommandUsage, type PublicCommand, type UsageFlag } from './cliUsage'

/** `--id <jobId>` where the placeholder names a Task. Repeated often enough to be worth a name. */
const req = (name: string, value: string, about: string): UsageFlag => ({
  name,
  value,
  required: true,
  about
})

const DISPATCH = (about: string): UsageFlag => req('dispatch', '<dispatchId>', about)
const RUN_ARG = (value: string, about: string): UsageFlag => req('run', value, about)

/**
 * The commands `USAGE` does not carry — the surface a session uses and a shell does not.
 *
 * **Every flag here was read off its `case` in command.ts**, not off the guide: the guide describes
 * the ones a coordinator is meant to use and is silent about the rest, and silence is exactly what
 * this file exists to end. Two consequences worth stating, because both look like omissions:
 *
 * - `run-create --schedule` is real in the handler and is **not** listed. It wants a rule object,
 *   and `parseArgs` can only produce strings and JSON arrays, so no command line can satisfy it —
 *   the app reaches that field over IPC. A flag no caller of this CLI can use does not belong in
 *   the CLI's own schema.
 * - The undocumented spellings are not listed either: `task-create --run-id` for `--run`,
 *   `worker-start --task-id` for `--task`, `questions answer --resolution` for `--answer`. They are
 *   accepted, they are aliases, and listing both would teach a vocabulary with two words for one
 *   thing.
 */
const SESSION = {
  'run-create': {
    summary: 'create a Job and start its first run',
    detail:
      'Returns the run, which is the id `task-create --run` wants. Pass --cwd: without it the run takes the working directory of whatever shell called this, and every worker comes up there.',
    flags: [
      req('objective', '<text>', 'what this Job is for'),
      { name: 'cwd', value: '<path>', about: 'the repository root this Job belongs to' },
      { name: 'concurrency', value: '<n>', about: 'how many workers this Job places at once' },
      {
        name: 'coordinator-account',
        value: '<accountId>',
        about: 'the account the coordinator session runs on (one, not a list)'
      },
      {
        name: 'convergence',
        about: 'repair failing Tasks for you instead of the coordinator retrying them'
      },
      { name: 'max-fix-attempts', value: '<n>', about: 'repairs per Task; needs --convergence' },
      { name: 'max-review-rounds', value: '<n>', about: 'review rounds per Task; needs --convergence' },
      {
        name: 'blocking-severity',
        value: '<high|medium>',
        about: 'which review findings block; needs --convergence'
      },
      { name: 'max-total-minutes', value: '<n>', about: 'time budget per Task; needs --convergence' },
      { name: 'auto', about: "this Job's workers are placed for you, and it holds until `run-start`" }
    ]
  },
  'run-configs': {
    summary: "the run configurations of the latest run's project",
    detail:
      'The ids `task-create --validate` accepts. It takes no --run: it always reads the latest. `run-configs list --job` is the same list for a named Job.'
  },
  'run-use': {
    summary: 'check that a run exists',
    detail: 'It binds nothing to this session — the commands that take --run still need it.',
    flags: [req('id', '<runId>', 'the run to check')]
  },
  'run-start': {
    summary: "clear a Job's start gate and run it",
    flags: [RUN_ARG('<jobId>', 'the Job to start')]
  },
  'run-pause': {
    summary: 'hold a scheduled Job so it fires no more runs',
    flags: [RUN_ARG('<jobId>', 'the Job to hold')]
  },
  'run-resume': {
    summary: 'let a held Job fire again',
    flags: [RUN_ARG('<jobId>', 'the Job to let go')]
  },
  'run-spawn': {
    summary: 'start one more run of a Job',
    flags: [RUN_ARG('<jobId>', 'the Job to run again')]
  },
  'run-merge': {
    summary: "merge this run's worktrees back into the project",
    detail: 'It does not remove the worktrees afterwards.',
    flags: [RUN_ARG('<runId>', 'the run whose worktrees to merge')]
  },
  'run-worktree-set': {
    summary: "record this run's worktree",
    flags: [
      RUN_ARG('<runId>', 'the run to record it on'),
      req('worktree', '<path>', 'the worktree folder')
    ]
  },
  'run-delete': {
    summary: 'delete a Job with its runs, or one run',
    detail: 'Refused while a worker of it is open.',
    flags: [
      req('id', '<jobId|runId>', 'the Job or the run to delete'),
      { name: 'merge', about: 'merge the worktrees before deleting' },
      { name: 'remove-worktrees', about: 'delete the worktree folders too' }
    ]
  },
  'task-create': {
    summary: 'add a Task to a run',
    detail:
      "Pass --run every time. Without it the Task lands in whatever run was created last across the whole app, which may be someone else's.",
    flags: [
      req('spec', '<text|->', 'the work, in full (a value of `-` reads it from stdin)'),
      req('account', '<id,…>', 'the accounts a worker for this Task may run on'),
      {
        name: 'run',
        value: '<runId|jobId>',
        about: 'where it goes (default: the latest run); a Job id makes a definition Task'
      },
      { name: 'title', value: '<text>', about: "a short name (default: the spec's first line)" },
      { name: 'deps', value: '<json array>', about: 'the Task ids this one waits for' },
      { name: 'validate', value: '<configId,…>', about: 'run configurations that must pass' },
      { name: 'parent', value: '<taskId>', about: 'the Task this one was split out of' },
      { name: 'review', about: 'have the result reviewed before it counts as done' }
    ]
  },
  'task-update': {
    summary: "set a Task's status by hand",
    detail:
      'It bypasses the transition table. --convergence off and --status cannot be sent together.',
    flags: [
      req('id', '<taskId>', 'the Task to change'),
      { name: 'status', value: '<s>', about: 'the status to set' },
      { name: 'result', value: '<text|->', about: 'what the Task produced' },
      { name: 'reason', value: '<text>', about: 'why it was set by hand' },
      { name: 'convergence', value: '<off>', about: 'stop repairing this Task (there is no on)' }
    ]
  },
  send: {
    summary: "post a message into the run's inbox",
    detail:
      '--type worker_done is how a worker reports, and it is the one type whose --task-id, --dispatch-id and --outcome are always required. The others take the dispatch of the calling session.',
    flags: [
      req('type', '<status|worker_done|question|escalation|heartbeat|decision_gate>', 'what kind of message'),
      { name: 'task-id', value: '<taskId>', about: 'the Task it is about (required for worker_done)' },
      {
        name: 'dispatch-id',
        value: '<dispatchId>',
        about: 'the dispatch it comes from (required for worker_done)'
      },
      { name: 'outcome', value: '<succeeded|failed>', about: 'how it went (required for worker_done)' },
      { name: 'subject', value: '<text>', about: 'one line' },
      { name: 'body', value: '<text|->', about: 'the body (a value of `-` reads it from stdin)' },
      { name: 'files-modified', value: '<a,b,c>', about: 'the files this Task changed (worker_done only)' }
    ]
  },
  reply: {
    summary: "answer a worker's question",
    flags: [
      req('id', '<messageId>', 'the question to answer'),
      req('body', '<text|->', 'the answer (a value of `-` reads it from stdin)')
    ]
  },
  check: {
    summary: 'take the next batch of messages for the coordinator',
    detail:
      'The same batch replays until it is acknowledged with --ack <deliveryId>. A timeout is success (exit 0) with `timedOut` in the body, not a failure.',
    flags: [
      { name: 'run', value: '<runId>', about: 'the run to read (default: the latest)' },
      { name: 'ack', value: '<deliveryId>', about: 'acknowledge the batch that id names' },
      { name: 'types', value: '<a,b,c>', about: 'only these message types' },
      { name: 'wait', about: 'hold the request open until something arrives' },
      { name: 'timeout-ms', value: '<ms>', about: 'how long --wait holds' }
    ]
  },
  inbox: {
    summary: 'the most recent messages, without acknowledging anything',
    flags: [{ name: 'limit', value: '<n>', about: 'how many (default 50)' }]
  },
  ask: {
    summary: 'ask the coordinator a question and wait for the answer',
    detail:
      'Either a new question (--question, with --task-id and --dispatch-id) or waiting again on one already asked (--resume). A timeout is success (exit 0) with `timedOut` in the body.',
    flags: [
      { name: 'question', value: '<text|->', about: 'the question (a value of `-` reads it from stdin)' },
      { name: 'task-id', value: '<taskId>', about: 'the Task it is about' },
      { name: 'dispatch-id', value: '<dispatchId>', about: "the asking dispatch (default: this session's)" },
      { name: 'options', value: '<a,b,c>', about: 'the answers to choose between' },
      { name: 'resume', value: '<questionId>', about: 'wait again on a question already asked' },
      { name: 'timeout-ms', value: '<ms>', about: 'how long to wait' }
    ]
  },
  'gate-create': {
    summary: 'block a Task on a decision',
    detail: 'For deciding the Task graph. Stopping a worker that is already running is `worker-stop`.',
    flags: [
      req('task', '<taskId>', 'the Task to block'),
      req('question', '<text|->', 'what has to be decided'),
      { name: 'options', value: '<json array>', about: 'the choices' }
    ]
  },
  'gate-resolve': {
    summary: 'resolve a gate with a decision',
    flags: [
      req('id', '<questionId>', 'the gate to resolve'),
      req('resolution', '<text|->', 'the decision')
    ]
  },
  'dispatch-show': {
    summary: 'the dispatches of one Task',
    flags: [req('task', '<taskId>', 'the Task to list them for')]
  },
  'worker-start': {
    summary: 'start a worker session for a Task',
    flags: [
      req('task', '<taskId>', 'the Task to work on'),
      req('agent', '<claude|codex>', 'which CLI the worker runs'),
      req('account', '<accountId>', 'the account it runs on'),
      { name: 'worktree', value: '<current|new|path>', about: "where it works (default: the run's)" },
      { name: 'name', value: '<text>', about: 'what to call the session' },
      { name: 'terminal', value: '<sessionId>', about: "reuse this finished session's terminal (a session of the same run)" },
      { name: 'retry-of', value: '<dispatchId>', about: 'the attempt this one retries' }
    ]
  },
  'worker-show': {
    summary: 'one dispatch and the state of its session',
    flags: [DISPATCH('the dispatch to read')]
  },
  'worker-read': {
    summary: "the tail of a worker's terminal output",
    flags: [
      DISPATCH('the dispatch to read'),
      { name: 'limit', value: '<n>', about: 'how many lines from the end' }
    ]
  },
  'worker-release': {
    summary: "close a finished worker's session",
    detail: 'Refused while the Task is still converging. A retained dispatch is reported, not closed.',
    flags: [DISPATCH('the dispatch to close')]
  },
  'worker-retain': {
    summary: "keep a worker's session alive past release",
    flags: [DISPATCH('the dispatch to hold open')]
  },
  'worker-stop': {
    summary: "stop a worker's session now",
    detail: 'The Task is left as it is. Refused while the dispatch is retained.',
    flags: [DISPATCH('the dispatch to stop')]
  },
  'worker-abandon': {
    summary: 'give up tracking a dispatch',
    detail: 'It touches no process and no folder — the session may still be running.',
    flags: [DISPATCH('the dispatch to let go of')]
  },
  accounts: {
    summary: 'the agent accounts the app holds',
    flags: [{ name: 'agent', value: '<claude|codex>', about: 'only this vendor' }]
  },
  reset: {
    summary: 'wipe orchestration state',
    detail: 'Refused while a dispatch is open. It copies the state file first.',
    flags: [
      { name: 'tasks', about: 'wipe the Tasks and dispatches' },
      { name: 'messages', about: 'wipe the messages and deliveries' },
      { name: 'all', about: 'wipe everything' }
    ]
  },
  'session-task-start': {
    summary: 'record that this session started a piece of work',
    flags: [req('objective', '<text>', 'what the work is')]
  },
  'session-task-complete': {
    summary: "record that this session's work finished",
    flags: [
      { name: 'check', value: '<name>=<status>', about: 'one verification result (repeatable)' },
      { name: 'summary', value: '<text|->', about: 'what was done' }
    ]
  },
  'session-task-cancel': {
    summary: "record that this session's work was dropped",
    flags: [{ name: 'reason', value: '<text>', about: 'why' }]
  },
  handoff: {
    summary: "save this session's Smart Resume memo",
    detail: 'Needs Smart Resume switched on. The memo is a JSON document.',
    flags: [req('memo', '<json|->', 'the memo (a value of `-` reads it from stdin)')]
  }
} satisfies Record<string, CommandUsage>

/** A command this CLI routes that a shell is not meant to type. */
export type SessionCommand = keyof typeof SESSION

/** Every command this binary can route, public and session-only. */
export type AgentCommand = PublicCommand | SessionCommand

/**
 * The commands `handleCommand`'s `switch` must **not** have a `case` for, each for one of three
 * reasons.
 *
 * *Answered by the CLI itself, so they never reach the command layer:* `help` and `browser-help`
 * read a guide off disk, `agent-context` prints this file, the three `host-*` commands ask
 * about the Host rather than about orchestration (src/cli/host.ts), and the two `skills-*` commands
 * read and write the profile's files with no Host at all (src/cli/skills.ts).
 *
 * *Answered before the switch:* `browser-js` and `handoff` each have their own toggle and need none
 * of the orchestration state the switch is built on, so `handleCommand` returns from an `if` above
 * it.
 *
 * *Answered by the **Host**, above the command layer entirely:* `requests-show` reads a request
 * receipt, and receipts live in the Host's memory rather than in the orchestration state (request
 * receipts design §4), so there is nothing here for a `case` to read. It sits beside `state-get`
 * and `state-put` in `src/host/orch.ts`, and a Host too old to know it answers 501 — exit 9 — for
 * free.
 *
 * **This is a hand-kept list, and `satisfies` is not the check it looks like.** It proves only that
 * these eleven names exist in the schema, which keeps a typo from quietly widening
 * `SwitchedCommand`. It proves nothing about anything answering them: a twelfth name added here would
 * compile, would pass the exhaustiveness check, and would 501 at runtime with no `case` and no
 * branch. cliAgentContext.test.ts carries the witness for that half — it asserts each name is
 * mentioned in one of the four files that can answer it. A text witness is weak, but it is the
 * difference between a claim and a check.
 */
const NOT_SWITCHED = [
  'help',
  'browser-help',
  'agent-context',
  'host-start',
  'host-status',
  'host-stop',
  'browser-js',
  'handoff',
  'requests-show',
  'skills-list',
  'skills-install'
] as const satisfies readonly AgentCommand[]

/**
 * Exactly the commands `handleCommand`'s `switch` has a `case` for.
 *
 * **command.ts switches on this type**, so the two directions are both compile errors: a `case`
 * this type does not name, and a name this type has with no `case` (the `never` in its `default`).
 */
export type SwitchedCommand = Exclude<AgentCommand, (typeof NOT_SWITCHED)[number]>

/** One flag, as a program reads it. `takesValue` rather than the placeholder, because what a caller
 *  has to decide is whether the next token belongs to this flag. */
export interface AgentContextFlag {
  readonly name: string
  readonly takesValue: boolean
  readonly required: boolean
  readonly about: string
}

export interface AgentContextCommand {
  /** The name on the wire, and the key everything else uses: `jobs-get`. */
  readonly name: string
  /** The line to type, with placeholders: `astera jobs get --id <jobId|runId>`. */
  readonly usage: string
  /** Public commands are `docs/cli.md`'s surface and are two words. The rest are one token, are
   *  documented only in the orchestration guide, and may change without notice. */
  readonly public: boolean
  readonly summary: string
  /** Only where one line would mislead. */
  readonly detail?: string
  readonly flags: readonly AgentContextFlag[]
}

export interface AgentContextExitCode {
  readonly code: CliErrorCode
  readonly exit: number
  readonly meaning: string
}

export interface AgentContext {
  /** The version of this envelope-and-exit-code contract, the same number `astera version` reports. */
  readonly protocol: number
  readonly output: {
    readonly ok: string
    readonly error: string
    readonly notes: readonly string[]
  }
  readonly globalFlags: readonly AgentContextFlag[]
  readonly commands: readonly AgentContextCommand[]
  readonly exitCodes: readonly AgentContextExitCode[]
}

/** What `error.code` means, one line each. The numbers are not written here — they come from
 *  `exitCodeFor`, which is the one table (cliOutput.ts). */
const MEANING: Record<CliErrorCode, string> = {
  FAILED: 'a failure none of the other codes describes',
  INVALID_ARGUMENTS: 'the parser refused, or the command rejected the arguments',
  HOST_NOT_RUNNING: 'the Host could not be reached, and the state file could not answer this command',
  NOT_FOUND: 'no such id',
  PERMISSION_DENIED: 'refused for this caller — a worker session calling a coordinator command',
  CONFLICT: 'refused because of current state, such as a Job that is already running',
  TIMEOUT: 'a deadline elapsed, or the Host is running and not answering',
  WAITING_FOR_INPUT: 'a wait stopped because a person is needed: a question is open, or the run is paused',
  VERSION_MISMATCH: 'the command exists in this CLI but not in the running build',
  RUN_FAILED: 'a wait ended with the Job or run in failure'
}

/** The flags every command accepts. They are read by the parser and by the output layer rather than
 *  by any one command (cliArgs.ts, run.ts), so no entry above carries them.
 *
 *  **`--request-id` is here rather than on 67 command entries, and that is the design's own
 *  argument** (request receipts design §3, §8): every command takes the key and the Host decides
 *  afterwards whether there was anything to record. Naming the set instead would mean a list beside
 *  a switch statement, and the command somebody forgets to add to it accepts the key and ignores
 *  it — which is precisely the failure this feature cannot afford, because the caller's whole
 *  reason for passing the flag is a belief about what happens next. */
const GLOBAL: readonly AgentContextFlag[] = [
  { name: 'json', takesValue: false, required: false, about: 'the envelope — the default, so this changes nothing' },
  { name: 'human', takesValue: false, required: false, about: 'aligned columns for a person; never parse them' },
  { name: 'quiet', takesValue: false, required: false, about: 'ids only, one per line' },
  // stdout is untouched by keepalives either way, so this is for a caller that wants stderr empty
  // rather than for one that is parsing anything (cliKeepalive.ts).
  {
    name: 'no-keepalive',
    takesValue: false,
    required: false,
    about: 'do not print the waiting line on stderr every 15s while a waiting command waits'
  },
  {
    name: 'request-id',
    takesValue: true,
    required: false,
    about:
      'this call\'s own id. Present the same id again and a command that already took effect is not done twice: the Host replays what it answered the first time. `astera requests show --id <id>` asks what became of it.'
  },
  { name: 'help', takesValue: false, required: false, about: 'print usage and exit 0 instead of running' }
]

const flagsOf = (entry: CommandUsage): AgentContextFlag[] =>
  (entry.flags ?? []).map((f) => ({
    name: f.name,
    takesValue: f.value !== undefined,
    required: f.required === true,
    about: f.about
  }))

const entryFor = (name: string, entry: CommandUsage, isPublic: boolean): AgentContextCommand => ({
  name,
  usage: invocationLine(name, entry.flags ?? []),
  public: isPublic,
  summary: entry.summary,
  ...(entry.detail === undefined ? {} : { detail: entry.detail }),
  flags: flagsOf(entry)
})

/**
 * The whole surface, built fresh each call.
 *
 * Sorted by name so a caller diffing two builds sees what changed rather than where things moved.
 */
export function agentContext(): AgentContext {
  const commands = [
    ...Object.entries(USAGE).map(([name, entry]) => entryFor(name, entry, true)),
    ...Object.entries(SESSION as Record<string, CommandUsage>).map(([name, entry]) =>
      entryFor(name, entry, false)
    )
  ].sort((a, b) => a.name.localeCompare(b.name))
  return {
    protocol: CLI_PROTOCOL,
    output: {
      ok: '{"ok":true,"data":{…}}',
      error: '{"ok":false,"error":{"code":…,"message":…,"details":{…},"nextSteps":[…]}}',
      notes: [
        'data is always an object. A list arrives under its own noun: data.jobs, data.tasks, data.questions, data.runs, data.projects, data.accounts, data.runConfigs, data.sessions; anything else is data.items.',
        'error.code is for branching, error.message is for a person, and error.nextSteps is a list of command lines to try — empty when there is nothing general to run.',
        'A timeout from `check --wait` or `ask` is a success: exit 0, with data.timedOut set.',
        // 요청 영수증 설계 §8·§7. 세 줄인 이유는 읽는 쪽이 다르기 때문이다 — 앞의 둘은 답을 받은
        // 뒤에 보는 칸이고, 마지막은 답을 못 받았을 때 손에 쥐는 줄이다. 그리고 앞의 둘은 서로 다른
        // 약속을 하므로 한 낱말로 묶을 수 없다.
        'replayed: true beside ok means this answer came out of a request receipt: you presented a --request-id that had already taken effect here, and the command was not run a second time. The exit code is the original answer\'s, so a replayed 404 still exits 4.',
        'observed: true beside ok is the other answer to an id you had already used, and it does not mean the same thing. The command committed once and then waited (ask, or check --ack --wait), so the commit was not repeated but the command did run again and this body is what is true now — a fresh poll can hand you a delivery you have never seen. Read it as a first answer, not as one you have already handled.',
        'When no answer came back at all — exit 3 with the connection dropped, or exit 7 with the deadline passed — error.details carries requestId, queryCommand and retryCommand. Run queryCommand first: `astera requests show --id <id>` says whether the command landed. retryCommand is the same line you ran with that id on it, for after you know, in POSIX shell syntax (bash, zsh, Git Bash; PowerShell reads the same quotes apart from a value containing one) — cmd.exe does not read single quotes, so requote there. A command that read a flag from standard input gets retryNote instead, because the payload was never on the line: run the same command again with that id and the same input.',
        "A timed out `ask` leaves the question open. Its data carries nextSteps — the same kind of command lines as error.nextSteps — with the one command that waits again on that question; when the id is unknown the list is empty and data.cannotResume says why. Do not ask again either way: a second question for the same person is answered once and waited on twice.",
        'While `ask`, `check --wait`, `jobs wait` or `runs wait` is waiting, a line goes to stderr every 15 seconds saying it is still waiting and when the Host last answered. stdout carries only the one result, so nothing has to be filtered out of it; --no-keepalive turns the lines off.'
      ]
    },
    globalFlags: GLOBAL,
    commands,
    exitCodes: CLI_ERROR_CODES.map((code) => ({
      code,
      exit: exitCodeFor(code),
      meaning: MEANING[code]
    }))
  }
}
