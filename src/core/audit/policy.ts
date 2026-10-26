// Observe mode's rules (design §7): one ordered list for the whole app, and the mode itself beside it (ruling M1), kept
// by the Host in `<profile>/audit-policy.json` with the extension registry's store pattern, so the Host is its one
// writer and the mode can change while the app is closed. The evaluator says what the rules would have done with a call
// the resolver named; nothing here blocks, `would-deny` is a preview.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { profilePaths } from '../profile/paths'
import { keepDamaged, readStoreFile } from '../storeFile'
import { writeThroughTmp } from '../accounts/fileQueue'
import { RepairNeeded } from '../settings/repairNeeded'
import type { ResolvedAction } from './resolve'
import type { AuditAction, AuditDecision, AuditMode, AuditPolicy, AuditRule, CommandFacts, CoverageCell, CoverageRow } from './types'

// Declared beside the other shapes the renderer reads (types.ts), kept importable from here
export type { AuditDecision, AuditMode, AuditPolicy, AuditRule, CoverageCell, CoverageClass, CoverageNote, CoverageRow } from './types'

/** What most people would not want an agent to do unattended, without flooding the preview (design §7). Written the
 *  first time observe is turned on, then the person's to edit; shown while there is no file. */
export const STARTER_POLICY: AuditPolicy = {
  version: 1,
  mode: 'compatibility',
  rules: [
    { id: 'starter-git-remote-write', effect: 'deny', action: 'git.remote.write' },
    { id: 'starter-github-pr-create', effect: 'deny', action: 'github.pr.create' },
    { id: 'starter-github-write', effect: 'deny', action: 'github.write' },
    { id: 'starter-write-outside', effect: 'deny', action: 'filesystem.write', scope: 'outside-project' },
    { id: 'starter-delete-outside', effect: 'deny', action: 'filesystem.delete', scope: 'outside-project' }
  ],
  otherwise: 'allow'
}

// A record so the compiler holds it to the resolver's list: an action missing here or one it does not name fails to build
const ACTIONS: Record<AuditAction, true> = {
  'process.execute': true,
  'git.read': true,
  'git.local.write': true,
  'git.remote.write': true,
  'github.pr.create': true,
  'github.write': true,
  'package.install': true,
  'filesystem.read': true,
  'filesystem.write': true,
  'filesystem.delete': true,
  'network.request': true,
  'mcp.call': true,
  'agent.spawn': true,
  other: true
}

/** Every action the resolver names. */
export const AUDIT_ACTIONS = Object.keys(ACTIONS) as AuditAction[]

/** Whether a rule's action can match anything: an action the resolver names, or a prefix ending in `*` that one of them
 *  starts with. A `*` anywhere else is not a pattern. */
export function isRuleAction(pattern: string): boolean {
  const star = pattern.indexOf('*')
  if (star < 0) return Object.hasOwn(ACTIONS, pattern)
  if (star !== pattern.length - 1) return false
  const prefix = pattern.slice(0, -1)
  return AUDIT_ACTIONS.some((a) => a.startsWith(prefix))
}

// ---------------------------------------------------------------------------------------------------------------------
// The evaluator

type Verdict = { decision: 'allow' | 'would-deny'; ruleId?: string }

const matches = (pattern: string, action: string): boolean =>
  pattern.endsWith('*') ? action.startsWith(pattern.slice(0, -1)) : pattern === action

/** The first rule that matches one command in one place, else `otherwise`. A scoped rule needs a place to match. */
function judge(action: string, inside: boolean | undefined, p: AuditPolicy): Verdict {
  for (const r of p.rules) {
    if (!matches(r.action, action)) continue
    if (r.scope !== undefined && (inside === undefined || inside !== (r.scope === 'inside-project'))) continue
    return { decision: r.effect === 'deny' ? 'would-deny' : 'allow', ruleId: r.id }
  }
  return { decision: p.otherwise === 'deny' ? 'would-deny' : 'allow' }
}

/** Writes and deletes: when one names no place it may still have been outside the project. */
const WRITES: ReadonlySet<string> = new Set<AuditAction>(['filesystem.write', 'filesystem.delete'])

/** One command's verdict, or null when it cannot be told. A write or delete that names no place is judged in both
 *  places: when they differ it cannot be told, so it is never allowed past an outside rule it might match (ledger,
 *  Task 2's note for Task 3); when they agree the decision stands, naming its rule only if one rule decided both. */
function judgeCommand(c: CommandFacts, p: AuditPolicy): Verdict | null {
  if (c.insideProject !== undefined || !WRITES.has(c.action)) return judge(c.action, c.insideProject, p)
  const inside = judge(c.action, true, p)
  const outside = judge(c.action, false, p)
  if (inside.decision !== outside.decision) return null
  return inside.ruleId === outside.ruleId ? inside : { decision: inside.decision }
}

/**
 * What the rules would have done with a call (design §7, revised after the final review and again on 2026-10-24). The
 * headline and every command of the line are each judged in their own place, and a denied command is denied wherever in
 * the line it sits: the first one that would be denied, headline first and then in line order, makes the call
 * `would-deny` with its rule, though the line is compound (agents push in compound lines, and the preview errs toward
 * flagging them), has control flow, runs a script or a command the resolver does not know, or was cut short. Else the
 * call is `unknown` when the resolver could not name all of it (`confidence` unknown) or one command cannot be told (a
 * write or delete with no place, where the place decides). Else the headline's verdict stands. `ruleId` names the rule
 * that decided, and is left out when `otherwise` did, or when a write with no place got the same decision from a
 * different rule in each place.
 */
export function decide(
  record: Pick<ResolvedAction, 'action' | 'insideProject' | 'confidence' | 'commands'>,
  p: AuditPolicy
): { decision: AuditDecision; ruleId?: string } {
  const verdicts = [record, ...(record.commands ?? [])].map((c) => judgeCommand(c, p))
  const denied = verdicts.find((v) => v?.decision === 'would-deny')
  if (denied) return denied
  if (record.confidence === 'unknown' || verdicts.some((v) => v === null)) return { decision: 'unknown' }
  return verdicts[0]!
}

// ---------------------------------------------------------------------------------------------------------------------
// The file

const FILE = 'audit-policy.json'
const EFFECTS: readonly string[] = ['allow', 'deny']
const SCOPES: readonly string[] = ['inside-project', 'outside-project']

/** The hash of the damaged text this process last kept aside, by file: the Host's commands read the rules at every call,
 *  and one copy per distinct damage is enough (the agent profile store's rule). */
const keptDamage = new Map<string, string>()

/** The file was read but holds no policy. Its bytes are kept beside it, so starting over with the starter rules may write
 *  over it (`policies-rules-reset`, the repair), in the mode sessions have been starting in meanwhile (compatibility). A
 *  file that could not be read throws plain RepairNeeded instead, and nothing writes over that one. */
export class AuditPolicyDamaged extends RepairNeeded {
  constructor(file: string) {
    super(`${file} is damaged; a copy was kept beside it`, file)
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A mode it does not know reads as compatibility, which never observes more than the person chose. */
const modeOf = (v: unknown): AuditMode => (isRecord(v) && v.mode === 'observe' ? 'observe' : 'compatibility')

function ruleOf(v: unknown): AuditRule | null {
  if (!isRecord(v)) return null
  const { id, effect, action, scope } = v
  if (typeof id !== 'string' || id === '' || typeof action !== 'string' || action === '') return null
  if (!EFFECTS.includes(effect as string) || (scope !== undefined && !SCOPES.includes(scope as string))) return null
  return { id, effect: effect as AuditRule['effect'], action, ...(scope !== undefined ? { scope: scope as AuditRule['scope'] } : {}) }
}

/** The policy a parsed file holds, or null when it is not one. */
function policyOf(v: unknown): AuditPolicy | null {
  if (!isRecord(v) || v.version !== 1 || !Array.isArray(v.rules) || !EFFECTS.includes(v.otherwise as string)) return null
  const rules = v.rules.map(ruleOf)
  if (rules.some((r) => r === null)) return null
  return { version: 1, mode: modeOf(v), rules: rules as AuditRule[], otherwise: v.otherwise as AuditPolicy['otherwise'] }
}

/** The profile's rules and mode; null when there is no file. Throws RepairNeeded when the file is unreadable, and its
 *  AuditPolicyDamaged when it is damaged, keeping a copy of the damage beside it unless `keepDamaged` is false: only the
 *  Host's commands keep one, so a read that every spawn makes, in the app's process too, writes nothing (final review
 *  M9). */
export async function readAuditPolicy(profileDir: string, o: { keepDamaged?: boolean } = {}): Promise<AuditPolicy | null> {
  const file = profilePaths(profileDir).auditPolicy
  const read = await readStoreFile(file)
  if (read.kind === 'missing') return null
  if (read.kind === 'unreadable') throw new RepairNeeded(`${FILE} could not be read (${String(read.error)})`, FILE)
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    parsed = null
  }
  const p = policyOf(parsed)
  if (p === null) {
    const hash = createHash('sha256').update(read.text).digest('hex')
    if (o.keepDamaged !== false && keptDamage.get(file) !== hash) {
      keptDamage.set(file, hash)
      await keepDamaged(file, read.text)
    }
    throw new AuditPolicyDamaged(FILE)
  }
  return p
}

/** Whether the damaged file's bytes are kept beside it: a copy of exactly this text is there, or could be made now. The
 *  repair starts over only when it is, since what it writes over would be gone otherwise. Never rejects. */
export async function damageIsKept(profileDir: string): Promise<boolean> {
  const file = profilePaths(profileDir).auditPolicy
  const read = await readStoreFile(file)
  if (read.kind !== 'text') return false
  const dir = path.dirname(file)
  const has = async (): Promise<boolean> => {
    for (const n of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!n.startsWith(`${path.basename(file)}.`) || !n.endsWith('.bak')) continue
      if ((await fs.readFile(path.join(dir, n), 'utf8').catch(() => null)) === read.text) return true
    }
    return false
  }
  if (await has()) return true
  await keepDamaged(file, read.text)
  return has()
}

/** Writes the rules and mode atomically. */
export async function writeAuditPolicy(profileDir: string, p: AuditPolicy): Promise<void> {
  const file = profilePaths(profileDir).auditPolicy
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeThroughTmp(file, JSON.stringify(p, null, 2) + '\n')
}

/** The mode sessions start in, read at every spawn. No file is compatibility; so is a damaged or unreadable one, since a
 *  spawn must not fail over it (the policies commands report that one as RepairNeeded, and keep its copy). Writes
 *  nothing. Never rejects. */
export async function readPolicyMode(profileDir: string): Promise<AuditMode> {
  return readAuditPolicy(profileDir, { keepDamaged: false }).then(
    (p) => p?.mode ?? 'compatibility',
    () => 'compatibility'
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Coverage

const SEEN: CoverageCell = { level: 'seen' }
const SHELL_TEXT_ONLY: CoverageCell = { level: 'partial', note: 'shell-text-only' }
/** Claude's network calls are seen when WebFetch or WebSearch make them; a `curl` in the shell is shell text. */
const WEB_TOOLS_ONLY: CoverageCell = { level: 'partial', note: 'web-tools-only' }

/** What observe can see for each provider and kind of session (design §9), worded for observing, never "enforced". */
export const COVERAGE: readonly CoverageRow[] = [
  { provider: 'claude', kind: 'terminal', classes: { shell: SEEN, 'file-read': SEEN, 'file-write': SEEN, mcp: SEEN, network: WEB_TOOLS_ONLY } },
  { provider: 'claude', kind: 'chat', classes: { shell: SEEN, 'file-read': SEEN, 'file-write': SEEN, mcp: SEEN, network: WEB_TOOLS_ONLY } },
  {
    provider: 'codex',
    kind: 'terminal',
    classes: { shell: SEEN, 'file-read': SHELL_TEXT_ONLY, 'file-write': SEEN, mcp: SEEN, network: { level: 'partial', note: 'web-search-and-shell-text' } }
  },
  { provider: 'codex', kind: 'chat', classes: { shell: SEEN, 'file-read': SHELL_TEXT_ONLY, 'file-write': SEEN, mcp: SEEN, network: { level: 'partial' } } }
]
