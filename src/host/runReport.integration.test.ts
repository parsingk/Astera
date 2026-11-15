// The Host posts a finished Run's report (run report spec §11, C2, C5): a real `createHostOrch` on a temp profile (the
// `orchOver` pattern of orch.test.ts) whose file holds a lifecycle Job, with a real `createRunReportPoster` over it, a
// recording fake gh and a fake Slack. Only gh and Slack are faked.
//
// **How the Run is finished.** The lifecycle Task is not completed and has not passed its checks, so `task-update
// --status completed` from the app is a forced completion: it needs a `reason`, and the commit that ends the Run stamps
// the app caller as `person`. It is the call the app's own button makes; `lifecycle.integration.test.ts` reaches a
// finished lifecycle Run by running the whole CI wait, which is not what is under test here. A second finish is a
// `task-update` back to `ready` and then completed again, so the Run ends twice on the same Task.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostOrch, type HostOrch } from './orch'
import { createRunReportPoster, type RunReportPoster } from './runReportPost'
import { emptyState, type OrchState } from '../core/orchestration/state'
import type { GhResult, GhRunner } from '../core/github/gh'
import type { GitHubBinding } from '../core/github/lifecycle'
import type { OrchCaller } from '../core/host/orchProtocol'

const T0 = '2026-11-15T09:00:00.000Z'
const NOW = '2026-11-15T10:00:00.000Z'
const LATER = '2026-11-15T11:00:00.000Z'
const COMMENT_URL = 'https://github.com/o/r/pull/7#issuecomment-123'
const BINDING: GitHubBinding = { repository: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', baseBranch: 'main', headBranch: 'run', createdByAstera: true, boundAt: T0 }
const POLICY = { ci: { mode: 'required' as const }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
const REASON = 'the checks cannot run here'
const APP: OrchCaller = { role: 'app', toOthers: () => {} }

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-runreport-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const seed = (o: { postRunReport: boolean; binding: boolean }): OrchState => ({
  ...emptyState(),
  jobs: [{ id: 'job_1', objective: 'Ship it', cwd: 'D:/p', createdAt: T0, convergence: {}, github: { ...POLICY, ...(o.postRunReport ? { postRunReport: true } : {}) } } as never],
  runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: T0, ...(o.binding ? { githubState: { binding: BINDING, log: [], seq: 0 } } : {}) } as never],
  tasks: [
    { id: 'tsk_a', runId: 'run_1', title: 'Do it', spec: 's', deps: [], status: 'completed', consecutiveFailures: 0, createdAt: T0, updatedAt: T0 },
    { id: 'tsk_l', runId: 'run_1', kind: 'lifecycle', title: 'GitHub', spec: 's', deps: ['tsk_a'], status: 'validating', validateConfigIds: ['github:ci'], reviewRequested: true, consecutiveFailures: 0, createdAt: T0, updatedAt: T0 }
  ] as never
})

const ok = (stdout: string): GhResult => ({ ok: true, stdout, stderr: '' })

async function rig(o: { postRunReport: boolean; binding: boolean; slackAnswer?: string }) {
  await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(seed(o), null, 2), 'utf8')
  let clock = NOW
  let poster: RunReportPoster | null = null
  const orch: HostOrch = createHostOrch({
    profileDir: dir,
    version: '9.9.9',
    now: () => clock,
    hostStartedAt: () => T0,
    runningSessions: () => 0,
    aliveSessionIds: () => new Set<string>(),
    act: async () => ({}),
    hasApp: () => true,
    onState: () => {},
    log: () => {},
    sessions: { listSessions: async () => [], readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }), sendSession: async () => {}, readChat: async () => [], sendChat: async () => {}, serial: (_id, run) => run() },
    runReports: { finished: (id) => poster?.finished(id) }
  })
  const ghCalls: string[][] = []
  const gh: GhRunner = async (args) => {
    ghCalls.push(args)
    if (args[0] === 'pr') return ok(COMMENT_URL)
    return ok('') // the lookup finds no comment; the PATCH answers nothing the poster reads
  }
  const slackTexts: string[] = []
  poster = createRunReportPoster({
    state: () => orch.state(),
    gh,
    accounts: async () => [],
    record: (args) => orch.handle('runs-github-record', args),
    slack: { postRunReport: async (text) => (slackTexts.push(text), o.slackAnswer ?? 'posted') },
    prefixes: [os.homedir(), dir],
    lang: () => 'en',
    log: () => {},
    retryAfterMs: 0
  })
  const update = async (args: Record<string, unknown>) => {
    const r = await orch.call({ cmd: 'task-update', args: { id: 'tsk_l', ...args }, sessionId: '', from: APP })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  }
  const finish = async (): Promise<void> => {
    await update({ status: 'completed', result: 'r', reason: REASON })
    await poster!.idle()
  }
  return { orch, poster: poster!, ghCalls, slackTexts, update, finish, setClock: (t: string) => (clock = t) }
}
const kind = (a: string[]): string => (a[0] === 'pr' ? 'post' : a.includes('PATCH') ? 'edit' : a.includes('--paginate') ? 'find' : 'other')

describe('the Host posts the run report', () => {
  it('comments once then edits the same comment, and posts to Slack at each finish', async () => {
    const r = await rig({ postRunReport: true, binding: true })
    await r.finish()
    const first = r.orch.state().runs[0].report
    expect(first?.outcome).toBe('completed')
    expect(first?.caveats).toContainEqual({ kind: 'forced', task: expect.any(String), lifecycle: true, by: 'person', reason: REASON })

    r.setClock(LATER)
    await r.update({ status: 'ready' })
    await r.finish()
    const second = r.orch.state().runs[0].report
    expect(second?.endedAt).not.toBe(first?.endedAt)
    expect(second?.caveats).toContainEqual({ kind: 'forced', task: expect.any(String), lifecycle: true, by: 'person', reason: REASON })

    expect(r.ghCalls.map(kind)).toEqual(['find', 'post', 'edit'])
    expect(r.ghCalls[2].join(' ')).toContain('comments/123')
    expect(r.orch.state().runs[0].githubState?.reportComment?.id).toBe(123)
    expect(r.slackTexts).toHaveLength(2)
    for (const text of r.slackTexts) expect(text).toContain(REASON)
  })

  it('nothing on the comment side when the switch is off, and Slack is asked once per finish', async () => {
    const r = await rig({ postRunReport: false, binding: true, slackAnswer: 'off' })
    await r.finish()
    expect(r.ghCalls).toEqual([])
    expect(r.slackTexts).toHaveLength(1)
    await r.update({ status: 'ready' })
    await r.finish()
    expect(r.ghCalls).toEqual([])
    expect(r.slackTexts).toHaveLength(2)
  })

  it('nothing on the comment side without a pull request, and Slack still posts', async () => {
    const r = await rig({ postRunReport: true, binding: false })
    await r.finish()
    expect(r.ghCalls).toEqual([])
    expect(r.slackTexts).toHaveLength(1)
  })
})
