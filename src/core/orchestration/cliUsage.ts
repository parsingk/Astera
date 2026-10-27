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
import { APP_VERBS, BROWSER_VERBS, NOUNS, camel, leadingGlobals, renamedTo, verbsOf } from './cliArgs'
import { AUDIT_ACTIONS } from '../audit/policy'

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

/** What a Job is made with, beside its objective and its folder: `jobs create`'s flags, and `jobs create-from-source`'s
 *  after its own. */
const JOB_MAKING_FLAGS: readonly UsageFlag[] = [
  { name: 'concurrency', value: '<n>', about: 'how many workers this Job places at once' },
  {
    name: 'coordinator-account',
    value: '<accountId>',
    about: 'the account a coordinator session runs on (one, from `accounts list`)'
  },
  {
    name: 'coordinator-provider',
    value: '<claude|codex>',
    about: "without --coordinator-account, that provider's default account coordinates"
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
  { name: 'max-total-minutes', value: '<n>', about: 'time budget per task; needs --convergence' },
  { name: 'github-lifecycle', about: 'carry the work through a pull request and GitHub CI (origin must be GitHub, and yours to push)' },
  { name: 'github-checks', value: '<name,...>', about: 'CI checks that decide beside the ones the repository requires; needs --github-lifecycle' }
]

/** `agent-profiles create`'s flags, and `update`'s, where none is required. */
const AGENT_PROFILE_FLAGS = (creating: boolean): UsageFlag[] => [
  { name: 'name', value: '<text>', ...(creating ? { required: true as const } : {}), about: 'what to call it, unique, at most 60 characters' },
  {
    name: 'account',
    value: '<id,…>',
    ...(creating ? { required: true as const } : {}),
    about: "its accounts, one provider's, in the order they are tried (from `accounts list`)"
  },
  { name: 'exclude-mcp', value: '<name,…>', about: 'the shared MCP servers its sessions do not get (from `ext list`)' },
  { name: 'permission', value: '<inherit|bypass|ask>', about: "permission prompts: Astera's setting (inherit), none (bypass) or shown (ask)" },
  { name: 'description', value: '<text>', about: 'a line saying what it is for' }
]

/** `audit list`'s and `audit summary`'s filters (observe mode design §12). */
const AUDIT_FILTERS: readonly UsageFlag[] = [
  { name: 'session', value: '<sessionId>', about: "only this session's calls (from `sessions list`)" },
  { name: 'job', value: '<jobId>', about: "only the calls of this Job's workers and coordinator" },
  { name: 'run', value: '<runId>', about: "only the calls of this run's workers and coordinator" },
  { name: 'task', value: '<taskId>', about: "only the calls of this task's workers" },
  { name: 'agent-profile', value: '<id|name>', about: 'only the calls of sessions started from this agent profile (from `agent-profiles list`)' },
  { name: 'action', value: '<action>', about: 'only this action, or the actions a start ending in * names (git.*)' },
  { name: 'decision', value: '<allow|would-deny|unknown|blocked>', about: 'only the calls the rules in force decide so, or Enforce blocked' },
  { name: 'since', value: '<time>', about: 'only calls at or after this time (2026-10-23T09:00:00Z)' },
  { name: 'until', value: '<time>', about: 'only calls before this time' }
]

/** What a rule's `--action` takes, said once for `rules-add` and `rules-edit`. */
const RULE_ACTION = `An action is one of ${AUDIT_ACTIONS.join(', ')}, or the start of one ending in * (git.* matches every git action).`
const RULE_ID: UsageFlag = ID('<ruleId>', 'the rule (from `policies show`)')
const RULE_SCOPE: UsageFlag = {
  name: 'scope',
  value: '<inside-project|outside-project>',
  about: "match only calls inside, or outside, the session's project folder"
}

/** The job-source commands' flags (plugin Phase 4 J21). */
const SOURCE: UsageFlag = { name: 'source', value: '<sourceId>', required: true, about: 'the source (from `sources list`)' }
const ITEM: UsageFlag = { name: 'item', value: '<itemId>', required: true, about: 'the item (from `sources items`)' }
const SOURCE_PROJECT: UsageFlag = {
  name: 'project',
  value: '<projectId>',
  about: 'the project, for a source that needs one: GitHub issues are its repository\'s (from `projects list`)'
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

  'host-start': {
    summary: 'start a Host if none is running (already running is success)',
    detail:
      'Refused with 9 while a Host of another protocol serves the profile. With --replace an older one is asked to leave first, and the sessions it holds end with it.',
    flags: [{ name: 'replace', about: 'ask a Host of an older protocol serving this profile to leave first; its sessions end' }]
  },
  'host-status': { summary: 'is a Host running, and on which profile' },
  'host-stop': {
    summary: 'ask the running Host to retire',
    detail: 'Refused while the Host still holds sessions or running runs. It says how many.'
  },
  'mcp-serve': {
    summary: 'serve Astera to an MCP client over stdio',
    detail:
      'For an MCP client to launch, not for a person to type: stdout carries the MCP protocol. It connects to the Host of this profile, starting one when none answers, and serves forty-two tools that create, plan, run, observe, answer, stop and resume Jobs, read and use sessions when Settings allows it, read pull requests, CI and issues on GitHub and, when Settings allows it, act on them, read the job sources and make a Job from an item, read the How It Works records of a project and regenerate one, list the agent profiles, and list the Runtimes this machine is paired with. What it may do is set by MCP access in Settings (CLI tab). See docs/mcp.md.'
  },
  'runtime-start': {
    summary: 'turn Remote Runtime on: other machines may pair with this one',
    detail:
      'Writes remote-runtime.json, makes this machine’s identity the first time, starts a Host if none runs, and waits until the Gateway listens. It listens on 127.0.0.1 until --listen names an address; use a private network, a VPN or Tailscale, never a port forwarded to the internet. 0 when listening, 1 when the Gateway failed (the code says why), 7 when it was not listening within 10 seconds. Refused with 5 inside an agent session (ASTERA_SESSION is set): opening this machine to the network is for a person.',
    flags: [
      { name: 'listen', value: '<addr>', about: 'the address to listen on (default 127.0.0.1)' },
      { name: 'port', value: '<n>', about: 'the TCP port (default 47831)' }
    ]
  },
  'runtime-stop': {
    summary: 'turn Remote Runtime off; the Host and its Jobs keep running',
    detail: 'Writes remote-runtime.json and stops the Gateway. Paired controllers stay paired; they cannot connect until it is on again.'
  },
  'runtime-status': { summary: 'whether Remote Runtime is on, the Gateway state, the fingerprint and the paired clients' },
  'runtime-serve': {
    summary: 'keep a Host running while Remote Runtime is on (for an OS service, in the foreground)',
    detail:
      'For a logon task, a LaunchAgent or a systemd unit, not for a person. It never turns Remote on or off: it runs a Host while `runtime start` left it on, starts none while it is off, watches a Host the app already started, restarts one that crashes, and starts none during an app update. SIGTERM or SIGINT stops its Host and it exits 0. `astera host stop` is followed by a new Host while Remote is on: run `astera runtime stop` first.'
  },
  'runtime-pair': {
    summary: 'a one-time pairing string for another machine (valid 10 minutes)',
    detail:
      'Prints astera-pair:v1:<address>:<port>:<code>:<fingerprint> and its parts. It carries a secret code: give it to the other machine directly and do not paste it anywhere else. Five wrong codes burn it. The pairing is read-only unless --full-control is given. Refused with 5 inside an agent session (ASTERA_SESSION is set).',
    flags: [
      { name: 'full-control', about: 'the controller may also change things: run Jobs, start sessions, type into them' },
      { name: 'read-only', about: 'the controller may read but not change anything (the default)' },
      { name: 'name', value: '<n>', about: 'what to call the controller in `runtime clients`' }
    ]
  },
  'runtime-clients': { summary: 'the controllers paired with this machine' },
  'runtime-revoke': {
    summary: 'unpair a controller and close its connections now',
    flags: [ID('<clientId>', 'the controller to unpair (from `runtime clients`)')]
  },
  'runtimes-add': {
    summary: 'pair this machine with a Runtime, from the string `astera runtime pair` printed there',
    detail:
      'Checks the Runtime\'s key against the fingerprint before the code is sent, keeps the token in this profile and never prints it. The parts may be given one by one instead of --pair; the fingerprint is then required.',
    flags: [
      { name: 'pair', value: '<string>', about: 'the astera-pair:v1: string; - reads it from stdin, off the command line other users can see' },
      { name: 'address', value: '<host>', about: 'the address to reach the Runtime at, over the one in the string' },
      { name: 'port', value: '<n>', about: 'its port, without --pair (default 47831)' },
      { name: 'code', value: '<code>', about: 'the one-time code, without --pair' },
      { name: 'fingerprint', value: '<fp>', about: 'the key fingerprint, without --pair' },
      { name: 'name', value: '<n>', about: 'what to call the Runtime here (default its own name)' },
      { name: 'replace', about: 'take the place of a Runtime paired here under the same id with another key' }
    ]
  },
  'runtimes-list': { summary: 'the Runtimes this machine is paired with' },
  'runtimes-remove': {
    summary: 'forget a paired Runtime on this machine (it does not revoke the pairing there)',
    flags: [ID('<runtimeId|name>', 'the Runtime to forget (from `runtimes list`)')]
  },
  'plugins-install': {
    summary: 'install a plugin from a folder or from npm, after you approve what it asks for',
    detail:
      'Shows the plugin, its version and the permissions it asks for, and installs nothing until you approve: --yes grants what it asks for, --grant names exactly what to grant (--grant "" grants none). Exits 2 until you approve. Plugins run trusted code on this machine: a plugin can do anything you can, and its permissions limit only what it asks Astera for. The folder is copied into this profile; installing the same plugin again replaces it and asks again. From npm, your npm fetches the package, or on a computer without Node.js an npm Astera fetches once from registry.npmjs.org; no install script runs, and the version installed is the one shown. Refused with 5 inside an agent session (ASTERA_SESSION is set).',
    flags: [
      { name: 'path', value: '<folder>', about: 'the plugin folder, the one with its package.json' },
      { name: 'npm', value: '<package>', about: 'a plugin published on npm: its name, with @version, @tag or a ^ or ~ range if you like' },
      { name: 'yes', about: 'approve the permissions the plugin asks for' },
      { name: 'grant', value: '<list>', about: 'approve exactly these permissions, comma separated (empty grants none)' }
    ]
  },
  'plugins-list': { summary: 'the plugins installed in this profile, with their status, what they were granted and what they offer' },
  'plugins-get': { summary: 'one installed plugin', flags: [ID('<pluginId>', 'the plugin (from `plugins list`)')] },
  'plugins-enable': { summary: 'let an installed plugin run', flags: [ID('<pluginId>', 'the plugin (from `plugins list`)')] },
  'plugins-disable': { summary: 'stop a plugin from running, keeping it installed', flags: [ID('<pluginId>', 'the plugin (from `plugins list`)')] },
  'plugins-remove': { summary: 'uninstall a plugin and delete its copy in this profile', flags: [ID('<pluginId>', 'the plugin (from `plugins list`)')] },
  'plugins-logs': {
    summary: "the last lines of a plugin's log: what it printed, and when it started, stopped or crashed",
    flags: [ID('<pluginId>', 'the plugin (from `plugins list`)'), { name: 'lines', value: '<n>', about: 'how many lines, from 1 to 1000 (default 100)' }]
  },
  'plugins-settings': {
    summary: "a plugin's settings: each one's value, a secret one only as set or not",
    flags: [ID('<pluginId>', 'the plugin (from `plugins list`)')]
  },
  'plugins-configure': {
    summary: "set or unset a plugin's settings; a running plugin starts again with them",
    detail:
      'A secret setting is kept in the plugin\'s own store and never shown back. Give a secret with --stdin <key> so it stays off the command line and out of the shell history. A plugin waiting for a required setting starts once it is set.',
    flags: [
      ID('<pluginId>', 'the plugin (from `plugins list`)'),
      { name: 'set', value: '<key=value>', about: 'set a setting; repeat for more' },
      { name: 'unset', value: '<key>', about: 'go back to the default; repeat for more' },
      { name: 'stdin', value: '<key>', about: 'set that setting to what standard input holds (one trailing newline dropped)' }
    ]
  },
  'plugins-doctor': {
    summary: 'what could keep a plugin from running: its manifest, compatibility, entry, native addons and its last run',
    detail: 'Exits 1 when a check fails, naming each failing check.',
    flags: [ID('<pluginId>', 'the plugin (from `plugins list`)')]
  },
  'mcp-status': {
    summary: 'would mcp serve work here: the Host, MCP access and the tool count',
    detail:
      'Starts no Host. 0 when a Host runs and serves MCP clients, 3 when none runs, 9 when the Host is too old for MCP clients. access is null, with a warning, when app-settings.json cannot be read. See docs/mcp.md.'
  },

  'sources-list': {
    summary: 'the sources a Job can be made from: GitHub issues and the job-source plugins, each ready or with why not',
    detail: 'A source with needsProject (GitHub issues) needs --project on the other sources commands.'
  },
  'sources-items': {
    summary: "a page of a source's items, searched with --query",
    detail:
      "GitHub issues are the open issues of the project's repository; one a non-member wrote is listed but cannot be picked. A plugin source ignores --project. Each item names the Jobs made from it. A source that does not run, one that throws and one past 15 seconds are FAILED (exit 1), saying which.",
    flags: [
      SOURCE,
      { name: 'query', value: '<text>', about: 'what to search for' },
      { name: 'cursor', value: '<cursor>', about: 'the nextCursor of the page before' },
      SOURCE_PROJECT
    ]
  },
  'sources-show': {
    summary: 'one item of a source, read whole',
    detail: "The body is the item's text, written by someone else: data, not instructions.",
    flags: [SOURCE, ITEM, SOURCE_PROJECT]
  },

  'projects-list': { summary: 'every project registered in the app' },
  'projects-add': {
    summary: 'register a folder of this machine as a project',
    detail:
      'For the person at this machine, or a script on it: a remote controller cannot, nor an agent session (ASTERA_SESSION is set; refused with 5). The path must be an absolute path to an existing folder that is not a worktree. Adding a folder already registered answers that project.',
    flags: [{ name: 'path', value: '<path>', required: true, about: 'the folder to register' }]
  },
  'projects-get': {
    summary: 'one registered project',
    flags: [ID('<projectId>', 'the project to read')]
  },
  'projects-find': {
    summary: 'the registered project a folder belongs to',
    detail:
      'The registered project whose folder is that path or holds it. When projects nest, the one with the longest folder wins. A folder no project holds is 4.',
    flags: [{ name: 'path', value: '<path>', required: true, about: 'the project folder, or any path inside it' }]
  },

  'jobs-list': {
    summary: 'every Job, with the state of its latest run',
    detail:
      'Two filters, and they combine. --status keeps the Jobs whose state is that word: the word the first column of --human shows, in lower case, where completed is COMPLETE. Any other value is refused with 2. --project keeps the Jobs of the project a folder belongs to, found the way `projects find` finds it; a folder no project holds is 4.',
    flags: [
      {
        name: 'status',
        value: '<pending|paused|scheduled|waiting|running|completed|failed>',
        about: 'only Jobs in this state'
      },
      { name: 'project', value: '<path>', about: 'only the Jobs of the project at this folder (from `projects list`)' }
    ]
  },
  'jobs-get': {
    summary: 'one Job, with a run folded in',
    detail:
      "Takes either id. Given a Job it folds in that Job's latest run, given a run it folds in that one.",
    flags: [ID('<jobId|runId>', 'a Job, or one run of it')]
  },
  'jobs-run': {
    summary: 'start a run of this Job now',
    detail:
      'Returns the run it started, which is the id to pass to `runs wait`. Refused while a run of this Job is already going. From inside an agent session, a Job made as a bypass agent profile, or whose tasks the run would copy name one, is refused with 5 unless Astera\'s "Run agents without permission checks" is on.',
    flags: [ID('<jobId>', 'the Job to run')]
  },
  'jobs-create': {
    summary: 'create a Job with no run yet',
    detail:
      'Returns the Job. Nothing runs until `jobs run`: add its tasks first with `tasks add --job`. Without --cwd the Job belongs to the directory this command was run from. With --coordinator-account a coordinator session starts on that account when the Job runs; without it the workers are placed for you. A Host that announces dispatch places them whether Astera is open or closed, and otherwise Astera does. From inside an agent session, a bypass agent profile is refused with 5 unless the setting "Run agents without permission checks" is on.',
    flags: [
      { name: 'objective', value: '<text>', required: true, about: 'what this Job is for' },
      { name: 'cwd', value: '<path>', about: 'the repository root this Job belongs to (default: here)' },
      ...JOB_MAKING_FLAGS,
      {
        name: 'agent-profile',
        value: '<id|name>',
        about: 'the agent profile its tasks run as unless a task names its own (from `agent-profiles list`); it does not pick the coordinator'
      }
    ]
  },
  'jobs-create-from-source': {
    summary: "create a Job in a project from a source's item: the item quoted as its objective, and kept as its source",
    detail:
      "Returns the Job, with no run yet, as `jobs create` does; it takes that command's flags but --objective and --cwd. Astera writes the objective, the item's text quoted as data, and the Job works in the project's folder. Refused for an item that cannot be picked (PERMISSION_DENIED, exit 5: a GitHub issue a non-member wrote, or a closed one) and for a GitHub pull request's number (NOT_FOUND, exit 4). A source that does not run, one that throws and one past 15 seconds are FAILED (exit 1), saying which.",
    flags: [SOURCE, ITEM, { name: 'project', value: '<projectId>', required: true, about: 'the project the Job works in (from `projects list`)' }, ...JOB_MAKING_FLAGS]
  },
  'jobs-wait': {
    summary: "wait until this Job's latest run ends",
    detail:
      'Five endings, and the exit code says which: finished well (0), a question is open, the run is paused, or the run is still running and every open worker, and the coordinator when it is stopped, is waiting for a usage limit to reset (8, `details` says which), the run failed (10). If the deadline passes first, it exits 7.',
    flags: [ID('<jobId>', 'the Job whose latest run to wait for'), TIMEOUT]
  },

  'runs-list': {
    summary: 'every run, oldest first',
    detail:
      "--project keeps the runs of the project's Jobs, the project found the way `projects find` finds it; a folder no project holds is 4. It combines with --job.",
    flags: [
      { name: 'job', value: '<jobId>', about: 'only the runs of this Job' },
      { name: 'project', value: '<path>', about: 'only the runs of the project at this folder' }
    ]
  },
  'runs-get': { summary: 'one run', flags: [ID('<runId>', 'the run to read')] },
  'runs-wait': {
    summary: 'wait until this run ends',
    detail:
      'Five endings, and the exit code says which: finished well (0), a question is open, the run is paused, or the run is still running and every open worker, and the coordinator when it is stopped, is waiting for a usage limit to reset (8, `details` says which), the run failed (10). If the deadline passes first, it exits 7.',
    flags: [ID('<runId>', 'the run to wait for'), TIMEOUT]
  },
  'runs-follow': {
    summary: "print this run's events as they happen, until it ends",
    detail:
      "Every event of the run's timeline so far, then each new one as it lands: one line each with --human, like `[14:21:02] worker started: task_1`, and one envelope per line in JSON (NDJSON), each with `data.event`. It stops where `runs wait` stops, with the same last line and the same exit code: finished well (0), a question open, the run paused or waiting for a usage limit (8), the run failed (10), or the deadline passed (7). Ctrl+C ends this command only; the run goes on.",
    flags: [ID('<runId>', 'the run to follow'), TIMEOUT]
  },
  'runs-stop': {
    summary: "close this run's open workers and pause it",
    detail:
      'Reversible, which is why it is not called cancel. `runs resume` clears exactly this. Refused while a dispatch is held open by worker-retain.',
    flags: [ID('<runId>', 'the run to stop')]
  },
  'runs-resume': {
    summary: 'let a paused run go again',
    detail:
      'From inside an agent session, a run of a Job made as a bypass agent profile, or with an unfinished task that names one, is refused with 5 unless Astera\'s "Run agents without permission checks" is on.',
    flags: [ID('<runId>', 'the run to resume')]
  },
  'runs-reconverge': {
    summary: 'carry a finished GitHub lifecycle run through GitHub again',
    detail:
      'Adds a new lifecycle task to the run, with a fresh repair and rerun budget, once its latest one completed or failed, and drops the old merge-ready evidence. Refused (409) for a run whose job is not carried through GitHub, a run with no branch of its own (or whose branch was removed), a run not carried through GitHub yet, a run whose lifecycle task still works, and a pull request that is merged or closed (the Host reads it from GitHub first). A worker session Astera started is refused (5). MCP clients need the "Let MCP clients act on GitHub" setting. From inside an agent session, a run of a Job made as a bypass agent profile, or with a task that names one, is refused with 5 unless Astera\'s "Run agents without permission checks" is on.',
    flags: [ID('<runId>', 'the run to carry again')]
  },
  'runs-checks': {
    summary: "each task's validation and review, and what they came to",
    detail:
      'One row per task of the run: `validation` (the run configurations it must pass, the last round of checks, each with its status, exit code and output tail) and `review` (whether one was asked for, and the verdict of the last reviewer that gave one, with its findings). Each has a `status`: not-required, pending, running, passed or failed. `failureSummary` says in one line what failed, validation first. A plugin check (`plugin:<id>`) carries its `summary`, `diagnostics` (the first 20, none once it passed), `diagnosticsTotal` (how many it found, when more) and `externalUrl`; its status `error` means it could not be made, and the task waits on a question. It reads what the checks already recorded and runs nothing.',
    flags: [ID('<runId>', 'the run whose checks to read')]
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
      "Exactly one of --job or --run. A task added to a Job is copied into every run `jobs run` starts from then on; a task added to a run belongs to that run only. An id of the other kind is not found (4), never quietly the other thing. Returns the task. With --agent-profile, or in a Job made with one, the task runs as that agent profile: without --account it runs on the profile's accounts, copied now, and with --account on those, the profile still deciding its MCP servers and permission prompts. A profile named here must not be archived (2); a task that only inherits its Job's archived profile still gets that profile's accounts. From inside an agent session, a task that would run as a bypass profile, named or its Job's, is refused with 5 unless Astera's \"Run agents without permission checks\" is on. The coordinator Astera started for a run is not asked about its Job's profile when adding tasks to that run, only about one it names; a session driving the run from outside is asked.",
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
        about: 'the accounts a worker may run on, in failover order (from `accounts list`); required unless an agent profile gives them'
      },
      {
        name: 'agent-profile',
        value: '<id|name>',
        about: "the agent profile it runs as (from `agent-profiles list`); default: its Job's"
      },
      { name: 'title', value: '<text>', about: "a short name (default: the spec's first line)" },
      { name: 'deps', value: '<json array>', about: 'the task ids this one waits for' },
      { name: 'parent', value: '<taskId>', about: 'the task this one was split out of' },
      {
        name: 'validate',
        value: '<configId,…>',
        about:
          'run configurations that must pass before it counts as done (from `run-configs list`), or `plugin:<id>` for a completion check plugin (from `plugins list`)'
      },
      { name: 'review', about: 'have the result reviewed before it counts as done' }
    ]
  },

  'tasks-dispatch': {
    summary: 'place one ready task now, the way the loop places one',
    detail:
      'The Host places it through the same path its loop uses: the account the task names, the run worktree, the placement, then worker-start, so the answer is the worker it started (dispatchId, sessionId). Refused with 6 when the task is not ready, the run is paused or not running, the run is at its concurrency limit, the run is driven by a coordinator (tell the coordinator instead, or stop the run first), or the Host does not drive Jobs right now. What would open a question in the loop (no usable account, a worktree that cannot be made) is a 6 with the reason instead, and nothing is opened. It is for a person or a script, so a worker session is refused with 5. From inside an agent session, a task that names a bypass agent profile is refused with 5 unless Astera\'s "Run agents without permission checks" is on. With --request-id a retry is not placed twice.',
    flags: [ID('<taskId>', 'the task to place (from `tasks list --ready`)')]
  },

  'questions-list': {
    summary: 'questions workers have asked',
    flags: [
      { name: 'run', value: '<runId>', about: 'only the questions of this run (an unknown run is 4)' },
      { name: 'task', value: '<taskId>', about: 'only the questions of this task' },
      { name: 'status', value: '<open|resolved>', about: 'only questions in this state (any other value is 2)' }
    ]
  },
  'questions-get': {
    summary: 'one question',
    flags: [ID('<questionId>', 'the question to read')]
  },
  'questions-answer': {
    summary: 'answer an open question',
    detail:
      'From inside an agent session, an answer that starts a task that runs as a bypass agent profile again (any answer but `mark-failed` on a question whose repair budget is used up, or `continue` or `retry` on a GitHub question, which start its round afresh) is refused with 5 unless Astera\'s "Run agents without permission checks" is on; any other answer is not.',
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

  'higgsfield-list': { summary: 'List the Higgsfield accounts Astera keeps, with credits and the current one' },
  'higgsfield-use': {
    summary: 'Make one Higgsfield account current for every session (only after the user picked it)',
    flags: [{ name: 'account', value: '<id|label|email>', required: true, about: 'the account to switch to' }]
  },

  'ext-list': {
    summary: 'the extensions shared with every account, and where Astera put their copies',
    detail:
      'Each shared MCP server, skill, command and agent from Settings › MCP & Skills, with `enabled` and `providers`. An MCP server lists its environment names with where each value comes from (`secret`, `value` or `inherit`), never a value. `copies` names each account copy Astera owns, with `adopted` for one that was already there. It reads the profile and needs no Host and no app.'
  },
  'ext-sync': {
    summary: 'put the shared skills, commands and agents into every account now',
    detail:
      "The sync the Host runs whenever the shared extensions change. Each item comes back per account as written, unchanged, adopted, restored (an edited copy put back; the edit is kept in extension-state/backups), conflict (the account has its own different copy, left alone), removed, forgotten, not-applicable or failed, and any failed makes it exit 1. Running it twice changes nothing the second time. It needs no Host and no app."
  },

  // Answered by the Host (Agent Profiles design §6), like the sessions below; the CLI resolves a name to the id first.
  'agent-profiles-list': {
    summary: 'the agent profiles: named sets of accounts, MCP servers and a permission choice',
    detail:
      'Each with its id, name, status (active or archived), accounts in order (an account removed from Astera is left out), `mcpExclude` (the ids of the shared MCP servers it leaves out, as `ext list` names them) and `permission`. Answered by the Host, so it works with Astera closed.'
  },
  'agent-profiles-show': {
    summary: 'one agent profile, by its id or its name',
    flags: [ID('<profileId|name>', 'the profile (a name is matched without regard to case)')]
  },
  'agent-profiles-create': {
    summary: 'make an agent profile',
    detail:
      "Returns the profile. Its accounts must be one provider's, in the order they are tried. --exclude-mcp names shared MCP servers its sessions do not get, as `ext list` names them; a name no shared server has is 2, naming it. Skills and commands are shared by every profile. --permission is inherit (Astera's setting, the default), bypass (run without permission checks) or ask (run with permission checks). A name another profile has is 2. Changing profiles is for a person: from inside an agent session it is refused with 5.",
    flags: AGENT_PROFILE_FLAGS(true)
  },
  'agent-profiles-update': {
    summary: 'change an agent profile: only the flags given',
    detail:
      'Returns the profile. --account and --exclude-mcp replace the lists; `--exclude-mcp ""` leaves no server out. Work already holding the profile reads the change when it next starts a session. From inside an agent session it is refused with 5.',
    flags: [ID('<profileId|name>', 'the profile to change'), ...AGENT_PROFILE_FLAGS(false)]
  },
  'agent-profiles-archive': {
    summary: 'keep a profile but start no new work as it',
    detail: 'Work that already holds it goes on. `agent-profiles restore` takes it back. From inside an agent session it is refused with 5.',
    flags: [ID('<profileId|name>', 'the profile to archive')]
  },
  'agent-profiles-restore': {
    summary: 'let an archived profile start work again',
    detail: 'From inside an agent session it is refused with 5.',
    flags: [ID('<profileId|name>', 'the profile to restore')]
  },
  'agent-profiles-delete': {
    summary: 'delete an agent profile',
    detail:
      'Refused with 6 while unfinished work holds it (a live session, a queued or running task, an unfinished Job): archive it instead. From inside an agent session it is refused with 5.',
    flags: [ID('<profileId|name>', 'the profile to delete')]
  },

  // Answered by the Host (observe mode design §12): the records are read back with the decision the rules give them now.
  'audit-list': {
    summary: 'the tool calls observe mode recorded, newest first, each with what the rules would do with it',
    detail:
      'Each call with its session, action, short target (never the full command, output or file contents) and the decision the rules in force give it now: allow, would-deny or unknown (the rules cannot tell), with `ruleId`, the rule that decided, when one did. The decision is never stored, so editing a rule changes what past calls show. The filters combine. `truncated` says --limit cut the list, and `next` holds the --until and --before-id that ask for the next page. Answered by the Host, so it works with Astera closed. The log of what agents did is for a person: from inside an agent session it is refused with 5.',
    flags: [
      ...AUDIT_FILTERS,
      { name: 'before-id', value: '<recordId>', about: 'with --until, the page after this record (both from the last page’s `next`)' },
      { name: 'limit', value: '<n>', about: 'how many, from 1 to 2000 (default 200)' }
    ]
  },
  'audit-summary': {
    summary: 'how many recorded calls the rules allow, would deny or cannot tell, in all and per action',
    detail:
      'The counts for the calls the filters keep, decided by the rules in force now. `stoppedAtLimit` is true when a day of the period stopped recording at the size limit, so it holds fewer calls than were made. From inside an agent session it is refused with 5.',
    flags: AUDIT_FILTERS
  },
  // Answered by the Host (credentials design §7): what Astera keeps out of agent sessions, read here, changed in the app.
  'credentials-list': {
    summary: 'what the Credentials list keeps out of agent sessions: shared MCP servers\' secrets and the entries you registered',
    detail:
      'Each entry with the variable names and CLI login presets it hides, whether hiding is on, and the projects it is narrowed to (none: every agent session). Shared MCP servers that hold a stored secret appear on their own, hidden by default; the entries you registered hold no value, only names. Nothing is a value. The list is changed only in the Astera app (Settings › Security & Access › Credentials), so an agent cannot switch off its own hiding. A change counts for sessions started afterwards. An agent session may read it.'
  },
  'credentials-show': {
    summary: 'one entry of the Credentials list, by its id or its name, with its last uses',
    detail:
      'A shared MCP server is named by its server name or `mcp:<id>`; its last 20 uses through the Gateway come with it, except to an agent session, which may read the entry but not its uses. A name two entries share answers with their ids; use one.',
    flags: [ID('<id|name>', 'the entry')]
  },
  'credentials-doctor': {
    summary: 'what hiding reaches and what it cannot, on this machine',
    detail:
      'Each entry\'s hiding, the presets and the platforms they were measured on, the names that are never hidden (what the CLIs and Astera need, and what the OS gives every program, such as PATH and TEMP), where a login made inside a session goes (that session\'s own empty location), and the limits: a program running as you can still read your files and OS stores, git and Docker hand their stored logins to any program that asks, and a variable your shell startup files set can come back in the commands an agent runs through a shell. An agent session may read it.'
  },
  'policies-show': {
    summary: 'whether observe mode is on, the rules in order, and what it can see',
    detail:
      '`mode` is compatibility (nothing is observed) or observe. The first rule whose action matches a call decides it; `otherwise` decides a call no rule matches. Until observe is first turned on these are the starter rules, and nothing is written. `coverage` says, per provider and kind of session, what observe can see of shell commands, file reads and writes, MCP calls and network requests. An agent session may read it.'
  },
  'policies-set-mode': {
    summary: 'turn observe mode on or off',
    detail:
      'Sessions started afterwards follow it; a running session keeps what it started with. The first time observe is turned on the starter rules are written. Turning it off keeps the records and the rules. From inside an agent session it is refused with 5.',
    flags: [{ name: 'mode', value: '<compatibility|observe>', required: true, about: 'compatibility observes nothing; observe records every tool call' }]
  },
  'policies-set-otherwise': {
    summary: 'what a call no rule matches gets',
    detail: 'From inside an agent session it is refused with 5.',
    flags: [{ name: 'effect', value: '<allow|deny>', required: true, about: 'allow, or deny (shown as would-deny)' }]
  },
  'policies-rules-add': {
    summary: 'add a rule, at the end or at a place in the list',
    detail: `Returns the rule with its id, and the rules. ${RULE_ACTION} A rule with --scope matches only calls known to be inside, or outside, the session's project folder. From inside an agent session it is refused with 5.`,
    flags: [
      { name: 'effect', value: '<allow|deny>', required: true, about: 'what a call it matches gets' },
      { name: 'action', value: '<action>', required: true, about: 'the action it matches, or the start of one ending in * (git.*)' },
      RULE_SCOPE,
      { name: 'at', value: '<n>', about: 'its place in the list, from 0 (default: the end)' }
    ]
  },
  'policies-rules-edit': {
    summary: 'change a rule: only the flags given',
    detail: `Returns the rule, and the rules. ${RULE_ACTION} --clear-scope makes it match wherever the call was. An edit that names none of --effect, --action, --scope and --clear-scope is refused with 2 (reason nothing-to-change). A rule that is not there is 4. From inside an agent session it is refused with 5.`,
    flags: [
      RULE_ID,
      { name: 'effect', value: '<allow|deny>', about: 'what a call it matches gets' },
      { name: 'action', value: '<action>', about: 'the action it matches, or the start of one ending in * (git.*)' },
      RULE_SCOPE,
      { name: 'clear-scope', about: 'match wherever the call was (not with --scope)' }
    ]
  },
  'policies-rules-remove': {
    summary: 'remove a rule',
    detail: 'A rule that is not there is 4. From inside an agent session it is refused with 5.',
    flags: [RULE_ID]
  },
  'policies-rules-move': {
    summary: 'move a rule to another place in the list',
    detail: 'The rules are tried in order, so a rule moved up decides before the ones it passed. A rule that is not there is 4. From inside an agent session it is refused with 5.',
    flags: [RULE_ID, { name: 'to', value: '<n>', required: true, about: 'its new place in the list, from 0' }]
  },
  'policies-rules-reset': {
    summary: 'put back the starter rules and their otherwise; the mode stays',
    detail:
      'It also repairs a damaged rules file, a copy of which was kept beside it, and writes compatibility then (the mode sessions were starting in while it was damaged). When that copy could not be kept it is refused with 6 and leaves the file as it is. From inside an agent session it is refused with 5.'
  },

  // Answered by the Host out of its own registries, so the app may be closed; it needs a Host.
  'sessions-list': {
    summary: 'the agent sessions the Host holds, running and ended',
    detail:
      'Each with its id, which is the id `sessions read` and `sessions send` take and the one `ASTERA_SESSION` holds inside that session. `kind` is terminal (an agent CLI in a terminal) or chat. `state` is working, waiting or unknown, from the hook events a Claude terminal session writes; Codex and chat sessions are always unknown, and so is a session typed into since its last event. A session started from an agent profile carries `agentProfileId`. Plain shell tabs and run configurations are not sessions and are not listed. Answered by the Host, so it works with Astera closed. --status alive or ended reads `alive`, and working, waiting or unknown reads `state`. --provider is the provider of the account the session runs on, as `accounts list` prints it; a session whose account is gone matches neither. Any other value is refused with 2. --project keeps the sessions whose folder is inside the project (found the way `projects find` finds it), and the workers and coordinators of its runs wherever their worktree is; a folder no project holds is 4.',
    flags: [
      { name: 'status', value: '<alive|ended|working|waiting|unknown>', about: 'only sessions in this state' },
      { name: 'provider', value: '<claude|codex>', about: "only sessions on this vendor's accounts" },
      {
        name: 'project',
        value: '<path>',
        about: "only the sessions in the project's folder, and the workers and coordinators of its runs"
      }
    ]
  },
  'sessions-read': {
    summary: "what a terminal session's tab shows, or a chat session's recent turns",
    detail:
      "`kind` says which shape came back. A terminal session: the Host replays its recent output into a terminal at the tab's size. `screen` is the visible rows, top first, with the empty rows below the last painted one left off; `scrollback` is up to --lines rows (at most 10000) from just above it, oldest first; `cols` and `rows` are the size; `screenWrapped` and `scrollbackWrapped` mark, row for row, each row that continues the one above it (a line wider than the tab). Text only, trailing spaces trimmed, no colours. The Host keeps about 256,000 characters of each running session and drops them when it ends. A chat session: `turns` is up to --turns turns (at most 200), oldest first, each with `role`, `text` and `tools` (one line per tool call), read from the transcript the agent writes, so it works with Astera closed and survives the session ending. `pending` names the card the session is waiting on (an approval or a question), answered by whichever process is that session's writer: the Host's own adapter, Astera closed included, or Astera when it holds the session instead. It is left out when neither can say. --lines is for terminal sessions and --turns for chat sessions; the other one is refused with 2.",
    flags: [
      ID('<sessionId>', 'the session to read (from `sessions list`)'),
      { name: 'lines', value: '<n>', about: 'terminal: how many rows of scrollback above the screen (default 200)' },
      { name: 'turns', value: '<n>', about: 'chat: how many of the most recent turns (default 20)' }
    ]
  },
  'sessions-send': {
    summary: 'type into a terminal session and press Enter, or send a chat session one turn',
    detail:
      'A terminal session: writes the text, then Enter once the session has shown it and gone quiet (5 seconds at most), the way the app delivers a scheduled message. It types into whatever the session shows, a permission prompt included, so read it first; from inside an agent session, a send into a terminal session at a permission prompt or a question is refused with 6 before anything is typed. A chat session: the text is one turn, delivered by whichever process is that session\'s writer. With Astera open and holding the session, the app delivers it, and a session waiting on a card (an approval or a question) is refused with 6 naming the card: answer it with `chats answer`, or in Astera. Just after Astera starts, a session it has not taken back yet is a 6 as well. Otherwise, once the Host holds an adapter for the session, the Host delivers it itself, Astera closed included, refusing the same way for an open card; for a Codex session it sends only the text, with no model, effort or plan mode, so the settings the thread has now apply. A session the Host holds no adapter for still takes a blind write that queues behind any card. A send refused for a card, for a session not taken back yet or for a Codex session with no thread sent nothing, so the same --request-id can be used again. --no-enter is for terminal sessions only. One send at a time per session either way. `--text -` drops one trailing newline. A session that has ended is refused with 6. Any process running as you can do this to any session, agent sessions included. With --request-id a retry is not sent twice. --wait then waits until the turn ends: for a terminal session when its hook events leave it waiting with no prompt, for a chat session when its adapter goes back to idle. It exits 0 when the turn ended, 8 when a permission prompt or a question opened first (`details.promptId` names a chat prompt for `chats answer`), 7 when the deadline passed, and 1 when the session ended first; `data.turn` says which. A Codex terminal session writes no hook events, a chat session nothing holds cannot be read, and a terminal session busy in a turn would end the wait on that turn, so all three are refused with 6 before anything is typed. --wait with --no-enter is 2.',
    flags: [
      ID('<sessionId>', 'the session to type into (from `sessions list`)'),
      { name: 'text', value: '<text|->', required: true, about: 'what to type (a value of `-` reads it from stdin)' },
      { name: 'no-enter', about: 'terminal: type the text and do not press Enter' },
      { name: 'wait', about: 'after the send, wait until the turn it starts ends' },
      { name: 'timeout-ms', value: '<ms>', about: 'with --wait: how long to wait (default 3600000, one hour)' }
    ]
  },
  'sessions-create': {
    summary: 'start a terminal or chat session on an account, in a folder',
    detail:
      "The Host starts it, so Astera may be open or closed: a terminal session the way it starts a worker (the agent CLI in a terminal, with Astera's hooks, the folder trusted, and its permission prompts on or off as Astera's setting says), a chat session the way it restarts one after a roll. With Astera open, it takes the session back and shows it as a tab. Answers the session as `sessions list` shows it; its id is what `sessions read` and `sessions send` take. --prompt is the first thing it is asked. --roll-accounts is the chain it rolls onto at a usage limit, --account first unless you place it; every account must be one vendor's. --unattended is for chat sessions: hold (the default) leaves a permission prompt open for someone to answer, deny-after-60s denies it after a minute when nobody has. A folder that does not exist is 2, an unknown account 4, and a Host started without the agent CLI paths is 6. A worker session (one with an open Dispatch) is refused with 5. With --request-id a retry does not start a second session. With --agent-profile the session starts from that agent profile, which decides its shared MCP servers and its permission prompts; without --account it runs on the profile's first account and rolls onto the others in order. An unknown or archived profile, or one with no account left, is 2. From inside an agent session, a bypass profile is refused with 5 unless Astera's \"Run agents without permission checks\" is on.",
    flags: [
      { name: 'account', value: '<accountId>', about: 'the account it runs on (from `accounts list`); required unless --agent-profile gives it' },
      { name: 'agent-profile', value: '<id|name>', about: 'the agent profile it starts from (from `agent-profiles list`)' },
      { name: 'cwd', value: '<path>', required: true, about: 'the folder it starts in (a relative path is from here)' },
      { name: 'kind', value: '<terminal|chat>', about: 'terminal (default) or chat' },
      { name: 'title', value: '<text>', about: "the tab's title (default: the folder's name)" },
      { name: 'prompt', value: '<text|->', about: 'the first prompt (a value of `-` reads it from stdin)' },
      { name: 'roll-accounts', value: '<id,…>', about: 'the accounts to roll onto at a usage limit, in order' },
      { name: 'unattended', value: '<hold|deny-after-60s>', about: 'chat: a permission prompt nobody answers' }
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
 * **Each dash in turn, until a noun's verb follows it**, because a noun can hold a dash of its own
 * (`run-configs-list` is `run-configs list`) and so can a verb (`jobs-create-from-source` is
 * `jobs create-from-source`). The first dash where the rest is one of that noun's verbs is the split.
 *
 * Exported because cliOutput.ts builds `astera jobs get --help` as a recovery step and
 * cliAgentContext.ts prints one line per command, and three spellings of one rule would drift.
 */
export const spelledCommand = (cmd: string): string => {
  // Each dash in turn, since a noun (`run-configs`) and a verb (`create-from-source`) may hold one
  for (let dash = cmd.indexOf('-'); dash >= 0; dash = cmd.indexOf('-', dash + 1)) {
    const noun = cmd.slice(0, dash)
    const verb = cmd.slice(dash + 1)
    const verbs: readonly string[] | undefined = noun === 'browser' ? BROWSER_VERBS : noun === 'app' ? APP_VERBS : verbsOf(noun)
    if (verbs?.includes(verb) === true) return `${noun} ${verb}`
  }
  return cmd
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
    'any other command whose Host has not answered in 3s says so on stderr the same way.',
    '--verbose says on stderr which Host was reached, its handshake, and how long each call took.',
    'astera --project <path> <command> filters jobs list, runs list and sessions list to that project.',
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
  // The mode flags a line may start with (`astera --verbose jobs list --help`) are skipped, so the
  // command after them is the one described. A line that starts with any other flag gets the root.
  const lead = leadingGlobals(argv.filter((t) => !HELP_TOKENS.has(t)))
  const from = 'error' in lead ? 0 : lead.start
  const words: string[] = []
  for (const tok of argv.filter((t) => !HELP_TOKENS.has(t)).slice(from)) {
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
export const GLOBAL_FLAGS: readonly string[] = [
  'json',
  'human',
  'quiet',
  'no-keepalive',
  'verbose',
  'project',
  'runtime',
  'request-id',
  'help'
]

/** Global flags that go **before** the command only. After the command `--project` is a command's own
 *  flag, accepted where `USAGE` declares it and refused elsewhere: accepting it on every command would
 *  let `runs get --project p` run and ignore it, the fault this check exists for. run.ts hands this
 *  check the line from the command on, so a leading `--project` never reaches it. */
const LEADING_ONLY: ReadonlySet<string> = new Set(['project', 'runtime'])

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
  const allowed = new Set(
    [...own, ...(UNLISTED[pc] ?? []), ...GLOBAL_FLAGS.filter((f) => !LEADING_ONLY.has(f))].map(camel)
  )
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
  return `${spelledCommand(cmd)} does not take ${named}: ${takes}, plus the global ones (--json, --human, --quiet, --no-keepalive, --verbose, --request-id)`
}
