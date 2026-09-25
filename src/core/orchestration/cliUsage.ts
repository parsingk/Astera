// `astera --help` — the three levels of usage text, and the one table they are printed from.
//
// **The table is hand-kept, and it cannot be derived.** The flags a command takes are declared
// nowhere. Most are read ad hoc inside `handleCommand`'s `case` for that command (`str(args.id)`,
// `args.ready === true`, `typeof args.timeoutMs === 'number'`), and the rest are read in the CLI
// before the call is ever made: `browser js --file` is opened in run.ts, and `--skills-dir` is read
// by `resolveGuidePath` there. `parseArgs` only knows how to turn a token into a value, never which
// command wanted it. There is no declaration to generate from, so the flags below are written by
// hand. That is the risk this file has to manage, because a usage table that has drifted from the
// real flags is worse than no usage table at all: a person acts on it.
//
// **Two things hold it honest, and they hold different halves.**
//
// 1. *The command set* is held by the compiler. `PublicCommand` is derived from `NOUNS`
//    (cliArgs.ts) plus the standalone commands, and `USAGE` is a `Record` over it — a verb added to
//    `NOUNS` stops this file compiling until its usage exists, and a verb removed leaves an excess
//    property. This is the shape `cliPublic.ts` already uses to pin the public field allowlist.
// 2. *The flags* are held by cliUsage.test.ts against the `## Command reference` block of
//    `docs/cli.md`. Nothing can check a flag against the server, so what is checked is that the
//    published document and this table say the same thing: which flags a command has, whether each
//    takes a value, and which are required. Prose and placeholder names are not compared — the two
//    are written for different readers.
//
// **What neither holds, one:** that a flag listed here is a flag the program actually reads. A flag
// added to a `case` and to this table but not to the document fails the test; added to none of the
// three it stays invisible. Only review covers that gap. `help`'s `--skills-dir` is a live example,
// deliberately (see its entry).
//
// **What neither holds, two:** that this set *is* the public surface. The compiler pins
// `USAGE` to `NOUNS` plus `TOP` plus `BROWSER_VERBS`, but `TOP` is written by hand here, and
// `parseArgs` passes any first token it does not recognise straight through to the server. So a
// future one-word command — `astera doctor`, say — compiles clean with no usage at all, and the
// only thing that would notice is the doc guard, and only once someone had added it to
// `docs/cli.md`. A new *verb* cannot slip through, because `NOUNS` is where verbs are declared; a
// new *noun-less command* can. If one is added, add it to `TOP`.
//
// The text is plain, not JSON, and no part of it needs a Host. `--help` is for a person, and a
// person asking what the commands are must get an answer with nothing running.
import { BROWSER_VERBS, NOUNS, camel, renamedTo, verbsOf } from './cliArgs'

/** `jobs-wait`, `host-start`, … — every noun/verb pair `NOUNS` declares. */
type NounCommand = {
  [N in keyof typeof NOUNS]: `${N}-${(typeof NOUNS)[N][number]}`
}[keyof typeof NOUNS]

/** The commands with no verb. They have no noun either, so `NOUNS` cannot name them.
 *
 *  **`agent-context` has a dash and is still one token.** `spelledCommand` below reads that off
 *  `NOUNS` rather than off this list — `agent` is not a noun, so nothing splits it. */
const TOP = ['version', 'status', 'help', 'agent-context'] as const

export type PublicCommand =
  | NounCommand
  | (typeof TOP)[number]
  | `browser-${(typeof BROWSER_VERBS)[number]}`

export interface UsageFlag {
  /** As typed, without the leading dashes: `timeout-ms`. */
  readonly name: string
  /** The placeholder printed after the flag. Absent for a flag that is only on or off. */
  readonly value?: string
  readonly required?: true
  readonly about: string
}

export interface CommandUsage {
  /** One line. It sits in a column beside its command, so it stays short and starts lower case. */
  readonly summary: string
  /** Printed only by the per-command level, for the commands whose one line would mislead. */
  readonly detail?: string
  readonly flags?: readonly UsageFlag[]
}

const ID = (value: string, about: string): UsageFlag => ({ name: 'id', value, required: true, about })

const TIMEOUT: UsageFlag = {
  name: 'timeout-ms',
  value: '<ms>',
  about: 'how long to wait (default 3600000, one hour)'
}

/**
 * Every public command, one entry each.
 *
 * Missing keys and unknown keys are both compile errors, so this object is exactly the public
 * surface. See the head of this file for what that does and does not guarantee.
 */
export const USAGE: Record<PublicCommand, CommandUsage> = {
  version: { summary: 'CLI, app and protocol versions' },
  status: { summary: 'is the orchestrator there, and what is running' },
  // `--skills-dir <path>` is real and is left out on purpose. It relocates the folder the guide is
  // read from, overriding ASTERA_SKILLS, and it exists for the app and for development rather than
  // for a person at a prompt, who gets the guide this build ships with. The guide itself
  // documents it, which is the right place, because the guide is where the non-public commands are
  // documented and this flag is one of them. docs/cli.md makes the same call, documenting the
  // ASTERA_SKILLS variable and not the flag, which is why the doc guard cannot see the difference.
  help: {
    summary: 'the orchestration guide, in full',
    detail:
      'The reference agents read. It is a long document, not usage text. Inside a session Astera starts it comes from the folder ASTERA_SKILLS names; elsewhere, from the guides this build ships with.'
  },
  'agent-context': {
    summary: 'every command this binary can route, as JSON',
    detail:
      'For a caller that is a program. It lists the session-only commands as well as the public ones, with their flags, plus the protocol version and the exit codes. Like --help it needs no Host and always exits 0.'
  },

  'host-start': { summary: 'start a Host if none is running (already running is success)' },
  'host-status': { summary: 'is a Host running, and on which profile' },
  'host-stop': {
    summary: 'ask the running Host to retire',
    detail: 'Refused while the Host still holds sessions or running runs. It says how many.'
  },

  'projects-list': { summary: 'every project registered in the app' },
  'projects-get': {
    summary: 'one registered project',
    flags: [ID('<projectId>', 'the project to read')]
  },
  'projects-find': {
    summary: 'the registered project a folder belongs to',
    flags: [{ name: 'path', value: '<path>', required: true, about: 'an absolute path inside the project' }]
  },

  'jobs-list': { summary: 'every Job, with the state of its latest run' },
  'jobs-get': {
    summary: 'one Job, with a run folded in',
    detail:
      "Takes either id. Given a Job it folds in that Job's latest run, given a run it folds in that one.",
    flags: [ID('<jobId|runId>', 'a Job, or one run of it')]
  },
  'jobs-run': {
    summary: 'start a run of this Job now',
    detail:
      'Returns the run it started, which is the id to pass to `runs wait`. Refused while a run of this Job is already going.',
    flags: [ID('<jobId>', 'the Job to run')]
  },
  'jobs-create': {
    summary: 'create a Job with no run yet',
    detail:
      'Returns the Job. Nothing runs until `jobs run`: add its tasks first with `tasks add --job`. Without --cwd the Job belongs to the directory this command was run from. With --coordinator-account a coordinator session starts on that account when the Job runs; without it the workers are placed for you. A Host that announces dispatch places them whether Astera is open or closed, and otherwise Astera does.',
    flags: [
      { name: 'objective', value: '<text>', required: true, about: 'what this Job is for' },
      { name: 'cwd', value: '<path>', about: 'the repository root this Job belongs to (default: here)' },
      { name: 'concurrency', value: '<n>', about: 'how many workers this Job places at once' },
      {
        name: 'coordinator-account',
        value: '<accountId>',
        about: 'the account a coordinator session runs on (one, from `accounts list`)'
      },
      {
        name: 'convergence',
        about: 'repair failing tasks instead of failing them'
      },
      { name: 'max-fix-attempts', value: '<n>', about: 'repairs per task; needs --convergence' },
      { name: 'max-review-rounds', value: '<n>', about: 'review rounds per task; needs --convergence' },
      {
        name: 'blocking-severity',
        value: '<high|medium>',
        about: 'which review findings block; needs --convergence'
      },
      { name: 'max-total-minutes', value: '<n>', about: 'time budget per task; needs --convergence' }
    ]
  },
  'jobs-wait': {
    summary: "wait until this Job's latest run ends",
    detail:
      'Five endings, and the exit code says which: finished well (0), a question is open, the run is paused, or the run is still running and every open worker, and the coordinator when it is stopped, is waiting for a usage limit to reset (8, `details` says which), the run failed (10). If the deadline passes first, it exits 7.',
    flags: [ID('<jobId>', 'the Job whose latest run to wait for'), TIMEOUT]
  },

  'runs-list': {
    summary: 'every run, oldest first',
    flags: [{ name: 'job', value: '<jobId>', about: 'only the runs of this Job' }]
  },
  'runs-get': { summary: 'one run', flags: [ID('<runId>', 'the run to read')] },
  'runs-wait': {
    summary: 'wait until this run ends',
    detail:
      'Five endings, and the exit code says which: finished well (0), a question is open, the run is paused, or the run is still running and every open worker, and the coordinator when it is stopped, is waiting for a usage limit to reset (8, `details` says which), the run failed (10). If the deadline passes first, it exits 7.',
    flags: [ID('<runId>', 'the run to wait for'), TIMEOUT]
  },
  'runs-stop': {
    summary: "close this run's open workers and pause it",
    detail:
      'Reversible, which is why it is not called cancel. `runs resume` clears exactly this. Refused while a dispatch is held open by worker-retain.',
    flags: [ID('<runId>', 'the run to stop')]
  },
  'runs-resume': {
    summary: 'let a paused run go again',
    flags: [ID('<runId>', 'the run to resume')]
  },

  'tasks-list': {
    summary: 'the tasks of a run',
    flags: [
      { name: 'run', value: '<runId>', about: 'only the tasks of this run' },
      { name: 'status', value: '<s>', about: 'only tasks in this status' },
      { name: 'ready', about: 'only tasks that are ready to be picked up' },
      { name: 'brief', about: 'cut each spec to 160 characters' }
    ]
  },
  // **--job and --run are both listed as optional, and exactly one of them is required.** A flag in
  // this table is either required or not; there is no field for "one of these two". `browser js`
  // has the same shape with --script and --file, and as there the rule is carried by the prose.
  'tasks-add': {
    summary: 'add a task to a Job, or to one run of it',
    detail:
      'Exactly one of --job or --run. A task added to a Job is copied into every run `jobs run` starts from then on; a task added to a run belongs to that run only. An id of the other kind is not found (4), never quietly the other thing. Returns the task.',
    flags: [
      { name: 'job', value: '<jobId>', about: 'the Job to add it to (exactly one of --job or --run)' },
      { name: 'run', value: '<runId>', about: 'the run to add it to (exactly one of --job or --run)' },
      {
        name: 'spec',
        value: '<text|->',
        required: true,
        about: 'the work, in full (a value of `-` reads it from stdin)'
      },
      {
        name: 'account',
        value: '<id,…>',
        required: true,
        about: 'the accounts a worker may run on, in failover order (from `accounts list`)'
      },
      { name: 'title', value: '<text>', about: "a short name (default: the spec's first line)" },
      { name: 'deps', value: '<json array>', about: 'the task ids this one waits for' },
      { name: 'parent', value: '<taskId>', about: 'the task this one was split out of' },
      {
        name: 'validate',
        value: '<configId,…>',
        about: 'run configurations that must pass before it counts as done (from `run-configs list`)'
      },
      { name: 'review', about: 'have the result reviewed before it counts as done' }
    ]
  },

  'questions-list': {
    summary: 'questions workers have asked',
    flags: [
      { name: 'task', value: '<taskId>', about: 'only the questions of this task' },
      { name: 'status', value: '<open|resolved>', about: 'only questions in this state' }
    ]
  },
  'questions-get': {
    summary: 'one question',
    flags: [ID('<questionId>', 'the question to read')]
  },
  'questions-answer': {
    summary: 'answer an open question',
    flags: [
      ID('<questionId>', 'the question to answer'),
      {
        name: 'answer',
        value: '<text>',
        required: true,
        about: 'the answer (a value of `-` reads it from stdin)'
      }
    ]
  },

  'accounts-list': {
    summary: 'the agent accounts the app holds',
    detail:
      'The ids `jobs create --coordinator-account` and `tasks add --account` take. With Astera closed the Host reads them from the profile, so this works either way.',
    flags: [{ name: 'agent', value: '<claude|codex>', about: 'only this vendor' }]
  },

  // Answered in the CLI process from the profile's files, with no Host and no app (cli/skills.ts).
  'run-configs-list': {
    summary: "the run configurations of a Job's project",
    detail:
      "The ids `tasks add --validate` takes: each with `id`, `name` and `type`, and nothing else about it. They are the Job's folder's configurations, the ones the app's Run menu shows there. With Astera closed the Host reads the profile's saved configurations and the folder's build files itself, so this works either way.",
    flags: [{ name: 'job', value: '<jobId>', required: true, about: 'the Job whose project to list (from `jobs list`)' }]
  },

  'skills-list': {
    summary: "which of Astera's agent skills each account has, and whether they are current",
    detail:
      'Per account, each skill with `enabled` (whether its setting in the app turns it on) and `installed`: current, stale (an older copy of ours that install would rewrite), missing, or not-ours (a file Astera did not write, which install leaves alone). It reads the profile and needs no Host and no app.',
    flags: [{ name: 'account', value: '<accountId>', about: 'only this account (from `accounts list`)' }]
  },
  'skills-install': {
    summary: 'install the skills the current settings enable, in every account',
    detail:
      'Writes what the settings in the app enable and nothing else: a skill whose setting is off is listed under notEnabled with the setting that turns it on. Each skill comes back written, unchanged, skipped-not-ours or failed, and any failed makes it exit 1. It removes nothing. Sessions already open do not pick up a new skill; open a new session. Run it after adding an account, which gets no skills until the app restarts. It needs no Host and no app.',
    flags: [{ name: 'account', value: '<accountId>', about: 'only this account (from `accounts list`)' }]
  },

  // Answered by the Host out of its own registries, so the app may be closed; it needs a Host.
  'sessions-list': {
    summary: 'the agent sessions the Host holds, running and ended',
    detail:
      'Each with its id, which is the id `sessions read` and `sessions send` take and the one `ASTERA_SESSION` holds inside that session. `kind` is terminal (an agent CLI in a terminal) or chat. `state` is working, waiting or unknown, from the hook events a Claude terminal session writes; Codex and chat sessions are always unknown, and so is a session typed into since its last event. Plain shell tabs and run configurations are not sessions and are not listed. Answered by the Host, so it works with Astera closed.'
  },
  'sessions-read': {
    summary: "what a terminal session's tab shows, or a chat session's recent turns",
    detail:
      "`kind` says which shape came back. A terminal session: the Host replays its recent output into a terminal at the tab's size. `screen` is the visible rows, top first, with the empty rows below the last painted one left off; `scrollback` is up to --lines rows (at most 10000) from just above it, oldest first; `cols` and `rows` are the size. Text only, trailing spaces trimmed, no colours. The Host keeps about 256,000 characters of each running session and drops them when it ends. A chat session: `turns` is up to --turns turns (at most 200), oldest first, each with `role`, `text` and `tools` (one line per tool call), read from the transcript the agent writes, so it works with Astera closed and survives the session ending. `pending` names the card the session is waiting on (an approval or a question), answered by whichever process is that session's writer: the Host's own adapter, Astera closed included, or Astera when it holds the session instead. It is left out when neither can say. --lines is for terminal sessions and --turns for chat sessions; the other one is refused with 2.",
    flags: [
      ID('<sessionId>', 'the session to read (from `sessions list`)'),
      { name: 'lines', value: '<n>', about: 'terminal: how many rows of scrollback above the screen (default 200)' },
      { name: 'turns', value: '<n>', about: 'chat: how many of the most recent turns (default 20)' }
    ]
  },
  'sessions-send': {
    summary: 'type into a terminal session and press Enter, or send a chat session one turn',
    detail:
      'A terminal session: writes the text, then Enter 150ms later, the way the app delivers a scheduled message. It types into whatever the session shows, a permission prompt included, so read it first. A chat session: the text is one turn, delivered by whichever process is that session\'s writer. With Astera open and holding the session, the app delivers it, and a session waiting on a card (an approval or a question) is refused with 6 naming the card: answer it with `chats answer`, or in Astera. Just after Astera starts, a session it has not taken back yet is a 6 as well. Otherwise, once the Host holds an adapter for the session, the Host delivers it itself, Astera closed included, refusing the same way for an open card; for a Codex session it sends only the text, with no model, effort or plan mode, so the settings the thread has now apply. A session the Host holds no adapter for still takes a blind write that queues behind any card. A send refused for a card, for a session not taken back yet or for a Codex session with no thread sent nothing, so the same --request-id can be used again. --no-enter is for terminal sessions only. One send at a time per session either way. `--text -` drops one trailing newline. A session that has ended is refused with 6. Any process running as you can do this to any session, agent sessions included. With --request-id a retry is not sent twice.',
    flags: [
      ID('<sessionId>', 'the session to type into (from `sessions list`)'),
      { name: 'text', value: '<text|->', required: true, about: 'what to type (a value of `-` reads it from stdin)' },
      { name: 'no-enter', about: 'terminal: type the text and do not press Enter' }
    ]
  },
  'chats-pending': {
    summary: 'the permission prompts and questions chat sessions are waiting on',
    detail:
      'Each with its session, its prompt id (the id `chats answer` takes), its kind (approval or question), the tool it asks about and a one-line summary. Answered by the Host: it lists the sessions it writes to itself and asks Astera, when it is open, for the rest. `complete` is false when Astera is open but could not be asked, so the list may be short. Works with Astera closed.',
    flags: [{ name: 'session', value: '<sessionId>', about: 'only this session (from `sessions list`)' }]
  },
  'chats-answer': {
    summary: 'allow or deny one permission prompt a chat session is waiting on',
    detail:
      'The session that holds the prompt answers it, whether Astera or the Host writes to it, and the turn goes on. Exactly one of --allow and --deny. A question is not a permission prompt and is refused with 6: answer it in Astera. A prompt that is no longer open is refused with 6 and nothing is answered. A prompt id is per session, so an id open in two sessions needs --session (2 otherwise). It is for a person: run from inside an agent session (where ASTERA_SESSION is set) it is refused with 5. With --request-id a retry is not answered twice.',
    flags: [
      ID('<promptId>', 'the prompt to answer (from `chats pending`)'),
      { name: 'allow', about: 'let the tool run' },
      { name: 'deny', about: 'refuse it; the turn goes on without it' },
      { name: 'session', value: '<sessionId>', about: 'the session that holds the prompt' }
    ]
  },

  'requests-show': {
    summary: 'did a call of mine land, and what did it answer',
    detail:
      'For a command whose answer was lost, which is exit 3 or exit 7 with the Host still there. Three states, and all three exit 0, because not finding a receipt is an answer rather than a failure: `completed` carries in `response` the envelope the command answered with, `pending` means a Host is running it right now, and `absent` means this Host holds no receipt for that id under your session, which is not proof that nothing happened. `interpretation` says which, in a sentence, and `hostStartedAt` says when this Host started: receipts live in its memory, so one that started after you sent the request never saw it. With no Host at all it is exit 3, because then there is no receipt to have and the question is answered by reading the state.',
    flags: [ID('<requestId>', 'the id the call was sent with (--request-id)')]
  },

  'browser-js': {
    summary: "run one script in this session's agent browser",
    detail:
      'One script: --script, --file, or the whole of stdin when neither is given. Giving both is refused. It needs a session the app started, with the agent browser switched on.',
    flags: [
      { name: 'script', value: '<text>', about: 'the script to run (a value of `-` reads stdin)' },
      { name: 'file', value: '<path>', about: 'a file to read the script from' }
    ]
  },
  'browser-help': { summary: 'the agent browser guide' }
}

/**
 * `jobs-wait` as a person types it: `jobs wait`.
 *
 * **The dash is a separator only when it separates a noun from one of its verbs.** Plenty of
 * command names contain a dash and are still one token: `agent-context` here, and every
 * session-only command — `worker-start`, `task-create`, `run-configs`, `gate-resolve`. Splitting
 * those printed a command that does not exist, and `parseArgs` would then read the first half as
 * the whole command. So the test is `NOUNS` itself, not a hand-kept list of exceptions: `worker` is
 * not a noun, `runs` is.
 *
 * **The last dash, not the first**, because a noun can hold a dash of its own: `run-configs-list` is
 * `run-configs list`. No verb has a dash, so the last one is the only place a verb can start.
 *
 * Exported because cliOutput.ts builds `astera jobs get --help` as a recovery step and
 * cliAgentContext.ts prints one line per command, and three spellings of one rule would drift.
 */
export const spelledCommand = (cmd: string): string => {
  const dash = cmd.lastIndexOf('-')
  if (dash < 0) return cmd
  const noun = cmd.slice(0, dash)
  const verb = cmd.slice(dash + 1)
  const verbs: readonly string[] | undefined = noun === 'browser' ? BROWSER_VERBS : verbsOf(noun)
  return verbs?.includes(verb) === true ? `${noun} ${verb}` : cmd
}

/** `--id <jobId>`, or `[--timeout-ms <ms>]` when it is optional. */
const spelledFlag = (f: UsageFlag): string => {
  const body = f.value === undefined ? `--${f.name}` : `--${f.name} ${f.value}`
  return f.required === true ? body : `[${body}]`
}

/** One command with its flags, ready to copy: `astera jobs wait --id <jobId> [--timeout-ms <ms>]`.
 *
 *  Exported because cliAgentContext.ts prints the same line for the session-only commands, whose
 *  usage is not in `USAGE` — written twice the two spellings would drift. */
export const invocationLine = (cmd: string, flags: readonly UsageFlag[] = []): string =>
  [`astera ${spelledCommand(cmd)}`, ...flags.map(spelledFlag)].join(' ')

/** The first line of the per-command level. */
const invocation = (cmd: PublicCommand): string => invocationLine(cmd, USAGE[cmd].flags ?? [])

type Row = readonly [string, string]

/** Two columns. `width` is passed in when several blocks have to line up as one table, as the root
 *  level's groups do — laid out separately they would each find their own column and the summaries
 *  would step in and out down the page. */
function columns(rows: readonly Row[], width = Math.max(...rows.map(([left]) => left.length))): string[] {
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`)
}

const TAIL = 'The full reference, including the exit codes, is docs/cli.md.'

/** Folds a `detail` paragraph into indented lines. Narrow enough that an 80-column terminal does
 *  not wrap it again at a different place. */
function wrapped(text: string): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > 76) {
      lines.push(line)
      line = word
    } else line = line === '' ? word : `${line} ${word}`
  }
  if (line !== '') lines.push(line)
  return lines.map((l) => `  ${l}`)
}

/** Level 1: every public command, one line each. */
export function rootUsage(): string {
  const row = (cmd: PublicCommand): Row => [spelledCommand(cmd), USAGE[cmd].summary]
  const blocks: Row[][] = [
    TOP.map(row),
    ...Object.entries(NOUNS as Record<string, readonly string[]>).map(([noun, verbs]) =>
      verbs.map((verb) => row(`${noun}-${verb}` as PublicCommand))
    ),
    BROWSER_VERBS.map((verb) => row(`browser-${verb}` as PublicCommand))
  ]
  const width = Math.max(...blocks.flat().map(([left]) => left.length))
  const groups = blocks.map((rows) => columns(rows, width))
  return [
    "astera: read and drive Astera's Jobs, runs, tasks and questions from a shell.",
    '',
    'usage:',
    '  astera <command> [flags]',
    '',
    'commands:',
    ...groups.flatMap((lines, i) => (i === 0 ? lines : ['', ...lines])),
    '',
    'output is JSON. --human prints aligned columns for reading, --quiet prints ids only.',
    'while a wait is on, a line every 15s goes to stderr, never stdout. --no-keepalive stops them.',
    // **The one flag here that changes what happens rather than how it is printed.** It was missing,
    // and `requests show`'s own usage text refers to it by name — so a person sent to that command
    // had no way to learn it from `--help`, which is the level that answers with nothing running.
    '--request-id <id> on any command says a retry is the same request: it is not done twice.',
    '',
    "astera <noun> --help lists that noun's verbs.",
    'astera <noun> <verb> --help describes one command and its flags.',
    TAIL
  ].join('\n')
}

/** Level 2: one noun's verbs, one line each. */
export function nounUsage(noun: string, verbs: readonly string[]): string {
  return [
    `astera ${noun} <verb> [flags]`,
    '',
    ...columns(
      verbs.map((verb) => {
        const cmd = `${noun}-${verb}` as PublicCommand
        return [verb, USAGE[cmd].summary] as const
      })
    ),
    '',
    `astera ${noun} <verb> --help describes one command and its flags.`
  ].join('\n')
}

/** Level 3: one command, what it does, and its flags. */
export function commandUsage(cmd: PublicCommand): string {
  return usageText(invocation(cmd), USAGE[cmd])
}

/** Level 3 for a command `USAGE` does not carry, one a coordinator or worker session uses
 *  (`worker-release`, say): the entry `agent-context` prints for it, laid out the same way. */
export function sessionCommandUsage(cmd: string, entry: CommandUsage): string {
  return usageText(invocationLine(cmd, entry.flags ?? []), entry, [
    '',
    '  A command a coordinator or worker session uses. `astera help` documents it.'
  ])
}

function usageText(first: string, entry: CommandUsage, note: readonly string[] = []): string {
  const flags = entry.flags ?? []
  return [
    first,
    '',
    `  ${entry.summary}`,
    ...note,
    ...(entry.detail === undefined ? [] : ['', ...wrapped(entry.detail)]),
    ...(flags.length === 0
      ? []
      : [
          '',
          'flags:',
          ...columns(
            flags.map(
              (f) =>
                [
                  f.value === undefined ? `--${f.name}` : `--${f.name} ${f.value}`,
                  `${f.required === true ? 'required  ' : '          '}${f.about}`
                ] as const
            )
          )
        ]),
    '',
    TAIL
  ].join('\n')
}

/**
 * The two tokens that mean "print usage instead of running this". Either of them, anywhere on the
 * line, wins over the command.
 *
 * `-h` is the only single-dash token this program understands; `parseArgs` rejects every other one.
 *
 * **The two are not equally safe, and the difference is on purpose.** `--help` can never be
 * mistaken for a flag's value: `parseArgs` only consumes a following token as a value when it does
 * not start with `--`. `-h` can be, because that test excludes nothing else — so
 * `astera questions answer --id q --answer -h` prints usage instead of recording the answer `-h`.
 *
 * That case is given up knowingly rather than guarded. Guarding it means deciding here which tokens
 * `parseArgs` would have eaten, which is a second copy of its value rule sitting in another file,
 * and it would also stop `astera tasks list --ready -h` from working, which someone would type. The
 * cost of being wrong is one flag whose literal value is the two characters `-h`, no documented flag
 * takes such a value, and the failure is loud: usage text arrives where an envelope was expected.
 * `--help` is unambiguous everywhere and is what the documentation tells people to use.
 */
const HELP_TOKENS = new Set(['--help', '-h'])

/**
 * Usage for whatever the person asked about, or `null` when they did not ask.
 *
 * **It answers before `parseArgs`** (run.ts), because all three levels used to fail there: a leading
 * flag was `expected a command, got flag`, a noun with a flag where its verb goes was `jobs needs
 * one of: …`, and `jobs list --help` was worst of all — `--help` parsed as an ordinary flag, went to
 * the server, was ignored, and the command ran. Asking for help silently did the thing.
 */
export function usageFor(
  argv: string[],
  /** The usage of a session-only command, by name (cliAgentContext's `sessionUsage`). Passed in rather
   *  than imported, because cliAgentContext.ts imports this file. */
  sessionUsage: (name: string) => CommandUsage | undefined = () => undefined
): { text: string } | { error: string } | null {
  if (!argv.some((t) => HELP_TOKENS.has(t))) return null
  const words: string[] = []
  for (const tok of argv) {
    if (tok.startsWith('-')) break
    words.push(tok)
  }
  const [first, second, ...rest] = words
  if (rest.length > 0) return { error: `unexpected argument: ${rest[0]}` }
  if (first === undefined) return { text: rootUsage() }
  // **The rename hint is checked here too, and for the same reason it exists at all.** It is aimed
  // at an agent carrying the old vocabulary, and an agent that reads `astera help` every time it
  // starts is exactly the caller likely to ask for help on the name it remembers. Answering
  // `no usage for run-list` would drop the hint on the one audience it was written for.
  const renamed = renamedTo(first)
  if (renamed !== undefined)
    return { error: `${first} was renamed to \`${renamed}\` (try: astera ${renamed} --help)` }
  const verbs = first === 'browser' ? BROWSER_VERBS : verbsOf(first)
  if (verbs !== undefined) {
    if (second === undefined) return { text: nounUsage(first, verbs) }
    if (!verbs.includes(second))
      return { error: `unknown ${first} subcommand: ${second} (expected ${verbs.join(', ')})` }
    return { text: commandUsage(`${first}-${second}` as PublicCommand) }
  }
  if (second !== undefined) return { error: `${first} takes no subcommand` }
  // Not a public command. The coordinator's own commands land here, and they have usage too: the
  // entry `agent-context` prints (S4+S5 tidy: closing finished workers before `host stop` needs
  // `worker-release`, and its `--help` said "no usage").
  // A typo lands here too, and the command table is one flag away.
  if (!Object.hasOwn(USAGE, first)) {
    const session = sessionUsage(first)
    if (session !== undefined) return { text: sessionCommandUsage(first, session) }
    return {
      error: `no usage for ${first} (astera --help lists the commands, astera help documents the ones agents use)`
    }
  }
  return { text: commandUsage(first as PublicCommand) }
}

/**
 * The flags every command takes, public or not. They are read by the parser and by run.ts rather
 * than by any one command, so no `USAGE` entry lists them. cliAgentContext.ts describes each one
 * (`globalFlags`), and cliUsage.test.ts holds the two lists to the same names.
 */
export const GLOBAL_FLAGS: readonly string[] = ['json', 'human', 'quiet', 'no-keepalive', 'request-id', 'help']

/** Flags a public command really reads that its `USAGE` entry leaves out on purpose. `--skills-dir`
 *  is the one, and the comment on `help` above says why it is not listed. */
const UNLISTED: Partial<Record<PublicCommand, readonly string[]>> = {
  help: ['skills-dir'],
  'browser-help': ['skills-dir']
}

/**
 * Why this line is refused, or `null`: a **public** command given a flag it does not declare.
 *
 * **Refused, because ignoring it was a wrong answer that looked right** (conformance audit #59).
 * `parseArgs` carries every `--x` into `args` and each command reads only the keys it knows, so
 * `runs wait --timeout 30m` waited the one-hour default and `jobs list --project p` listed every Job.
 * A script reads either as the answer it asked for.
 *
 * **No near-miss is mapped to the flag it resembles.** `--timeout` is not read as `--timeout-ms`:
 * this CLI has no aliases (public CLI design §2), and the message lists the flags the command takes,
 * which is the whole fix.
 *
 * **Session-only commands are not checked.** Their flags are declared nowhere a machine can read
 * (cliAgentContext.ts), and the guide and sessions started by older builds pass flags a command
 * ignores. Refusing those would break a running coordinator over a flag that never did anything.
 * `accounts` and `run-configs` with no verb are session commands in this sense.
 *
 * **It reads the flags off `argv`, not off the parsed arguments**, so the message names the flag as
 * it was typed. Every token that starts with `--` is a flag: `parseArgs` never takes one as a value.
 */
export function unknownFlagError(cmd: string, argv: readonly string[]): string | null {
  if (!Object.hasOwn(USAGE, cmd)) return null
  const pc = cmd as PublicCommand
  const own = (USAGE[pc].flags ?? []).map((f) => f.name)
  const allowed = new Set([...own, ...(UNLISTED[pc] ?? []), ...GLOBAL_FLAGS].map(camel))
  const unknown = argv
    .filter((t) => t.startsWith('--'))
    .map((t) => t.slice(2))
    .filter((name) => !allowed.has(camel(name)))
  if (unknown.length === 0) return null
  const named = [...new Set(unknown)].map((n) => `--${n}`).join(', ')
  const takes =
    own.length === 0
      ? `it takes no flags of its own`
      : `its flags are ${own.map((n) => `--${n}`).join(', ')}`
  return `${spelledCommand(cmd)} does not take ${named}: ${takes}, plus the global ones (--json, --human, --quiet, --no-keepalive, --request-id)`
}
