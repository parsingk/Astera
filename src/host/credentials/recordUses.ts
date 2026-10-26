// Recording credential uses that pass through Astera (credentials design §6). The Host wraps its `gh` and `git` runners per
// caller: an agent's (or an outside caller's, or Astera's MCP server's) every GitHub call is recorded, anyone's GitHub
// writes are, the scheduled background reads are not. A record names the action and the repository, never the output or
// an error's text, which can quote a secret.
import { randomBytes } from 'node:crypto'
import type { GhRunner } from '../../core/github/gh'
import type { GitResult } from '../../core/worktrees/git'
import type { CredentialUse } from '../../core/audit/types'
import { appendCredentialUses, newUseId } from '../../core/credentials/uses'
import { classifyGh, repoOfOrigin } from '../../core/credentials/githubUse'
import type { OrchState } from '../../core/orchestration/state'

export type UseFields = Omit<CredentialUse, 'id' | 'at' | 'requestId'>

export interface UseRecorder {
  record(u: UseFields): void
}

/** Collects records and appends them in one write a turn later. Never throws. */
export function createUseRecorder(a: { profileDir: string; now?: () => number; log?: (m: string) => void }): UseRecorder & { flush(): Promise<void> } {
  const now = a.now ?? Date.now
  let pending: CredentialUse[] = []
  let writing: Promise<void> = Promise.resolve()
  let scheduled = false
  const flush = (): Promise<void> => {
    scheduled = false
    const batch = pending
    pending = []
    if (batch.length === 0) return writing
    writing = writing.then(() => appendCredentialUses(a.profileDir, batch, a.log ? { log: a.log } : {})).catch(() => {})
    return writing
  }
  return {
    record(u) {
      pending.push({ ...u, id: newUseId(), at: new Date(now()).toISOString(), requestId: `rq_${randomBytes(6).toString('hex')}` })
      if (!scheduled) {
        scheduled = true
        setImmediate(() => void flush())
      }
    },
    flush
  }
}

/** Who asked, as a record names them, with the work their session holds. */
export interface UseCaller {
  actor: CredentialUse['actor']
  sessionId?: string
  runId?: string
  jobId?: string
  taskId?: string
  agentProfileId?: string
}

const callerFields = (c: UseCaller): Pick<CredentialUse, 'actor' | 'sessionId' | 'runId' | 'jobId' | 'taskId' | 'agentProfileId'> => ({
  actor: c.actor,
  ...(c.sessionId !== undefined ? { sessionId: c.sessionId } : {}),
  ...(c.runId !== undefined ? { runId: c.runId } : {}),
  ...(c.jobId !== undefined ? { jobId: c.jobId } : {}),
  ...(c.taskId !== undefined ? { taskId: c.taskId } : {}),
  ...(c.agentProfileId !== undefined ? { agentProfileId: c.agentProfileId } : {})
})

/** Callers whose every call is recorded; the app's, the Host's and a controller's reads are not (design §6). */
const recordsReads = (c: UseCaller): boolean => c.actor === 'session' || c.actor === 'mcp' || c.actor === 'outside'

const repoOf = async (repoArg: string | undefined, cwd: string, originOf: (cwd: string) => Promise<string | null>): Promise<string> =>
  repoArg ?? repoOfOrigin(await originOf(cwd).catch(() => null)) ?? 'unknown repository'

/** `base` with each call recorded for `caller` (design §6). `background`: the call is one of the app's or the Host's
 *  scheduled reads, never recorded as a read. */
export function recordingGhRunner(
  base: GhRunner,
  caller: UseCaller,
  rec: UseRecorder,
  o: { background: boolean; originOf: (cwd: string) => Promise<string | null> }
): GhRunner {
  return async (args, cwd) => {
    const r = await base(args, cwd)
    const u = classifyGh(args)
    const write = u.action !== 'github.read'
    if (!write && (o.background || !recordsReads(caller))) return r
    const repo = await repoOf(u.repoArg, cwd, o.originOf)
    const suffix = u.number === undefined ? '' : u.number.startsWith('#') ? u.number : ` ${u.number}`
    rec.record({
      ...callerFields(caller),
      provider: 'github',
      action: u.action,
      resource: u.other !== undefined ? `${repo} (${u.other})` : `${repo}${suffix}`,
      outcome: r.ok ? 'ok' : 'failed',
      evidence: 'observed'
    })
    return r
  }
}

/** `base` with each push recorded for `caller` as a git login use (the push before a PR, design §6 and C5). */
export function recordingGitRunner(
  base: (args: string[], cwd: string) => Promise<GitResult>,
  caller: UseCaller,
  rec: UseRecorder,
  o: { originOf: (cwd: string) => Promise<string | null> }
): (args: string[], cwd: string) => Promise<GitResult> {
  return async (args, cwd) => {
    const r = await base(args, cwd)
    if (args[0] !== 'push') return r
    const plain = args.slice(1).filter((x) => !x.startsWith('-'))
    await recordPush(rec, caller, { cwd, branch: plain.length >= 2 ? plain[plain.length - 1] : undefined, ok: r.ok, originOf: o.originOf })
    return r
  }
}

/** One push with git's own login, recorded for `caller` (the lifecycle's push calls it directly). Never throws. */
export async function recordPush(
  rec: UseRecorder,
  caller: UseCaller,
  p: { cwd: string; branch?: string; ok: boolean; originOf: (cwd: string) => Promise<string | null> }
): Promise<void> {
  const repo = await repoOf(undefined, p.cwd, p.originOf)
  rec.record({
    ...callerFields(caller),
    provider: 'github',
    action: 'git.remote.write',
    resource: p.branch !== undefined ? `${repo} ${p.branch}` : repo,
    outcome: p.ok ? 'ok' : 'failed',
    evidence: 'observed'
  })
}

/** The work a session holds now: a worker's open Dispatch (its Task, Run and Job), else the Run it coordinates. */
export function workOfSession(s: OrchState, sessionId: string): Pick<UseCaller, 'runId' | 'jobId' | 'taskId'> {
  const open = s.dispatches.filter((d) => d.sessionId === sessionId && !d.endedAt).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
  if (open) {
    const runId = s.tasks.find((t) => t.id === open.taskId)?.runId
    const jobId = runId !== undefined ? s.runs.find((r) => r.id === runId)?.jobId : undefined
    return { taskId: open.taskId, ...(runId !== undefined ? { runId } : {}), ...(jobId !== undefined ? { jobId } : {}) }
  }
  const run = s.runs.filter((r) => r.coordinatorSessionId === sessionId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
  return run ? { runId: run.id, jobId: run.jobId } : {}
}
