// Observe mode's resolver (design §6): a provider's tool call in, the canonical action out. Pure and deterministic, with
// no I/O, no clock and no model. A shell line is classified from its words and never run. What comes out is what a
// record keeps, so every target is short by construction (a program and its first subcommand, a path relative to the
// session folder, a host name, `server.tool`) and passes through redactTarget before it leaves.
import path from 'node:path'
import { isPathWithin } from '../files/tree'
import { redactSecrets } from '../remote/redact'

export type AuditAction =
  | 'process.execute'
  | 'git.read'
  | 'git.local.write'
  | 'git.remote.write'
  | 'github.pr.create'
  | 'github.write'
  | 'package.install'
  | 'filesystem.read'
  | 'filesystem.write'
  | 'filesystem.delete'
  | 'network.request'
  | 'mcp.call'
  | 'agent.spawn'
  | 'other'

export type Confidence = 'exact' | 'high' | 'heuristic' | 'unknown'

export interface ResolveCall {
  provider: 'claude' | 'codex'
  tool: string
  /** The tool's input as the provider wrote it: Claude's `tool_input` object, or Codex's `arguments` (a JSON string)
   *  or patch text. */
  input: unknown
  /** The session's folder, what "inside the project" is measured against. */
  cwd: string
}

/** What one command of a line does, and where, for a rule to judge on its own. */
export interface CommandFacts {
  action: AuditAction
  /** Left out when the command names no path. */
  insideProject?: boolean
}

export interface ResolvedAction {
  action: AuditAction
  target: string
  /** Whether every path the headline command names is under `cwd`. Left out when it names no path. False also means
   *  "cannot be shown to be inside" (a `~` or a variable in a shell path). */
  insideProject?: boolean
  confidence: Confidence
  /** Every command of a compound shell line, and every file a redirection or a pipe into a writer touches, in order and
   *  without repeats, each with its own place. Left out for a line that is one command with nothing else. */
  commands?: CommandFacts[]
}

const SHELL_TARGET_MAX = 60
const TARGET_MAX = 200

type Words = string[]
type Flavor = 'posix' | 'ps'
type Kind =
  | 'shell' | 'read' | 'write' | 'search' | 'fetch' | 'web-search' | 'patch' | 'agent' | 'exec' | 'quiet' | 'worktree' | 'stdin'

const table = <T>(value: T, words: string): Array<[string, T]> => words.split(/\s+/).map((w) => [w, value])

const KINDS: Record<ResolveCall['provider'], ReadonlyMap<string, Kind>> = {
  claude: new Map<string, Kind>([
    ['Bash', 'shell'], ['PowerShell', 'shell'], ['Monitor', 'shell'],
    ['Read', 'read'], ['NotebookRead', 'read'],
    ['Grep', 'search'], ['Glob', 'search'], ['LS', 'search'],
    ['Write', 'write'], ['Edit', 'write'], ['MultiEdit', 'write'], ['NotebookEdit', 'write'],
    ['WebFetch', 'fetch'], ['WebSearch', 'web-search'],
    ['Agent', 'agent'], ['Task', 'agent'],
    ['EnterWorktree', 'worktree'], ['ExitWorktree', 'worktree'],
    // They run nothing: notes to oneself, questions to the person, asking Claude's own harness something.
    ...table<Kind>(
      'quiet',
      `TodoWrite TodoRead ToolSearch Skill SendMessage AskUserQuestion ExitPlanMode EnterPlanMode TaskOutput TaskStop TaskCreate
      TaskUpdate TaskList TaskGet BashOutput KillShell KillBash ListAgents`
    )
  ]),
  codex: new Map<string, Kind>([
    ['shell', 'shell'], ['shell_command', 'shell'], ['exec_command', 'shell'], ['local_shell', 'shell'], ['container.exec', 'shell'],
    ['exec', 'exec'], ['apply_patch', 'patch'], ['view_image', 'read'],
    ['web_search', 'web-search'], ['web_search_call', 'web-search'], ['web__run', 'web-search'],
    ['spawn_agent', 'agent'],
    ['write_stdin', 'stdin'], // types into a session that is already running, so what it runs cannot be told
    ...table<Kind>(
      'quiet',
      `wait update_plan sleep send_message followup_task list_agents wait_agent close_agent request_user_input
      request_user_input_async`
    )
  ])
}

/** Never throws: the Host feeds this from files and streams it does not control, so a call it cannot read is `other`. */
export function resolveAction(call: ResolveCall): ResolvedAction {
  try {
    const r = resolve(call)
    return { ...r, target: clip(redactTarget(r.target), TARGET_MAX) }
  } catch {
    const target = typeof call.tool === 'string' ? clip(redactTarget(call.tool), TARGET_MAX) : 'unknown'
    return { action: 'other', target, confidence: 'unknown' }
  }
}

/** The shell a tool runs its command in. Claude names it; Codex and Monitor run the platform's own. */
function flavorOf(tool: string): Flavor {
  if (tool === 'PowerShell') return 'ps'
  if (tool === 'Bash') return 'posix'
  return process.platform === 'win32' ? 'ps' : 'posix'
}

function resolve({ provider, tool, input, cwd }: ResolveCall): ResolvedAction {
  const mcp = mcpTarget(tool)
  if (mcp !== null) return { action: 'mcp.call', target: mcp, confidence: 'exact' }
  const rec = asRecord(input)
  const ctx: Ctx = { cwd, base: cwd }
  switch (KINDS[provider].get(tool)) {
    case 'shell':
      return resolveShell(rec, cwd, flavorOf(tool))
    case 'exec':
      return resolveExec(str(input), cwd)
    case 'read':
      return fileTool('filesystem.read', tool, [str(rec.file_path) ?? str(rec.notebook_path) ?? str(rec.path)], ctx)
    case 'write':
      return fileTool('filesystem.write', tool, [str(rec.file_path) ?? str(rec.notebook_path)], ctx)
    case 'search': {
      const where = str(rec.path) ?? (tool === 'Glob' ? globRoot(str(rec.pattern)) : '.')
      return fileTool('filesystem.read', tool, [where], ctx)
    }
    case 'patch':
      return fileTool('filesystem.write', tool, patchPaths(str(rec.input) ?? str(rec.patch) ?? str(input)), ctx)
    case 'fetch': {
      const host = hostOf(str(rec.url) ?? '')
      return host === null
        ? { action: 'network.request', target: tool, confidence: 'unknown' }
        : { action: 'network.request', target: host, confidence: 'exact' }
    }
    case 'web-search':
      return { action: 'network.request', target: 'web search', confidence: 'exact' } // the query is the person's text, not recorded
    case 'agent':
      return { action: 'agent.spawn', target: '', confidence: 'exact' }
    case 'quiet':
      return { action: 'other', target: tool, confidence: 'exact' }
    case 'worktree':
      return { action: 'git.local.write', target: tool, confidence: 'exact' }
    case 'stdin':
      return { action: 'process.execute', target: tool, confidence: 'unknown' }
    default:
      return { action: 'other', target: tool, confidence: 'unknown' }
  }
}

/** What a part contributes to `commands`: its own action and place, or the list it already carries. */
function effectsOf(p: ResolvedAction): CommandFacts[] {
  if (p.commands !== undefined) return p.commands
  return [p.insideProject === undefined ? { action: p.action } : { action: p.action, insideProject: p.insideProject }]
}

/**
 * What one line of work did when it was several things. The headline (`lead`, the first part unless the caller names
 * another) gives the action, target and place; `commands` lists them all without repeats; the line is unknown if any part
 * was, heuristic if it was `compound` (several commands, or a loop or conditional) and otherwise as sure as its headline.
 */
function combine(parts: ResolvedAction[], compound: boolean, lead: ResolvedAction = parts[0]): ResolvedAction {
  if (parts.length === 1 && !compound) return parts[0]
  const seen = new Set<string>()
  const commands = parts.flatMap(effectsOf).filter((c) => {
    const key = `${c.action}|${c.insideProject}`
    return seen.has(key) ? false : (seen.add(key), true)
  })
  const out: ResolvedAction = {
    action: lead.action,
    target: lead.target,
    confidence: parts.some((p) => p.confidence === 'unknown') ? 'unknown' : compound ? 'heuristic' : lead.confidence,
    commands
  }
  if (lead.insideProject !== undefined) out.insideProject = lead.insideProject
  return out
}

/**
 * A Codex `exec` call. Its input is not arguments but a script: `await tools.exec_command({cmd:"…","workdir":"…"})`,
 * `tools.apply_patch("*** Begin Patch…")`, `tools.mcp__<server>__<tool>({…})`, `tools.view_image({path:"…"})`. Each
 * `tools.<name>(` in the code (not in a string or a comment) is a call, resolved as the tool of that name; several make a
 * compound line.
 */
function resolveExec(source: string | null, cwd: string): ResolvedAction {
  const text = source ?? ''
  const calls = toolCalls(text)
  if (calls.length === 0) return { action: 'other', target: 'exec', confidence: 'unknown' }
  const parts = calls.map((c, i) =>
    resolve({ provider: 'codex', tool: c.name, input: execArgs(c.name, text.slice(c.from, calls[i + 1]?.at)), cwd })
  )
  return combine(parts, parts.length > 1)
}

const CALL = /tools\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/y

/** The `tools.<name>(` calls of a script, found in its code only: string literals and comments are skipped, and so is a
 *  property of something else (`this.tools.get(`). `from` is where the arguments start, `at` where the call does. */
function toolCalls(source: string): Array<{ name: string; at: number; from: number }> {
  const calls: Array<{ name: string; at: number; from: number }> = []
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '"' || c === "'" || c === '`') {
      i = endOfString(source, i)
    } else if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      if (nl < 0) break
      i = nl
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) break
      i = end + 1
    } else if (c === 't' && !/[\w$.]/.test(source[i - 1] ?? '')) {
      CALL.lastIndex = i
      const m = CALL.exec(source)
      if (m !== null) {
        calls.push({ name: m[1], at: i, from: i + m[0].length })
        i += m[0].length - 1
      }
    }
  }
  return calls
}

/** The index of the quote that closes the string literal opened at `open`, or the end of the source. */
function endOfString(source: string, open: number): number {
  const quote = source[open]
  for (let j = open + 1; j < source.length; j++) {
    if (source[j] === '\\') j++
    else if (source[j] === quote) return j
  }
  return source.length
}

/** A string literal as the script wrote it (JSON-compatible), or null. */
function literal(text: string | undefined): string | null {
  if (text === undefined) return null
  try {
    const v: unknown = JSON.parse(text)
    return str(v)
  } catch {
    return null // a template or single-quoted string, which this does not read
  }
}

/** The arguments of one call in an exec script, as the object its tool reads. Only the fields the resolver uses are read. */
function execArgs(tool: string, args: string): unknown {
  if (tool === 'apply_patch') return literal(/^\s*("(?:[^"\\]|\\.)*")/.exec(args)?.[1])
  const field = (name: string): string | null => literal(new RegExp(`\\b${name}"?\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(args)?.[1])
  return { cmd: field('cmd'), workdir: field('workdir'), path: field('path') }
}

// ---------------------------------------------------------------------------------------------------------------------
// Input helpers

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s)

/** The input as an object. Codex hands a call's arguments over as a JSON string. */
function asRecord(input: unknown): Record<string, unknown> {
  if (isRecord(input)) return input
  if (typeof input === 'string' && input.trimStart().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(input)
      if (isRecord(parsed)) return parsed
    } catch {
      // not JSON: patch text that starts with a brace, say
    }
  }
  return {}
}

/** `mcp__<server>__<tool>` as `server.tool`. The server is what sits before the first `__`, as Claude Code reads it. */
function mcpTarget(tool: string): string | null {
  if (!tool.startsWith('mcp__')) return null
  const rest = tool.slice(5)
  const i = rest.indexOf('__')
  return i <= 0 || i + 2 >= rest.length ? null : `${rest.slice(0, i)}.${rest.slice(i + 2)}`
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

/** Where a Glob with no `path` searches: the fixed part of an absolute pattern, else the session's folder. */
function globRoot(pattern: string | null): string {
  if (pattern === null || !path.isAbsolute(nativePath(pattern))) return '.'
  const wild = pattern.search(/[*?[{]/)
  const head = wild < 0 ? pattern : pattern.slice(0, wild)
  return /[\\/]$/.test(head) ? head : path.dirname(head)
}

/** The files an `apply_patch` names, from its envelope's own header lines (a rename's destination counts as a file). The
 *  path is taken to the end of its line and trimmed after, which stays linear where a lazy match before `\s*$` does not. */
function patchPaths(text: string | null): string[] {
  if (text === null) return []
  return [...text.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((m) => m[1].trim())
}

// ---------------------------------------------------------------------------------------------------------------------
// Paths

interface Ctx {
  /** The session's folder. */
  cwd: string
  /** What a relative path is relative to: the session's folder, a Codex call's own working directory, or where a `cd`
   *  went. Null after a `cd` to somewhere this cannot follow. */
  base: string | null
}

/** A shell path that names a place this cannot follow: home (also `~user`), or a variable. */
const UNFOLLOWABLE = /^~|\$|%[^%\s]+%/
/** A home path as a tool that takes literal paths gets it: `~/x`, `~\x`. A file called `~$draft.docx` is not one. */
const HOME = /^~(?:[\\/]|$)/

interface Place {
  shown: string
  inside: boolean
}

/** Git Bash, which Claude's Bash tool uses on Windows, writes the C: drive as /c. */
function nativePath(p: string): string {
  if (process.platform !== 'win32') return p
  const m = /^\/([A-Za-z])(?=\/|$)/.exec(p)
  return m === null ? p : `${m[1]}:${p.slice(2) || '/'}`
}

const leaf = (p: string): string => path.basename(p.replace(/[\\/]+$/, '')) || p

/** Where one path is. A home path, a shell path this cannot follow (`$VAR`, `%VAR%`, `~user`), or a relative one after a
 *  `cd` it could not follow counts as outside: the rule about outside is there for what is not provably in the folder. */
function placeOf(p: string, ctx: Ctx, fromShell: boolean): Place {
  const outside = (name: string): Place => ({ shown: `outside project: ${name}`, inside: false })
  if (HOME.test(p) || (fromShell && UNFOLLOWABLE.test(p))) return outside(leaf(p))
  const native = nativePath(p)
  if (ctx.base === null && !path.isAbsolute(native)) return outside(leaf(p))
  const abs = path.resolve(ctx.base ?? ctx.cwd, native)
  if (!isPathWithin(ctx.cwd, abs)) return outside(leaf(abs))
  // Sliced rather than path.relative, which does not fold case on darwin where isPathWithin does.
  const rel = abs.slice(path.resolve(ctx.cwd).length).replace(/^[\\/]+/, '')
  return { shown: rel === '' ? '.' : rel.split(path.sep).join('/'), inside: true }
}

/** The first path and a count of the rest, and whether all of them are inside. */
function placesOf(paths: string[], ctx: Ctx, fromShell: boolean): { target: string; inside: boolean } {
  const uniq = [...new Set(paths)]
  const places = uniq.map((p) => placeOf(p, ctx, fromShell))
  const first = places[0].shown
  return { target: uniq.length > 1 ? `${first} (+${uniq.length - 1})` : first, inside: places.every((p) => p.inside) }
}

/** A structured file tool. With no path to read, the call is unknown rather than guessed. */
function fileTool(action: AuditAction, tool: string, paths: Array<string | null>, ctx: Ctx): ResolvedAction {
  const named = paths.filter((p): p is string => p !== null)
  if (named.length === 0) return { action, target: tool, confidence: 'unknown' }
  const { target, inside } = placesOf(named, ctx, false)
  return { action, target, insideProject: inside, confidence: 'exact' }
}

// ---------------------------------------------------------------------------------------------------------------------
// Shell

/** One command of a shell line. */
interface Cmd {
  words: Words
  /** The files its output is redirected into (`>`, `>>`), without /dev/null and the like. */
  out: string[]
  /** It began with PowerShell's call operator `&`, so its first word is a program however it is spelled. */
  call: boolean
  /** Its first word was quoted. */
  quoted: boolean
}

interface Facts {
  action: AuditAction
  target: string
  /** The program (and, where the table looks, its subcommand) is one the table has a row for, and what it acts on is known. */
  known: boolean
  inside?: boolean
  /** The target is a path, which keeps to the length a structured tool's does rather than the shell cap. */
  path?: true
}

/** Commands that change nothing a rule cares about, so a line is not headlined by its leading `cd` or its `[ -f x ]`. */
const PASSIVE = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', '[', '[[', 'test', 'true', 'false'])
/** Commands after which a relative path is relative to somewhere else. */
const MOVES = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl'])
/** Commands that only print what they are given, so with a redirection the file written is the point of the line. */
const PRODUCERS = new Set(['echo', 'printf', 'cat', 'write-output', 'write-host'])

function resolveShell(rec: Record<string, unknown>, cwd: string, flavor: Flavor): ResolvedAction {
  const raw = rec.command ?? rec.cmd
  // Codex may send an argv array; `bash -lc <script>` in it is read below like a typed line.
  const typed: Cmd[] =
    typeof raw === 'string'
      ? splitLine(raw)
      : Array.isArray(raw)
        ? [{ words: raw.filter((w): w is string => typeof w === 'string'), out: [], call: false, quoted: false }]
        : []
  const workdir = str(rec.workdir)
  let base: string | null = workdir === null ? cwd : path.resolve(cwd, nativePath(workdir))
  const { commands, scripted } = expand(typed, flavor)

  const parts: ResolvedAction[] = []
  let lead: ResolvedAction | undefined
  for (const cmd of commands) {
    const ctx: Ctx = { cwd, base }
    let own: ResolvedAction | undefined
    if (cmd.words.length > 0) {
      const f = classify(cmd, ctx)
      own = {
        action: f.action,
        // Cut before it is redacted, so a long word costs no more than a short one.
        target: clip(redactTarget(clip(f.target, 200)), f.path === true ? TARGET_MAX : SHELL_TARGET_MAX),
        confidence: f.known ? 'high' : 'unknown'
      }
      if (f.inside !== undefined) own.insideProject = f.inside
      parts.push(own)
    }
    const writes: ResolvedAction[] = cmd.out.map((file) => {
      const { target, inside } = placesOf([file], ctx, true)
      const shown = clip(redactTarget(clip(target, 200)), TARGET_MAX)
      return { action: 'filesystem.write', target: shown, insideProject: inside, confidence: 'high' }
    })
    parts.push(...writes)

    const prog = cmd.words.length > 0 ? programName(cmd.words[0]).toLowerCase() : ''
    if (lead === undefined) {
      const onlyPrints = own !== undefined && PRODUCERS.has(prog) && own.action === 'process.execute'
      if (own === undefined || (onlyPrints && writes.length > 0)) lead = writes[0]
      else if (!PASSIVE.has(prog)) lead = own
    }
    if (MOVES.has(prog)) base = movedTo(cmd.words.slice(1), ctx)
  }
  if (parts.length === 0) return { action: 'process.execute', target: 'shell', confidence: 'unknown' }
  return combine(parts, commands.length > 1 || scripted, lead)
}

/** Where a `cd` goes, or null when it goes to home, a variable, nowhere or somewhere relative to a place already lost. */
function movedTo(args: Words, ctx: Ctx): string | null {
  const [dest] = pathArgs('cd', args)
  if (dest === undefined || UNFOLLOWABLE.test(dest)) return null
  const native = nativePath(dest)
  return ctx.base === null && !path.isAbsolute(native) ? null : path.resolve(ctx.base ?? ctx.cwd, native)
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** PowerShell `$env:X='y'` in one word, or `$x` with the `=` as the next word. */
const PS_ASSIGNED = /^\$[\w:.]+[+-]?=/
const PS_VARIABLE = /^\$[\w:.]+$/
/** What PowerShell writes where a command could be but is not: a variable, a member (`.Count`), an operator (`-not`), a
 *  type (`[int]`). */
const PS_EXPRESSION = /^(?:\$|\.[A-Za-z]|-[A-Za-z]|\[[A-Za-z])/
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'time', 'nohup', 'command'])
/** Words that lead a command, which is what follows them. */
const KEYWORDS = new Set(['if', 'elif', 'elseif', 'while', 'until', 'then', 'else', 'do', '!'])
/** Words that start a command which runs nothing: a loop or case header, a closer, a jump. */
const NO_COMMAND = new Set([
  'for', 'foreach', 'select', 'case', 'switch', 'function', 'try', 'catch', 'finally', 'throw', 'fi', 'done', 'esac', 'break',
  'continue', 'return'
])
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const INTERPRETERS = new Set([...POSIX_SHELLS, 'powershell', 'pwsh', 'cmd'])
const PROGRAM = /^(?:[\w.+@-]+|\[\[?)$/

/** The program as it is named, without its folder or a Windows executable extension. */
function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word
  return base.replace(/\.(?:exe|cmd|bat|com|ps1)$/i, '')
}

/** Where the command starts after `timeout [-s SIG] [-k DUR] DURATION`. */
function afterTimeout(words: Words, from: number): number {
  let i = from
  while (i < words.length && words[i].startsWith('-')) i += /^(?:-s|-k|--signal|--kill-after)$/.test(words[i]) ? 2 : 1
  return DURATION.test(words[i] ?? '') ? i + 1 : i
}

/**
 * A command without what comes before its program: `NAME=value` and PowerShell `$name =` assignments (their values can
 * be secrets), sudo-like wrappers and `timeout N`, and the keyword of a conditional or loop body (`then`, `do`, `while`).
 * `syntax` is whether a keyword or a word that runs nothing was seen (a loop header, a PowerShell condition or `.Count`),
 * which makes the line a script. A command of only assignments or only a header comes back with no words.
 */
function stripPrefix(raw: Cmd, flavor: Flavor): { cmd: Cmd; syntax: boolean } {
  const words = raw.words
  let i = 0
  let syntax = false
  while (i < words.length) {
    const w = words[i].toLowerCase()
    if (ASSIGNMENT.test(words[i]) || PS_ASSIGNED.test(words[i]) || WRAPPERS.has(programName(w))) i++
    else if (PS_VARIABLE.test(words[i]) && /^[+-]?=$/.test(words[i + 1] ?? '')) i += 2
    else if (KEYWORDS.has(w)) {
      i++
      syntax = true
    } else if (programName(w) === 'timeout') i = afterTimeout(words, i + 1)
    else break
  }
  const rest = words.slice(i)
  const quoted = i === 0 && raw.quoted
  const cmd: Cmd = { words: rest, out: raw.out, call: raw.call, quoted }
  const noCommand = rest.length > 0 && NO_COMMAND.has(rest[0].toLowerCase())
  const expression = flavor === 'ps' && rest.length > 0 && !raw.call && !quoted && PS_EXPRESSION.test(rest[0])
  return noCommand || expression ? { cmd: { ...cmd, words: [] }, syntax: true } : { cmd, syntax }
}

/** The script a shell was handed with -c / -Command / /c, if it was handed one, and the shell it is written for. */
function scriptOf(words: Words): { text: string; flavor: Flavor } | null {
  const prog = programName(words[0] ?? '').toLowerCase()
  const rest = words.slice(1)
  if (POSIX_SHELLS.has(prog)) {
    const i = rest.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a))
    return i >= 0 && i + 1 < rest.length ? { text: rest[i + 1], flavor: 'posix' } : null
  }
  const i = rest.findIndex((a) => (prog === 'cmd' ? /^\/[ck]$/i.test(a) : /^-c(?:ommand)?$/i.test(a)))
  if (i < 0 || i + 1 >= rest.length) return null
  if (prog === 'cmd') return { text: rest.slice(i + 1).join(' '), flavor: 'posix' }
  return prog === 'powershell' || prog === 'pwsh' ? { text: rest.slice(i + 1).join(' '), flavor: 'ps' } : null
}

/** The commands of a line with the scripts inside `bash -c` and the like replaced by their own commands, and whether any
 *  of it was control flow. */
function expand(cmds: Cmd[], flavor: Flavor, depth = 0): { commands: Cmd[]; scripted: boolean } {
  const out: Cmd[] = []
  let scripted = false
  for (const raw of cmds) {
    const { cmd, syntax } = stripPrefix(raw, flavor)
    scripted ||= syntax
    if (cmd.words.length === 0 && cmd.out.length === 0) continue
    const script = depth < 2 && cmd.words.length > 0 ? scriptOf(cmd.words) : null
    if (script === null) out.push(cmd)
    else {
      const inner = expand(splitLine(script.text), script.flavor, depth + 1)
      out.push(...inner.commands)
      if (cmd.out.length > 0) out.push({ words: [], out: cmd.out, call: false, quoted: false }) // `bash -c "x" > f`
      scripted ||= inner.scripted
    }
  }
  return { commands: out, scripted }
}

const ESCAPABLE = ' "\'&|;()<>$#'
/** An unquoted heredoc delimiter, matched in place (sticky) so a line of many heredocs is not copied again for each. */
const TAG = /[\w.-]*/y
/** Where a redirection can point that writes no file: the null devices and the standard streams. */
const SINK = /^(?:\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)|nul|\$null)$/i

/**
 * A shell line as the commands it runs, each a list of words with the quotes taken off.
 *
 * Splits on `&&`, `||`, `;`, `|`, `&`, newlines and the brackets of `( )` and `$( )` outside quotes, so the commands in a
 * group or a substitution are seen. A redirection's operator and target are not words: a `>` target is kept apart as a
 * file the command writes; `2>&1`, `< in` and heredoc bodies are left out. A `&` that starts a command is PowerShell's
 * call operator. Backslash is a path separator on Windows, so it only escapes the characters a shell line needs it for.
 */
function splitLine(line: string): Cmd[] {
  const commands: Cmd[] = []
  let words: Words = []
  let out: string[] = []
  let call = false
  let quoted = false // the first word was quoted
  let wordQuoted = false // the word being read has had a quote in it
  let cur = ''
  let has = false // a word has begun, so an empty '' counts
  let sink: { write: boolean; dup: boolean } | null = null // the next word is a redirection's target
  let heredoc: { tag: string; indent: boolean } | null = null

  const endWord = (): void => {
    if (has) {
      if (sink !== null) {
        const duplicate = sink.dup && /^(?:\d+|-)$/.test(cur) // the 1 of 2>&1
        if (sink.write && !duplicate && !SINK.test(cur)) out.push(cur)
        sink = null
      } else {
        if (words.length === 0) quoted = wordQuoted
        words.push(cur)
      }
    }
    cur = ''
    has = false
    wordQuoted = false
  }
  const endCommand = (): void => {
    endWord()
    sink = null
    if (words.length > 0 || out.length > 0) commands.push({ words, out, call, quoted })
    words = []
    out = []
    call = false
    quoted = false
  }

  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") {
      const j = line.indexOf("'", i + 1)
      const end = j < 0 ? line.length : j
      cur += line.slice(i + 1, end)
      has = true
      wordQuoted = true
      i = end
    } else if (c === '"') {
      has = true
      wordQuoted = true
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === '\\' && (line[i + 1] === '"' || line[i + 1] === '$')) i++
        cur += line[i]
      }
    } else if (c === '\\') {
      const n = line[i + 1]
      if (n === '\n') i++
      else if (n === '\r' && line[i + 2] === '\n') i += 2
      else if (n !== undefined && ESCAPABLE.includes(n)) {
        cur += n
        has = true
        i++
      } else {
        cur += c
        has = true
      }
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
    } else if (c === '\n') {
      endCommand()
      if (heredoc !== null) i = endOfHeredoc(line, i, heredoc)
      heredoc = null
    } else if (c === '#' && !has) {
      while (i + 1 < line.length && line[i + 1] !== '\n') i++ // a comment
    } else if (c === ';' || c === '|' || c === '(' || c === ')') {
      endCommand()
    } else if (c === '&') {
      if (line[i + 1] === '&') {
        endCommand()
        i++
      } else if (line[i - 1] === '>' || line[i - 1] === '<' || line[i + 1] === '>') {
        cur += c // the & of 2>&1 or &>file
        has = true
      } else if (words.length === 0 && out.length === 0 && !has) {
        call = true // PowerShell's call operator, at the start of a command
      } else endCommand()
    } else if ((c === '{' || c === '}') && !has && /^(?:\s|;|$)/.test(line.slice(i + 1, i + 2))) {
      endCommand() // a group or script block's brace, standing alone
    } else if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      endWord()
      let j = i + 2
      const indent = line[j] === '-'
      if (indent) j++
      while (line[j] === ' ' || line[j] === '\t') j++
      let tag: string
      if (line[j] === "'" || line[j] === '"') {
        const k = line.indexOf(line[j], j + 1)
        tag = line.slice(j + 1, k < 0 ? line.length : k)
        j = k < 0 ? line.length : k + 1
      } else {
        TAG.lastIndex = j
        tag = TAG.exec(line)?.[0] ?? ''
        j += tag.length
      }
      heredoc = tag === '' ? null : { tag, indent }
      i = j - 1
    } else if (c === '>' || c === '<') {
      if (/^\d*&?$/.test(cur)) {
        cur = '' // the file descriptor in 2>x
        has = false
        wordQuoted = false
      } else endWord()
      let dup = false
      while (line[i + 1] === '>' || line[i + 1] === '<' || line[i + 1] === '&' || line[i + 1] === '|') {
        if (line[i + 1] === '&') dup = true
        i++
      }
      sink = { write: c === '>', dup }
    } else {
      cur += c
      has = true
    }
  }
  endCommand()
  return commands
}

/** Where the heredoc that opened on the line ending at `nl` closes: the index of the newline after its terminator. */
function endOfHeredoc(line: string, nl: number, h: { tag: string; indent: boolean }): number {
  let pos = nl + 1
  while (pos <= line.length) {
    const next = line.indexOf('\n', pos)
    const end = next < 0 ? line.length : next
    const text = line.slice(pos, end).replace(/\r$/, '')
    if ((h.indent ? text.trim() : text) === h.tag) return end
    if (next < 0) break
    pos = next + 1
  }
  return line.length
}

// The programs the table has a row for, as ordinary `process.execute` at high confidence. Anything else is `unknown`.
const KNOWN = new Set(
  `cd chdir pushd popd pwd ls dir tree cat type head tail less more bat nl wc sort uniq cut tr tee diff cmp file stat du df which
  where whoami hostname date uname env printenv echo printf true false test [ [[ sleep clear cls export unset exit read local
  declare readonly shift wait trap set seq id free top man yes watch
  grep egrep fgrep rg ack find fd sed awk xargs jq yq perl ruby php
  ps kill pkill killall lsof netstat ss ping nslookup tasklist taskkill cygpath sha256sum md5sum shasum base64 od xxd hexdump
  strings column paste join comm split tac rev fold
  mkdir md cp copy xcopy robocopy mv move ren rename touch ln chmod chown rm rmdir del erase rd unlink tar zip unzip gzip gunzip 7z
  basename dirname realpath readlink mktemp
  git gh node npm npx pnpm pnpx yarn bun bunx deno tsc tsx vitest jest mocha eslint prettier vite webpack esbuild rollup turbo nx
  python python3 py pip pip3 pytest uv poetry ruff mypy black cargo rustc rustup go gofmt java javac mvn mvnw gradle gradlew dotnet
  make cmake ninja gcc g++ clang docker docker-compose kubectl helm terraform curl wget ssh scp rsync code claude codex astera
  set-location sl foreach-object new-item set-content add-content out-file copy-item move-item rename-item remove-item stop-process
  start-sleep out-string out-host out-null out-default gc gci`
    .split(/\s+/)
    .filter((w) => w !== '')
)
const PYTHON = /^python\d*(?:\.\d+)?$/
/** PowerShell's verbs for reading, selecting and printing, which every cmdlet of that verb keeps to. (Not `Out-`: Out-File
 *  writes.) */
const PS_READ_VERB = /^(?:get|test|select|where|sort|measure|format|write|group|compare|convertto|convertfrom|join|split|resolve)-[a-z]+$/

/** The programs whose first subcommand is part of the target (`git push`, `npm test`). Others show the program alone. */
const SUBCOMMAND_PROGRAMS = new Set(
  `git gh npm pnpm yarn bun npx pnpx bunx pip pip3 uv poetry cargo go dotnet docker docker-compose kubectl helm terraform make
  deno rustup claude codex astera`.split(/\s+/)
)

/** Global options that take a value, which `git -C dir push` and the like must step over to find the subcommand. */
const VALUED_GLOBALS = new Map<string, ReadonlySet<string>>([
  ['git', new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])],
  ['gh', new Set(['-R', '--repo'])],
  ['npm', new Set(['--prefix', '-C', '--workspace', '-w', '--registry', '--cache', '--userconfig'])],
  ['pnpm', new Set(['--dir', '-C', '--filter', '-F'])],
  ['yarn', new Set(['--cwd'])],
  ['cargo', new Set(['--manifest-path'])],
  ['docker', new Set(['-H', '--host', '-c', '--context', '--config'])],
  ['kubectl', new Set(['-n', '--namespace', '--context', '--kubeconfig'])]
])

/** The index of the first non-flag word, stepping over the global options that take a value; -1 when there is none. */
function subcommandAt(prog: string, args: Words): number {
  const valued = VALUED_GLOBALS.get(prog)
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (valued?.has(args[i])) i++
    } else return i
  }
  return -1
}

/** The first `n` non-flag words after the program. */
function positionals(prog: string, args: Words, n: number): string[] {
  const valued = VALUED_GLOBALS.get(prog)
  const out: string[] = []
  for (let i = 0; i < args.length && out.length < n; i++) {
    if (args[i].startsWith('-')) {
      if (valued?.has(args[i])) i++
    } else out.push(args[i])
  }
  return out
}

/** A subcommand is a plain word; a path or a quoted sentence in its place is not one. */
function subcommandOf(prog: string, args: Words): string | undefined {
  const at = subcommandAt(prog, args)
  const sub = at < 0 ? undefined : args[at]
  return sub !== undefined && /^[A-Za-z0-9@][\w.:@/+-]{0,39}$/.test(sub) ? sub : undefined
}

const isSwitch = (a: string, prog: string): boolean =>
  (a.length > 1 && a.startsWith('-')) || (CMD_SWITCH_PROGRAMS.has(prog) && /^\/[A-Za-z]$/.test(a))

const GIT = new Map<string, AuditAction>([
  ...table<AuditAction>(
    'git.read',
    `status log diff show blame ls-files ls-tree rev-parse rev-list describe shortlog grep cat-file show-ref name-rev
    merge-base diff-tree check-ignore ls-remote reflog for-each-ref check-attr count-objects`
  ),
  ...table<AuditAction>('git.remote.write', 'push'),
  ...table<AuditAction>(
    'git.local.write',
    `add commit checkout switch merge rebase reset restore rm mv cherry-pick revert apply am clean stash tag branch remote
    config worktree submodule init clone fetch pull gc notes update-ref filter-branch`
  )
])

/** Git subcommands that both list and change. What they do is read from the words after them. */
const GIT_AMBIGUOUS = new Set(['branch', 'tag', 'remote', 'stash', 'config', 'worktree', 'submodule'])

/** Whether `git <sub> <rest>` only lists. */
function gitLists(sub: string, rest: Words): boolean {
  const flags = rest.filter((a) => a.startsWith('-'))
  const pos = rest.filter((a) => !a.startsWith('-'))
  const has = (re: RegExp): boolean => flags.some((f) => re.test(f))
  switch (sub) {
    case 'branch':
      if (has(/^(?:-[dDmMcCfu]|--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description))$/)) return false
      return has(/^(?:-[arvl]|-vv|--(?:list|show-current|all|remotes|verbose|contains|no-contains|merged|no-merged|points-at|sort))$/) || pos.length === 0
    case 'tag':
      if (has(/^(?:-[dasfmFu]|--(?:delete|annotate|sign|force|local-user))$/)) return false
      return has(/^(?:-[ln]|--(?:list|contains|no-contains|merged|no-merged|points-at|sort))$/) || pos.length === 0
    case 'remote':
      return pos.length === 0 || pos[0] === 'show' || pos[0] === 'get-url'
    case 'stash':
      return pos[0] === 'list' || pos[0] === 'show'
    case 'config':
      if (has(/^--(?:unset|unset-all|add|replace-all|edit|rename-section|remove-section)$|^-e$/)) return false
      return has(/^(?:-l|--(?:get|get-all|get-regexp|get-urlmatch|list))$/) || pos.length === 1
    case 'worktree':
      return pos[0] === 'list'
    default: // submodule
      return pos.length === 0 || pos[0] === 'status' || pos[0] === 'summary'
  }
}

function gitAction(sub: string, rest: Words): AuditAction | undefined {
  const action = GIT.get(sub)
  return action === 'git.local.write' && GIT_AMBIGUOUS.has(sub) && gitLists(sub, rest) ? 'git.read' : action
}

/** `gh <group> <verb>` pairs that change something on GitHub; the rest of gh reads. */
const GH_WRITES = new Map<string, ReadonlySet<string>>([
  ['pr', new Set(['merge', 'close', 'comment', 'edit', 'review', 'ready', 'reopen', 'lock', 'unlock', 'update-branch'])],
  ['issue', new Set(['create', 'close', 'comment', 'edit', 'reopen', 'delete', 'transfer', 'pin', 'unpin', 'lock', 'unlock', 'develop'])],
  ['release', new Set(['create', 'delete', 'edit', 'upload', 'delete-asset'])],
  ['repo', new Set(['create', 'delete', 'edit', 'fork', 'rename', 'archive', 'unarchive', 'sync'])],
  ['label', new Set(['create', 'edit', 'delete', 'clone'])],
  ['workflow', new Set(['run', 'enable', 'disable'])],
  ['run', new Set(['rerun', 'cancel', 'delete'])],
  ['gist', new Set(['create', 'edit', 'delete', 'rename'])],
  ['secret', new Set(['set', 'delete', 'remove'])],
  ['variable', new Set(['set', 'delete'])],
  ['project', new Set(['create', 'edit', 'delete', 'close', 'copy'])]
])

/** `gh api` changes something when it names a method other than GET, or sends fields (which makes it a POST). */
function ghApiWrites(args: Words): boolean {
  let method: string | undefined
  let fields = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-X' || a === '--method') method = args[++i]
    else if (a.startsWith('--method=')) method = a.slice(9)
    else if (/^-X./.test(a)) method = a.slice(2)
    else if (['-f', '-F', '--field', '--raw-field', '--input'].some((f) => a === f || a.startsWith(`${f}=`))) fields = true
  }
  return method !== undefined ? method.toUpperCase() !== 'GET' : fields
}

/** `gh api graphql` sends fields for a query as much as for a mutation, so it is a write only if the query says so (or
 *  comes from a file, which this cannot read). */
const ghGraphqlWrites = (args: Words): boolean => args.some((a) => /\bmutation\b/.test(a) || /query=@/.test(a))

const INSTALLS = new Map<string, ReadonlySet<string>>([
  ['npm', new Set(['install', 'i', 'add', 'ci'])],
  ['pnpm', new Set(['install', 'i', 'add'])],
  ['yarn', new Set(['install', 'add'])],
  ['bun', new Set(['install', 'i', 'add'])],
  ['pip', new Set(['install'])],
  ['pip3', new Set(['install'])],
  ['uv', new Set(['add'])],
  ['poetry', new Set(['add', 'install'])],
  ['cargo', new Set(['install', 'add'])],
  ['go', new Set(['install', 'get'])],
  ['gem', new Set(['install'])],
  ['composer', new Set(['require', 'install'])],
  ['apt', new Set(['install'])],
  ['apt-get', new Set(['install'])],
  ['brew', new Set(['install'])],
  ['winget', new Set(['install'])],
  ['choco', new Set(['install'])]
])

function installs(prog: string, args: Words, sub: string | undefined): boolean {
  if (prog === 'yarn' && args.length === 0) return true // a bare `yarn` installs
  if (sub !== undefined && INSTALLS.get(prog)?.has(sub)) return true
  if (PYTHON.test(prog) || prog === 'py') {
    const m = args.indexOf('-m')
    return m >= 0 && /^pip3?$/.test(args[m + 1] ?? '') && args[m + 2] === 'install'
  }
  return prog === 'uv' && positionals(prog, args, 2).join(' ') === 'pip install'
}

const DELETERS = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'unlink', 'remove-item', 'ri'])
const COPIERS = new Set(['cp', 'mv', 'copy', 'move', 'copy-item', 'move-item', 'cpi', 'mi'])
const SETTERS = new Set(['set-content', 'add-content', 'out-file'])
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'get-content', 'gc', 'nl'])
const LISTERS = new Set(['ls', 'dir', 'get-childitem', 'gci', 'tree']) // with no path they read the folder itself
const SEARCHERS = new Set(['rg', 'grep', 'egrep', 'fgrep'])
const NETWORK = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm'])
/** cmd.exe's /s, /q style switches, which would otherwise read as absolute POSIX paths. */
const CMD_SWITCH_PROGRAMS = new Set(['dir', 'del', 'erase', 'rd', 'rmdir', 'cd', 'chdir', 'pushd', 'copy', 'move'])
/** Flags that take the next word as their value, which is therefore not a path. */
const VALUED_FLAGS = new Map<string, ReadonlySet<string>>([
  ['head', new Set(['-n', '-c', '--lines', '--bytes'])],
  ['tail', new Set(['-n', '-c', '--lines', '--bytes', '--pid'])],
  ['nl', new Set(['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w'])],
  ['cp', new Set(['-t', '-S', '--target-directory', '--suffix'])],
  ['mv', new Set(['-t', '-S', '--target-directory', '--suffix'])],
  [
    'grep',
    new Set([
      '-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--after-context', '--before-context',
      '--context', '--include', '--exclude', '--exclude-dir', '--exclude-from', '--label', '--directories', '--devices'
    ])
  ],
  [
    'rg',
    new Set([
      '-e', '-f', '-g', '-t', '-T', '-A', '-B', '-C', '-m', '-j', '-d', '-E', '-M', '-r', '--regexp', '--file', '--glob', '--iglob',
      '--type', '--type-not', '--after-context', '--before-context', '--context', '--max-count', '--threads', '--max-depth',
      '--encoding', '--max-columns', '--replace', '--sort', '--sortr', '--ignore-file', '--pre', '--type-add', '--max-filesize',
      '--path-separator'
    ])
  ],
  ['sed', new Set(['-e', '-f', '-l', '--expression', '--file', '--line-length'])]
])
VALUED_FLAGS.set('egrep', VALUED_FLAGS.get('grep')!)
VALUED_FLAGS.set('fgrep', VALUED_FLAGS.get('grep')!)
/** PowerShell parameters that take a value which is not a path. */
const PS_VALUED = new Set([
  'erroraction', 'ea', 'warningaction', 'wa', 'errorvariable', 'ev', 'include', 'exclude', 'filter', 'credential', 'stream',
  'totalcount', 'tail', 'head', 'encoding', 'readcount', 'delimiter', 'depth', 'attributes', 'destination', 'value'
])
/** PowerShell parameters whose value is a path. */
const PS_PATH = new Set(['path', 'literalpath', 'filepath'])

/**
 * The path-like words of a command: its non-flag words, with `-Path x` (also `-Path:x`) taken and the value of other
 * valued flags skipped.
 */
function pathArgs(prog: string, args: Words): string[] {
  const out: string[] = []
  const valued = VALUED_FLAGS.get(prog)
  let afterDashes = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!afterDashes && a === '--') afterDashes = true
    else if (!afterDashes && isSwitch(a, prog)) {
      const ps = /^-([A-Za-z]{2,})(?::(.*))?$/.exec(a)
      if (ps !== null) {
        const name = ps[1].toLowerCase()
        if (PS_PATH.has(name)) {
          const v = ps[2] ?? args[++i]
          if (v !== undefined && v !== '') out.push(v)
        } else if (PS_VALUED.has(name) && ps[2] === undefined) i++
      } else if (valued?.has(a)) i++
    } else if (a !== '-') out.push(a)
  }
  return out
}

/** The value of one of `flags`, as `-t DIR` or `--target-directory=DIR`, or of a PowerShell parameter in `psNames`. */
function valueOf(args: Words, flags: string[], psNames: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (flags.includes(a)) return args[i + 1]
    const eq = flags.find((f) => f.startsWith('--') && a.startsWith(`${f}=`))
    if (eq !== undefined) return a.slice(eq.length + 1)
    const ps = /^-([A-Za-z]{2,})(?::(.*))?$/.exec(a)
    if (ps !== null && psNames.includes(ps[1].toLowerCase())) return ps[2] ?? args[i + 1]
  }
  return undefined
}

/** The files a search or `sed` reads: its path words, less the pattern or script, which is the first unless a flag gave it. */
function searchFiles(prog: string, args: Words): string[] {
  const paths = pathArgs(prog, args)
  const givenByFlag = args.some((a) => /^-[ef]|^--(?:regexp|file|expression)(?:=|$)/.test(a))
  const patternGiven = givenByFlag || (prog === 'rg' && args.includes('--files'))
  return patternGiven ? paths : paths.slice(1)
}

/** The first URL in a command's words, also as `--url=…` or `-Uri:…`. */
function urlIn(args: Words): string | null {
  for (const a of args) {
    const m = /^(?:--?\w+[=:])?([A-Za-z][A-Za-z0-9+.-]*:\/\/.+)$/.exec(a)
    if (m !== null) return m[1]
  }
  return null
}

const withTarget = (name: string, sub: string | undefined): string => (sub === undefined ? name : `${name} ${sub}`)

function readFacts(paths: string[], ctx: Ctx): Facts {
  const { target, inside } = placesOf(paths, ctx, true)
  return { action: 'filesystem.read', target, known: true, inside, path: true }
}

/** A write to `paths`. With no destination to name, the write is unknown rather than guessed. */
function writeFacts(name: string, paths: string[], ctx: Ctx): Facts {
  if (paths.length === 0) return { action: 'filesystem.write', target: name, known: false }
  const { target, inside } = placesOf(paths, ctx, true)
  return { action: 'filesystem.write', target, known: true, inside, path: true }
}

/** Where `find` starts: its leading words, before the first test or expression. */
function findStarts(args: Words): string[] {
  const out: string[] = []
  for (const a of args) {
    if (a === '-H' || a === '-L' || a === '-P') continue
    if (a.startsWith('-') || a === '(' || a === '!') break
    out.push(a)
  }
  return out.length > 0 ? out : ['.']
}

const findDeletes = (args: Words): boolean =>
  args.includes('-delete') ||
  args.some((a, i) => /^-(?:exec|execdir|ok|okdir)$/.test(a) && DELETERS.has(programName(args[i + 1] ?? '').toLowerCase()))

const XARGS_VALUED = new Set(['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a', '-l'])

/** The index of the command `xargs` runs, past its own flags. */
function xargsCommandAt(args: Words): number {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (XARGS_VALUED.has(args[i])) i++
    } else return i
  }
  return -1
}

/** Facts for a program the table has a row for. */
function classify(cmd: Cmd, ctx: Ctx): Facts {
  const unreadable: Facts = { action: 'process.execute', target: 'shell', known: false }
  const words = cmd.words
  const name = programName(words[0])
  // A quoted word is a value, not a program, unless it is clearly a path to one or follows the call operator.
  if (!PROGRAM.test(name) || (cmd.quoted && !cmd.call && !/[\\/]/.test(words[0]))) return unreadable
  const prog = name.toLowerCase()
  const args = words.slice(1)

  if (DELETERS.has(prog)) {
    const paths = pathArgs(prog, args)
    const facts: Facts = { action: 'filesystem.delete', target: name, known: true }
    if (paths.length > 0) facts.inside = placesOf(paths, ctx, true).inside
    return facts
  }

  if (prog === 'find' && findDeletes(args)) {
    return { action: 'filesystem.delete', target: name, known: true, inside: placesOf(findStarts(args), ctx, true).inside }
  }

  if (prog === 'xargs') {
    const at = xargsCommandAt(args)
    const inner = at < 0 ? '' : programName(args[at]).toLowerCase()
    if (DELETERS.has(inner)) {
      // What it removes comes from stdin unless the line names it.
      const named = pathArgs(inner, args.slice(at + 1)).filter((p) => !/^\{.*\}$/.test(p))
      return named.length === 0
        ? { action: 'filesystem.delete', target: name, known: false }
        : { action: 'filesystem.delete', target: name, known: true, inside: placesOf(named, ctx, true).inside }
    }
  }

  if (COPIERS.has(prog)) {
    // The destination is named by -t / -Destination, else it is the last of two or more paths.
    const paths = pathArgs(prog, args)
    const last = paths.length >= 2 ? paths[paths.length - 1] : undefined
    const dest = valueOf(args, ['-t', '--target-directory'], ['destination']) ?? last
    return writeFacts(name, dest === undefined ? [] : [dest], ctx)
  }

  if (SETTERS.has(prog)) return writeFacts(name, pathArgs(prog, args).slice(0, 1), ctx)

  if (prog === 'tee') {
    const files = pathArgs(prog, args).filter((f) => !SINK.test(f))
    if (files.length > 0) return writeFacts(name, files, ctx)
  }

  if (prog === 'sed') {
    const files = searchFiles(prog, args)
    if (args.some((a) => /^-[A-Za-z]*i|^--in-place/.test(a))) return writeFacts(name, files, ctx)
    if (files.length > 0) return readFacts(files, ctx)
  }

  if (SEARCHERS.has(prog)) {
    const files = searchFiles(prog, args)
    if (files.length > 0) return readFacts(files, ctx)
  }

  if (READERS.has(prog) || LISTERS.has(prog)) {
    const paths = pathArgs(prog, args)
    if (paths.length === 0 && LISTERS.has(prog)) paths.push('.')
    if (paths.length > 0) return readFacts(paths, ctx)
  }

  if (NETWORK.has(prog)) {
    const url = urlIn(args)
    return { action: 'network.request', target: (url === null ? null : hostOf(url)) ?? name, known: true }
  }

  if (INTERPRETERS.has(prog)) {
    // Its -c script was read in expand(). Otherwise it runs a file or reads its script from stdin (a heredoc, a pipe),
    // neither of which this can see into. Only asking for its version is a command this knows.
    const asksVersion = args.length > 0 && args.every((a) => /^(?:--version|--help|-V|-h|\/\?)$/.test(a))
    return { action: 'process.execute', target: name, known: asksVersion }
  }

  const sub = SUBCOMMAND_PROGRAMS.has(prog) ? subcommandOf(prog, args) : undefined
  const target = withTarget(name, sub)

  if (prog === 'git') {
    const at = subcommandAt(prog, args)
    const action = sub === undefined ? 'process.execute' : gitAction(sub, args.slice(at + 1))
    return { action: action ?? 'process.execute', target, known: sub === undefined || action !== undefined }
  }

  if (prog === 'gh') {
    const [group, verb] = positionals(prog, args, 2)
    const writes =
      group === 'api'
        ? verb === 'graphql'
          ? ghGraphqlWrites(args)
          : ghApiWrites(args)
        : verb !== undefined && GH_WRITES.get(group)?.has(verb) === true
    const action: AuditAction = group === 'pr' && verb === 'create' ? 'github.pr.create' : writes ? 'github.write' : 'process.execute'
    return { action, target, known: true }
  }

  if (installs(prog, args, sub)) return { action: 'package.install', target, known: true }
  return { action: 'process.execute', target, known: KNOWN.has(prog) || PYTHON.test(prog) || PS_READ_VERB.test(prog) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Redaction

const MAX_REDACT_INPUT = 1000
const SECRET_NAME = /token|secret|passw(?:or)?d|api[-_]?key|auth|credential|key/i
const maskIfSecret = (m: string, name: string): string => (SECRET_NAME.test(name) ? `${name}=[redacted]` : m)

// Each pattern starts at a fixed anchor (a word boundary, a lookbehind, a literal) so a long run of word characters is
// read once, and the name of a `name=value` pair is tested after the match rather than matched by backtracking.
const RULES: Array<[RegExp, string | ((m: string, name: string) => string)]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [redacted]'],
  [/\b(Authorization\s*[:=]\s*)(?:\w+\s+)?\S+/gi, '$1[redacted]'],
  [/(:\/\/)[^\s/@]+@/g, '$1[redacted]@'],
  [/(?<![\w-])(--?[\w-]+)(?:=\S+|\s+(?!-)\S+)/g, maskIfSecret], // --token=x, --token x
  [/(?<![\w.-])([\w.-]+)=\S+/g, maskIfSecret], // api_key=x
  // The shapes well-known tokens have: GitHub, GitLab, OpenAI/Anthropic and Stripe keys, Slack, AWS, Google, npm.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,})/g, '[redacted]'],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, '[redacted]'],
  [/\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,})/g, '[redacted]'],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, '[redacted]'],
  [/\b[0-9a-fA-F]{32,}\b/g, '[redacted]']
]

/** Whether a long run reads as words (`2026-10-23-ObserveModeDesignDocument`) rather than as a token: at least two pieces
 *  of five letters or more, and 40% of the run in pieces of four or more (measured: a random 32 to 64 character token passes
 *  that 2% to 4% of the time, which is why it only spares a run inside a path, never one that stands alone). */
function readsAsWords(run: string): boolean {
  let inWords = 0
  let long = 0
  for (const piece of run.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? []) {
    if (piece.length >= 4) inWords += piece.length
    if (piece.length >= 5) long++
  }
  return long >= 2 && inWords >= run.length * 0.4
}

/**
 * What a target is cleaned with before it is stored, as a second wall behind building targets from short parts: masks
 * `Bearer …`, `Authorization: …`, `key=…` and `--token …` pairs, URL credentials, well-known token shapes, long hex and
 * long base64. A long run counts as base64 only with upper case, lower case and a digit; and inside a path or a file name
 * (beside a `/`, `\` or `.`) only when it does not read as words, so `docs/2026-10-23-ObserveModeDesignDocument.md`
 * stays readable. Input past 1000 characters is cut.
 */
export function redactTarget(s: string): string {
  // Cut first, so the patterns below stay cheap on a word of a megabyte. A target is clipped far below this after.
  let out = s.length > MAX_REDACT_INPUT ? s.slice(0, MAX_REDACT_INPUT) : s
  for (const [re, to] of RULES) out = typeof to === 'string' ? out.replace(re, to) : out.replace(re, to)
  out = out.replace(/[A-Za-z0-9+_=-]{32,}/g, (run, offset: number, whole: string) => {
    if (!(/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run))) return run
    const inPath = /[./\\]/.test(whole[offset - 1] ?? '') || /[./\\]/.test(whole[offset + run.length] ?? '')
    return inPath && readsAsWords(run) ? run : '[redacted]'
  })
  return redactSecrets(out)
}
