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

export interface ResolvedAction {
  action: AuditAction
  target: string
  /** Whether every path the call names is under `cwd`. Left out when the call names no path. False also means "cannot be
   *  shown to be inside" (a `~` or a variable in a shell path). */
  insideProject?: boolean
  confidence: Confidence
  /** The action of each command of a compound shell line, in order, for the evaluator's `unknown` rule. */
  commands?: AuditAction[]
}

const SHELL_TARGET_MAX = 60
const TARGET_MAX = 200

type Words = string[]
type Kind = 'shell' | 'read' | 'write' | 'search' | 'fetch' | 'web-search' | 'patch' | 'agent' | 'exec'

const KINDS: Record<ResolveCall['provider'], ReadonlyMap<string, Kind>> = {
  claude: new Map<string, Kind>([
    ['Bash', 'shell'], ['PowerShell', 'shell'],
    ['Read', 'read'], ['NotebookRead', 'read'],
    ['Grep', 'search'], ['Glob', 'search'], ['LS', 'search'],
    ['Write', 'write'], ['Edit', 'write'], ['MultiEdit', 'write'], ['NotebookEdit', 'write'],
    ['WebFetch', 'fetch'], ['WebSearch', 'web-search'],
    ['Agent', 'agent'], ['Task', 'agent']
  ]),
  codex: new Map<string, Kind>([
    ['shell', 'shell'], ['shell_command', 'shell'], ['exec_command', 'shell'], ['local_shell', 'shell'], ['container.exec', 'shell'],
    ['exec', 'exec'], ['apply_patch', 'patch'], ['view_image', 'read'],
    ['web_search', 'web-search'], ['web_search_call', 'web-search'], ['web__run', 'web-search'],
    ['spawn_agent', 'agent']
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

function resolve({ provider, tool, input, cwd }: ResolveCall): ResolvedAction {
  const mcp = mcpTarget(tool)
  if (mcp !== null) return { action: 'mcp.call', target: mcp, confidence: 'exact' }
  const rec = asRecord(input)
  const ctx: Ctx = { cwd, base: cwd }
  switch (KINDS[provider].get(tool)) {
    case 'shell':
      return resolveShell(rec, cwd)
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
    default:
      return { action: 'other', target: tool, confidence: 'unknown' }
  }
}

/**
 * What one line of work did when it was several calls: the first is the headline, `commands` lists them all, and the line
 * is unknown if any call was and heuristic otherwise. `compound` makes a single call count as one too (a loop's body).
 */
function combine(parts: ResolvedAction[], compound = false, lead: ResolvedAction = parts[0]): ResolvedAction {
  if (parts.length === 1 && !compound) return parts[0]
  const out: ResolvedAction = {
    action: lead.action,
    target: lead.target,
    confidence: parts.some((p) => p.confidence === 'unknown') ? 'unknown' : 'heuristic',
    commands: parts.flatMap((p) => p.commands ?? [p.action])
  }
  const insides = parts.filter((p) => p.insideProject !== undefined)
  if (insides.length > 0) out.insideProject = insides.every((p) => p.insideProject)
  return out
}

/**
 * A Codex `exec` call. Its input is not arguments but a script: `await tools.exec_command({cmd:"…","workdir":"…"})`,
 * `tools.apply_patch("*** Begin Patch…")`, `tools.mcp__<server>__<tool>({…})`, `tools.view_image({path:"…"})`. Each
 * `tools.<name>(` is a call, resolved as the tool of that name; several make a compound line.
 */
function resolveExec(source: string | null, cwd: string): ResolvedAction {
  const calls = [...(source ?? '').matchAll(/\btools\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
  if (calls.length === 0) return { action: 'other', target: 'exec', confidence: 'unknown' }
  return combine(
    calls.map((m, i) => {
      const args = (source ?? '').slice(m.index + m[0].length, calls[i + 1]?.index)
      return resolve({ provider: 'codex', tool: m[1], input: execArgs(m[1], args), cwd })
    })
  )
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

/** The files an `apply_patch` names, from its envelope's own header lines (a rename's destination counts as a file). */
function patchPaths(text: string | null): string[] {
  if (text === null) return []
  return [...text.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/gm)].map((m) => m[1])
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

/** A shell path that names a place this cannot follow: home, or a variable. */
const UNFOLLOWABLE = /^~|\$|%[^%\s]+%/

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

/** Where one path is. A shell path this cannot follow (`~`, `$VAR`, `%VAR%`, or a relative one after a `cd` it could not
 *  follow) counts as outside: the rule about outside is there for what is not provably in the folder. */
function placeOf(p: string, ctx: Ctx, fromShell: boolean): Place {
  const outside = (name: string): Place => ({ shown: `outside project: ${name}`, inside: false })
  if (fromShell && UNFOLLOWABLE.test(p)) return outside(leaf(p))
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

interface Facts {
  action: AuditAction
  target: string
  /** The program (and, where the table looks, its subcommand) is one the table has a row for. */
  known: boolean
  inside?: boolean
}

/** Commands that change nothing a rule cares about, so a line is not headlined by its leading `cd` or its `[ -f x ]`. */
const PASSIVE = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', '[', '[[', 'test', 'true', 'false'])
/** Commands after which a relative path is relative to somewhere else. */
const MOVES = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl'])

function resolveShell(rec: Record<string, unknown>, cwd: string): ResolvedAction {
  const raw = rec.command ?? rec.cmd
  // Codex may send an argv array; `bash -lc <script>` in it is read below like a typed line.
  const typed: Words[] =
    typeof raw === 'string'
      ? splitLine(raw)
      : Array.isArray(raw)
        ? [raw.filter((w): w is string => typeof w === 'string')]
        : []
  const workdir = str(rec.workdir)
  let base: string | null = workdir === null ? cwd : path.resolve(cwd, nativePath(workdir))
  const { commands, scripted } = expand(typed)

  const parts: ResolvedAction[] = []
  let lead: ResolvedAction | undefined
  for (const words of commands) {
    const f = classify(words, { cwd, base })
    const part: ResolvedAction = {
      action: f.action,
      target: clip(redactTarget(f.target), SHELL_TARGET_MAX),
      confidence: f.known ? 'high' : 'unknown'
    }
    if (f.inside !== undefined) part.insideProject = f.inside
    parts.push(part)
    const prog = programName(words[0]).toLowerCase()
    if (lead === undefined && !PASSIVE.has(prog)) lead = part
    if (MOVES.has(prog)) base = movedTo(words.slice(1), { cwd, base })
  }
  if (parts.length === 0) return { action: 'process.execute', target: 'shell', confidence: 'unknown' }
  return combine(parts, scripted, lead)
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
 * A command's words without what comes before the program: `NAME=value` and PowerShell `$name =` assignments (their
 * values can be secrets), sudo-like wrappers and `timeout N`, and the keyword of a conditional or loop body (`then`,
 * `do`, `while`). `syntax` is whether a keyword or a word that runs nothing was seen, which makes the line a script. A
 * command of only assignments, or only a header, comes back empty.
 */
function stripPrefix(raw: Words): { words: Words; syntax: boolean } {
  let i = 0
  let syntax = false
  while (i < raw.length) {
    const w = raw[i].toLowerCase()
    if (ASSIGNMENT.test(raw[i]) || PS_ASSIGNED.test(raw[i]) || WRAPPERS.has(programName(w))) i++
    else if (PS_VARIABLE.test(raw[i]) && /^[+-]?=$/.test(raw[i + 1] ?? '')) i += 2
    else if (KEYWORDS.has(w)) {
      i++
      syntax = true
    } else if (programName(w) === 'timeout') i = afterTimeout(raw, i + 1)
    else break
  }
  const words = raw.slice(i)
  return words.length > 0 && NO_COMMAND.has(words[0].toLowerCase()) ? { words: [], syntax: true } : { words, syntax }
}

/** The script a shell was handed with -c / -Command / /c, if it was handed one. */
function scriptOf(words: Words): string | null {
  const prog = programName(words[0] ?? '').toLowerCase()
  const rest = words.slice(1)
  if (POSIX_SHELLS.has(prog)) {
    const i = rest.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a))
    return i >= 0 && i + 1 < rest.length ? rest[i + 1] : null
  }
  const i = rest.findIndex((a) => (prog === 'cmd' ? /^\/[ck]$/i.test(a) : /^-c(?:ommand)?$/i.test(a)))
  return (prog === 'cmd' || prog === 'powershell' || prog === 'pwsh') && i >= 0 && i + 1 < rest.length
    ? rest.slice(i + 1).join(' ')
    : null
}

/** The commands of a line with the scripts inside `bash -c` and the like replaced by their own commands, and whether any
 *  of it was control flow. */
function expand(commands: Words[], depth = 0): { commands: Words[]; scripted: boolean } {
  const out: Words[] = []
  let scripted = false
  for (const raw of commands) {
    const { words, syntax } = stripPrefix(raw)
    scripted ||= syntax
    if (words.length === 0) continue
    const script = depth < 2 ? scriptOf(words) : null
    if (script === null) out.push(words)
    else {
      const inner = expand(splitLine(script), depth + 1)
      out.push(...inner.commands)
      scripted ||= inner.scripted
    }
  }
  return { commands: out, scripted }
}

const ESCAPABLE = ' "\'&|;()<>$#'
/** An unquoted heredoc delimiter, matched in place (sticky) so a line of many heredocs is not copied again for each. */
const TAG = /[\w.-]*/y

/**
 * A shell line as the commands it runs, each a list of words with the quotes taken off.
 *
 * Splits on `&&`, `||`, `;`, `|`, `&`, newlines and the brackets of `( )` and `$( )` outside quotes, so the commands in a
 * group or a substitution are seen. Redirections (`> file`, `2>&1`) and heredoc bodies are not words and are left out.
 * Backslash is a path separator on Windows, so it only escapes the characters a shell line needs it for.
 */
function splitLine(line: string): Words[] {
  const commands: Words[] = []
  let words: Words = []
  let cur = ''
  let has = false // a word has begun, so an empty '' counts
  let drop = false // the next word is a redirection's target
  let heredoc: { tag: string; indent: boolean } | null = null

  const endWord = (): void => {
    if (has) {
      if (drop) drop = false
      else words.push(cur)
    }
    cur = ''
    has = false
  }
  const endCommand = (): void => {
    endWord()
    drop = false
    if (words.length > 0) commands.push(words)
    words = []
  }

  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") {
      const j = line.indexOf("'", i + 1)
      const end = j < 0 ? line.length : j
      cur += line.slice(i + 1, end)
      has = true
      i = end
    } else if (c === '"') {
      has = true
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
      if (line[i - 1] === '>' || line[i - 1] === '<' || line[i + 1] === '>') {
        cur += c // the & of 2>&1 or &>file
        has = true
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
      } else endWord()
      while (line[i + 1] === '>' || line[i + 1] === '<' || line[i + 1] === '&' || line[i + 1] === '|') i++
      drop = true
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
  set-location sl foreach-object new-item set-content add-content copy-item move-item rename-item remove-item stop-process
  start-sleep gc gci`
    .split(/\s+/)
    .filter((w) => w !== '')
)
const PYTHON = /^python\d*(?:\.\d+)?$/
/** PowerShell's verbs for reading, selecting and printing, which every cmdlet of that verb keeps to. */
const PS_READ_VERB = /^(?:get|test|select|where|sort|measure|format|write|out|group|compare|convertto|convertfrom|join|split|resolve)-[a-z]+$/

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
  const [sub] = positionals(prog, args, 1)
  return sub !== undefined && /^[A-Za-z0-9@][\w.:@/+-]{0,39}$/.test(sub) ? sub : undefined
}

const table = <T>(value: T, words: string): Array<[string, T]> => words.split(/\s+/).map((w) => [w, value])
const isSwitch = (a: string, prog: string): boolean =>
  (a.length > 1 && a.startsWith('-')) || (CMD_SWITCH_PROGRAMS.has(prog) && /^\/[A-Za-z]$/.test(a))

const GIT = new Map<string, AuditAction>([
  ...table<AuditAction>(
    'git.read',
    `status log diff show blame ls-files ls-tree rev-parse rev-list describe shortlog grep cat-file show-ref name-rev
    merge-base diff-tree check-ignore ls-remote reflog for-each-ref check-attr count-objects`
  ),
  ...table<AuditAction>('git.remote.write', 'push'),
  // branch, tag, remote, stash, config, worktree and submodule both list and change; a change is the one to be seen.
  ...table<AuditAction>(
    'git.local.write',
    `add commit checkout switch merge rebase reset restore rm mv cherry-pick revert apply am clean stash tag branch remote
    config worktree submodule init clone fetch pull gc notes update-ref filter-branch`
  )
])

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
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'get-content', 'gc'])
const LISTERS = new Set(['ls', 'dir', 'get-childitem', 'gci', 'tree']) // with no path they read the folder itself
const NETWORK = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm'])
/** cmd.exe's /s, /q style switches, which would otherwise read as absolute POSIX paths. */
const CMD_SWITCH_PROGRAMS = new Set(['dir', 'del', 'erase', 'rd', 'rmdir', 'cd', 'chdir', 'pushd'])
const VALUED_FLAGS = new Map<string, ReadonlySet<string>>([
  ['head', new Set(['-n', '-c', '--lines', '--bytes'])],
  ['tail', new Set(['-n', '-c', '--lines', '--bytes', '--pid'])]
])
/** PowerShell parameters that take a value which is not a path. */
const PS_VALUED = new Set([
  'erroraction', 'ea', 'warningaction', 'wa', 'errorvariable', 'ev', 'include', 'exclude', 'filter', 'credential', 'stream',
  'totalcount', 'tail', 'head', 'encoding', 'readcount', 'delimiter', 'depth', 'attributes'
])

/** The path-like words of a command: its non-flag words, with `-Path x` taken and the value of other valued flags skipped. */
function pathArgs(prog: string, args: Words): string[] {
  const out: string[] = []
  let afterDashes = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!afterDashes && a === '--') afterDashes = true
    else if (!afterDashes && isSwitch(a, prog)) {
      if (/^-[A-Za-z]{2,}$/.test(a)) {
        const name = a.slice(1).toLowerCase()
        if (name === 'path' || name === 'literalpath') {
          if (i + 1 < args.length) out.push(args[++i])
        } else if (PS_VALUED.has(name)) i++
      } else if (VALUED_FLAGS.get(prog)?.has(a)) i++
    } else if (a !== '-') out.push(a)
  }
  return out
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

function classify(words: Words, ctx: Ctx): Facts {
  const unreadable: Facts = { action: 'process.execute', target: 'shell', known: false }
  if (words.length === 0) return unreadable
  const name = programName(words[0])
  if (!PROGRAM.test(name)) return unreadable
  const prog = name.toLowerCase()
  const args = words.slice(1)

  if (DELETERS.has(prog)) {
    const paths = pathArgs(prog, args)
    const facts: Facts = { action: 'filesystem.delete', target: name, known: true }
    if (paths.length > 0) facts.inside = placesOf(paths, ctx, true).inside
    return facts
  }

  if (READERS.has(prog) || LISTERS.has(prog)) {
    const paths = pathArgs(prog, args)
    if (paths.length === 0 && LISTERS.has(prog)) paths.push('.')
    if (paths.length > 0) {
      const { target, inside } = placesOf(paths, ctx, true)
      return { action: 'filesystem.read', target, known: true, inside }
    }
  }

  if (NETWORK.has(prog)) {
    const url = urlIn(args)
    return { action: 'network.request', target: (url === null ? null : hostOf(url)) ?? name, known: true }
  }

  if (INTERPRETERS.has(prog)) {
    // Its -c script was read in expand(); a file here is a script this cannot see into.
    const runsFile = args.some((a) => !a.startsWith('-') && !/^\/[A-Za-z]$/.test(a))
    return { action: 'process.execute', target: name, known: !runsFile }
  }

  const sub = SUBCOMMAND_PROGRAMS.has(prog) ? subcommandOf(prog, args) : undefined
  const target = withTarget(name, sub)

  if (prog === 'git') {
    const action = sub === undefined ? 'process.execute' : GIT.get(sub)
    return { action: action ?? 'process.execute', target, known: sub === undefined || action !== undefined }
  }

  if (prog === 'gh') {
    const [group, verb] = positionals(prog, args, 2)
    const writes = group === 'api' ? ghApiWrites(args) : verb !== undefined && GH_WRITES.get(group)?.has(verb) === true
    const action: AuditAction = group === 'pr' && verb === 'create' ? 'github.pr.create' : writes ? 'github.write' : 'process.execute'
    return { action, target, known: true }
  }

  if (installs(prog, args, sub)) return { action: 'package.install', target, known: true }
  return { action: 'process.execute', target, known: KNOWN.has(prog) || PYTHON.test(prog) || PS_READ_VERB.test(prog) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Redaction

const MAX_REDACT_INPUT = 1000
const SECRET_NAME = '(?:token|secret|passw(?:or)?d|api[-_]?key|auth|credential|key)'

const RULES: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [redacted]'],
  [/\b(Authorization\s*[:=]\s*)(?:\w+\s+)?\S+/gi, '$1[redacted]'],
  [/(:\/\/)[^\s/@]+@/g, '$1[redacted]@'],
  [new RegExp(`(--?[\\w-]*${SECRET_NAME}[\\w-]*)(?:=|\\s+)\\S+`, 'gi'), '$1=[redacted]'],
  [new RegExp(`\\b([\\w.-]*${SECRET_NAME}[\\w.-]*)=\\S+`, 'gi'), '$1=[redacted]'],
  // The shapes well-known tokens have: GitHub, GitLab, OpenAI/Anthropic and Stripe keys, Slack, AWS, Google, npm.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,})/g, '[redacted]'],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, '[redacted]'],
  [/\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,})/g, '[redacted]'],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, '[redacted]'],
  [/\b[0-9a-fA-F]{32,}\b/g, '[redacted]']
]

/**
 * What a target is cleaned with before it is stored, as a second wall behind building targets from short parts: masks
 * `Bearer …`, `Authorization: …`, `key=…` and `--token …` pairs, URL credentials, well-known token shapes, long hex and
 * long base64. A long run counts as base64 only with upper case, lower case and a digit, so a long kebab-case file name
 * stays readable. Input past 1000 characters is cut.
 */
export function redactTarget(s: string): string {
  // Cut first, so the patterns below stay cheap on a word of a megabyte. A target is clipped far below this after.
  let out = s.length > MAX_REDACT_INPUT ? s.slice(0, MAX_REDACT_INPUT) : s
  for (const [re, to] of RULES) out = out.replace(re, to)
  out = out.replace(/[A-Za-z0-9+_=-]{32,}/g, (run) =>
    /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) ? '[redacted]' : run
  )
  return redactSecrets(out)
}
