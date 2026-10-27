// The Host's `audit-*` commands (observe mode design §8, §11, §12): the records the recorder kept, read back with the
// decision the rules in force now give each one, never a stored one, so editing a rule changes what the past would have
// been. While there is no rules file the starter rules preview them, as `policies-show` shows them. Reads only.
//
// For this machine's app and CLI: MCP, a remote controller and a plugin never get here, since no gate lists them, and an
// agent's shell is refused even these reads, so the log of an agent's calls stays away from agents (design §3).
import { RepairNeeded } from '../../core/settings/repairNeeded'
import {
  AUDIT_ACTIONS,
  AuditPolicyDamaged,
  STARTER_POLICY,
  decide,
  isRuleAction,
  readAuditPolicy,
  type AuditDecision,
  type AuditPolicy
} from '../../core/audit/policy'
import { auditStoppedAtLimit, queryRecords, visitRecords, type AuditFilter, type AuditRecord } from '../../core/audit/store'
import type { OrchCaller } from '../../core/host/orchProtocol'

export const AUDIT_COMMANDS: ReadonlySet<string> = new Set(['audit-list', 'audit-summary'])

export interface AuditAnswer {
  status: number
  body: unknown
}

export interface HostAudit {
  command(a: {
    cmd: string
    args: Record<string, unknown>
    role: OrchCaller['role'] | undefined
    /** The sentence an agent's shell is refused with, present exactly when the caller is one. */
    agentRefusal?: string
    marks: { effects: number }
  }): Promise<AuditAnswer>
}

const LIST_DEFAULT = 200
const LIST_MAX = 2000
const DECISIONS: readonly unknown[] = ['allow', 'would-deny', 'unknown', 'blocked']
const TEXT_FILTERS = ['sessionId', 'jobId', 'runId', 'taskId', 'agentProfileId'] as const

interface Counts {
  allow: number
  wouldDeny: number
  unknown: number
  blocked: number
}
const COUNT_KEY: Record<AuditDecision, keyof Counts> = { allow: 'allow', 'would-deny': 'wouldDeny', unknown: 'unknown', blocked: 'blocked' }
const noCounts = (): Counts => ({ allow: 0, wouldDeny: 0, unknown: 0, blocked: 0 })

/** A record's decision: a call Enforce's hook stopped is blocked for good, with what stopped it (enforce design §5); any
 *  other is what the rules in force now give it. */
const decisionOf = (r: AuditRecord, p: AuditPolicy): { decision: AuditDecision; ruleId?: string } =>
  r.status === 'blocked' ? { decision: 'blocked', ...(r.blockedBy !== undefined ? { ruleId: r.blockedBy } : {}) } : decide(r, p)

const bad = (error: string): AuditAnswer => ({ status: 400, body: { error } })
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The filter the arguments name, or the sentence that refuses them. */
function filterOf(args: Record<string, unknown>): { filter: AuditFilter; decision?: AuditDecision } | string {
  const filter: AuditFilter = {}
  for (const k of TEXT_FILTERS) {
    const v = args[k]
    if (v === undefined) continue
    if (typeof v !== 'string' || v === '') return `${k} must be text`
    filter[k] = v
  }
  // As a rule names one: an action, or the start of one ending in * (git.*)
  if (args.action !== undefined) {
    if (typeof args.action !== 'string' || !isRuleAction(args.action))
      return `action must be one of ${AUDIT_ACTIONS.join(', ')}, or the start of one ending in * (git.*)`
    filter.action = args.action
  }
  for (const k of ['since', 'until'] as const) {
    const v = args[k]
    if (v === undefined) continue
    if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) return `${k} must be a time such as 2026-10-23T09:00:00Z`
    filter[k] = v
  }
  // The next page's cursor, as audit-list's `next` gives it
  if (args.beforeId !== undefined) {
    if (typeof args.beforeId !== 'string' || args.beforeId === '' || filter.until === undefined) return 'beforeId must be text, given with until'
    filter.beforeId = args.beforeId
  }
  if (args.decision !== undefined && !DECISIONS.includes(args.decision)) return 'decision must be allow, would-deny, unknown or blocked'
  return { filter, ...(args.decision !== undefined ? { decision: args.decision as AuditDecision } : {}) }
}

export function createHostAudit(d: {
  profileDir: string
  /** Test injection for the clock the kept days are counted back from (epoch ms). */
  now?: () => number
}): HostAudit {
  const kept = d.now !== undefined ? { now: d.now } : {}
  /** The rules in force: the file's, or the starter rules while there is none. */
  const rules = async (): Promise<AuditPolicy> => (await readAuditPolicy(d.profileDir)) ?? STARTER_POLICY

  const answer = async (cmd: string, args: Record<string, unknown>): Promise<AuditAnswer> => {
    const f = filterOf(args)
    if (typeof f === 'string') return bad(f)
    switch (cmd) {
      case 'audit-list': {
        const limit = args.limit ?? LIST_DEFAULT
        if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > LIST_MAX) return bad(`limit must be from 1 to ${LIST_MAX}`)
        const n = limit as number
        const p = await rules()
        const where = f.decision !== undefined ? { where: (r: AuditRecord) => decisionOf(r, p).decision === f.decision } : {}
        // One past the limit, to tell whether it cut anything
        const found = await queryRecords(d.profileDir, { ...f.filter, ...where, limit: n + 1 }, kept)
        const page = found.slice(0, n)
        const truncated = found.length > n
        // Where the next page starts: after this page's last record, in the page's order (time, then id)
        const last = page[page.length - 1]
        const next = truncated ? { until: last.at, beforeId: last.id } : null
        return { status: 200, body: { records: page.map((r) => ({ ...r, ...decisionOf(r, p) })), truncated, next } }
      }
      case 'audit-summary': {
        const p = await rules()
        const total = noCounts()
        // A Map, so an action read from the file can never name a property of a plain object
        const byAction = new Map<string, Counts>()
        // Counted as they are read, so the whole folder is never held at once
        await visitRecords(d.profileDir, f.filter, (r) => {
          const { decision } = decisionOf(r, p)
          if (f.decision !== undefined && decision !== f.decision) return
          const key = COUNT_KEY[decision]
          total[key] += 1
          const counts = byAction.get(r.action) ?? noCounts()
          counts[key] += 1
          byAction.set(r.action, counts)
        }, kept)
        // A day of the period whose records stopped at the size has fewer of them than its calls
        const stoppedAtLimit = auditStoppedAtLimit(d.profileDir, { since: f.filter.since, until: f.filter.until })
        return { status: 200, body: { ...total, byAction: Object.fromEntries(byAction), stoppedAtLimit } }
      }
      default:
        return { status: 501, body: { error: `${cmd} is not answered by this Host` } }
    }
  }

  return {
    command: async (a) => {
      if (a.role !== 'app' && a.role !== 'cli') return { status: 403, body: { error: `${a.cmd} is for this machine's app and CLI only` } }
      if (a.agentRefusal !== undefined) return { status: 403, body: { error: a.agentRefusal } }
      try {
        return await answer(a.cmd, a.args)
      } catch (e) {
        // A damaged rules file is the person's to repair (RepairNeeded): no decision can be made until then. `reason:
        // 'damaged'` when starting over with the starter rules (policies-rules-reset) repairs it, as policies-* say
        return {
          status: e instanceof RepairNeeded ? 409 : 500,
          body: { error: message(e), ...(e instanceof AuditPolicyDamaged ? { reason: 'damaged' } : {}) }
        }
      }
    }
  }
}
