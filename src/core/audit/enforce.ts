// Enforce's verdict (enforce design §5, E7): whether a call is stopped before it runs. The hook script asks this at every
// call of a session started in Enforce, with the Rules as the file holds them; nothing here reads a file, the clock or
// the environment. Astera's own settings come first and no rule can let a call past them: an agent session must not
// write Astera's settings folder or change its Policies, Credentials or agent profiles, so it cannot switch off what
// stops it. Writing the folder from a script it runs stays possible under the same-user limit, which the screen states.
import path from 'node:path'
import { resolveAction, type ResolveCall, type ResolvedAction } from './resolve'
import { decide, type AuditPolicy } from './policy'

export const BUILT_IN_RULE_IDS = ['builtin-profile-write', 'builtin-settings-command'] as const

export type EnforceVerdict = { deny: false } | { deny: true; ruleId: string; reason: string }

/** A session started in Enforce whose blocking hook is not in place does not start (E5): the error both session
 *  managers throw, `ENFORCE_UNAVAILABLE: <code>`, whose code the app turns into words. */
export function enforceUnavailable(code: string): Error {
  return new Error(`ENFORCE_UNAVAILABLE: ${code}`)
}

/** What both session managers ask before a session starts in Enforce (enforce design §5, E5). */
export interface EnforceStart {
  /** The arguments that make a session of `provider` run the blocking hook (a Claude chat's --settings, Codex's -c),
   *  or null when it cannot. */
  args(provider: 'claude' | 'codex'): string[] | null
  /** Why a `kind` session of `provider` cannot be enforced (`ENFORCE_UNAVAILABLE: cli-too-old …`, `cli-version-unknown
   *  …`, `cli-missing …`, `hooks-off`, `codex-daemon`), or null. Read synchronously: `warm` asked first. */
  blocker?(provider: 'claude' | 'codex', kind: 'terminal' | 'chat'): string | null
  /** Asks the CLI its version off the thread, so `blocker` answers at once. */
  warm?(provider: 'claude' | 'codex'): Promise<void>
}

const REASONS = {
  profile: "Blocked by Astera: an agent session cannot write Astera's settings folder.",
  settings: "Blocked by Astera: an agent session cannot change Astera's Policies, Credentials or agent profiles.",
  failClosed: 'Blocked by Astera: the Rules could not be read, so only reads are allowed.'
} as const

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A tool's input as an object: Claude's is one, Codex's `arguments` is JSON text; a patch is plain text. */
function inputRecord(input: unknown): Record<string, unknown> {
  if (isRecord(input)) return input
  if (typeof input === 'string' && input.trimStart().startsWith('{')) {
    try {
      const v: unknown = JSON.parse(input)
      if (isRecord(v)) return v
    } catch {
      // Not JSON: a patch or a bare line
    }
  }
  return {}
}

/** The shell line a call runs, as text: Claude's `command`, Codex's `command` (a string or its argv) or `cmd`. */
function shellText(call: ResolveCall): string {
  const rec = inputRecord(call.input)
  const c = rec.command ?? rec.cmd
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((w): w is string => typeof w === 'string').join(' ')
  return ''
}

/** Every text of a call a path can sit in: the shell line, and a patch's own text. */
function callText(call: ResolveCall): string {
  const rec = inputRecord(call.input)
  const texts = [shellText(call)]
  for (const k of ['input', 'patch']) if (typeof rec[k] === 'string') texts.push(rec[k] as string)
  if (typeof call.input === 'string') texts.push(call.input)
  return texts.filter((t) => t !== '').join('\n')
}

// ---------------------------------------------------------------------------------------------------------------------
// Astera's settings folder

const WRITEISH: ReadonlySet<string> = new Set(['filesystem.write', 'filesystem.delete', 'process.execute'])
/** What may follow a path that ends exactly at the folder: a separator, a quote or the end of a word. */
const AFTER_PATH = /[/\s"'`;&|()]/
/** The variables a path to the folder can start from, in any shell's spelling (`$X`, `${X}`, `$env:X`, `%X%`). */
const HOME_VARS = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME'] as const

type Env = Readonly<Record<string, string | undefined>>

/** A variable's value; on Windows its name in any case, as the shells read it. */
function envValue(env: Env, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name] || undefined
  const key = Object.keys(env).find((k) => k.toUpperCase() === name)
  return key === undefined ? undefined : env[key] || undefined
}

/** `text` with the home and its folders' variables and a leading `~` put in, and a POSIX shell's escaped space as the
 *  space, so a path to the folder however the agent spelled it reads as the folder (final review I2). */
function expandHome(text: string, env: Env, platform: NodeJS.Platform): string {
  let t = platform === 'win32' ? text : text.replace(/\\ /g, ' ')
  for (const name of HOME_VARS) {
    const value = envValue(env, name, platform)
    if (value === undefined) continue
    t = t.replace(new RegExp(`\\$\\{${name}\\}|\\$env:${name}(?![A-Za-z0-9_])|%${name}%|\\$${name}(?![A-Za-z0-9_])`, 'gi'), () => value)
  }
  const home = envValue(env, 'HOME', platform) ?? envValue(env, 'USERPROFILE', platform)
  if (home !== undefined) t = t.replace(/(^|[\s"'=(;|&:])~(?=[\\/]|$|[\s"';|&)])/g, (_m, before: string) => before + home)
  return t
}

/** Every string an MCP tool's arguments hold, a few levels deep: its path argument may be any of them. */
function stringsOf(v: unknown, depth = 0): string[] {
  if (typeof v === 'string') return [v]
  if (depth >= 4) return []
  if (Array.isArray(v)) return v.flatMap((x) => stringsOf(x, depth + 1))
  if (isRecord(v)) return Object.values(v).flatMap((x) => stringsOf(x, depth + 1))
  return []
}

function touchesProfile(call: ResolveCall, r: ResolvedAction, profileDir: string, platform: NodeJS.Platform, env: Env): boolean {
  const mcp = r.action === 'mcp.call'
  if (!mcp && ![r.action, ...(r.commands ?? []).map((c) => c.action)].some((a) => WRITEISH.has(a))) return false
  const fold = platform === 'win32' || platform === 'darwin'
  const norm = (s: string): string => {
    const t = s.replace(/\\/g, '/')
    return fold ? t.toLowerCase() : t
  }
  const root = norm(profileDir).replace(/\/+$/, '')
  const p = platform === 'win32' ? path.win32 : path.posix
  const within = (candidate: string): boolean => {
    const from = call.base ?? call.cwd
    const resolved = norm(p.isAbsolute(candidate) ? candidate : p.resolve(from, candidate)).replace(/\/+$/, '')
    return resolved === root || resolved.startsWith(`${root}/`)
  }
  const rec = inputRecord(call.input)
  for (const k of ['file_path', 'notebook_path', 'path']) {
    const v = rec[k]
    if (typeof v === 'string' && v !== '' && within(expandHome(v, env, platform))) return true
  }
  // An MCP tool cannot be told to write or to read, so any of its arguments that names the folder is enough
  const raw = mcp ? stringsOf(rec).join('\n') : callText(call)
  const text = norm(expandHome(raw, env, platform))
  // Git Bash spells C:/x as /c/x
  const drive = /^([a-z]):\//i.exec(root)
  const needles = drive ? [root, `/${drive[1].toLowerCase()}/${root.slice(3)}`] : [root]
  for (const n of needles) {
    for (let i = text.indexOf(n); i >= 0; i = text.indexOf(n, i + 1)) {
      const after = text[i + n.length]
      if (after === undefined || AFTER_PATH.test(after)) return true
    }
  }
  // Every word that is a path, from where the call runs: a relative one (`../../AppData/…`), a patch's own headers
  for (const word of text.split(/[\s"'`;&|()<>=,]+/)) if ((word.includes('/') || word.startsWith('.')) && within(word)) return true
  // The shell is already in the folder: the call before it left it there
  return call.base !== undefined && text !== '' && within(call.base)
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands that change Astera's settings

/** A line that reaches Astera's CLI however it is spelled: the command bare or behind a path, `.cmd` or `.exe`, its
 *  `cli.js`, the ASTERA_CLI variable in any shell (`"$ASTERA_CLI"`, `& $env:ASTERA_CLI`, `%ASTERA_CLI%`, as Astera's own
 *  guide teaches), behind a wrapper (`env`, `cmd /c`) or global flags (`--json`): any of them names `astera`. Final
 *  review C1: matching the command word alone let those through. */
const ASTERA_REF = /astera/i
/** The group, then a verb that changes Policies or agent profiles anywhere after it (flags may sit between), the findings'
 *  ignore list among them (lifecycle design §7: an agent cannot hide a finding about itself). The CLI has no verb that
 *  changes the Credentials list (credentials design §7). */
const SETTINGS_CHANGE =
  /(?:^|[\s"'`;&|(])(?:policies|agent-profiles)(?=$|[\s"'`;&|)])[\s\S]*?(?:^|[\s"'`;&|(])(?:set-mode|set-otherwise|rules-(?:add|edit|remove|move|reset)|create|update|archive|restore|delete|audit-(?:ignore|unignore))(?=$|[\s"'`;&|)])/i

const changesSettings = (line: string): boolean => ASTERA_REF.test(line) && SETTINGS_CHANGE.test(line)

// ---------------------------------------------------------------------------------------------------------------------
// The verdict

/** What a call may still do when the Rules cannot be read (spec §33.1): read, or run nothing at all. */
const isRead = (action: string, confidence?: string): boolean =>
  action === 'filesystem.read' || action === 'git.read' || (action === 'other' && confidence === 'exact')

const reads = (r: ResolvedAction): boolean => isRead(r.action, r.confidence) && (r.commands ?? []).every((c) => isRead(c.action, 'exact'))

function ruleReason(policy: AuditPolicy, ruleId: string): string {
  const rule = policy.rules.find((x) => x.id === ruleId)
  if (!rule) return `Blocked by Astera Rules: ${ruleId}.`
  const scope = rule.scope === 'outside-project' ? ' outside the project' : rule.scope === 'inside-project' ? ' inside the project' : ''
  return `Blocked by Astera Rules: ${rule.action}${scope} is denied.`
}

/** Whether a call is stopped, and why. `policy` null: the Rules could not be read, so only reads go through. `env`: the
 *  hook's own environment, for the home folders a path can be spelled from. */
export function enforceVerdict(a: {
  call: ResolveCall
  policy: AuditPolicy | null
  profileDir: string
  platform: NodeJS.Platform
  env?: Env
}): EnforceVerdict {
  const r = resolveAction(a.call)
  if (a.policy === null) return reads(r) ? { deny: false } : { deny: true, ruleId: 'fail-closed', reason: REASONS.failClosed }
  if (touchesProfile(a.call, r, a.profileDir, a.platform, a.env ?? {})) return { deny: true, ruleId: 'builtin-profile-write', reason: REASONS.profile }
  if (changesSettings(shellText(a.call))) return { deny: true, ruleId: 'builtin-settings-command', reason: REASONS.settings }
  const d = decide(r, a.policy)
  if (d.decision === 'would-deny')
    return d.ruleId !== undefined
      ? { deny: true, ruleId: d.ruleId, reason: ruleReason(a.policy, d.ruleId) }
      : { deny: true, ruleId: 'otherwise', reason: `Blocked by Astera Rules: no rule allows ${r.action}.` }
  if (d.decision === 'unknown' && a.policy.otherwise === 'deny')
    return { deny: true, ruleId: 'otherwise', reason: `Blocked by Astera Rules: no rule allows ${r.action}.` }
  return { deny: false }
}
