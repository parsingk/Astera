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
  /** Why `provider`'s CLI cannot be enforced (`ENFORCE_UNAVAILABLE: cli-too-old …` or `cli-version-unknown …`), or
   *  null. Read synchronously: `warm` asked first. */
  blocker?(provider: 'claude' | 'codex'): string | null
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

function touchesProfile(call: ResolveCall, r: ResolvedAction, profileDir: string, platform: NodeJS.Platform): boolean {
  if (![r.action, ...(r.commands ?? []).map((c) => c.action)].some((a) => WRITEISH.has(a))) return false
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
    if (typeof v === 'string' && v !== '' && within(v)) return true
  }
  const text = norm(callText(call))
  // Git Bash spells C:/x as /c/x
  const drive = /^([a-z]):\//i.exec(root)
  const needles = drive ? [root, `/${drive[1].toLowerCase()}/${root.slice(3)}`] : [root]
  for (const n of needles) {
    for (let i = text.indexOf(n); i >= 0; i = text.indexOf(n, i + 1)) {
      const after = text[i + n.length]
      if (after === undefined || AFTER_PATH.test(after)) return true
    }
  }
  // The shell is already in the folder: the call before it left it there
  return call.base !== undefined && text !== '' && within(call.base)
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands that change Astera's settings

/** `astera` (bare, behind a path, `.cmd` or `.exe`, quoted or not) with a verb that changes Policies or agent profiles.
 *  The CLI has no verb that changes the Credentials list (credentials design §7). */
const SETTINGS_COMMAND =
  /(?:^|[\s"'`;&|(])(?:"[^"]*[\\/]|'[^']*[\\/]|[^\s"'`;&|()]*[\\/])?astera(?:\.cmd|\.exe)?["']?\s+(?:policies\s+(?:set-mode|set-otherwise|rules-(?:add|edit|remove|move|reset))|agent-profiles\s+(?:create|update|archive|restore|delete))(?![\w-])/i

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

/** Whether a call is stopped, and why. `policy` null: the Rules could not be read, so only reads go through. */
export function enforceVerdict(a: { call: ResolveCall; policy: AuditPolicy | null; profileDir: string; platform: NodeJS.Platform }): EnforceVerdict {
  const r = resolveAction(a.call)
  if (a.policy === null) return reads(r) ? { deny: false } : { deny: true, ruleId: 'fail-closed', reason: REASONS.failClosed }
  if (touchesProfile(a.call, r, a.profileDir, a.platform)) return { deny: true, ruleId: 'builtin-profile-write', reason: REASONS.profile }
  if (SETTINGS_COMMAND.test(shellText(a.call))) return { deny: true, ruleId: 'builtin-settings-command', reason: REASONS.settings }
  const d = decide(r, a.policy)
  if (d.decision === 'would-deny')
    return d.ruleId !== undefined
      ? { deny: true, ruleId: d.ruleId, reason: ruleReason(a.policy, d.ruleId) }
      : { deny: true, ruleId: 'otherwise', reason: `Blocked by Astera Rules: no rule allows ${r.action}.` }
  if (d.decision === 'unknown' && a.policy.otherwise === 'deny')
    return { deny: true, ruleId: 'otherwise', reason: `Blocked by Astera Rules: no rule allows ${r.action}.` }
  return { deny: false }
}
