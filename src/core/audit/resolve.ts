// Observe mode's resolver (design §6): a provider's tool call in, the canonical action out. Pure and deterministic, with
// no I/O, no clock and no model. A shell line is classified from its words and never run. What comes out is what a
// record keeps, so every target is short by construction (a program and its first subcommand, a path relative to the
// session folder, a host name, `server.tool`) and passes through redactTarget before it leaves. It also says whether the
// call read or wrote, and which login folder it touched (lifecycle design §4.10); for that it reads this machine's home
// and environment, unless the caller names them.
import os from 'node:os'
import path from 'node:path'
import { isPathWithin } from '../files/tree'
import { redactSecrets } from '../remote/redact'
import { sensitiveEntries, type DenyEntry } from '../sandbox/locations'
import { UNPLACED, homePathOf, homeSensitiveNameOf, sensitiveNameOf } from './sensitive'
import type { AuditAction, CallEffect, CommandFacts, Confidence } from './types'

// Declared beside the other shapes the renderer reads (types.ts), kept importable from here
export type { AuditAction, CallEffect, CommandFacts, Confidence } from './types'

export interface ResolveCall {
  provider: 'claude' | 'codex'
  tool: string
  /** The tool's input as the provider wrote it: Claude's `tool_input` object, or Codex's `arguments` (a JSON string)
   *  or patch text. */
  input: unknown
  /** The session's folder, what "inside the project" is measured against. */
  cwd: string
  /** Where the call ran, when the source knows (for Claude, where its call before left the shell, which follows the
   *  shell's `cd`s from call to call): a relative path is read from there. Left out: from `cwd`. */
  base?: string
  /** The login folders a path is matched against for `sensitive` (the E6 list, core/sandbox/locations.ts). Left out: the
   *  list of `home` when that is given, else this machine's, from its environment and home. */
  sensitive?: readonly DenyEntry[]
  /** The home a `~`, `$HOME` or `%USERPROFILE%` path is read from. Left out: this machine's. */
  home?: string
}

/** The fields of a Claude tool's input this reads. The audit capture keeps these and drops the rest (a Write's contents,
 *  an Edit's strings), so nothing more of a call waits on disk (statusline.ts). */
export const CLAUDE_INPUT_FIELDS = ['command', 'cmd', 'workdir', 'file_path', 'notebook_path', 'path', 'pattern', 'url'] as const

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
  /** Whether it read or wrote (lifecycle design §4.10): a line writes if any of its parts does, and is unknown if any part
   *  may do either or could not be read. */
  effect: CallEffect
  /** The login folder (E6) a path it names is in or under, by the location's short name, never the path; UNPLACED
   *  (`unknown`) for a path this cannot place. Left out when no path is either. */
  sensitive?: string
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
    // What Codex's hooks call every shell tool (Enforce; codex-rs core/src/tools/hook_names.rs, rust-v0.160.0). A rollout
    // never does.
    ['Bash', 'shell'],
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
    return { action: 'other', target, confidence: 'unknown', effect: 'unknown' }
  }
}

const READS: ReadonlySet<AuditAction> = new Set<AuditAction>(['filesystem.read', 'git.read'])
const WRITES: ReadonlySet<AuditAction> = new Set<AuditAction>([
  'filesystem.write', 'filesystem.delete', 'git.local.write', 'git.remote.write', 'github.pr.create', 'github.write', 'package.install'
])

/** Whether one action read or wrote (lifecycle design §4.10). A request through a web tool (`web`) reads; one from a shell
 *  may send anything. `other` reads only as a quiet tool's, the one `other` that is exact: it runs nothing. A program, an
 *  MCP tool and an agent can do either, so they are unknown. */
function effectOf(action: AuditAction, confidence: Confidence, web = false): CallEffect {
  if (READS.has(action)) return 'read'
  if (WRITES.has(action)) return 'write'
  if (action === 'network.request') return web ? 'read' : 'unknown'
  return action === 'other' && confidence === 'exact' ? 'read' : 'unknown'
}

/** A call that is one action, with the effect that action has. */
const one = (r: Omit<ResolvedAction, 'effect'>, web = false): ResolvedAction => ({ ...r, effect: effectOf(r.action, r.confidence, web) })

/** The E6 list and the home a call's paths are matched against: the call's, else this machine's. A list for a home the call
 *  names is laid out from that home alone (its APPDATA is `<home>/AppData/Roaming`), never with this machine's
 *  environment. */
function e6Of(entries: readonly DenyEntry[] | undefined, home: string | undefined): E6 {
  if (home === undefined) return entries === undefined ? ownE6() : { entries, home: ownE6().home }
  return { entries: entries ?? (home === '' ? [] : sensitiveEntries(process.platform, {}, home)), home }
}

/** This machine's list and home, worked out once for the system the process says it runs on: the Host's and the hook's
 *  home and environment do not change while they run. */
let own: { platform: NodeJS.Platform; e6: E6 } | null = null

function ownE6(): E6 {
  if (own === null || own.platform !== process.platform) {
    const home = ownHome()
    // A home that cannot be read ('') places no home path, which then reads as one that could not be placed
    own = { platform: process.platform, e6: { entries: home === '' ? [] : sensitiveEntries(process.platform, process.env, home), home } }
  }
  return own.e6
}

/** os.homedir() throws where neither the environment nor the user database names a home. */
function ownHome(): string {
  try {
    return os.homedir()
  } catch {
    return ''
  }
}

/** The shell a tool runs its command in. Claude's PowerShell tool runs PowerShell, and its Bash and Monitor tools the one Bash
 *  does (Git Bash on Windows). Codex runs the platform's own: PowerShell on Windows, whatever its hooks call the tool. */
function flavorOf(provider: ResolveCall['provider'], tool: string): Flavor {
  if (provider === 'claude' && tool === 'PowerShell') return 'ps'
  if (provider === 'claude' && (tool === 'Bash' || tool === 'Monitor')) return 'posix'
  return process.platform === 'win32' ? 'ps' : 'posix'
}

function resolve({ provider, tool, input, cwd, base, sensitive, home }: ResolveCall): ResolvedAction {
  const mcp = mcpTarget(tool)
  if (mcp !== null) return one({ action: 'mcp.call', target: mcp, confidence: 'exact' })
  const rec = asRecord(input)
  const ctx: Ctx = { cwd, base: base === undefined ? cwd : path.resolve(cwd, nativePath(base)), e6: e6Of(sensitive, home) }
  switch (KINDS[provider].get(tool)) {
    case 'shell':
      return resolveShell(rec, ctx, flavorOf(provider, tool))
    case 'exec':
      return resolveExec(str(input), cwd, ctx.e6)
    case 'read':
      return fileTool('filesystem.read', tool, [str(rec.file_path) ?? str(rec.notebook_path) ?? str(rec.path)], ctx)
    case 'write':
      return fileTool('filesystem.write', tool, [str(rec.file_path) ?? str(rec.notebook_path)], ctx)
    case 'search': {
      const where = str(rec.path) ?? (tool === 'Glob' ? globRoot(str(rec.pattern)) : '.')
      // Glob and LS list names, as ls does, so a folder they list names no login folder it holds; Grep reads what it finds
      // (the controller's ruling R2-5)
      return fileTool('filesystem.read', tool, [where], tool === 'Grep' ? ctx : { ...ctx, holders: false })
    }
    case 'patch':
      // The rollout holds the patch as the input or in `input`; a Codex hook sends it in `command`
      return fileTool('filesystem.write', tool, patchPaths(str(rec.input) ?? str(rec.patch) ?? str(rec.command) ?? str(input)), ctx)
    case 'fetch': {
      const host = hostOf(str(rec.url) ?? '')
      return host === null
        ? one({ action: 'network.request', target: tool, confidence: 'unknown' }, true)
        : one({ action: 'network.request', target: host, confidence: 'exact' }, true)
    }
    case 'web-search':
      return one({ action: 'network.request', target: 'web search', confidence: 'exact' }, true) // the query is the person's text, not recorded
    case 'agent':
      return one({ action: 'agent.spawn', target: '', confidence: 'exact' })
    case 'quiet':
      return one({ action: 'other', target: tool, confidence: 'exact' })
    case 'worktree':
      return one({ action: 'git.local.write', target: tool, confidence: 'exact' })
    case 'stdin':
      return one({ action: 'process.execute', target: tool, confidence: 'unknown' })
    default:
      return one({ action: 'other', target: tool, confidence: 'unknown' })
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
 * was, and heuristic if it was `compound` (several commands, or a loop or conditional), if any part was, or if it lists
 * more than one entry (a command and the file it redirects into is two things to be sure of). It writes if any part
 * does, else is unknown if any part or the line is, else reads; and it names the login folder a part named.
 */
function combine(parts: ResolvedAction[], compound: boolean, lead: ResolvedAction = parts[0]): ResolvedAction {
  if (parts.length === 1 && !compound) return parts[0]
  const seen = new Set<string>()
  const commands = parts.flatMap(effectsOf).filter((c) => {
    const key = `${c.action}|${c.insideProject}`
    return seen.has(key) ? false : (seen.add(key), true)
  })
  const unsure = compound || commands.length > 1 || parts.some((p) => p.confidence === 'heuristic')
  const confidence: Confidence = parts.some((p) => p.confidence === 'unknown') ? 'unknown' : unsure ? 'heuristic' : lead.confidence
  const out: ResolvedAction = {
    action: lead.action,
    target: lead.target,
    confidence,
    commands,
    effect: parts.some((p) => p.effect === 'write')
      ? 'write'
      : confidence === 'unknown' || parts.some((p) => p.effect === 'unknown')
        ? 'unknown'
        : 'read'
  }
  if (lead.insideProject !== undefined) out.insideProject = lead.insideProject
  const sensitive = firstSensitive(parts.map((p) => p.sensitive))
  if (sensitive !== undefined) out.sensitive = sensitive
  return out
}

/** The login folder several places or parts name: the first location's name, else UNPLACED when one could not be placed,
 *  else none. A name says more than UNPLACED, so it outranks one wherever it sits. */
function firstSensitive(names: Array<string | undefined>): string | undefined {
  return names.find((n) => n !== undefined && n !== UNPLACED) ?? names.find((n) => n !== undefined)
}

/**
 * A Codex `exec` call. Its input is not arguments but a script: `await tools.exec_command({cmd:"…","workdir":"…"})`,
 * `tools.apply_patch("*** Begin Patch…")`, `tools.mcp__<server>__<tool>({…})`, `tools.view_image({path:"…"})`. Each
 * `tools.<name>(` in the code (not in a string or a comment) is a call, resolved as the tool of that name; several make a
 * compound line: the code around them, which this does not read, decides which of them run.
 */
function resolveExec(source: string | null, cwd: string, e6: E6): ResolvedAction {
  const text = source ?? ''
  const calls = toolCalls(text)
  if (calls.length === 0) return one({ action: 'other', target: 'exec', confidence: 'unknown' })
  const parts = calls.map((c, i) =>
    resolve({ provider: 'codex', tool: c.name, input: execArgs(c.name, text.slice(c.from, calls[i + 1]?.at)), cwd, sensitive: e6.entries, home: e6.home })
  )
  return combine(parts, parts.length > 1, parts[0])
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
  if (pattern === null || !(HOME.test(pattern) || path.isAbsolute(nativePath(pattern)))) return '.'
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
  /** The login folders and the home a path is matched against. */
  e6: E6
  /** The paths are a PowerShell command's, which takes `\` as a separator on every platform. */
  ps?: true
  /** The paths are those of a call that reads no file's contents (a listing, a printer, a `cd`), so a folder that holds login
   *  folders does not name them; one a path is in or under still does (the controller's rulings R2-4 and R2-5). */
  holders?: false
}

/** The E6 list and the home the paths of one call are matched against (lifecycle design §4.10). */
interface E6 {
  entries: readonly DenyEntry[]
  /** '' when it could not be read. */
  home: string
}

/** A shell path that names a place this cannot follow: home (also `~user`), or a variable. */
const UNFOLLOWABLE = /^~|\$|%[^%\s]+%/
/** A home path as a tool that takes literal paths gets it: `~/x`, `~\x`. A file called `~$draft.docx` is not one. */
const HOME = /^~(?:[\\/]|$)/
/** A URL given where a path is expected. path.resolve would collapse its `://` and leave its credentials in the text. */
const URL_PATH = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
/** A path on another machine, as scp and rsync write it: `host:/dir`, `user@host:dir`. (A drive letter is one character.) */
const REMOTE_PATH = /^(?:[^\s/\\:@]+@[^\s/\\:]+|[^\s/\\:]{2,}):/

interface Place {
  shown: string
  inside: boolean
  /** The login folder it is in or under, by its short name, or UNPLACED. Left out when neither. */
  sensitive?: string
}

/** Git Bash, which Claude's Bash tool uses on Windows, writes the C: drive as /c. */
/** A shell path as this platform's path functions read it. PowerShell takes `\` as a separator on Linux and macOS too, where
 *  Node's path reads it as part of a name; a POSIX shell keeps a quoted `\` as part of the name, so only PowerShell's turn. */
function shellPath(p: string, ctx: Ctx): string {
  return ctx.ps === true && process.platform !== 'win32' ? nativePath(p.replace(/\\/g, '/')) : nativePath(p)
}

function nativePath(p: string): string {
  if (process.platform !== 'win32') return p
  const m = /^\/([A-Za-z])(?=\/|$)/.exec(p)
  return m === null ? p : `${m[1]}:${p.slice(2) || '/'}`
}

/** The last part of a path, past the separators it ends with. Those are trimmed by hand: `/[\\/]+$/` starts again from each
 *  separator of a long run that is not at the end, which is quadratic. */
function leaf(p: string): string {
  let end = p.length
  while (end > 0 && (p[end - 1] === '/' || p[end - 1] === '\\')) end--
  return path.basename(p.slice(0, end)) || p
}

/** Where one path is. A home path, a shell path this cannot follow (`$VAR`, `%VAR%`, `~user`), or a relative one after a
 *  `cd` it could not follow counts as outside: the rule about outside is there for what is not provably in the folder.
 *  Every path is matched against the login folders here (lifecycle design §4.10): an absolute one as it is, a home
 *  spelling from the home; one that cannot be placed may be in any of them. */
function placeOf(p: string, ctx: Ctx, fromShell: boolean): Place {
  const outside = (name: string, sensitive: string | null): Place => ({
    shown: `outside project: ${name}`,
    inside: false,
    ...(sensitive !== null ? { sensitive } : {})
  })
  if (URL_PATH.test(p)) return outside(hostOf(p) ?? 'url', null) // the host only, never the credentials in front of it
  if (HOME.test(p) || (fromShell && (UNFOLLOWABLE.test(p) || REMOTE_PATH.test(p)))) return outside(leaf(p), unfollowed(p, ctx))
  const native = shellPath(p, ctx)
  if (ctx.base === null && !path.isAbsolute(native)) return outside(leaf(p), UNPLACED)
  const abs = path.resolve(ctx.base ?? ctx.cwd, native)
  const sensitive = sensitiveNameOf(abs, ctx.e6.entries, process.platform, ctx.holders !== false)
  if (!isPathWithin(ctx.cwd, abs)) return outside(leaf(abs), sensitive)
  // Sliced rather than path.relative, which does not fold case on darwin where isPathWithin does.
  const rel = abs.slice(path.resolve(ctx.cwd).length).replace(/^[\\/]+/, '')
  const inside: Place = { shown: rel === '' ? '.' : rel.split(path.sep).join('/'), inside: true }
  return sensitive === null ? inside : { ...inside, sensitive }
}

/** The login folder of a path this cannot follow: a home spelling is placed from the home, in one folder or in none; any
 *  other (a variable, `~user`, a path on another machine) could be in any, so it is UNPLACED. PowerShell reads its own
 *  spellings of the home in any case. */
function unfollowed(p: string, ctx: Ctx): string | null {
  const ps = ctx.ps === true
  return homeSensitiveNameOf(p, ctx.e6.entries, ctx.e6.home, ps, ctx.holders !== false) ?? (homePathOf(p, ctx.e6.home, ps) === null ? UNPLACED : null)
}

/** The first path and a count of the rest, whether all of them are inside, and the login folder one of them is in. */
function placesOf(paths: string[], ctx: Ctx, fromShell: boolean): { target: string; inside: boolean; sensitive?: string } {
  const uniq = [...new Set(paths)]
  const places = uniq.map((p) => placeOf(p, ctx, fromShell))
  const first = places[0].shown
  const out = { target: uniq.length > 1 ? `${first} (+${uniq.length - 1})` : first, inside: places.every((p) => p.inside) }
  const sensitive = firstSensitive(places.map((p) => p.sensitive))
  return sensitive === undefined ? out : { ...out, sensitive }
}

/** A structured file tool. With no path to read, the call is unknown rather than guessed. */
function fileTool(action: AuditAction, tool: string, paths: Array<string | null>, ctx: Ctx): ResolvedAction {
  const named = paths.filter((p): p is string => p !== null)
  if (named.length === 0) return one({ action, target: tool, confidence: 'unknown' })
  const { target, inside, sensitive } = placesOf(named, ctx, false)
  return one({ action, target, insideProject: inside, confidence: 'exact', ...(sensitive !== undefined ? { sensitive } : {}) })
}

// ---------------------------------------------------------------------------------------------------------------------
// Shell

/** One command of a shell line. */
interface Cmd {
  words: Words
  /** The files its output is redirected into (`>`, `>>`), without /dev/null and the like. */
  out: string[]
  /** The files its input is redirected from (`<`), read for the login folder they are in (lifecycle design §4.10). */
  inputs?: string[]
  /** Set by splitLine on a command of a POSIX line inside loops, conditionals or brace groups: their ids, outermost first,
   *  up to MAX_GROUPS deep. A `cd` in one moves the commands after it, unlike a subshell's. */
  within?: number[]
  /** Set by splitLine on the redirection after a loop, conditional or brace group ends (`done < f`, `} < f`): the id of the
   *  one it is the input of, which the shell opens where that began, before its commands run. */
  inputsOf?: number
  /** Set by stripPrefix: its leading assignments, name and value (`KEY=~/.ssh/k make`, or `KEY=~/.aws/x;` with no command),
   *  whose values are read for the login folder they name alone (lifecycle design §4.10, assignedReadings). */
  assigned?: string[]
  /** Set by stripPrefix on the header of a POSIX `for` or `select` loop, which runs nothing: the words its variable takes in
   *  turn (`for k in ~/.ssh/id_*`), read for the login folder they name alone (lifecycle design §4.10). */
  listed?: string[]
  /** Set by splitLine on a command whose output a `|` hands to another: the program that one is, as stripPrefix finds it
   *  past assignments and wrappers, in lower case. */
  pipes?: string
  /** It began with PowerShell's call operator `&`, so its first word is a program however it is spelled. */
  call: boolean
  /** For each word, whether it was quoted. A quoted word is a value, so it is never a program or a subcommand shown. */
  quoted: boolean[]
  /** Its last word was directly followed by `(`: a method call, in PowerShell `$f.Delete(` or `[IO.File]::Copy(`. */
  invoked: boolean
  /** Set by stripPrefix on a PowerShell method call that is a command: its one word is the call's name. */
  method?: Facts
  /** Set by stripPrefix: the cmdlet the command is, whose parameters PowerShell binds by name, alias and prefix (`-Val`,
   *  `-ea`). Left out for a program, which reads its own flags. */
  cmdlet?: string
  /** Set by expand on a command whose line holds the commands it runs (`xargs git push`, `find -exec`), which follow it in
   *  the list and headline the line in its place. */
  runs?: true
  /** Set by expand on a command that runs others too deep in scripts to be read, and by splitLine on one with a substitution
   *  in double quotes too deep to be read, so what it does is not known. */
  unread?: true
  /** Set by splitLine on a command that runs in a subshell: the group `( )`, `$( )` or substitution it is in, and the ones
   *  those are in, outermost first. A `cd` in a subshell moves the commands of that subshell and none after it. */
  groups?: number[]
  /** Set by splitLine on a command of a PowerShell line, whose paths take `\` as a separator on every platform. */
  ps?: true
}

/** The ids of subshells, which only have to differ from each other. */
let nextGroup = 0
/** How many unquoted groups deep a command is told apart (each command carries the list), so a run of `(` costs no more than a line of them. */
const MAX_GROUPS = 16

interface Facts {
  action: AuditAction
  target: string
  /** The program (and, where the table looks, its subcommand) is one the table has a row for, and what it acts on is known. */
  known: boolean
  /** Known only roughly (a method named for what it usually does), so the part is `heuristic`. */
  heuristic?: true
  inside?: boolean
  /** The login folder one of its paths is in, or UNPLACED (placeOf). */
  sensitive?: string
  /** The target is a path, which keeps to the length a structured tool's does rather than the shell cap. */
  path?: true
  /** What else the same command does: `curl -o file` also writes the file. */
  also?: Facts[]
}

/** The words that open and close a POSIX loop or conditional, and those that may stand before a command's own first word,
 *  so an opener after them is still one (`do if …`). */
const OPENERS = new Set(['while', 'until', 'for', 'select', 'if', 'case'])
const CLOSERS = new Set(['done', 'fi', 'esac'])
const LEADERS = new Set(['do', 'then', 'else', 'elif', '!', 'time', 'while', 'until', 'if'])

/** Commands that change nothing a rule cares about, so a line is not headlined by its leading `cd` or its `[ -f x ]`. */
const PASSIVE = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', '[', '[[', 'test', 'true', 'false'])
/** Commands after which a relative path is relative to somewhere else. */
const MOVES = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl'])
/** Commands that only print what they are given, so with a redirection the file written is the point of the line. */
const PRODUCERS = new Set(['echo', 'printf', 'cat', 'write-output', 'write-host'])
/** The producers that print only their words, so without a redirection they read (R2-1). `cat` prints files, and keeps its
 *  own row. */
const PRINTERS = new Set(['echo', 'printf', 'write-output', 'write-host'])
/** The commands that run, or act on, what a `|` hands them: xargs and parallel, a shell and PowerShell's Invoke-Expression,
 *  and the PowerShell cmdlets that bind it (the item cmdlets by any alias, Compress-Archive, ForEach-Object). A printer or a
 *  listing piped into one names the login folders its words hold, as the command reads them; one piped into a filter
 *  (`ls ~ | head`, `Get-ChildItem | Where-Object`) does not (lifecycle design §4.10). */
const PIPE_RUNNERS = new Set([
  'xargs', 'parallel', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'iex', 'invoke-expression',
  'remove-item', 'rm', 'del', 'erase', 'ri', 'rd', 'rmdir', 'copy-item', 'cp', 'copy', 'cpi', 'move-item', 'mv', 'move', 'mi',
  'compress-archive', 'foreach-object', 'foreach', '%'
])

/** A variable as the shells spell it: `$X`, `$1`, `$@`, `${X}`, `$env:X`, `%X%`. A `${` reads to its `}` and no further
 *  than the next `$`, so a run of them is read once wherever a match is tried. */
const VARIABLE_SPELLING = String.raw`(?:\$(?:\w+|[@*]|\{[^}\s$]*\}|env:\w+)|%[^%\s]+%)`
/** A word that starts as a path does: `~`, `./`, `../`, a separator, a drive, or a variable a separator follows (`$X/`,
 *  `${X}\`, `$env:X\`, `%X%\`), as the controller's ruling R2-3 has it. A bare variable (`$N`, `$BRANCH`, `$null`) is a
 *  value as often as a path; a bare home spelling (`$HOME`) is the home, which homePathOf reads. At the start, where a
 *  match is tried once, a `${` reads to its `}` whatever it holds: a default that names another variable
 *  (`${SSH_DIR:-$HOME}/id_rsa`, `${D:=$HOME}/x`) could name any file. */
const PATH_START = new RegExp(String.raw`^(?:~|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|(?:\$\{[^}\s]*\}|${VARIABLE_SPELLING})[\\/])`, 'i')
/** A variable a separator follows, anywhere in a word (`src/$X/y`, `-i$HOME/.ssh/id`). */
const VARIABLE_FOLDER = new RegExp(String.raw`${VARIABLE_SPELLING}[\\/]`, 'i')
/** A flag with its value in the same word: `--key=v`, `-Path:v`. */
const FLAG_VALUE = /^--?[A-Za-z][\w-]*[=:](.+)$/
/** A `NAME=value` word with no dash (make's `KEY=v`, ssh's `-o IdentityFile=v`): its name and its value. */
const NAMED_VALUE = /^([A-Za-z_][\w.-]*)=(.+)$/
/** The flags whose value is a mount (docker's and podman's): `-v host:container[:mode]`, `--mount source=host,…`. */
const MOUNT_FLAGS = new Set(['-v', '--volume', '--mount'])
/** A word of separators alone: the root as a path, but as often a delimiter or an operand (`cut -d /`, `expr 10 / 2`, `IFS=/`). */
const LONE_ROOT = /^[\\/]+$/
/** A word that starts with a `${…}` holding a separator (`${KEY:-~/.ssh/id_rsa}`, `${D:-/etc/k}.pub`): a default that is a
 *  path, so it could name any file. Anchored, and its part before the separator holds none, so it is read once. */
const BRACED_PATH = /^\$\{[^}\s\\/]*[\\/][^}\s]*\}/
/** The programs that walk the folders under a path they are given, for which a lone `/` is the root (the controller's
 *  rulings R2-6 and R2-8: the folder-wide copy and archive tools too). */
const WALKERS = new Set(['find', 'du', 'rg', 'grep', 'chmod', 'chown', 'chgrp', 'rsync', 'zip', '7z', 'scp', 'aws'])
/** The names whose values are search paths: folders looked in for what is asked of them, and not read whole (the
 *  controller's ruling R2-7). A POSIX shell's names are exact; PowerShell reads its `$env:` names in any case. */
const SEARCH_PATHS = new Set(
  `PATH LD_LIBRARY_PATH DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FRAMEWORK_PATH LIBRARY_PATH PKG_CONFIG_PATH CPATH
  C_INCLUDE_PATH CPLUS_INCLUDE_PATH PYTHONPATH NODE_PATH CLASSPATH GOPATH GEM_PATH MANPATH INFOPATH CDPATH FPATH PSModulePath`.split(/\s+/)
)
const SEARCH_PATHS_FOLDED = new Set([...SEARCH_PATHS].map((name) => name.toLowerCase()))

/** Whether a value is a list of paths, as a search path is written: it holds a `;`, or a `:` that is no drive's (`C:\x`), none
 *  inside a `${…}` (`${X:-d}`) and not PowerShell's `$env:`. A value with spaces is a command's words (R2-9), not a list.
 *  Read once, left to right. */
function pathList(value: string): boolean {
  if (/\s/.test(value)) return false
  let braces = 0
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === ';') return true
    if (c === '$' && value[i + 1] === '{') {
      braces++
      i++
    } else if (c === '}' && braces > 0) braces--
    else if (c === ':' && braces === 0 && !(i === 1 && /[A-Za-z]/.test(value[0])) && !/\$env$/i.test(value.slice(Math.max(0, i - 4), i))) return true
  }
  return false
}

/** Whether `name=value` sets a search path (R2-7): a name programs look things up in, or any name whose value is a list. */
const isSearchPath = (name: string, value: string, ps: boolean): boolean =>
  (ps ? SEARCH_PATHS_FOLDED.has(name.toLowerCase()) : SEARCH_PATHS.has(name)) || pathList(value)
/** A name that says its value is a path (`ROOT_PATH`, `SSH_KEY_PATH`), so a lone `/` it is given is the root. */
const isPathName = (name: string, ps: boolean): boolean => (ps ? name.toUpperCase() : name).endsWith('PATH')

/** One way a word may name a file, placed for the login folder it names alone (lifecycle design §4.10). */
interface Reading {
  text: string
  /** A search path's value (R2-7, isSearchPath): it names a login folder it is in or under, and never one it holds or
   *  UNPLACED, so `PATH=/usr/local/bin:$PATH` and `NODE_PATH=~` name none while `CLASSPATH=~/.aws/x.jar` names `.aws`. */
  inOnly?: true
}

/** The host's side of a mount: the part of `-v` before its first colon that is not a drive's (`C:\x:/y`) or PowerShell's
 *  `$env:` (`$env:USERPROFILE\.ssh:/y`, `${env:X}\y:/z`), or a `--mount` list's `source=`/`src=`. */
function hostSide(spec: string): string {
  const source = /(?:^|,)(?:source|src)=([^,]*)/.exec(spec)
  return source !== null ? source[1] : (/^(?:\$\{env:[^}]*\}|\$env:|[A-Za-z]:)?[^:]*/i.exec(spec)?.[0] ?? spec)
}

/** Whether a word may name a file: it starts as a path does, or with a `${…}` that holds one (BRACED_PATH), is a home
 *  spelling, or holds a separator, no space and no remote's `x:` (`main:src/x.ts`; a word that starts with `$` is a
 *  variable's, as `${KEY:-$HOME/.ssh/k}` is), and any variable in it has a separator after it (`date +%Y/%m/%d` names none). */
function mayNameFile(w: string, ps: boolean): boolean {
  if (PATH_START.test(w) || BRACED_PATH.test(w) || homePathOf(w, '/', ps) !== null) return true
  return /[\\/]/.test(w) && !/\s/.test(w) && (w.startsWith('$') || !REMOTE_PATH.test(w)) && (!UNFOLLOWABLE.test(w) || VARIABLE_FOLDER.test(w))
}

/** The ways one word may name a file: as it is, a flag's or a `NAME=`'s value without its name, a `@file` (curl's, among
 *  others) without its `@`; a `NAME=`'s value with spaces in it (`export GIT_SSH_COMMAND='ssh -i ~/.ssh/k'`, or a leading
 *  assignment's) also word by word, as a command's words are (R2-9); after a mount flag, also by the mount's host side,
 *  which hands the whole of it over. Each is placed, and the first folder found is the word's. A lone `/` is the root only
 *  for a program that walks folders (`walks`, R2-6) or as the value of a name that says it is a path (`ROOT_PATH=/`), and
 *  a search path's value names only what it is in (R2-7). */
function readingsOf(word: string, before: string, walks: boolean, ps: boolean): Reading[] {
  const flag = FLAG_VALUE.exec(word)?.[1]
  const named = flag === undefined ? NAMED_VALUE.exec(word) : null
  const text = (flag ?? named?.[2] ?? word).replace(/^@(?=\S)/, '')
  const own: Reading[] = walks || !LONE_ROOT.test(text) || (named !== null && isPathName(named[1], ps)) ? [{ text }] : []
  if (named !== null && /\s/.test(named[2])) own.push(...readingsAmong(named[2].split(/\s+/), 0, ps, false))
  const found = named !== null && isSearchPath(named[1], named[2], ps) ? own.map((r): Reading => ({ ...r, inOnly: true })) : own
  const mount = MOUNT_FLAGS.has(before) ? word : /^--(?:volume|mount)=(.*)$/.exec(word)?.[1]
  return mount === undefined ? found : [...found, { text: hostSide(mount) }]
}

/** The readings of `words` from `from` on that may name a file (mayNameFile), each word read after the one before it. */
function readingsAmong(words: Words, from: number, ps: boolean, walks: boolean): Reading[] {
  const found: Reading[] = []
  for (let i = from; i < words.length; i++) {
    for (const r of readingsOf(words[i], words[i - 1] ?? '', walks, ps)) if (mayNameFile(r.text, ps)) found.push(r)
  }
  return found
}

/**
 * The words of a command that may name a file, for a command whose facts placed none (lifecycle design §4.10), each in
 * every reading of it (readingsOf, mayNameFile). They are placed for the login folder they name alone, so one taken
 * wrongly can only mark a call as touching one, which holds a suggestion back. `walks`: the command walks the folders
 * under its paths (WALKERS).
 */
function looseWords(cmd: Cmd, walks: boolean): Reading[] {
  return readingsAmong(cmd.words, 1, cmd.ps === true, walks)
}

/**
 * The ways the values of a command's leading assignments (`KEY=~/.ssh/k make`, or `KEY=v;` with no command) may name a
 * file, read as any `NAME=value` word is (readingsOf): each value as it is, and, when it holds spaces (a quoted
 * `GIT_SSH_COMMAND='ssh -i ~/.ssh/k'`), each of its words as a command's are read. A lone `/` (`IFS=/`) is no program's
 * root (R2-6) unless the name says it is a path, and a search path's value names only what it is in (R2-7).
 */
function assignedReadings(cmd: Cmd): Reading[] {
  return readingsAmong(cmd.assigned ?? [], 0, cmd.ps === true, false)
}

/** The login folder readings name: the first one a reading is in or holds, else UNPLACED when one could not be placed, else
 *  none. A search path's names only one it is in (Reading.inOnly). */
function folderOf(readings: Reading[], ctx: Ctx): string | undefined {
  if (readings.length === 0) return undefined
  const searched: Ctx = { ...ctx, holders: false }
  const uniq = new Map(readings.map((r) => [`${r.inOnly === true ? '+' : '-'}${r.text}`, r]))
  return firstSensitive(
    [...uniq.values()].map((r) => {
      const name = placeOf(r.text, r.inOnly === true ? searched : ctx, true).sensitive
      return r.inOnly === true && name === UNPLACED ? undefined : name
    })
  )
}

/** A shell call. `at.base` is where it started: the session's folder, or where the provider says it ran. */
function resolveShell(rec: Record<string, unknown>, at: Ctx, flavor: Flavor): ResolvedAction {
  const cwd = at.cwd
  const start = at.base ?? cwd
  const raw = rec.command ?? rec.cmd
  // Codex may send an argv array; `bash -lc <script>` in it is read below like a typed line.
  const typed: Cmd[] =
    typeof raw === 'string'
      ? splitLine(raw, flavor)
      : Array.isArray(raw)
        ? [argvCommand(raw.filter((w): w is string => typeof w === 'string'))]
        : []
  const workdir = str(rec.workdir)
  let base: string | null = workdir === null ? start : path.resolve(start, nativePath(workdir))
  // Astera's own variable names its CLI (the worker guide's fallback for a PATH without `astera`), as trusted as the name
  // itself, unless the line sets it: then it is a variable program like any other
  const line = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(' ') : ''
  const asteraCli = !/ASTERA_CLI\s*=/i.test(line)
  const { commands: expanded, syntax } = expand(typed, flavor)
  const commands = asteraCli
    ? expanded.map((c) => (c.words.length > 0 && ASTERA_CLI_WORD.test(c.words[0]) ? { ...c, words: ['astera', ...c.words.slice(1)], quoted: [false, ...c.quoted.slice(1)] } : c))
    : expanded

  const parts: ResolvedAction[] = []
  let lead: ResolvedAction | undefined
  const held: Array<{ id: number; base: string | null }> = [] // where the line was outside each subshell open now, which a cd in it leaves
  // The login folders the commands with no words name: a loop's, a group's or a subshell's input, an assignment standing alone
  const wordless: Array<string | undefined> = []
  const began = new Map<number, string | null>() // where each loop, conditional or brace group began, by its id
  for (const cmd of commands) {
    const chain = cmd.groups ?? []
    while (held.length > 0 && (held.length > chain.length || held[held.length - 1].id !== chain[held.length - 1])) base = held.pop()!.base
    for (let k = held.length; k < chain.length; k++) held.push({ id: chain[k], base })
    for (const id of cmd.within ?? []) if (!began.has(id)) began.set(id, base)
    const prog = cmd.words.length > 0 ? programName(cmd.words[0]).toLowerCase() : ''
    // `sl` is Set-Location in PowerShell only: elsewhere it is a program this does not know, which neither moves nor passes
    const foreign = cmd.cmdlet === undefined && PS_ONLY_ALIASES.has(prog)
    // Where the shell opens the files a redirection names
    const opens: Ctx = cmd.ps === true ? { cwd, base, e6: at.e6, ps: true } : { cwd, base, e6: at.e6 }
    // A passive command, a printer and a listing read no file's contents, so a folder their words name names no login folder
    // it holds (the controller's ruling R2-4); one their words are in or under it still names. A printer or a listing whose
    // output a `|` hands to a command that runs it or acts on it (`ls ~ | xargs rm -rf`, `echo / | bash`) names the folders
    // they hold, as that command reads them, and a lone `/` among its words is the root
    const namesOnly = !foreign && (PRINTERS.has(prog) || LISTERS.has(prog))
    const feeds = namesOnly && cmd.pipes !== undefined && PIPE_RUNNERS.has(cmd.pipes)
    const ctx: Ctx = (!foreign && PASSIVE.has(prog)) || (namesOnly && !feeds) ? { ...opens, holders: false } : opens
    let own: ResolvedAction | undefined
    if (cmd.words.length > 0) {
      const f = classify(cmd, ctx)
      own = partOf(f)
      // A passive command changes only where the shell is, and a printer with no file to print into only prints: both
      // read (lifecycle design §4.10, the controller's ruling R2-1). Any other program stays unknown
      const quiet = (PASSIVE.has(prog) && !foreign) || (PRINTERS.has(prog) && cmd.out.length === 0)
      if (quiet && own.action === 'process.execute' && own.confidence !== 'unknown') own.effect = 'read'
      // The words its facts did not place, the values its leading assignments give and the files it reads its input from
      // may still be in a login folder: placed for that alone, its action, target and place staying what the table says
      const loose = [...(f.inside === undefined ? looseWords(cmd, WALKERS.has(prog) || feeds) : []), ...assignedReadings(cmd)]
      const read = cmd.inputs === undefined ? undefined : placesOf(cmd.inputs, opens, true).sensitive
      const folder = firstSensitive([own.sensitive, folderOf(loose, ctx), read])
      if (folder !== undefined) own.sensitive = folder
      parts.push(own)
      for (const also of f.also ?? []) parts.push(partOf(also))
    } else {
      // The shell opens a loop's or group's input where it began, before a `cd` in it runs; an assignment standing alone
      // (`KEY=~/.aws/x; aws …`) names what its value names, and a loop's list what its words name (`for k in ~/.ssh/id_*`)
      const from = cmd.inputsOf === undefined ? undefined : began.get(cmd.inputsOf)
      if (cmd.inputs !== undefined) wordless.push(placesOf(cmd.inputs, from === undefined ? opens : { ...opens, base: from }, true).sensitive)
      wordless.push(folderOf([...assignedReadings(cmd), ...readingsAmong(cmd.listed ?? [], 0, false, false)], opens))
    }
    const writes: ResolvedAction[] = cmd.out.map((file) => {
      const { target, inside, sensitive } = placesOf([file], opens, true)
      const write: ResolvedAction = { action: 'filesystem.write', target: clip(redactTarget(target), TARGET_MAX), insideProject: inside, confidence: 'high', effect: 'write' }
      return sensitive === undefined ? write : { ...write, sensitive }
    })
    parts.push(...writes)

    if (lead === undefined) {
      const onlyPrints = own !== undefined && PRODUCERS.has(prog) && own.action === 'process.execute'
      if (own === undefined || (onlyPrints && writes.length > 0)) lead = writes[0]
      else if (!(PASSIVE.has(prog) && !foreign) && cmd.runs !== true) lead = own
    }
    if (MOVES.has(prog) && !foreign) base = movedTo(cmd.words.slice(1), ctx, cmd.cmdlet)
  }
  // A command that runs the ones after it (`xargs`) is not one more command beside them, though it is listed with them; nor
  // is the input of a loop, group or subshell, which its commands read, nor an assignment that runs nothing
  const whole =
    parts.length === 0
      ? one({ action: 'process.execute', target: 'shell', confidence: 'unknown' })
      : combine(parts, commands.filter((c) => c.runs !== true && (c.words.length > 0 || c.out.length > 0)).length > 1 || syntax, lead)
  const folder = firstSensitive([whole.sensitive, ...wordless])
  return folder === whole.sensitive ? whole : { ...whole, sensitive: folder }
}

/** A command Codex gave as an argv array: its words are already split and none was quoted in the shell's sense. */
const argvCommand = (words: Words): Cmd => ({ words, out: [], call: false, quoted: words.map(() => false), invoked: false })

/** What a command's facts become in the record. The target is redacted before it is cut, and a path target keeps to the
 *  length a structured tool's does. A shell's request is not a web tool's, so its effect is unknown. */
function partOf(f: Facts): ResolvedAction {
  const part = one({
    action: f.action,
    target: clip(redactTarget(f.target), f.path === true ? TARGET_MAX : SHELL_TARGET_MAX),
    confidence: !f.known ? 'unknown' : f.heuristic === true ? 'heuristic' : 'high'
  })
  if (f.inside !== undefined) part.insideProject = f.inside
  if (f.sensitive !== undefined) part.sensitive = f.sensitive
  return part
}

/** Where a `cd` goes, or null when it goes to home, a variable, nowhere or somewhere relative to a place already lost. */
function movedTo(args: Words, ctx: Ctx, cmdlet: string | undefined): string | null {
  const [dest] = pathArgs('cd', args, cmdlet)
  if (dest === undefined || UNFOLLOWABLE.test(dest)) return null
  const native = shellPath(dest, ctx)
  return ctx.base === null && !path.isAbsolute(native) ? null : path.resolve(ctx.base ?? ctx.cwd, native)
}

/** Astera's CLI named by its own variable, as a POSIX shell or PowerShell writes it. */
const ASTERA_CLI_WORD = /^\$(?:ASTERA_CLI|\{ASTERA_CLI\}|env:ASTERA_CLI)$/i
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** PowerShell `$env:X='y'` in one word, or `$x` with the `=` as the next word. */
const PS_ASSIGNED = /^\$[\w:.]+[+-]?=/
const PS_VARIABLE = /^\$[\w:.]+$/
/** What PowerShell writes where a command could be but is not: a variable, an array or hashtable (`@(`, `@{`), a member
 *  (`.Count`), an operator (`-not`), a type (`[int]`), a number, or an item of an argument list (`$p,`). */
const PS_EXPRESSION = /^(?:[$@]|\.[A-Za-z]|-[A-Za-z]|\[[A-Za-z]|(?:\d|[.,]\d)[\d.,]*$)/ // a lone `.` is dot-sourcing, a command
const isPsExpression = (word: string): boolean => PS_EXPRESSION.test(word) || word.endsWith(',')

/** Casts in front of a call, but not the class of a static call (`[IO.File]` before `::`). */
const CASTS = /^(?:\[[\w.]+\](?!::))+/

// The calls an expression can make. `[IO.File]::WriteAllText(` and `$f.Delete(` do something, so they stay commands.
const SAFE_STATIC_CLASSES = new Set(
  `math regex convert string char path environment datetime guid array bitconverter version timespan uri enum console encoding`.split(' ')
)
const BENIGN_MEMBERS = new Set(
  `ToString ToLower ToUpper ToLowerInvariant ToUpperInvariant Trim TrimStart TrimEnd Replace Split Substring Contains
  StartsWith EndsWith IndexOf LastIndexOf PadLeft PadRight Join Format Equals GetType GetValue GetValueKind Add AddSeconds
  AddMinutes AddHours AddDays AddMonths AddYears Insert OpenSubKey ReadToEnd ReadLine Close Dispose WaitForExit Where ForEach
  Match Matches IsMatch ContainsKey Append AppendLine AppendFormat`.split(/\s+/)
)
const WRITE_MEMBERS = new Set(
  `WriteAllText WriteAllLines WriteAllBytes AppendAllText AppendAllLines AppendText Copy CopyTo Move MoveTo Create CreateText
  CreateDirectory CreateSubdirectory Save`.split(/\s+/)
)
const READ_MEMBERS = new Set(
  `ReadAllText ReadAllLines ReadAllBytes ReadLines Exists GetFiles GetDirectories GetFileSystemEntries EnumerateFiles
  EnumerateDirectories EnumerateFileSystemEntries OpenRead OpenText`.split(/\s+/)
)

/**
 * What a PowerShell method call is, from the one word that names it: null for a call that is only arithmetic, text or
 * conversion (an expression, not a command), else facts. Known members that write, delete or read a file map to that
 * action, roughly (`heuristic`), with no place: the paths are in arguments this does not read. Any other call is unknown.
 */
function methodFacts(called: string): Facts | null {
  const word = called.replace(CASTS, '') // `[void][IO.File]::Delete(` and `[string]$f.Name.Trim(` are the call behind the cast
  const stat = /^\[([\w.]+)\]::(\w+)$/.exec(word)
  const member = stat !== null ? stat[2] : /\.(\w+)$/.exec(word)?.[1]
  if (member === undefined) return null
  const benign = stat !== null ? SAFE_STATIC_CLASSES.has((stat[1].split('.').pop() ?? '').toLowerCase()) || member === 'new' : BENIGN_MEMBERS.has(member)
  if (benign) return null
  const action = WRITE_MEMBERS.has(member) ? 'filesystem.write' : member === 'Delete' ? 'filesystem.delete' : READ_MEMBERS.has(member) ? 'filesystem.read' : undefined
  return action === undefined
    ? { action: 'process.execute', target: 'shell', known: false }
    : { action, target: member, known: true, heuristic: true }
}
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'time', 'nohup', 'command'])
/** Wrappers that run their arguments after options of their own: the options that take a value, and how many plain words
 *  (a priority, a CPU mask) come before the command. */
const WRAPPER_OPTIONS = new Map<string, { valued: ReadonlySet<string>; positional: number }>([
  ['exec', { valued: new Set(['-a']), positional: 0 }],
  ['builtin', { valued: new Set(), positional: 0 }],
  ['coproc', { valued: new Set(), positional: 0 }],
  ['setsid', { valued: new Set(), positional: 0 }],
  ['nice', { valued: new Set(['-n', '--adjustment']), positional: 0 }],
  ['stdbuf', { valued: new Set(['-i', '-o', '-e', '--input', '--output', '--error']), positional: 0 }],
  ['ionice', { valued: new Set(['-c', '-n', '--class', '--classdata']), positional: 0 }],
  ['chrt', { valued: new Set(), positional: 1 }],
  ['taskset', { valued: new Set(['-c', '--cpu-list']), positional: 1 }]
])

/** Programs that act on a running process with -p / --pid, and run no command then. */
const PID_WRAPPERS = new Set(['chrt', 'taskset', 'ionice'])

/** Where the command starts after the wrapper at `from` and its options; `from` itself when it runs none (`chrt -p PID`). */
function afterWrapper(words: Words, from: number, prog: string): number {
  const spec = WRAPPER_OPTIONS.get(prog)!
  let positional = spec.positional
  let i = from + 1
  while (i < words.length && words[i].startsWith('-') && words[i].length > 1) {
    if (PID_WRAPPERS.has(prog) && (words[i] === '--pid' || /^-[A-Za-z]*p[A-Za-z]*$/.test(words[i]))) return from
    if (spec.valued.has(words[i])) {
      if (prog === 'taskset') positional = 0 // `-c LIST` stands for the mask
      i++
    }
    i++
  }
  return Math.min(i + positional, words.length)
}
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

/** A shell named by its absolute path (a drive, a UNC share or `/`), as Codex on Windows hands every command:
 *  `"C:\Program Files\PowerShell\7\pwsh.exe" -Command '<script>'`. Quoted, such a word is still that shell. */
const SHELL_PATH = /^(?:[A-Za-z]:[\\/]|[\\/])/
const isShellPath = (word: string): boolean =>
  SHELL_PATH.test(word) && /^(?:pwsh|powershell|bash|sh|cmd|zsh)(?:\.exe)?$/i.test(word.split(/[\\/]/).pop() ?? '')

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
 * which makes the line compound. A command of only assignments or only a header comes back with no words.
 */
function stripPrefix(raw: Cmd, flavor: Flavor): { cmd: Cmd; syntax: boolean } {
  const words = raw.words
  let i = 0
  let syntax = false
  const assigned: string[] = [] // read for the login folder a value names, never kept (lifecycle design §4.10)
  while (i < words.length) {
    const w = words[i].toLowerCase()
    if (ASSIGNMENT.test(words[i])) assigned.push(words[i++])
    else if (PS_ASSIGNED.test(words[i]) || WRAPPERS.has(programName(w))) i++
    else if (PS_VARIABLE.test(words[i]) && /^[+-]?=$/.test(words[i + 1] ?? '')) i += 2
    else if (KEYWORDS.has(w)) {
      i++
      syntax = true
    } else if (programName(w) === 'timeout') i = afterTimeout(words, i + 1)
    else if (WRAPPER_OPTIONS.has(programName(w))) {
      const next = afterWrapper(words, i, programName(w))
      if (next === i) break // it runs no command: it is the program
      i = next
    }
    else break
  }
  const rest = words.slice(i)
  const cmdlet = rest.length > 0 ? cmdletOf(rest[0], flavor) : undefined
  const cmd: Cmd = {
    words: rest, out: raw.out, call: raw.call, quoted: raw.quoted.slice(i), invoked: raw.invoked, cmdlet, unread: raw.unread, groups: raw.groups,
    ...(raw.inputs !== undefined ? { inputs: raw.inputs } : {}),
    ...(raw.within !== undefined ? { within: raw.within } : {}),
    ...(raw.inputsOf !== undefined ? { inputsOf: raw.inputsOf } : {}),
    ...(assigned.length > 0 ? { assigned } : {}),
    ...(raw.pipes !== undefined ? { pipes: raw.pipes } : {}),
    ...(raw.ps === true ? { ps: true as const } : {})
  }
  const dropped = { cmd: { ...cmd, words: [], quoted: [] }, syntax: true }
  if (rest.length === 0) return { cmd, syntax }
  if (NO_COMMAND.has(rest[0].toLowerCase())) {
    // A loop's header runs nothing, but its variable takes each word of its list in turn
    const listed = flavor === 'posix' ? loopList(rest) : []
    return listed.length === 0 ? dropped : { cmd: { ...dropped.cmd, listed }, syntax: true }
  }
  if (flavor === 'ps' && !raw.call) {
    // PowerShell never runs a quoted word that is not called with `&`: it is data, whatever was stripped before it. A
    // quoted absolute path to a shell is the one exception, so the script it was handed is read (scriptOf).
    if (cmd.quoted[0] && !isShellPath(rest[0])) return dropped
    if (isPsExpression(rest[0])) {
      const method = raw.invoked && rest.length === 1 ? methodFacts(rest[0]) : null
      return method === null ? dropped : { cmd: { ...cmd, method }, syntax }
    }
  }
  return { cmd, syntax }
}

/** The words a POSIX `for` or `select` header's variable takes in turn (`for k in ~/.ssh/id_*`): those after its `in`, up to a
 *  `do` on the same line (a `;` or a newline ends the header before one). None for a header with no list (`for k; do`). */
function loopList(header: Words): string[] {
  if ((header[0] !== 'for' && header[0] !== 'select') || header[2] !== 'in') return []
  const end = header.indexOf('do', 3)
  return header.slice(3, end < 0 ? header.length : end)
}

/** The script a shell was handed with -c / -Command / /c, if it was handed one, and the shell it is written for. */
function scriptOf(words: Words): { text: string; flavor: Flavor } | null {
  const prog = programName(words[0] ?? '').toLowerCase()
  const rest = words.slice(1)
  if (POSIX_SHELLS.has(prog)) {
    // A bundle of letters that has a c in it, tested as two simple things: one pattern with a quantifier on each side of the
    // c backtracks quadratically on a long run of letters.
    const i = rest.findIndex((a) => /^-[A-Za-z]+$/.test(a) && a.includes('c'))
    return i >= 0 && i + 1 < rest.length ? { text: rest[i + 1], flavor: 'posix' } : null
  }
  const i = rest.findIndex((a) => (prog === 'cmd' ? /^\/[ck]$/i.test(a) : /^-c(?:ommand)?$/i.test(a)))
  if (i < 0 || i + 1 >= rest.length) return null
  if (prog === 'cmd') return { text: rest.slice(i + 1).join(' '), flavor: 'posix' }
  return prog === 'powershell' || prog === 'pwsh' ? { text: rest.slice(i + 1).join(' '), flavor: 'ps' } : null
}

/** The words `from` up to `to` of a command as a command of their own, each as quoted as it was: what xargs, watch and
 *  find -exec run. It has none of the redirections of the command that runs it. */
const commandAmong = (cmd: Cmd, from: number, to = cmd.words.length): Cmd => ({
  words: cmd.words.slice(from, to), out: [], call: false, quoted: cmd.quoted.slice(from, to), invoked: false,
  ...(cmd.ps === true ? { ps: true as const } : {})
})

/**
 * The commands a command runs for something else, as `expand` reads them: the command of `xargs` and `watch`, of each
 * `find -exec`, `-execdir`, `-ok` and `-okdir`, and the shell line `trap` runs on a signal or `watch` is given as one word
 * (which it hands to `sh -c`). None for a trap that only lists, resets or ignores, and for a command with nothing behind it.
 */
function commandsBehind(cmd: Cmd, flavor: Flavor, depth: number): Cmd[] {
  if (cmd.quoted[0] === true) return [] // a quoted word is a value, not a program
  const args = cmd.words.slice(1)
  switch (programName(cmd.words[0]).toLowerCase()) {
    case 'xargs': {
      const at = xargsCommandAt(args)
      if (at < 0) return []
      const run = commandAmong(cmd, at + 1)
      // What takes the place of a `{}` is read from stdin, so a word that is one names no file
      const keep = run.words.map((w, i) => i === 0 || !PLACEHOLDER.test(w))
      return [{ ...run, words: run.words.filter((_, i) => keep[i]), quoted: run.quoted.filter((_, i) => keep[i]) }]
    }
    case 'find':
      return findExecs(cmd)
    case 'watch': {
      const from = 1 + afterWatch(args)
      if (cmd.words.length === from + 1) return splitLine(cmd.words[from], 'posix', depth + 1)
      return cmd.words.length > from ? [commandAmong(cmd, from)] : []
    }
    case 'trap': {
      const line = flavor === 'posix' ? trapHandler(args) : null
      return line === null ? [] : splitLine(line, 'posix', depth + 1)
    }
    default:
      return []
  }
}

/** The commands a command runs, each in the subshell the command is in, if it is in one. */
const inSubshell = (cmd: Cmd, run: Cmd[]): Cmd[] =>
  cmd.groups === undefined ? run : run.map((c) => ({ ...c, groups: [...cmd.groups!, ...(c.groups ?? [])] }))

/** The commands of a line with the scripts inside `bash -c` and the like replaced by their own commands, and the commands
 *  that xargs, find -exec, watch and trap run put after the one that runs them. Also whether any of it was syntax rather
 *  than a command (`syntax`), which makes the line compound. */
function expand(cmds: Cmd[], flavor: Flavor, depth = 0): { commands: Cmd[]; syntax: boolean } {
  const out: Cmd[] = []
  let syntax = false
  for (const raw of cmds) {
    const stripped = stripPrefix(raw, flavor)
    const cmd = stripped.cmd
    syntax ||= stripped.syntax
    if (cmd.words.length === 0 && cmd.out.length === 0 && cmd.inputs === undefined && cmd.assigned === undefined && cmd.listed === undefined) continue
    const script = depth < 2 && cmd.words.length > 0 ? scriptOf(cmd.words) : null
    if (script === null) {
      const behind = cmd.words.length > 0 ? commandsBehind(cmd, flavor, depth) : []
      if (behind.length === 0) out.push(cmd)
      else if (depth >= 2) out.push({ ...cmd, unread: true }) // past the depth scripts are read to, where a shell's -c is unknown too
      else {
        const inner = expand(behind, flavor, depth + 1)
        out.push({ ...cmd, runs: true }, ...inSubshell(cmd, inner.commands))
        syntax ||= inner.syntax
      }
    } else {
      const inner = expand(splitLine(script.text, script.flavor, depth + 1), script.flavor, depth + 1)
      const outer = cmd.within
      const run = inSubshell(cmd, inner.commands).map((c) => (outer === undefined ? c : { ...c, within: [...outer, ...(c.within ?? [])].slice(-MAX_GROUPS) }))
      // What the shell reads from its input, its first command does (`bash -c "x" < f`)
      if (cmd.inputs !== undefined && run.length > 0) run[0] = { ...run[0], inputs: [...(run[0].inputs ?? []), ...cmd.inputs] }
      out.push(...run)
      if (cmd.out.length > 0) out.push({ words: [], out: cmd.out, call: false, quoted: [], invoked: false, ...(cmd.ps === true ? { ps: true as const } : {}) }) // `bash -c "x" > f`
      syntax ||= inner.syntax
    }
  }
  return { commands: out, syntax }
}

const ESCAPABLE = ' "\'&|;()<>$#`'
/** An unquoted heredoc delimiter, matched in place (sticky) so a line of many heredocs is not copied again for each. */
const TAG = /[\w.-]*/y
/** Where a redirection can point that writes no file: the null devices and the standard streams. */
const SINK = /^(?:\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)|nul|\$null)$/i

/**
 * A shell line as the commands it runs, each a list of words with the quotes taken off.
 *
 * Splits on `&&`, `||`, `;`, `|`, `&`, newlines and the brackets of `( )` and `$( )` outside quotes, so the commands in a
 * group or a substitution are seen, and in a POSIX line on the backticks of a substitution too. A redirection's operator
 * and target are not words: a `>` target is kept apart as a file the command writes, a `<` target as one it reads (for
 * the login folder it is in alone); `2>&1`, a `<<<` string and heredoc bodies are left out. A `&` that starts a command is
 * PowerShell's call operator. Each flavour escapes its own way: in POSIX a backslash escapes only the characters a shell
 * line needs it for (it is a path separator on Windows) and joins a line it ends; in PowerShell a backslash is a letter,
 * and the backtick makes the next character one, or joins a line it ends.
 *
 * Inside double quotes a `$( )` (in a POSIX line also a pair of backticks) is a substitution the shell runs: its text is read
 * as a line of its own and its commands follow the command the quoted word is in, while the word keeps a `$` where it was,
 * a value and no place. PowerShell reads only `$( )`, also in an @" "@ here-string. Single quotes, `\$(`, an escaped backtick
 * and arithmetic (`$((`) hold none. Substitutions nest to the depth scripts are read to, `depth` counting both; a command
 * with one past it is `unread`.
 */
function splitLine(line: string, flavor: Flavor, depth = 0): Cmd[] {
  return splitFrom(line, 0, 'line', flavor, depth).commands
}

/** Where `splitFrom` stops: the end of the line, the `)` that closes the `$(` it began after, or the backtick that closes one. */
type Stop = 'line' | 'paren' | 'tick'

/** `splitLine` from `start` to where `stop` says, with the index of what stopped it (the line's end if nothing did). */
function splitFrom(line: string, start: number, stop: Stop, flavor: Flavor, depth: number): { commands: Cmd[]; end: number } {
  const commands: Cmd[] = []
  const later: Cmd[] = [] // the commands of substitutions in double quotes, which follow the command the quotes are in
  let unread = false // that command held a substitution too deep to read
  let parens = 0 // the `(` read since the start that no `)` has closed
  let end = line.length
  let words: Words = []
  let out: string[] = []
  let inputs: string[] = []
  let call = false
  let invoked = false // the last word was directly followed by `(`
  let quoted: boolean[] = [] // for each word, whether it was quoted
  let wordQuoted = false // the word being read has had a quote in it
  let cur = ''
  let has = false // a word has begun, so an empty '' counts
  let sink: { write: boolean; dup: boolean; text: boolean } | null = null // the next word is a redirection's target; `text`: a here-string's
  const chain: number[] = [] // the unquoted `(` open now, as subshells, up to MAX_GROUPS deep: beyond it they share the last
  let beyond = 0 // the `(` open past that
  // POSIX loops, conditionals and brace groups open now, whose input a redirection after their end gives them; the one the
  // command being read ends (`done < f`) or the brace just closed (`} < f`); whether its words so far only lead to one
  const compounds: number[] = []
  let closing: number | undefined
  let atCommand = true
  const braces: Array<'block' | 'hash' | 'switch'> = [] // the PowerShell braces open now: a block, a hashtable or a switch's body
  let endedBy = '' // the character being read, which is what ended the command in endCommand
  let switchNext: { parens: number; braces: number } | null = null // a PowerShell `switch` was read: the first brace at this depth opens its body
  let cases = 0 // the `case … in` read since the start that no `esac` has closed: a `)` in one ends a pattern, not a substitution
  let heredoc: { tag: string; indent: boolean; expands: boolean } | null = null // `expands`: its tag was not quoted, so the shell runs the substitutions in the body
  let feeding: Cmd | null = null // the command a `|` just ended, whose output the next command takes

  const endWord = (): void => {
    if (has) {
      if (sink !== null) {
        const duplicate = sink.dup && /^(?:\d+|-)$/.test(cur) // the 1 of 2>&1
        if (!duplicate && !SINK.test(cur)) {
          if (sink.write) out.push(cur)
          else if (!sink.text) inputs.push(cur)
        }
        sink = null
      } else {
        if (flavor === 'posix' && atCommand && !wordQuoted) {
          if (OPENERS.has(cur)) compounds.push(nextGroup++)
          else if (CLOSERS.has(cur) && compounds.length > 0) closing = compounds.pop()
        }
        atCommand &&= !wordQuoted && LEADERS.has(cur)
        quoted.push(wordQuoted)
        words.push(cur)
        if (cur === 'in' && words.length === 3 && words[0] === 'case') cases++
        else if (cur === 'esac' && words.length === 1 && cases > 0) cases--
      }
    }
    cur = ''
    has = false
    wordQuoted = false
  }
  let failedFrom = -1 // where the last arithmetic reading that found none began, and how far it had read
  let failedTo = -1
  const failed = (from: number, to: number): number => {
    failedFrom = from
    failedTo = to
    return -1
  }
  /** `arithmetic`, but a reading that finds no arithmetic leaves nothing behind: -1, with the commands and the unread mark it
   *  collected taken back. */
  const tryArithmetic = (at: number): number => {
    if (at > failedFrom && at <= failedTo) return -1 // inside what a reading just failed to close: not read again, which would be quadratic
    const kept: number = later.length
    const wasUnread: boolean = unread
    const to = arithmetic(at)
    if (to < 0) {
      later.length = kept
      unread = wasUnread
    }
    return to
  }
  /** The commands of substitutions join the line, in the subshells the command they follow is in. */
  const flushLater = (): void => {
    for (const c of later) commands.push(chain.length > 0 ? { ...c, groups: [...chain, ...(c.groups ?? [])] } : c)
    later.length = 0
  }
  /** The body of a heredoc whose tag was not quoted, `from` to `to`, is read like the inside of double quotes: a `$( )` or a pair
   *  of backticks in it is run. Its commands follow the command that opened the heredoc.
   *  Says where the reading ended, past `to` when a substitution did not close inside the body (and then none is read twice). */
  const bodySubstitutions = (from: number, to: number): number => {
    let j = from
    for (; j < to; j++) {
      const e = line[j]
      if (e === '\\') j++
      else if (e === '$' && line[j + 1] === '(' && line[j + 2] === '(') {
        const k = tryArithmetic(j)
        j = k >= 0 ? k : substitute(j, false)
      } else if ((e === '$' && line[j + 1] === '(') || e === '`') j = substitute(j, e === '`')
    }
    if (unread) {
      // too deep to read: what the heredoc's command does is not known, as for any substitution past the depth
      const opener = commands[commands.length - 1]
      if (opener === undefined) commands.push({ words: ['heredoc'], out: [], call: false, quoted: [false], invoked: false, unread: true })
      else opener.unread = true
    }
    flushLater()
    unread = false
    return j
  }
  /** Ends the command being read, and gives it back if it was kept. */
  const endCommand = (): Cmd | undefined => {
    endWord()
    sink = null
    if (flavor === 'ps' && words[0]?.toLowerCase() === 'switch' && (endedBy === '(' || endedBy === '{')) switchNext = { parens, braces: braces.length }
    // A redirection with no words is a loop's, a group's or a subshell's (`done < f`, `} < f`, `) < f`), kept with them
    let kept: Cmd | undefined
    if (words.length > 0 || out.length > 0 || inputs.length > 0) {
      // Inside an unquoted ( ) or $( ) the command runs in a subshell, as the commands of a quoted substitution do
      const cmd: Cmd = { words, out, call, quoted, invoked }
      if (inputs.length > 0) cmd.inputs = inputs
      if (compounds.length > 0) cmd.within = compounds.slice(-MAX_GROUPS)
      if (closing !== undefined && inputs.length > 0) cmd.inputsOf = closing
      if (flavor === 'ps') cmd.ps = true
      if (unread) cmd.unread = true
      if (chain.length > 0) cmd.groups = [...chain]
      commands.push(cmd)
      // The command a `|` handed its output to is the first kept after it (`a | { b; }` and `a | (b)` too), and what it runs
      // is what stripPrefix finds past its assignments and wrappers (`a | sudo xargs rm`)
      if (feeding !== null) {
        const into = words.length > 0 ? stripPrefix(cmd, flavor).cmd.words[0] : undefined
        if (into !== undefined) feeding.pipes = programName(into).toLowerCase()
        feeding = null
      }
      kept = cmd
    }
    flushLater()
    unread = false
    words = []
    out = []
    inputs = []
    call = false
    invoked = false
    quoted = []
    closing = undefined
    atCommand = true
    return kept
  }
  /** Reads the substitution (a `$(` or a backtick) at `at` as a line of its own, whose commands follow the command in
   *  progress, and says where it ends. Past the depth substitutions are read to it is not read, and this says `at`. */
  const substitute = (at: number, tick: boolean): number => {
    if (depth >= 2) {
      unread = true // the command is not known
      return at
    }
    const sub = splitFrom(line, at + (tick ? 1 : 2), tick ? 'tick' : 'paren', flavor, depth + 1)
    // A POSIX substitution is a subshell. PowerShell's run in the same runspace, so a Set-Location in them moves the line.
    const id = nextGroup++
    for (const s of sub.commands) later.push(flavor === 'posix' ? { ...s, groups: [id, ...(s.groups ?? [])] } : s)
    return sub.end
  }
  /** Reads the POSIX arithmetic `$(( ))` at `at`, which runs nothing, for the substitutions inside it, and says where it ends
   *  (at its closing `))`, whose parentheses inner ones do not close). A nested one is counted, not entered, so the reading
   *  is one pass of the text however deep the nesting. */
  const arithmetic = (at: number): number => {
    let open = 1 // the `$((` not closed yet
    let paren = 0 // plain parentheses inside it
    let j = at + 3
    for (; j < line.length; j++) {
      const e = line[j]
      if (e === '"') {
        // a quoted operand, skipped whole; with no closing quote, the one that ends the word came before any `))`
        let k = j + 1
        while (k < line.length && line[k] !== '"') k += line[k] === '\\' ? 2 : 1
        if (k >= line.length) return failed(at, line.length)
        j = k
      } else if (e === '\\') j++
      else if (e === '$' && line[j + 1] === '(') {
        if (line[j + 2] === '(') {
          open++
          j += 2
        } else j = substitute(j, false)
      } else if (e === '`') j = substitute(j, true)
      else if (e === '(') paren++
      else if (e === ')') {
        if (paren > 0) paren--
        else if (line[j + 1] === ')') {
          j++
          if (--open === 0) break
        } else return failed(at, j) // a `)` that no second one follows: bash reads `$((git push) )` as a substitution
      }
    }
    return j
  }

  for (let i = start; i < line.length; i++) {
    const c = line[i]
    endedBy = c
    const armed = switchNext as { parens: number; braces: number } | null // set in endCommand, which TypeScript does not follow
    if (armed !== null && armed.parens === parens && armed.braces === braces.length) {
      // A command end of the switch's own level that is not its subject or its body: the switch has no body to come
      if (c === ';' || c === '|' || c === '&') switchNext = null
      else if (c === '\n') {
        let j = i - 1
        while (j > start && (line[j] === ' ' || line[j] === '\t' || line[j] === '\r')) j--
        if (line[j] !== ')') switchNext = null // `switch ($x)` and a newline before its brace is fine
      }
    }
    if (c === "'") {
      const j = line.indexOf("'", i + 1)
      const close = j < 0 ? line.length : j
      cur += line.slice(i + 1, close)
      has = true
      wordQuoted = true
      i = close
    } else if (c === '"') {
      // An @" "@ here-string (PowerShell: its header ends the line) ends at a `"@` that starts a line, and holds quotes
      const here = flavor === 'ps' && cur === '@' && !wordQuoted && /^\r?\n/.test(line.slice(i + 1, i + 3))
      const closes = (j: number): boolean => (here ? line[j] === '"' && line[j + 1] === '@' && line[j - 1] === '\n' : line[j] === '"')
      has = true
      wordQuoted = true
      for (i++; i < line.length && !closes(i); i++) {
        const d = line[i]
        const n = line[i + 1]
        if (flavor === 'ps' && d === '`') {
          cur += n === undefined ? d : d + n // the escape character: `$ is a dollar
          i++
        } else if (flavor === 'posix' && d === '\\' && n === '\\') {
          cur += '\\\\' // a backslash, which does not escape what follows it
          i++
        } else if (flavor === 'posix' && d === '\\' && (n === '"' || n === '$' || n === '`')) {
          cur += n // in PowerShell a backslash escapes nothing
          i++
        } else if (flavor === 'posix' && d === '$' && n === '(' && line[i + 2] === '(') {
          cur += '$' // in PowerShell `$((` is a sub-expression that starts with a parenthesis
          const to = tryArithmetic(i)
          // no `))` closed it before the quote, so the shell reads a command substitution that starts with a subshell
          i = to >= 0 ? to : substitute(i, false)
        } else if ((d === '$' && n === '(') || (d === '`' && flavor === 'posix')) {
          const to = substitute(i, d === '`')
          if (to === i) cur += d // too deep to read: the text stays the word's
          else {
            cur += '$'
            i = to
          }
        } else cur += d
      }
      if (here) i++ // the @ of "@
    } else if (c === '\\' && flavor === 'posix') {
      // In PowerShell a backslash is a letter, as in its strings: a path ends in one, and the `;` after it still ends the command
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
    } else if (c === '`' && flavor === 'ps') {
      // PowerShell's escape character: at the end of a line it joins the next, and else the next character is a letter
      const n = line[i + 1]
      if (n === '\n') i++
      else if (n === '\r' && line[i + 2] === '\n') i += 2
      else if (n !== undefined) {
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
      if (heredoc !== null) {
        const to = endOfHeredoc(line, i, heredoc)
        i = heredoc.expands && flavor === 'posix' ? Math.max(to, bodySubstitutions(i + 1, to)) : to
      }
      heredoc = null
    } else if (c === '#' && !has) {
      while (i + 1 < line.length && line[i + 1] !== '\n') i++ // a comment
    } else if ((c === ')' && stop === 'paren' && parens === 0 && cases - (has && sink === null && cur === 'esac' && words.length === 0 ? 1 : 0) <= 0) || (c === '`' && stop === 'tick')) {
      end = i // what closes the substitution this was started for
      break
    } else if (c === ';' || c === '|' || c === ')' || (c === '`' && flavor === 'posix')) {
      const ended = endCommand()
      // A lone `|` hands this command's output to the next; `||` runs the next only when this one fails
      if (c === '|' && line[i + 1] !== '|' && line[i - 1] !== '|' && ended !== undefined) feeding = ended
      if (c === ')' && parens > 0) {
        parens--
        if (beyond > 0) beyond--
        else chain.pop()
      }
    } else if (c === '(') {
      if (has && !wordQuoted && sink === null) invoked = true // `$f.Delete(`, `[IO.File]::Copy(`
      endCommand()
      parens++
      if (flavor !== 'posix') {
        // not a subshell: PowerShell's ( ), $( ) and @( ) run in the same runspace
      } else if (chain.length < MAX_GROUPS) chain.push(nextGroup++)
      else beyond++
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
    } else if (flavor === 'ps' && c === '{' && has && !wordQuoted && cur.endsWith('$')) {
      // `${name}` is a variable named in braces: part of the word, to the brace that closes it
      let braces = 1
      let j = i + 1
      for (; j < line.length && braces > 0; j++) braces += line[j] === '{' ? 1 : line[j] === '}' ? -1 : 0
      cur += line.slice(i, j)
      i = j - 1
    } else if (flavor === 'ps' && c === '{') {
      // In PowerShell a brace always starts a new token (`stash@{0}` splits there), a block to read; `${name}` is handled
      // above, and `@{` is a hashtable, a value that goes on in the word.
      if (!wordQuoted && cur.endsWith('@')) {
        braces.push('hash')
        cur += c
      } else if (braces[braces.length - 1] === 'switch') {
        // directly in a switch's body what stands before a block is its label (or `default`): a value, not a command
        endWord()
        words = []
        quoted = []
        out = []
        inputs = []
        call = false
        invoked = false
        braces.push('block')
      } else {
        endCommand()
        // a brace inside the subject `switch (…)` is an ordinary block; the body is the first one after the subject closes.
        // Read again after endCommand: a switch without parentheses (`switch $x {`) is armed by this very brace
        const now = switchNext as { parens: number; braces: number } | null
        const body = now !== null && now.parens === parens && now.braces === braces.length
        braces.push(body ? 'switch' : 'block')
        if (body) switchNext = null
      }
    } else if (flavor === 'ps' && c === '}') {
      if (braces.pop() === 'hash') cur += c // closes a hashtable
      else endCommand() // closes a block (a stray one too)
    } else if ((c === '{' || c === '}') && !has && (/^(?:\s|;|$)/.test(line.slice(i + 1, i + 2)) || (c === '}' && words.length === 0 && /^[<>]/.test(line.slice(i + 1, i + 2))))) {
      // a group or script block's brace, standing alone; one that closes a group where a command starts may have the group's
      // redirection right after it (`}<f`)
      endCommand()
      if (flavor === 'posix' && c === '{') compounds.push(nextGroup++)
      else if (flavor === 'posix' && compounds.length > 0) closing = compounds.pop() // the redirection that follows is the group's
    } else if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      endWord()
      let j = i + 2
      const indent = line[j] === '-'
      if (indent) j++
      while (line[j] === ' ' || line[j] === '\t') j++
      let tag: string
      const expands = line[j] !== "'" && line[j] !== '"'
      if (!expands) {
        const k = line.indexOf(line[j], j + 1)
        tag = line.slice(j + 1, k < 0 ? line.length : k)
        j = k < 0 ? line.length : k + 1
      } else {
        TAG.lastIndex = j
        tag = TAG.exec(line)?.[0] ?? ''
        j += tag.length
      }
      heredoc = tag === '' ? null : { tag, indent, expands }
      i = j - 1
    } else if (c === '>' || c === '<') {
      if (/^\d*&?$/.test(cur)) {
        cur = '' // the file descriptor in 2>x
        has = false
        wordQuoted = false
      } else endWord()
      // `<<<` hands its word over as text (a heredoc's `<<` is read above)
      const text = c === '<' && line[i + 1] === '<'
      let dup = false
      while (line[i + 1] === '>' || line[i + 1] === '<' || line[i + 1] === '&' || line[i + 1] === '|') {
        if (line[i + 1] === '&') dup = true
        i++
      }
      sink = { write: c === '>', dup, text }
    } else if (flavor === 'posix' && c === '$' && line[i + 1] === '(' && line[i + 2] === '(') {
      // arithmetic outside quotes runs nothing either: its substitutions are read, and the word keeps a `$`, a value
      cur += c
      has = true
      const to = tryArithmetic(i)
      if (to >= 0) i = to // else the `(` that follows is read as a group
    } else {
      cur += c
      has = true
    }
  }
  endCommand()
  return { commands, end }
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
  chrt taskset ionice make cmake ninja gcc g++ clang docker docker-compose kubectl helm terraform curl wget ssh scp rsync code claude codex astera
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

/** For the programs whose first word is often a prompt, the words that are subcommands. */
const SUBCOMMAND_WORDS = new Map<string, ReadonlySet<string>>([
  ['claude', new Set('mcp config update doctor install plugin agents setup-token migrate-installer'.split(' '))],
  ['codex', new Set('exec e login logout mcp apply resume sandbox completion cloud review fork proto app features'.split(' '))]
])

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
const plainSubcommand = (word: string | undefined): string | undefined =>
  word !== undefined && /^[A-Za-z0-9@][\w.:@/+-]{0,39}$/.test(word) ? word : undefined

/** Whether the table the program is read by has this subcommand. A quoted word is a value, so it counts only if it is one. */
function inTable(prog: string, sub: string): boolean {
  if (prog === 'git') return GIT.has(sub)
  if (prog === 'gh') return sub === 'api' || GH_WRITES.has(sub)
  return INSTALLS.get(prog)?.has(sub) === true
}

const isSwitch = (a: string, prog: string): boolean =>
  (a.length > 1 && a.startsWith('-')) ||
  (CMD_SWITCH_PROGRAMS.has(prog) && /^\/[A-Za-z]$/.test(a)) ||
  (MIRRORS.has(prog) && /^\/[A-Za-z][\w:-]*$/.test(a))

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

/** Whether `gh <args>` (the subcommand first) changes something on GitHub, by the rules above. The credential-use records
 *  read the gh calls Astera runs by the same rules (credentials design §6), so a query sent with fields is a read there
 *  too. */
export function ghWrites(args: readonly string[]): boolean {
  const [group, verb] = args
  if (group === 'api') return args.includes('graphql') ? ghGraphqlWrites([...args]) : ghApiWrites([...args])
  return verb !== undefined && GH_WRITES.get(group)?.has(verb) === true
}

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
const COPIERS = new Set(['cp', 'mv', 'ln', 'copy', 'move', 'copy-item', 'move-item', 'cpi', 'mi'])
const MOVERS = new Set(['mv', 'move', 'move-item', 'mi']) // a copy that also removes the original
const SETTERS = new Set(['set-content', 'add-content', 'out-file'])
const MAKERS = new Set(['touch', 'mkdir', 'md']) // create what their words name
const ITEM_WRITERS = new Set(['new-item', 'ni', 'rename-item', 'rni', 'ren']) // write the item a -Path or first word names
/** robocopy and xcopy write their second path, past switches such as /E, /MIR and /EXCLUDE:file. */
const MIRRORS = new Set(['robocopy', 'xcopy'])
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
  ['ln', new Set(['-t', '-S', '--target-directory', '--suffix'])],
  ['touch', new Set(['-d', '-t', '-r', '--date', '--reference'])],
  ['mkdir', new Set(['-m', '--mode'])],
  [
    'rsync',
    new Set([
      '-e', '-f', '-T', '--rsh', '--exclude', '--include', '--exclude-from', '--include-from', '--filter', '--port', '--timeout',
      '--bwlimit', '--chmod', '--chown', '--log-file', '--files-from', '--partial-dir', '--backup-dir', '--suffix', '--max-size',
      '--min-size', '--temp-dir', '--compare-dest', '--link-dest'
    ])
  ],
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
      '--path-separator', '--color', '--colors', '--context-separator', '--field-context-separator', '--field-match-separator',
      '--engine', '--hostname-bin', '--hyperlink-format', '--pre-glob', '--regex-size-limit', '--dfa-size-limit', '--type-clear'
    ])
  ],
  ['sed', new Set(['-e', '-f', '-l', '--expression', '--file', '--line-length'])]
])
VALUED_FLAGS.set('egrep', VALUED_FLAGS.get('grep')!)
VALUED_FLAGS.set('fgrep', VALUED_FLAGS.get('grep')!)
/** PowerShell parameters that take a value which is not a path. */
const PS_VALUED = new Set([
  'erroraction', 'ea', 'warningaction', 'wa', 'errorvariable', 'ev', 'warningvariable', 'informationaction',
  'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable', 'include', 'exclude', 'filter', 'credential', 'stream',
  'totalcount', 'tail', 'head', 'encoding', 'readcount', 'delimiter', 'depth', 'attributes', 'destination', 'value',
  'inputobject', 'itemtype', 'type', 'newname', 'width', 'stackname'
])
/** PowerShell parameters whose value is a path. */
const PS_PATH = new Set(['path', 'literalpath', 'filepath'])

// PowerShell takes a parameter by its name, by its aliases, and by any prefix of its name in any case (`-Val`, `-va` and `-V`
// are -Value, `-Inp` is -InputObject). A prefix that a cmdlet's own parameter shares with common ones is the cmdlet's own
// (`-V` is -Value, not -Verbose); one that two of its own share is refused (`-T` of Get-Content: TotalCount or Tail).
// Measured in PowerShell 7.6 and Windows PowerShell 5.1. The cmdlets below are the ones this reads parameters of.
const PS_COMMON = `verbose debug erroraction errorvariable warningaction warningvariable informationaction informationvariable
  outvariable outbuffer pipelinevariable whatif confirm`.split(/\s+/)
const PS_PARAMS = new Map<string, readonly string[]>()
for (const [cmdlets, params] of [
  ['set-content add-content', 'path literalpath value passthru filter include exclude force credential usetransaction nonewline encoding asbytestream stream'],
  ['out-file', 'filepath literalpath encoding append force noclobber width nonewline inputobject'],
  ['new-item', 'path name itemtype value force credential usetransaction'],
  ['rename-item', 'path literalpath newname force passthru credential usetransaction'],
  ['copy-item move-item', 'path literalpath destination container force filter include exclude recurse passthru credential usetransaction'],
  ['remove-item', 'path literalpath filter include exclude recurse force credential stream usetransaction'],
  ['get-content', 'path literalpath readcount totalcount tail filter include exclude force credential delimiter wait raw encoding asbytestream stream usetransaction'],
  ['get-childitem', 'path literalpath filter include exclude recurse depth force name attributes directory file hidden readonly system followsymlink usetransaction'],
  ['invoke-webrequest invoke-restmethod', 'uri outfile method headers body contenttype useragent usebasicparsing passthru credential'],
  ['set-location', 'path literalpath passthru stackname']
] as const) {
  for (const cmdlet of cmdlets.split(' ')) PS_PARAMS.set(cmdlet, params.split(' '))
}
const PS_PARAM_ALIASES = new Map([
  ['ea', 'erroraction'], ['ev', 'errorvariable'], ['wa', 'warningaction'], ['wv', 'warningvariable'], ['ia', 'informationaction'],
  ['iv', 'informationvariable'], ['ov', 'outvariable'], ['ob', 'outbuffer'], ['pv', 'pipelinevariable'], ['cf', 'confirm'],
  ['wi', 'whatif'], ['lp', 'literalpath'], ['pspath', 'literalpath']
])
/** PowerShell's aliases, and its mkdir function, for the cmdlets above, as PowerShell 7 and 5.1 both have them on Windows. Not
 *  `sc`: Windows PowerShell runs Set-Content for it and PowerShell 7 runs sc.exe, so what it does cannot be told. */
const CMDLET_OF = new Map([
  ['ac', 'add-content'], ['gc', 'get-content'], ['cat', 'get-content'], ['gci', 'get-childitem'], ['dir', 'get-childitem'],
  ['ls', 'get-childitem'], ['ni', 'new-item'], ['mkdir', 'new-item'], ['md', 'new-item'], ['rni', 'rename-item'],
  ['ren', 'rename-item'], ['cpi', 'copy-item'], ['copy', 'copy-item'], ['cp', 'copy-item'], ['mi', 'move-item'],
  ['move', 'move-item'], ['mv', 'move-item'], ['ri', 'remove-item'], ['rm', 'remove-item'], ['del', 'remove-item'],
  ['erase', 'remove-item'], ['rd', 'remove-item'], ['rmdir', 'remove-item'], ['iwr', 'invoke-webrequest'],
  ['irm', 'invoke-restmethod'], ['sl', 'set-location'], ['cd', 'set-location'], ['chdir', 'set-location']
])
/** The aliases above that Bash has no program for (it has `cat`, `rm`, `cp` and `mkdir` of its own, and `del`, `copy` and
 *  `dir` stay known as cmd's), so in Bash `ni a -Value x` is a program it does not know, not New-Item and its parameters.
 *  cmd has `ren` too, but a shell that is not PowerShell is read as Bash. */
const PS_ONLY_ALIASES = new Set('ac gc gci ni rni ren cpi mi ri iwr irm sl'.split(' '))

/**
 * The cmdlet a command is, if PowerShell binds its parameters: a cmdlet named in full in any shell, and in PowerShell one of
 * its aliases written bare (`rm.exe` is the program). A program reads its own flags, so in Bash `rm -iv` is -i and -v and
 * never -InformationVariable, and `grep -iv` is that in PowerShell too.
 */
function cmdletOf(word: string, flavor: Flavor): string | undefined {
  const name = programName(word).toLowerCase()
  if (PS_PARAMS.has(name)) return name
  return flavor === 'ps' ? CMDLET_OF.get(word.toLowerCase()) : undefined
}

/** The name a parameter token stands for in `cmdlet`'s command, lower case: its full name or alias, else the parameter its
 *  prefix starts, the cmdlet's own before a common one. A prefix two of its own share stays as written, bound to nothing. */
function psParam(token: string, cmdlet: string): string {
  const t = token.toLowerCase()
  const own = PS_PARAMS.get(cmdlet) ?? []
  if (own.includes(t) || PS_COMMON.includes(t)) return t
  const alias = PS_PARAM_ALIASES.get(t)
  if (alias !== undefined) return alias
  for (const names of [own, PS_COMMON]) {
    const hits = names.filter((n) => n.startsWith(t))
    if (hits.length > 0) return hits.length === 1 ? hits[0] : t
  }
  return t
}

/** A cmdlet's parameter token (`-Path`, `-Path:x`, `-va`) as the parameter it binds and the value written after its colon.
 *  Null for a word that is not one, and for any word of a program. */
function psToken(word: string, cmdlet: string | undefined): { name: string; inline: string | undefined } | null {
  if (cmdlet === undefined) return null
  const m = /^-([A-Za-z]+)(?::(.*))?$/.exec(word)
  return m === null ? null : { name: psParam(m[1], cmdlet), inline: m[2] }
}

/**
 * The path-like words of a command: its non-flag words, with the value of valued flags skipped. For a cmdlet `-Path x`
 * (also `-Path:x`) is taken and the value of its other valued parameters skipped.
 */
function pathArgs(prog: string, args: Words, cmdlet?: string): string[] {
  const out: string[] = []
  const valued = VALUED_FLAGS.get(prog)
  let afterDashes = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!afterDashes && a === '--') afterDashes = true
    else if (!afterDashes && isSwitch(a, prog)) {
      const ps = psToken(a, cmdlet)
      if (ps !== null) {
        if (PS_PATH.has(ps.name)) {
          const v = ps.inline ?? args[++i]
          if (v !== undefined && v !== '') out.push(v)
        } else if ((PS_VALUED.has(ps.name) || (ps.name === 'name' && cmdlet === 'new-item')) && ps.inline === undefined) i++
      } else if (valued?.has(a)) i++
    } else if (a !== '-') out.push(a)
  }
  return out
}

/** The value of one of `flags`, as `-t DIR` or `--target-directory=DIR`, or of a parameter in `psNames` of a cmdlet. */
function valueOf(args: Words, flags: string[], psNames: string[], cmdlet?: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (flags.includes(a)) return args[i + 1]
    const eq = flags.find((f) => f.startsWith('--') && a.startsWith(`${f}=`))
    if (eq !== undefined) return a.slice(eq.length + 1)
    const ps = psToken(a, cmdlet)
    if (ps !== null && psNames.includes(ps.name)) return ps.inline ?? args[i + 1]
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
  const { target, ...where } = placesOf(paths, ctx, true)
  return { action: 'filesystem.read', target, known: true, ...where, path: true }
}

/** A write to `paths`. With no destination to name, the write is unknown rather than guessed. */
function writeFacts(name: string, paths: string[], ctx: Ctx): Facts {
  if (paths.length === 0) return { action: 'filesystem.write', target: name, known: false }
  const { target, ...where } = placesOf(paths, ctx, true)
  return { action: 'filesystem.write', target, known: true, ...where, path: true }
}

/** Where a command's paths are, for facts that keep their own target: whether all are inside, and the login folder one is
 *  in. */
function whereOf(paths: string[], ctx: Ctx): Pick<Facts, 'inside' | 'sensitive'> {
  const { inside, sensitive } = placesOf(paths, ctx, true)
  return sensitive === undefined ? { inside } : { inside, sensitive }
}

/** A write's facts with the login folder of what it reads from too (lifecycle design §4.10): a copy, a mirror or an archive
 *  reads its sources, though its place and target stay where it writes. */
function readingFrom(facts: Facts, sources: string[], ctx: Ctx): Facts {
  if (sources.length === 0) return facts
  const sensitive = firstSensitive([placesOf(sources, ctx, true).sensitive, facts.sensitive])
  return sensitive === undefined ? facts : { ...facts, sensitive }
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

/** What takes the place of the files in a command that xargs or find runs, which this cannot place. */
const PLACEHOLDER = /^\{.*\}$/

const FIND_EXEC = /^-(?:exec|execdir|ok|okdir)$/

/** The most start paths a `{}` is put at. A command line holds a copy of them for each `{}`, so more would make a long line
 *  of starts and `{}` words quadratic; past it the `{}` is left out, as xargs's is, and find's own facts keep the places. */
const FIND_STARTS_MAX = 8

/**
 * The command of each `-exec`, `-execdir`, `-ok` and `-okdir` of a `find`: the words up to a `;` (written `\;` or `';'`) or a
 * `{} +`. A `{}` among them is a file find found, so it stands for where find starts, which the files are under, if those
 * are few and distinct. A word that only holds one (`{}.bak`) is left as it is.
 */
function findExecs(cmd: Cmd): Cmd[] {
  const words = cmd.words
  const first = words.findIndex((w, i) => i > 0 && FIND_EXEC.test(w))
  if (first < 0) return []
  const distinct = [...new Set(findStarts(words.slice(1)))]
  const starts = distinct.length <= FIND_STARTS_MAX ? distinct : []
  const runs: Cmd[] = []
  for (let i = first; i < words.length; i++) {
    if (!FIND_EXEC.test(words[i])) continue
    let end = i + 1
    while (end < words.length && !(words[end] === ';' || (words[end] === '+' && words[end - 1] === '{}'))) end++
    const run: Cmd = { words: [], out: [], call: false, quoted: [], invoked: false }
    for (let j = i + 1; j < end; j++) {
      const found = words[j] === '{}'
      run.words.push(...(found ? starts : [words[j]]))
      run.quoted.push(...(found ? starts.map(() => false) : [cmd.quoted[j]]))
    }
    runs.push(run)
    i = end
  }
  return runs
}

// The options of xargs that take a value as the next word, GNU's and BSD's. The ones that take it only when written together
// with it (`-i{}`, `-eEND`, `-l5`, `--replace=X`) are one word and skipped as any other.
const XARGS_VALUED = new Set([
  '-a', '-d', '-E', '-I', '-J', '-L', '-n', '-P', '-R', '-S', '-s', '--arg-file', '--delimiter', '--max-args', '--max-procs',
  '--max-chars'
])

/** Where the command starts after `watch`'s own options, in its arguments. `-n` and `-q` take a value, also at the end of a
 *  bundle (`-dn 5`), and so do `--interval` and `--equexit` written apart from it. */
function afterWatch(args: Words): number {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) i += /^-[A-Za-z]*[nq]$|^--(?:interval|equexit)$/.test(args[i]) ? 2 : 1
  return i
}

/** The shell line `trap` runs on a signal: its first argument, unless the trap lists (`-l`, `-p`), resets (`-`), or has only
 *  signals to name (one argument, as in `trap INT`). `''` ignores a signal: a line that runs nothing. */
function trapHandler(args: Words): string | null {
  const [first, ...signals] = args[0] === '--' ? args.slice(1) : args
  return first === undefined || first === '-' || /^-[lp]+$/.test(first) || signals.length === 0 ? null : first
}

/** The index of the command `xargs` runs, past its own flags. */
function xargsCommandAt(args: Words): number {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (XARGS_VALUED.has(args[i])) i++
    } else return i
  }
  return -1
}

/** Every value given to one of `flags`, as `-o FILE`, `--output FILE` or `--output=FILE`. */
function valuesOf(args: Words, flags: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (flags.includes(a)) {
      if (i + 1 < args.length) out.push(args[++i])
      continue
    }
    const eq = flags.find((f) => f.startsWith('--') && a.startsWith(`${f}=`))
    if (eq !== undefined) out.push(a.slice(eq.length + 1))
  }
  return out
}

// The short options that take a value, for curl and wget: a bundle such as `-fsSLo FILE` or `-qO../x` has to be read
// letter by letter to know which word is the value of which letter.
const CURL_VALUED = 'AbcCdDeEFHKmoPQrtTuUwxXyYz'
const WGET_VALUED = 'OPoaeiBtTwQUlARDIX'

/**
 * The short options of `wanted` in `args`, read the way getopt reads a bundle: a letter that takes a value takes what is
 * left of its word (`-o../x`) or else the next word (`-fsSLo FILE`), and ends the bundle. A word with a space in it is a
 * value, not a bundle.
 */
function shortOptions(args: Words, valued: string, wanted: string): Array<{ letter: string; value?: string }> {
  const found: Array<{ letter: string; value?: string }> = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') break
    if (a.length < 2 || a[0] !== '-' || a[1] === '-' || /\s/.test(a)) continue
    for (let j = 1; j < a.length; j++) {
      const letter = a[j]
      if (valued.includes(letter)) {
        const attached = a.slice(j + 1)
        const value = attached !== '' ? attached : args[++i]
        if (wanted.includes(letter) && value !== undefined) found.push({ letter, value })
        break
      }
      if (wanted.includes(letter)) found.push({ letter })
    }
  }
  return found
}

/** What `curl -O` names its file: the last part of the URL's path. */
function remoteName(url: string | null): string | null {
  if (url === null) return null
  try {
    return new URL(url).pathname.split('/').pop() || null
  } catch {
    return null
  }
}

/** `file` as curl puts it under `--output-dir`, if that is given and the file is not already a full path. */
const under = (dir: string | undefined, file: string): string =>
  dir === undefined || UNFOLLOWABLE.test(file) || path.isAbsolute(nativePath(file)) ? file : `${dir}/${file}`

/**
 * The files a download saves: what curl (`-o`, `--output`, `-O` with the name from the URL, `--output-dir`), wget (`-O`,
 * `-P`, `--output-document`, `--directory-prefix`) and Invoke-WebRequest (`-OutFile`) are told. `-` and the null devices
 * write no file.
 */
function savedFiles(prog: string, args: Words, cmdlet: string | undefined): string[] {
  let named: string[]
  if (prog === 'curl') {
    const dir = valuesOf(args, ['--output-dir'])[0]
    const outputs = [...shortOptions(args, CURL_VALUED, 'o').map((o) => o.value ?? ''), ...valuesOf(args, ['--output'])]
    named = outputs.filter((f) => f !== '-' && !SINK.test(f)).map((f) => under(dir, f))
    const remote = shortOptions(args, CURL_VALUED, 'O').length > 0 || args.some((a) => a === '--remote-name' || a === '--remote-name-all')
    if (remote) {
      const file = remoteName(urlIn(args))
      named.push(file === null ? (dir ?? '.') : under(dir, file))
    }
    return named
  }
  if (prog === 'wget') {
    const given = shortOptions(args, WGET_VALUED, 'OP').map((o) => o.value ?? '')
    named = [...given, ...valuesOf(args, ['--output-document', '--directory-prefix'])]
  } else named = [valueOf(args, [], ['outfile'], cmdlet)].filter((v): v is string => v !== undefined)
  return named.filter((f) => f !== '-' && !SINK.test(f))
}

/** Facts for `tar`: extracting writes where it is told with -C (else here), creating writes the archive named with -f. Null
 *  for listing and for a mode this cannot find. */
function tarFacts(name: string, args: Words, ctx: Ctx): Facts | null {
  // The mode letters are in a bundle (`-xzf`, or `xzf` as the first word) or a long flag.
  const at = args.findIndex((a, i) => (/^-[A-Za-z]+$/.test(a) && /[cxtru]/.test(a)) || (i === 0 && /^[cxtru][A-Za-z]*$/.test(a)))
  const bundle = at < 0 ? '' : args[at].replace(/^-/, '')
  const extract = /x/.test(bundle) || args.some((a) => a === '--extract' || a === '--get')
  const create = /[cru]/.test(bundle) || args.some((a) => a === '--create' || a === '--append' || a === '--update')
  if (!extract && !create) return null
  if (extract) {
    const dir = valueOf(args, ['-C', '--directory'], []) ?? '.'
    return writeFacts(name, [dir], ctx)
  }
  const file = valuesOf(args, ['-f', '--file'])[0] ?? (/f/.test(bundle) && at >= 0 ? args[at + 1] : undefined)
  return file === '-' ? null : writeFacts(name, file === undefined ? [] : [file], ctx)
}

/** A tar's words that are not flags, each read from the folder the last `-C` before it named, as tar reads the files it
 *  archives (`tar czf a.tgz -C ~ .ssh` archives `~/.ssh`). For the login folder they name alone: the archive named after
 *  a `-C` is placed there too, which can only mark a call as touching a folder. */
function tarWords(args: Words): string[] {
  const found: string[] = []
  let dir: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-C' || a === '--directory') dir = args[++i]
    else if (a.startsWith('--directory=')) dir = a.slice('--directory='.length)
    else if (!a.startsWith('-')) found.push(dir === undefined ? a : under(dir, a))
  }
  return found
}

/** Facts for a program the table has a row for. */
function classify(cmd: Cmd, ctx: Ctx): Facts {
  if (cmd.method !== undefined) return cmd.method
  const unreadable: Facts = { action: 'process.execute', target: 'shell', known: false }
  const words = cmd.words
  const name = programName(words[0])
  const prog = name.toLowerCase()
  if (!PROGRAM.test(name)) return unreadable
  // A quoted word is a value, not a program. It is one only when it names a program the table has and is written as a path
  // (`"/usr/bin/git"`) or follows the call operator (`& 'git'`): a quoted word with a slash in it could as well be a secret.
  const knownName = KNOWN.has(prog) || PYTHON.test(prog) || PS_READ_VERB.test(prog)
  if (cmd.quoted[0] === true && !(knownName && (cmd.call || /[\\/]/.test(words[0])))) return unreadable
  const args = words.slice(1)
  const cmdlet = cmd.cmdlet
  // Where cmdletOf found no cmdlet for an alias only PowerShell has, the shell is not PowerShell and the word is a program
  // it does not know. Its words are never read as a cmdlet's, whose `-Value hunter2` would show a value as the path.
  if (cmdlet === undefined && PS_ONLY_ALIASES.has(prog)) return { action: 'process.execute', target: name, known: false }

  if (DELETERS.has(prog)) {
    const paths = pathArgs(prog, args, cmdlet)
    const facts: Facts = { action: 'filesystem.delete', target: name, known: true }
    return paths.length > 0 ? { ...facts, ...whereOf(paths, ctx) } : facts
  }

  // A find's place is where it starts, not where what it runs deletes, so one that runs commands left unread is not known
  if (prog === 'find' && findDeletes(args)) {
    return { action: 'filesystem.delete', target: name, known: cmd.unread !== true, ...whereOf(findStarts(args), ctx) }
  }

  if (prog === 'xargs') {
    const at = xargsCommandAt(args)
    const inner = at < 0 ? '' : programName(args[at]).toLowerCase()
    if (DELETERS.has(inner)) {
      // What it removes comes from stdin unless the line names it.
      const named = pathArgs(inner, args.slice(at + 1)).filter((p) => !PLACEHOLDER.test(p))
      return named.length === 0
        ? { action: 'filesystem.delete', target: name, known: false }
        : { action: 'filesystem.delete', target: name, known: true, ...whereOf(named, ctx) }
    }
  }

  // Past the branches that name their own places: what it runs was not read, so what it does is not known
  if (cmd.unread === true) return { action: 'process.execute', target: name, known: false }

  if (COPIERS.has(prog)) {
    // The destination is named by -t / -Destination, else it is the last of two or more paths.
    const paths = pathArgs(prog, args, cmdlet)
    const named = valueOf(args, ['-t', '--target-directory'], ['destination'], cmdlet)
    const dest = named ?? (paths.length >= 2 ? paths[paths.length - 1] : undefined)
    // What it copies from: every path that is not the destination, or all of them when none is
    const sources = named !== undefined || dest === undefined ? paths : paths.slice(0, -1)
    const facts = readingFrom(writeFacts(name, dest === undefined ? [] : [dest], ctx), sources, ctx)
    // A move also takes the files from where they were
    if (MOVERS.has(prog) && dest !== undefined && sources.length > 0) {
      facts.also = [{ action: 'filesystem.delete', target: name, known: true, ...whereOf(sources, ctx) }]
    }
    return facts
  }

  if (SETTERS.has(cmdlet ?? prog) || ITEM_WRITERS.has(prog)) {
    // A named -Path / -LiteralPath / -FilePath outranks the positional words, and a value is never the destination.
    const named = valueOf(args, [], ['path', 'literalpath', 'filepath'], cmdlet)
    const base = named ?? pathArgs(prog, args, cmdlet)[0]
    // New-Item puts its -Name under its -Path (or here), however far up the name goes.
    const item = cmdlet === 'new-item' ? valueOf(args, [], ['name'], cmdlet) : undefined
    const dest = item === undefined ? base : under(base ?? '.', item)
    return writeFacts(name, dest === undefined ? [] : [dest], ctx)
  }

  if (MAKERS.has(prog)) return writeFacts(name, pathArgs(prog, args, cmdlet), ctx)

  if (MIRRORS.has(prog)) {
    const paths = pathArgs(prog, args)
    const dest = paths[1]
    return readingFrom(writeFacts(name, dest === undefined ? [] : [dest], ctx), paths.filter((_, i) => i !== 1), ctx)
  }

  if (prog === 'rsync') {
    const paths = pathArgs(prog, args)
    const facts = writeFacts(name, paths.length >= 2 ? [paths[paths.length - 1]] : [], ctx)
    return readingFrom(facts, paths.length >= 2 ? paths.slice(0, -1) : paths, ctx)
  }

  if (prog === 'unzip' && !args.some((a) => /^-(?:[lptvZ]|[A-Za-z]*[lptvZ])$/.test(a))) {
    // It reads the archive it is named, which the words hold with the folder it extracts into
    return readingFrom(writeFacts(name, [valueOf(args, ['-d'], []) ?? '.'], ctx), pathArgs(prog, args), ctx)
  }

  if (prog === 'tar') {
    // Creating reads what it archives, extracting reads the archive: both are among its words
    const facts = tarFacts(name, args, ctx)
    if (facts !== null) return readingFrom(facts, tarWords(args), ctx)
  }

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
    const paths = pathArgs(prog, args, cmdlet)
    if (paths.length === 0 && LISTERS.has(prog)) paths.push('.')
    if (paths.length > 0) return readFacts(paths, ctx)
  }

  if (NETWORK.has(prog)) {
    const url = urlIn(args)
    const facts: Facts = { action: 'network.request', target: (url === null ? null : hostOf(url)) ?? name, known: true }
    const saved = savedFiles(prog, args, cmdlet)
    if (saved.length > 0) facts.also = [writeFacts(name, saved, ctx)]
    return facts
  }

  if (INTERPRETERS.has(prog)) {
    // Its -c script was read in expand(). Otherwise it runs a file or reads its script from stdin (a heredoc, a pipe),
    // neither of which this can see into. Only asking for its version is a command this knows.
    const asksVersion = args.length > 0 && args.every((a) => /^(?:--version|--help|-V|-h|\/\?)$/.test(a))
    return { action: 'process.execute', target: name, known: asksVersion }
  }

  const subAt = SUBCOMMAND_PROGRAMS.has(prog) ? subcommandAt(prog, args) : -1
  const word = subAt < 0 ? undefined : plainSubcommand(args[subAt])
  // claude and codex take a prompt where other programs take a subcommand, so only their own subcommands are shown.
  const own = SUBCOMMAND_WORDS.get(prog)
  const sub = word !== undefined && own !== undefined && !own.has(word) ? undefined : word
  // A quoted subcommand is a value. It is classified as the subcommand it names when the table has it (`git "push"`) and
  // shown only then; one the table does not have makes the line unknown and stays out of the target (`git 'hunter2'`).
  // claude and codex show only their own words already, and any other word, quoted or not, is their prompt.
  if (subAt >= 0 && cmd.quoted[subAt + 1] === true && own === undefined && (sub === undefined || !inTable(prog, sub))) {
    return { action: 'process.execute', target: name, known: false }
  }
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
