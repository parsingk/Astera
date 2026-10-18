// How what the Host read of a Run's GitHub side changes the Run's record (GitHub lifecycle G1, design §5.2): what moved
// is logged once, with a number a public event can follow, and a read that finds nothing new answers null so nothing
// is written. Pure.
import {
  CI_CHECKS_MAX,
  GITHUB_LOG_MAX,
  type GitHubBinding,
  type GitHubCiSnapshot,
  type GitHubLogEntry,
  type GitHubPrFacts,
  type RunGitHubState
} from './lifecycle'

export interface RunGitHubPatch {
  /** Kept only when the Run has none yet: a binding is made once (§7). */
  binding?: GitHubBinding
  /** null clears. */
  prCandidates?: number[] | null
  read?: { headSha: string; pr: GitHubPrFacts; ci: Omit<GitHubCiSnapshot, 'changedAt'> }
  /** null clears: a read succeeded. */
  lastReadError?: { kind: string } | null
  sourceChanged?: true
}

type NewEntry = Omit<GitHubLogEntry, 'seq' | 'at'>

const sameCi = (a: GitHubCiSnapshot | undefined, b: Omit<GitHubCiSnapshot, 'changedAt'>): boolean =>
  a !== undefined &&
  a.sha === b.sha &&
  a.basis === b.basis &&
  a.verdict === b.verdict &&
  a.failing === b.failing &&
  a.failingUrl === b.failingUrl &&
  JSON.stringify(a.failure) === JSON.stringify(b.failure) &&
  JSON.stringify(a.checks) === JSON.stringify(b.checks.slice(0, CI_CHECKS_MAX))

export function nextGitHubState(prev: RunGitHubState | undefined, patch: RunGitHubPatch, now: string): RunGitHubState | null {
  const base: RunGitHubState = prev ?? { log: [], seq: 0 }
  const next: RunGitHubState = { ...base }
  const entries: NewEntry[] = []
  if (patch.binding && !base.binding) {
    next.binding = patch.binding
    delete next.prCandidates
    entries.push({ kind: 'pr-bound', pr: patch.binding.number })
  }
  if (patch.prCandidates !== undefined && !next.binding) {
    if (patch.prCandidates === null || patch.prCandidates.length === 0) delete next.prCandidates
    else next.prCandidates = [...patch.prCandidates]
  }
  if (patch.read) {
    const r = patch.read
    if (base.headSha !== undefined && base.headSha !== r.headSha) entries.push({ kind: 'head-changed', sha: r.headSha })
    next.headSha = r.headSha
    next.pr = r.pr
    const prevCi = base.ci
    next.ci = sameCi(prevCi, r.ci) ? prevCi : { ...r.ci, checks: r.ci.checks.slice(0, CI_CHECKS_MAX), changedAt: now }
    // A verdict is news about the PR only for its head: a read can catch GitHub between a push and the PR's own move,
    // with the checks of the commit before (final review I1). That verdict is kept, never announced.
    const ofHead = r.ci.sha === r.headSha
    const moved = ofHead && (!prevCi || prevCi.sha !== r.ci.sha || prevCi.verdict !== r.ci.verdict)
    if (moved && r.ci.verdict === 'passed') entries.push({ kind: 'ci-passed', sha: r.ci.sha })
    if (moved && r.ci.verdict === 'failed')
      entries.push({
        kind: 'ci-failed',
        sha: r.ci.sha,
        ...(r.ci.failing ? { check: r.ci.failing } : {}),
        ...(r.ci.failure ? { class: r.ci.failure.class } : {})
      })
  }
  if (patch.lastReadError === null) delete next.lastReadError
  else if (patch.lastReadError)
    next.lastReadError = base.lastReadError?.kind === patch.lastReadError.kind ? base.lastReadError : { kind: patch.lastReadError.kind, since: now }
  if (patch.sourceChanged && !base.sourceChanged) {
    next.sourceChanged = { at: now }
    entries.push({ kind: 'source-changed' })
  }
  if (entries.length > 0) {
    let seq = base.seq
    next.log = [...base.log, ...entries.map((e) => ({ seq: ++seq, at: now, ...e }))].slice(-GITHUB_LOG_MAX)
    next.seq = seq
  }
  return JSON.stringify(next) === JSON.stringify(base) ? null : next
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

function bindingOk(b: unknown): b is GitHubBinding {
  return (
    isObj(b) &&
    isStr(b.repository) &&
    typeof b.number === 'number' &&
    isStr(b.url) &&
    isStr(b.baseBranch) &&
    isStr(b.headBranch) &&
    typeof b.createdByAstera === 'boolean' &&
    isStr(b.boundAt) &&
    (b.host === undefined || isStr(b.host))
  )
}

function failureOk(f: unknown): boolean {
  return isObj(f) && isStr(f.check) && isStr(f.externalId) && isStr(f.class) && isStr(f.summary) && Array.isArray(f.diagnostics)
}

function readOk(r: unknown): r is NonNullable<RunGitHubPatch['read']> {
  if (!isObj(r) || !isStr(r.headSha) || !isObj(r.pr) || !isObj(r.ci)) return false
  const pr = r.pr
  const ci = r.ci
  return (
    (pr.state === 'open' || pr.state === 'closed' || pr.state === 'merged') &&
    typeof pr.isDraft === 'boolean' &&
    isStr(pr.baseBranch) &&
    isStr(ci.sha) &&
    (ci.basis === 'required' || ci.basis === 'all-reported' || ci.basis === 'selected') &&
    (ci.verdict === 'pending' || ci.verdict === 'passed' || ci.verdict === 'failed' || ci.verdict === 'none') &&
    (ci.failing === undefined || isStr(ci.failing)) &&
    (ci.failingUrl === undefined || isStr(ci.failingUrl)) &&
    (ci.failure === undefined || failureOk(ci.failure)) &&
    Array.isArray(ci.checks) &&
    ci.checks.every((c) => isObj(c) && isStr(c.externalId) && isStr(c.name) && isStr(c.status) && typeof c.required === 'boolean')
  )
}

/** The patch `runs-github-record` takes, or why it is refused. Only the Host sends it (in-process), so this is a
 *  sanity check on its shape, not a defence. */
export function parseRunGitHubPatch(v: unknown): RunGitHubPatch | string {
  if (!isObj(v)) return 'patch must be an object'
  if (v.binding !== undefined && !bindingOk(v.binding)) return 'binding is malformed'
  if (v.read !== undefined && !readOk(v.read)) return 'read is malformed'
  if (v.prCandidates !== undefined && v.prCandidates !== null && !(Array.isArray(v.prCandidates) && v.prCandidates.every((n) => typeof n === 'number')))
    return 'prCandidates is malformed'
  if (v.lastReadError !== undefined && v.lastReadError !== null && !(isObj(v.lastReadError) && isStr(v.lastReadError.kind)))
    return 'lastReadError is malformed'
  if (v.sourceChanged !== undefined && v.sourceChanged !== true) return 'sourceChanged is malformed'
  return v as RunGitHubPatch
}
