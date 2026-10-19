// Whether a PR head's CI has passed, failed or is still running, under the Job's policy (GitHub lifecycle design L3,
// §4.4, self-review S1), and the required check names the branch rules give. evaluateCi is pure.
//
// A pass needs more than green checks: checks appear as GitHub gets to them, so every suite with check runs must be
// done (a running workflow can still add a job), and every name the policy requires must have reported.
import { ghFailureSentence, type GhFailed, type GhRunner } from './gh'
import type { CiBasis, CiVerdict, GitHubCiCheck, GitHubCiConclusion, GitHubCiPolicy } from './lifecycle'
import type { PrStateRead } from './prState'
import { hostnameArgs, repoSlug, type GitHubRepo } from './remote'

export interface CiEvaluation {
  basis: CiBasis
  verdict: CiVerdict
  /** The target check that completed unsuccessfully first. */
  failing?: GitHubCiCheck
}

/** What branch protection counts as passing. */
const PASSING: readonly GitHubCiConclusion[] = ['success', 'skipped', 'neutral']
/** Not counted in all-reported mode: nothing was checked. */
const NOTHING_CHECKED: readonly GitHubCiConclusion[] = ['skipped', 'neutral']

/** Completed with a conclusion that is a verdict. STALE is not: GitHub will run it again. */
const settled = (c: GitHubCiCheck): boolean => c.status === 'completed' && c.conclusion !== undefined && c.conclusion !== 'stale'

/** The names of the checks CI is judged on by `basis`, sorted, once (GitHub lifecycle G5b): the required ones present,
 *  the selected ones present, or every reported one but those settled skipped or neutral. Kept with merge-ready; a
 *  later read of the same head that judges on other names withdraws it. */
export function ciTargetNames(checks: readonly GitHubCiCheck[], basis: CiBasis, selected: readonly string[] = []): string[] {
  const targets =
    basis === 'required'
      ? checks.filter((c) => c.required)
      : basis === 'selected'
        ? checks.filter((c) => selected.includes(c.name))
        : checks.filter((c) => !(settled(c) && NOTHING_CHECKED.includes(c.conclusion!)))
  return [...new Set(targets.map((c) => c.name))].sort()
}

/** `ruleNames` is null when the branch rules could not be read. In `required` mode that, or a read that could not say
 *  whether some check is required, keeps a verdict from passing (spec §9: do not guess a pass), and so does a read
 *  that ran past its page in any mode; a failure seen still fails (final review C1, I2, M1). */
export function evaluateCi(
  read: Pick<PrStateRead, 'checks' | 'suites' | 'requiredUnknown' | 'truncated'>,
  policy: GitHubCiPolicy,
  ruleNames: readonly string[] | null
): CiEvaluation {
  let basis: CiBasis
  let targets: GitHubCiCheck[]
  let named: string[] = []
  const unknowable = read.truncated === true || (policy.mode === 'required' && (ruleNames === null || read.requiredUnknown === true))
  if (policy.mode === 'selected') {
    basis = 'selected'
    named = [...new Set(policy.selectedChecks ?? [])]
    targets = read.checks.filter((c) => named.includes(c.name))
  } else {
    const required = new Set([...(ruleNames ?? []), ...read.checks.filter((c) => c.required).map((c) => c.name)])
    if (required.size > 0) {
      basis = 'required'
      named = [...required]
      targets = read.checks.filter((c) => required.has(c.name))
    } else {
      basis = 'all-reported'
      targets = read.checks.filter((c) => !(settled(c) && NOTHING_CHECKED.includes(c.conclusion!)))
    }
  }
  // An Actions suite with no check yet is a workflow starting: CI is coming, not absent (G4)
  if (basis === 'all-reported' && read.checks.length === 0) return { basis, verdict: read.suites.some((s) => !s.completed) ? 'pending' : 'none' }
  const failing = targets
    .filter((c) => settled(c) && !PASSING.includes(c.conclusion!))
    .sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''))[0]
  if (failing) return { basis, verdict: 'failed', failing }
  const present = new Set(read.checks.map((c) => c.name))
  const passed = !unknowable && named.every((n) => present.has(n)) && targets.every(settled) && read.suites.every((s) => s.completed)
  return { basis, verdict: passed ? 'passed' : 'pending' }
}

/** `gh api repos/{o}/{r}/rules/branches/{branch}`: the rules that apply to a branch, readable with read access
 *  (measured 2026-10-17; classic branch protection needs admin and is not read). The names of the status checks they
 *  require, once each; [] when none do; null when the answer is not a list. */
export function parseRuleCheckNames(stdout: string): string[] | null {
  let rows: unknown
  try {
    rows = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(rows)) return null
  const names: string[] = []
  for (const raw of rows) {
    const rule = raw as { type?: unknown; parameters?: { required_status_checks?: unknown } } | null
    if (rule?.type !== 'required_status_checks') continue
    const list = rule.parameters?.required_status_checks
    if (!Array.isArray(list)) continue
    for (const c of list) {
      const context = (c as { context?: unknown } | null)?.context
      if (typeof context === 'string' && !names.includes(context)) names.push(context)
    }
  }
  return names
}

export async function readRuleCheckNames(
  run: GhRunner,
  cwd: string,
  repo: GitHubRepo,
  branch: string
): Promise<{ ok: true; names: string[] } | GhFailed> {
  // A branch's slashes are path separators GitHub reads as part of the name; every other character is encoded.
  const path = branch.split('/').map(encodeURIComponent).join('/')
  const r = await run(['api', ...hostnameArgs(repo), `repos/${repoSlug(repo)}/rules/branches/${path}`], cwd)
  // A private repository on a free plan has no rulesets at all: GitHub answers 403 "Upgrade to GitHub Pro or make this
  // repository public to enable this feature" (measured on the sandbox, 2026-10-18). No rules can require a check there.
  // Any other refusal stays a failure: the rules may exist and be unreadable.
  if (!r.ok && /upgrade to github pro/i.test(r.stderr)) return { ok: true, names: [] }
  if (!r.ok) return { ok: false, ...ghFailureSentence(r) }
  const names = parseRuleCheckNames(r.stdout)
  return names ? { ok: true, names } : { ok: false, kind: 'other', message: 'the branch rules answer is not a list' }
}
