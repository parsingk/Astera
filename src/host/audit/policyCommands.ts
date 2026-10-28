// The Host's `policies-*` commands (observe mode design §7, §12): the Host owns observe mode's rules and the mode beside
// them (audit-policy.json, ruling M1), so the app's Settings › Security & Access and this machine's CLI change them
// through here, even while the app is closed. Like the `agent-profiles-*` commands they are for the app and the CLI
// only: MCP, a remote controller and a plugin never get here, since no gate lists them, and an agent's shell may read
// but not change the rules its own calls are previewed against.
import { randomBytes } from 'node:crypto'
import { RepairNeeded } from '../../core/settings/repairNeeded'
import {
  AUDIT_ACTIONS,
  AuditPolicyDamaged,
  COVERAGE,
  COVERAGE_ENFORCE,
  STARTER_POLICY,
  damageIsKept,
  isRuleAction,
  readAuditPolicy,
  readPolicyMode,
  writeAuditPolicy,
  type AuditPolicy,
  type AuditRule
} from '../../core/audit/policy'
import { SANDBOX_COVERAGE } from '../../core/sandbox/coverage'
import type { OrchCaller } from '../../core/host/orchProtocol'

export const POLICY_COMMANDS: ReadonlySet<string> = new Set([
  'policies-show',
  'policies-set-mode',
  'policies-set-otherwise',
  'policies-rules-add',
  'policies-rules-edit',
  'policies-rules-remove',
  'policies-rules-move',
  'policies-rules-reset'
])

/** The ones that change the rules or the mode: all but the read. */
export const POLICY_CHANGES: ReadonlySet<string> = new Set([
  'policies-set-mode',
  'policies-set-otherwise',
  'policies-rules-add',
  'policies-rules-edit',
  'policies-rules-remove',
  'policies-rules-move',
  'policies-rules-reset'
])

export interface PoliciesAnswer {
  status: number
  body: unknown
}

export interface HostPolicies {
  command(a: {
    cmd: string
    args: Record<string, unknown>
    role: OrchCaller['role'] | undefined
    /** The sentence an agent's shell is refused with, present exactly when the caller is one. */
    agentRefusal?: string
    marks: { effects: number }
  }): Promise<PoliciesAnswer>
}

const MODES: readonly unknown[] = ['compatibility', 'observe', 'enforce']
const EFFECTS: readonly unknown[] = ['allow', 'deny']
const SCOPES: readonly unknown[] = ['inside-project', 'outside-project']

const bad = (error: string): PoliciesAnswer => ({ status: 400, body: { error } })
const badAction = (): PoliciesAnswer => bad(`action must be one of ${AUDIT_ACTIONS.join(', ')}, or the start of one ending in * (git.*)`)
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const newRuleId = (): string => `ar_${randomBytes(6).toString('hex')}`
/** A position in a list, counted from 0; whether the list is that long is checked against the rules read. */
const isPosition = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0

export function createHostPolicies(d: {
  profileDir: string
  /** Told after every change that landed: the recorder reads the mode again rather than wait out its last read. */
  onChange?: (cmd: string) => void
}): HostPolicies {
  // One change at a time: two changes must each read what the other wrote
  let chain: Promise<unknown> = Promise.resolve()
  const queued = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f, f)
    chain = run.catch(() => {})
    return run
  }

  /** The rules in force: the file's, or the starter rules in compatibility while there is none. */
  const current = async (): Promise<AuditPolicy> => (await readAuditPolicy(d.profileDir)) ?? STARTER_POLICY
  const saved = async (p: AuditPolicy, extra: Record<string, unknown> = {}): Promise<PoliciesAnswer> => {
    await writeAuditPolicy(d.profileDir, p)
    return { status: 200, body: { mode: p.mode, policy: p, ...extra } }
  }
  const noRule = (id: string): PoliciesAnswer => ({ status: 404, body: { error: `no rule ${id}` } })

  const answer = async (cmd: string, args: Record<string, unknown>): Promise<PoliciesAnswer> => {
    switch (cmd) {
      case 'policies-show': {
        const p = await current()
        // What Enforce would block beside what observe sees, so the screen's preview says it before Enforce is on, and what
        // the sandbox blocks per CLI and OS (sandbox design §6), whatever the mode: the sandbox is an agent profile's switch
        return {
          status: 200,
          body: { mode: p.mode, policy: p, coverage: COVERAGE, enforceCoverage: COVERAGE_ENFORCE, sandboxCoverage: SANDBOX_COVERAGE }
        }
      }
      case 'policies-set-mode': {
        if (!MODES.includes(args.mode)) return bad('mode must be compatibility, observe or enforce')
        const mode = args.mode as AuditPolicy['mode']
        return queued(async () => {
          const p = await readAuditPolicy(d.profileDir)
          // Compatibility writes no new file (the plan's first constraint): with none there is nothing to turn off
          if (p === null && mode === 'compatibility') return { status: 200, body: { mode, policy: STARTER_POLICY } }
          // The starter rules are written the first time observe or enforce is turned on (design §7), and the person's kept after
          return saved({ ...(p ?? STARTER_POLICY), mode })
        })
      }
      case 'policies-set-otherwise': {
        if (!EFFECTS.includes(args.otherwise)) return bad('otherwise must be allow or deny')
        const otherwise = args.otherwise as AuditPolicy['otherwise']
        return queued(async () => saved({ ...(await current()), otherwise }))
      }
      case 'policies-rules-add': {
        if (!EFFECTS.includes(args.effect)) return bad('effect must be allow or deny')
        if (typeof args.action !== 'string' || !isRuleAction(args.action)) return badAction()
        if (args.scope !== undefined && !SCOPES.includes(args.scope)) return bad('scope must be inside-project or outside-project')
        if (args.at !== undefined && !isPosition(args.at)) return bad('at must be a position in the list, from 0')
        const rule: AuditRule = {
          id: newRuleId(),
          effect: args.effect as AuditRule['effect'],
          action: args.action,
          ...(args.scope !== undefined ? { scope: args.scope as AuditRule['scope'] } : {})
        }
        const at = args.at as number | undefined
        return queued(async () => {
          const p = await current()
          if (at !== undefined && at > p.rules.length) return bad(`at must be from 0 to ${p.rules.length}`)
          const i = at ?? p.rules.length
          return saved({ ...p, rules: [...p.rules.slice(0, i), rule, ...p.rules.slice(i)] }, { rule })
        })
      }
      case 'policies-rules-edit': {
        if (typeof args.id !== 'string' || args.id === '') return bad('policies-rules-edit needs id')
        if (args.effect !== undefined && !EFFECTS.includes(args.effect)) return bad('effect must be allow or deny')
        if (args.action !== undefined && (typeof args.action !== 'string' || !isRuleAction(args.action))) return badAction()
        // null clears the scope: the rule then applies wherever the call was
        if (args.scope !== undefined && args.scope !== null && !SCOPES.includes(args.scope))
          return bad('scope must be inside-project or outside-project, or null to clear it')
        // An edit that names nothing to change is a mistake, not a change that happens to land on what is there
        if (args.effect === undefined && args.action === undefined && args.scope === undefined)
          return { status: 400, body: { error: 'policies-rules-edit needs something to change: effect, action or scope', reason: 'nothing-to-change' } }
        const { id, effect, action } = args
        return queued(async () => {
          const p = await current()
          const old = p.rules.find((r) => r.id === id)
          if (!old) return noRule(id)
          const scope = args.scope === undefined ? old.scope : (args.scope as AuditRule['scope'] | null)
          const rule: AuditRule = {
            id,
            effect: effect !== undefined ? (effect as AuditRule['effect']) : old.effect,
            action: action !== undefined ? (action as string) : old.action,
            ...(scope != null ? { scope } : {})
          }
          return saved({ ...p, rules: p.rules.map((r) => (r.id === id ? rule : r)) }, { rule })
        })
      }
      case 'policies-rules-remove': {
        if (typeof args.id !== 'string' || args.id === '') return bad('policies-rules-remove needs id')
        const { id } = args
        return queued(async () => {
          const p = await current()
          if (!p.rules.some((r) => r.id === id)) return noRule(id)
          return saved({ ...p, rules: p.rules.filter((r) => r.id !== id) })
        })
      }
      case 'policies-rules-move': {
        if (typeof args.id !== 'string' || args.id === '') return bad('policies-rules-move needs id')
        if (!isPosition(args.to)) return bad('to must be a position in the list, from 0')
        const { id, to } = args
        return queued(async () => {
          const p = await current()
          const from = p.rules.findIndex((r) => r.id === id)
          if (from < 0) return noRule(id)
          if (to > p.rules.length - 1) return bad(`to must be from 0 to ${p.rules.length - 1}`)
          const rest = p.rules.filter((_, i) => i !== from)
          return saved({ ...p, rules: [...rest.slice(0, to), p.rules[from], ...rest.slice(to)] })
        })
      }
      case 'policies-rules-reset':
        // Starts over with the starter rules and their `otherwise`; the mode is the person's switch and stays. It is also
        // the repair of a damaged file, whose bytes were kept aside when it was read: the mode is the one sessions have
        // been starting in meanwhile (readPolicyMode), so the repair never turns observing on or off by itself. A file
        // that could not be read is never written over, nor is a damaged one whose copy could not be kept
        return queued(async () => {
          const mode = await readAuditPolicy(d.profileDir).then(
            (p) => (p ?? STARTER_POLICY).mode,
            async (e: unknown) => {
              if (!(e instanceof AuditPolicyDamaged)) throw e
              if (!(await damageIsKept(d.profileDir)))
                throw new RepairNeeded(`${e.file} is damaged and a copy of it could not be kept, so it is not written over`, e.file)
              return readPolicyMode(d.profileDir)
            }
          )
          return saved({ ...STARTER_POLICY, mode })
        })
      default:
        return { status: 501, body: { error: `${cmd} is not answered by this Host` } }
    }
  }

  return {
    command: async (a) => {
      if (a.role !== 'app' && a.role !== 'cli') return { status: 403, body: { error: `${a.cmd} is for this machine's app and CLI only` } }
      if (POLICY_CHANGES.has(a.cmd) && a.agentRefusal !== undefined) return { status: 403, body: { error: a.agentRefusal } }
      let r: PoliciesAnswer
      try {
        r = await answer(a.cmd, a.args)
      } catch (e) {
        // A damaged file is the person's to repair (RepairNeeded), and nothing is written over it; anything else failed.
        // `reason: 'damaged'` when starting over with the starter rules repairs it, so a screen offers that and only then
        r = {
          status: e instanceof RepairNeeded ? 409 : 500,
          body: {
            error: message(e),
            ...(e instanceof AuditPolicyDamaged ? { reason: 'damaged' } : {}),
            // A file the reset cannot repair: the 409 names it, so the CLI says which one
            ...(e instanceof RepairNeeded && !(e instanceof AuditPolicyDamaged) ? { repair: e.file } : {})
          }
        }
      }
      if (r.status === 200 && POLICY_CHANGES.has(a.cmd)) {
        a.marks.effects += 1
        d.onChange?.(a.cmd)
      }
      return r
    }
  }
}
