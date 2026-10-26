// Recording what passes through Astera (credentials design §6): a GitHub runner wrapped per caller records an agent's
// every call and anyone's writes, never a background read, never message text; the push before a PR is a git login use.
import { describe, it, expect } from 'vitest'
import type { GhResult, GhRunner } from '../../core/github/gh'
import type { CredentialUse } from '../../core/audit/types'
import { emptyState, type OrchState } from '../../core/orchestration/state'
import { readPrState } from '../../core/github/prState'
import { listIssueItems } from '../../core/github/issueSource'
import { recordingGhRunner, recordingGitRunner, workOfSession, type UseRecorder } from './recordUses'

const ok = (stdout = ''): GhResult => ({ ok: true, stdout, stderr: '', exitCode: 0 })
const recorder = (): UseRecorder & { got: Omit<CredentialUse, 'id' | 'at' | 'requestId'>[] } => {
  const got: Omit<CredentialUse, 'id' | 'at' | 'requestId'>[] = []
  return { got, record: (u) => void got.push(u) }
}
const originOf = async (): Promise<string | null> => 'https://github.com/o/r.git'

describe('recordingGhRunner', () => {
  it('records every call of an agent session and every write of the app', async () => {
    const base: GhRunner = async () => ok()
    const rec = recorder()
    const agent = recordingGhRunner(base, { actor: 'session', sessionId: 's1', runId: 'run_1' }, rec, { background: false, originOf })
    await agent(['pr', 'view', '3'], 'D:/p')
    await agent(['pr', 'create', '--title', 't'], 'D:/p')
    const app = recordingGhRunner(base, { actor: 'app' }, rec, { background: false, originOf })
    await app(['pr', 'list'], 'D:/p')
    await app(['run', 'rerun', '9', '--failed'], 'D:/p')
    expect(rec.got).toEqual([
      { actor: 'session', sessionId: 's1', runId: 'run_1', provider: 'github', action: 'github.read', resource: 'o/r#3', outcome: 'ok', evidence: 'observed' },
      { actor: 'session', sessionId: 's1', runId: 'run_1', provider: 'github', action: 'github.pr.create', resource: 'o/r', outcome: 'ok', evidence: 'observed' },
      { actor: 'app', provider: 'github', action: 'github.ci.rerun', resource: 'o/r 9', outcome: 'ok', evidence: 'observed' }
    ])
  })

  it('leaves background reads out', async () => {
    const rec = recorder()
    const host = recordingGhRunner(async () => ok(), { actor: 'host' }, rec, { background: true, originOf })
    await host(['pr', 'checks', '3'], 'D:/p')
    await host(['run', 'rerun', '9', '--failed'], 'D:/p')
    expect(rec.got.map((u) => u.action)).toEqual(['github.ci.rerun'])
  })

  // Final review I1: the Host's own readers, with their exact arguments, leave nothing when they run in the background
  it('leaves the lifecycle watch\u2019s PR read and the issue search out of a background caller\u2019s records', async () => {
    const rec = recorder()
    const sent: string[][] = []
    const host = recordingGhRunner(
      async (args) => {
        sent.push(args)
        return ok(args.includes('graphql') ? '{"data":null}' : args.includes('--jq') ? 'o/r' : '{"items":[]}')
      },
      { actor: 'host' },
      rec,
      { background: true, originOf }
    )
    await readPrState(host, 'D:/p', { host: 'github.com', owner: 'o', name: 'r' }, 3)
    await listIssueItems(host, 'D:/p', { query: 'crash' })
    expect(sent.length).toBe(3)
    expect(rec.got).toEqual([])
    // And the app's own search is a read, which the app's caller does not record either
    const app = recordingGhRunner(async () => ok('{"items":[]}'), { actor: 'app' }, rec, { background: false, originOf })
    await listIssueItems(app, 'D:/q', { query: 'crash' })
    expect(rec.got).toEqual([])
  })

  it('records no message text', async () => {
    const secret = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const rec = recorder()
    const failing: GhRunner = async () => ({ ok: false, stdout: secret, stderr: `HTTP 401: Bad credentials (token ${secret})`, exitCode: 1 })
    const r = await recordingGhRunner(failing, { actor: 'session', sessionId: 's1' }, rec, { background: false, originOf })(['pr', 'create'], 'D:/p')
    expect(r.ok).toBe(false)
    expect(rec.got).toHaveLength(1)
    expect(rec.got[0].outcome).toBe('failed')
    expect(JSON.stringify(rec.got)).not.toContain('ghp_')
    expect(JSON.stringify(rec.got)).not.toContain('Bad credentials')
  })

  it('names the repository a -R names over the folder\'s origin', async () => {
    const rec = recorder()
    await recordingGhRunner(async () => ok(), { actor: 'session', sessionId: 's1' }, rec, { background: false, originOf })(['pr', 'create', '-R', 'x/y'], 'D:/p')
    expect(rec.got[0].resource).toBe('x/y')
  })
})

describe('recordingGitRunner', () => {
  it('records the push before a PR as git.remote.write with credential git login', async () => {
    const rec = recorder()
    const git = recordingGitRunner(async () => ({ ok: true, stdout: '', stderr: '' }), { actor: 'session', sessionId: 's1' }, rec, { originOf })
    await git(['push', '-u', 'origin', 'feat'], 'D:/p')
    await git(['status'], 'D:/p')
    expect(rec.got).toEqual([{ actor: 'session', sessionId: 's1', provider: 'github', action: 'git.remote.write', resource: 'o/r feat', outcome: 'ok', evidence: 'observed' }])
  })
})

describe('workOfSession', () => {
  it('finds a worker\'s Task, Run and Job, and a coordinator\'s Run and Job', () => {
    const s: OrchState = {
      ...emptyState(),
      runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: '2026-10-26T00:00:00.000Z', coordinatorSessionId: 'coord' }],
      tasks: [{ id: 'tsk_1', runId: 'run_1', title: 't', spec: 's', deps: [], status: 'running', createdAt: '2026-10-26T00:00:00.000Z' } as never],
      dispatches: [{ id: 'dsp_1', taskId: 'tsk_1', sessionId: 'w1', provider: 'claude', accountId: 'a', cwd: 'D:/p', specPath: '', startedAt: '2026-10-26T00:00:00.000Z' } as never]
    }
    expect(workOfSession(s, 'w1')).toEqual({ taskId: 'tsk_1', runId: 'run_1', jobId: 'job_1' })
    expect(workOfSession(s, 'coord')).toEqual({ runId: 'run_1', jobId: 'job_1' })
    expect(workOfSession(s, 'nobody')).toEqual({})
  })
})
