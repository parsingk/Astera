// createReviewStarter(review.ts) — 앱(ipc.ts 의 bootOrch)과 Host 가 같은 것을 짓는 검토 시작.
// 순수 층으로 reviewing 상태를 세우고(구현 Dispatch 는 claude 에서 돌았다), 가짜는 ReviewContext 의
// 바깥 자리(계정·로그인·경로 가드·startWorker)뿐이다.
//
// Finding 1(resultPath 는 convergence Run 에서만)과 ruling F63(세워 둔 회차에는 검토자를 띄우지
// 않고, 검토 Dispatch 도 커밋하지 않는다)은 예전에는 ipcConvergenceWiring.test.ts 의 글자 가드였다 —
// 이제 여기서 동작으로 지킨다(R28).
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createReviewStarter, type ReviewContext } from './review'
import { applyWorkerDone, createJob, createTask, emptyState, openDispatch, startJobRun, type OrchState } from '../state'
import type { Account } from '../../types'

const NOW = '2026-09-24T00:00:00.000Z'
const unwrap = <T>(r: { ok: boolean } & Record<string, unknown>): { state: OrchState; value: T } => {
  if (!r.ok) throw new Error(`expected ok, got ${String(r.error)}`)
  return { state: r.state as OrchState, value: r.value as T }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const account = (id: string, provider: 'claude' | 'codex'): Account => ({
  id,
  label: id,
  configDir: `/cfg/${id}`,
  color: '#000',
  createdAt: NOW,
  provider
})
const claude = (id: string): Account => account(id, 'claude')
const codex = (id: string): Account => account(id, 'codex')

interface RigOpts {
  accounts: Account[]
  loggedIn: string[]
  convergence?: boolean
  /** 손으로 고친 orchestration.json 의 `"convergence": null` — 정책이 없는 Run 이다(policyOf 가 null). */
  convergenceNull?: boolean
  runPaused?: boolean
  startFails?: string
}

type StartArgs = Parameters<ReviewContext['startWorker']>[0]

function rig(o: RigOpts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astera-review-'))
  dirs.push(dir)
  const implCwd = path.join(dir, 'tree')
  const specsDir = path.join(dir, 'specs')
  fs.mkdirSync(implCwd)
  fs.mkdirSync(specsDir)

  // reviewing 에 닿은 Task — createJob → startJobRun → createTask → openDispatch(claude) → applyWorkerDone
  const planned = unwrap<{ id: string }>(
    createJob(emptyState(), { objective: 'o', cwd: implCwd, ...(o.convergence ? { convergence: {} } : {}) }, NOW) as never
  )
  const started0 = unwrap<{ id: string }>(startJobRun(planned.state, planned.value.id, NOW) as never)
  const t = unwrap<{ id: string }>(
    createTask(
      started0.state,
      { runId: started0.value.id, title: 'T', spec: 'do it', deps: [], reviewRequested: true },
      NOW
    ) as never
  )
  const d = unwrap<{ id: string }>(
    openDispatch(
      t.state,
      { taskId: t.value.id, provider: 'claude', accountId: 'c1', sessionId: 'sess1', cwd: implCwd, specPath: path.join(dir, 'spec.md') },
      NOW
    ) as never
  )
  let state = unwrap(
    applyWorkerDone(
      d.state,
      { taskId: t.value.id, dispatchId: d.value.id, outcome: 'succeeded', subject: 's', body: 'b' },
      NOW
    ) as never
  ).state
  const taskId = t.value.id
  if (state.tasks.find((x) => x.id === taskId)?.status !== 'reviewing') throw new Error('rig: not reviewing')
  // 사람이 세운 회차(runs stop) — runGatedForTask 가 읽는 칸이다.
  if (o.convergenceNull) state = { ...state, jobs: state.jobs.map((j) => ({ ...j, convergence: null as never })) }
  if (o.runPaused) state = { ...state, runs: state.runs.map((r) => ({ ...r, paused: true })) }

  const history: OrchState[] = []
  const logs: string[] = []
  let committed: boolean | undefined
  let specFileContent: string | undefined
  const startWorker = vi.fn(async (a: StartArgs) => {
    committed = state.dispatches.some((x) => x.id === a.dispatchId)
    specFileContent = a.specFileContent
    if (o.startFails !== undefined) throw new Error(o.startFails)
    return { sessionId: 's-review', cwd: a.runCwd, specPath: path.join(specsDir, 'x.md') }
  })

  const ctx: ReviewContext = {
    getState: () => state,
    setState: async (next) => {
      history.push(next)
      state = next
    },
    now: () => NOW,
    log: (m) => logs.push(m),
    accounts: () => o.accounts,
    loginStatus: async (id) => o.loggedIn.includes(id),
    assertAllowedPath: async (p) => p,
    startWorker,
    specsDir
  }

  return {
    start: createReviewStarter(ctx),
    taskId,
    implCwd,
    specsDir,
    logs,
    startWorker,
    committedBeforeSpawn: () => committed,
    specFile: () => specFileContent ?? '',
    history: () => history,
    state: () => state,
    task: () => state.tasks.find((x) => x.id === taskId)!
  }
}

describe('createReviewStarter', () => {
  it('starts the reviewer on the other provider, in the implementer’s tree, after committing its Dispatch', async () => {
    const h = rig({ accounts: [claude('c1'), codex('x1')], loggedIn: ['c1', 'x1'] })
    await h.start({ taskId: h.taskId })
    expect(h.startWorker).toHaveBeenCalledTimes(1)
    const a = h.startWorker.mock.calls[0][0]
    expect(a).toMatchObject({ provider: 'codex', accountId: 'x1', worktree: 'current', runCwd: h.implCwd })
    // Committed before the spawn: the Dispatch named in the call already existed.
    expect(h.committedBeforeSpawn()).toBe(true)
    expect(h.state().dispatches.find((d) => d.id === a.dispatchId)?.sessionId).toBe('s-review')
  })

  it('with no logged-in account on another provider it opens a Gate and starts nobody', async () => {
    const h = rig({ accounts: [claude('c1')], loggedIn: ['c1'] })
    await h.start({ taskId: h.taskId })
    expect(h.startWorker).not.toHaveBeenCalled()
    expect(h.task().status).toBe('blocked')
  })

  // Finding 1, as behaviour (R28).
  it('passes resultPath only when the Run converges', async () => {
    const plain = rig({ accounts: [claude('c1'), codex('x1')], loggedIn: ['c1', 'x1'] })
    await plain.start({ taskId: plain.taskId })
    expect(plain.specFile()).not.toMatch(/\.review\.json/)
    const conv = rig({ convergence: true, accounts: [claude('c1'), codex('x1')], loggedIn: ['c1', 'x1'] })
    await conv.start({ taskId: conv.taskId })
    // buildReviewSpecFile 은 경로를 `/` 로 적는다(coordinator.ts 의 verdictSection) — Windows 에서도
    // 같은 글자로 비교한다.
    expect(conv.specFile()).toContain(path.join(conv.specsDir, '').replace(/\\/g, '/'))
    expect(conv.specFile()).toMatch(/\.review\.json/)
    // 판별식은 policyOf 이지 raw 칸이 아니다 — `.convergence !== undefined` 는 손으로 고친 null 을
    // 정책 있음으로 잘못 읽는다(지워진 글자 가드가 지키던 셋째 절, review-task-7 I1).
    const nulled = rig({ convergenceNull: true, accounts: [claude('c1'), codex('x1')], loggedIn: ['c1', 'x1'] })
    await nulled.start({ taskId: nulled.taskId })
    expect(nulled.startWorker).toHaveBeenCalledTimes(1)
    expect(nulled.specFile()).not.toMatch(/\.review\.json/)
  })

  // F63, as behaviour (R28).
  it('a paused Run gets no reviewer, and no review Dispatch is ever committed; the review Gate blocks the Task (N10)', async () => {
    const h = rig({ runPaused: true, accounts: [claude('c1'), codex('x1')], loggedIn: ['c1', 'x1'] })
    await h.start({ taskId: h.taskId })
    expect(h.startWorker).not.toHaveBeenCalled()
    // Every state setState was handed, in order: none of them ever held a review Dispatch.
    expect(h.history().some((s) => s.dispatches.some((d) => d.review))).toBe(false)
    expect(h.task().status).toBe('blocked')
  })

  it('a reviewer that fails to start drops its Dispatch and gates the Task', async () => {
    const h = rig({ accounts: [claude('c1'), codex('x1')], loggedIn: ['c1', 'x1'], startFails: 'spawn refused' })
    await h.start({ taskId: h.taskId })
    expect(h.task().status).toBe('blocked')
    expect(h.state().dispatches.filter((d) => d.review && !d.endedAt)).toHaveLength(0)
  })
})
