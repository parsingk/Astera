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
import { BROWSER_VERBS, NOUNS, renamedTo, verbsOf } from './cliArgs'

/** `jobs-wait`, `host-start`, … — every noun/verb pair `NOUNS` declares. */
type NounCommand = {
  [N in keyof typeof NOUNS]: `${N}-${(typeof NOUNS)[N][number]}`
}[keyof typeof NOUNS]

/** The one-word commands. They have no noun, so `NOUNS` cannot name them. */
const TOP = ['version', 'status', 'help'] as const

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
  // for a person at a prompt: outside a session there is no guide to point it at. The guide itself
  // documents it, which is the right place, because the guide is where the non-public commands are
  // documented and this flag is one of them. docs/cli.md makes the same call, documenting the
  // ASTERA_SKILLS variable and not the flag, which is why the doc guard cannot see the difference.
  help: {
    summary: 'the orchestration guide, in full',
    detail:
      'The reference agents read. It is a long document, not usage text. It comes from the folder ASTERA_SKILLS names, which a session Astera starts sets for you.'
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
  'jobs-wait': {
    summary: "wait until this Job's latest run ends",
    detail:
      'Four endings, and the exit code says which: finished well (0), a question is open or the run is paused (8), the run failed (10), the deadline passed (7).',
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
      'Four endings, and the exit code says which: finished well (0), a question is open or the run is paused (8), the run failed (10), the deadline passed (7).',
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

/** `jobs-wait` as a person types it. Every public command has at most one dash. */
const spelled = (cmd: string): string => cmd.replace('-', ' ')

/** `--id <jobId>`, or `[--timeout-ms <ms>]` when it is optional. */
const spelledFlag = (f: UsageFlag): string => {
  const body = f.value === undefined ? `--${f.name}` : `--${f.name} ${f.value}`
  return f.required === true ? body : `[${body}]`
}

/** The first line of the per-command level: the command with its flags, ready to copy. */
const invocation = (cmd: PublicCommand): string =>
  [`astera ${spelled(cmd)}`, ...(USAGE[cmd].flags ?? []).map(spelledFlag)].join(' ')

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
  const row = (cmd: PublicCommand): Row => [spelled(cmd), USAGE[cmd].summary]
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
  const entry = USAGE[cmd]
  const flags = entry.flags ?? []
  return [
    invocation(cmd),
    '',
    `  ${entry.summary}`,
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
export function usageFor(argv: string[]): { text: string } | { error: string } | null {
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
  // Not a public command. The coordinator's own commands land here, and pointing at the guide is
  // the true answer for them: it is where they are documented. A typo lands here too, and the
  // command table is one flag away.
  if (!Object.hasOwn(USAGE, first))
    return {
      error: `no usage for ${first} (astera --help lists the commands, astera help documents the ones agents use)`
    }
  return { text: commandUsage(first as PublicCommand) }
}
