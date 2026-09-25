import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createHostOrch,
  fingerprintOf,
  interpretationOf,
  OBSERVED,
  receiptsToEvict,
  RECEIPTS_PER_CALLER,
  RECEIPTS_TOTAL,
  RECEIPT_TTL_MS
} from './orch'
import { PENDING_START_WINDOW_MS } from '../core/orchestration/command'
import {
  applyWorkerDone,
  attachCoordinator,
  closeDispatch,
  createJob,
  createTask,
  emptyState,
  openDispatch,
  openReviewDispatch,
  setRunWorktree,
  startJobRun,
  type OrchState
} from '../core/orchestration/state'
import { outcomeOf } from '../core/orchestration/view'
import type { HostChecks } from './checks'
import { codeForStatus, exitCodeFor } from '../core/orchestration/cliOutput'
import type { OrchCaller } from '../core/host/orchProtocol'
import { createHostSpawner, type HostLocal, type HostSpawner, type HostSpawnerDeps } from './spawner'
import type { HostMessage } from '../core/host/protocol'
import { AppUnreachable, leftNothingBehind, refusedBeforeActing, wasRefusedBeforeActing } from '../core/host/orchProtocol'
import { RepairNeeded } from '../core/settings/repairNeeded'
import { PtyRegistry } from './registry'
import { ProcRegistry } from './procRegistry'
import { registrySessions } from './sessions'
import { encodeUserTurn } from '../core/chat/claudeProtocol'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../core/sessions/pty'
import { HostRetiring } from '../core/host/hostRetiring'
import { pendingReportFileName, pendingReportsDirIn, serializePendingReport } from '../core/orchestration/pendingReports'
import { createHostProjectRoots } from './projectRoots'
import { createHostExits } from './exits'
import { createHostRollTap } from './rollTapHost'
import { EXIT_DEFER_MS } from '../core/orchestration/exec/exitOwner'

const NOW = '2026-09-22T00:00:00.000Z'
/** 이 Host 가 선 시각. `now` 보다 **앞**이어야 하는 값이다 — `requests show` 가 이것을 실어 주는
 *  이유가 "네가 보낸 때보다 이 Host 가 늦게 섰다면 그 요청은 여기 온 적이 없다" 이므로(설계 §6),
 *  둘이 같은 문자열이면 그 비교가 시험에서 아무 말도 하지 않는다. */
const HOST_STARTED_AT = '2026-09-21T23:00:00.000Z'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hostorch-'))
  logs = []
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** A profile with one Job, one Run and one Task in it — written the way the app writes it, through
 *  the pure layer, so the fixture cannot drift from the shape the store reads. */
const seed = async (): Promise<{ jobId: string; taskId: string }> => {
  const job = createJob(emptyState(), { objective: '무언가', cwd: 'D:/p' }, NOW)
  if (!job.ok) throw new Error(job.error)
  const run = startJobRun(job.state, job.value.id, NOW)
  if (!run.ok) throw new Error(run.error)
  const task = createTask(run.state, { runId: run.value.id, title: '하나', spec: 's', deps: [] }, NOW)
  if (!task.ok) throw new Error(task.error)
  await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(task.state, null, 2), 'utf8')
  return { jobId: job.value.id, taskId: task.value.id }
}

let logs: string[] = []
const orchOver = (over: Partial<Parameters<typeof createHostOrch>[0]> = {}): ReturnType<typeof createHostOrch> =>
  createHostOrch({
    profileDir: dir,
    version: '9.9.9',
    now: () => NOW,
    hostStartedAt: () => HOST_STARTED_AT,
    runningSessions: () => 2,
    aliveSessionIds: () => new Set<string>(),
    act: async () => ({}),
    hasApp: () => true,
    onState: () => {},
    log: (m) => logs.push(m),
    sessions: { listSessions: async () => [], readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }), sendSession: async () => {}, readChat: async () => [], sendChat: async () => {}, serial: (_id, run) => run() },
    ...over
  })

describe('createHostOrch', () => {
  it('파일에 있던 Job 을 그대로 답한다', async () => {
    const { jobId } = await seed()
    const orch = orchOver()
    await orch.ready()
    const r = await orch.call({ cmd: 'jobs-list', args: {}, sessionId: '' })
    expect(r.status).toBe(200)
    expect((r.body as { id: string }[]).map((j) => j.id)).toEqual([jobId])
  })

  // 설계 §8: 상태가 실리기 전에 온 호출은 실패하는 대신 기다린다. ready() 를 부르지 않는 것이
  // 여기서 요점이다 — 실제 Host 도 부르지 않는다.
  it('ready() 전에 온 호출도 상태를 보고 답한다', async () => {
    const { jobId } = await seed()
    const r = await orchOver().call({ cmd: 'jobs-list', args: {}, sessionId: '' })
    expect((r.body as { id: string }[]).map((j) => j.id)).toEqual([jobId])
  })

  // ready() 는 한 번만 읽는다 — 부를 때마다 읽으면 명령 하나마다 파일을 다시 읽고, 그 사이 Host 가
  // 메모리에서 바꾼 것을 디스크의 옛 내용이 덮는다.
  it('파일은 한 번만 읽는다', async () => {
    await seed()
    const orch = orchOver()
    await orch.ready()
    // 파일을 통째로 비워도 이미 읽은 상태는 그대로여야 한다.
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(emptyState()), 'utf8')
    await orch.ready()
    const r = await orch.call({ cmd: 'jobs-list', args: {}, sessionId: '' })
    expect((r.body as unknown[]).length).toBe(1)
  })

  // 앱이 없으면 **그 명령이** 거절당해야 한다 — 409 는 "지금 상태로는 못 한다"이고, CLI 는 그것을
  // CONFLICT(6)로 떨어뜨린다(설계 §5). 400 으로 나가면 사람이 인자를 고치려 든다.
  it('앱이 없으면 worker-start 를 409 APP_REQUIRED 로 거절한다', async () => {
    const { taskId } = await seed()
    const orch = orchOver({ hasApp: () => false, act: vi.fn() })
    const r = await orch.call({
      cmd: 'worker-start',
      args: { task: taskId, agent: 'codex', account: 'acc1', worktree: 'current' },
      sessionId: ''
    })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.body)).toContain('APP_REQUIRED')
  })

  // 거절은 남기는 것이 없어야 한다 — worker-start 는 Dispatch 를 열고 시작에 실패하면 되돌린다.
  it('앱 없이 거절한 worker-start 는 Dispatch 를 남기지 않는다', async () => {
    const { taskId } = await seed()
    const orch = orchOver({ hasApp: () => false })
    await orch.call({
      cmd: 'worker-start',
      args: { task: taskId, agent: 'codex', account: 'acc1', worktree: 'current' },
      sessionId: ''
    })
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')) as OrchState
    expect(saved.dispatches).toEqual([])
  })

  it('모르는 명령은 501 이다 — 없는 id 의 404 와 가른다', async () => {
    const orch = orchOver()
    expect((await orch.call({ cmd: 'no-such-command', args: {}, sessionId: '' })).status).toBe(501)
  })

  /**
   * **409 는 앱이 없었다는 사실로 정한다 — 답의 문구로 정하지 않는다.**
   *
   * 이 층의 에러 본문 대부분은 부르는 쪽이 준 id 와 제목을 그대로 실어 나른다. 문구를 맞춰 보면
   * id 에 APP_REQUIRED 가 들어 있는 것만으로 404 가 409 가 되고, 스크립트는 NOT_FOUND(4) 여야 할
   * 자리에서 CONFLICT(6) 를 읽는다.
   */
  it('문구에 APP_REQUIRED 가 들어 있어도 404 는 404 다', async () => {
    const orch = orchOver({ hasApp: () => true })
    const r = await orch.call({ cmd: 'worker-show', args: { dispatch: 'APP_REQUIRED' }, sessionId: '' })
    expect(r.status).toBe(404)
    expect(JSON.stringify(r.body)).toContain('APP_REQUIRED')
  })

  /**
   * **삼켜진 거절은 상태 코드를 정하지 않는다**(F25).
   *
   * `send worker_done --outcome failed` 는 한도 탐침을 부르고, 그 실패는 명령 층이 일부러 삼킨다
   * (로그하고 계속 간다). 앱이 없으면 그 탐침은 거절당하지만 명령은 계속 가고, 이어서 제 이유로
   * 실패한다 — 여기서는 dispatch 와 taskId 가 안 맞는다. 그 400 이 409 로 바뀌면 스크립트는
   * NOT_FOUND 도 아니고 잘못된 인자도 아닌, "앱이 없다" 를 읽는다.
   */
  it('삼켜진 탐침 거절은 뒤따르는 400 을 409 로 바꾸지 않는다', async () => {
    const { taskId } = await seed()
    const state = JSON.parse(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')) as OrchState
    state.dispatches = [
      {
        id: 'dsp_1',
        taskId,
        provider: 'codex',
        accountId: 'acc1',
        sessionId: 'sess1',
        cwd: 'D:/p',
        specPath: 'D:/p/s.md',
        startedAt: NOW
      } as OrchState['dispatches'][number]
    ]
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(state), 'utf8')
    const orch = orchOver({ hasApp: () => false })
    const r = await orch.call({
      cmd: 'send',
      args: { type: 'worker_done', dispatchId: 'dsp_1', taskId: 'tsk_not_this_one', outcome: 'failed', subject: 's', body: 'b' },
      sessionId: ''
    })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toContain('does not match')
    // 탐침이 못 돈 사실은 조용히 지나가지 않는다.
    expect(logs.some((l) => l.includes('limit probe failed') && l.includes('APP_REQUIRED'))).toBe(true)
  })

  /**
   * **앱에 못 물어본 repair 대상은 거절이 아니라 `null` 이다**(F28).
   *
   * 거절하면 검토자의 판정이 **아무 데도 기록되지 않는다** — 워커는 보고했는데 남는 것이 없다.
   * `null` 은 이 의존이 이미 가진 말이고("repair 대상 없음"), 그때 순수 층이 무엇을 하는지도
   * 문서에 적혀 있다: repairFailed Gate. 사람이 보는 Gate 가 사라진 판정보다 낫다.
   */
  it('앱이 없어도 검토 판정은 기록되고 Gate 가 열린다 — 409 가 아니다', async () => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p', convergence: {} }, NOW)
    if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW)
    if (!run.ok) throw new Error(run.error)
    const task = createTask(
      run.state,
      { runId: run.value.id, title: 't', spec: 's', deps: [], accountIds: ['accA'], reviewRequested: true },
      NOW
    )
    if (!task.ok) throw new Error(task.error)
    const impl = openDispatch(
      task.state,
      { taskId: task.value.id, provider: 'claude', accountId: 'accA', sessionId: 'sess1', cwd: 'D:/p', specPath: 'D:/p/s.md' },
      NOW
    )
    if (!impl.ok) throw new Error(impl.error)
    const done = applyWorkerDone(
      impl.state,
      { taskId: task.value.id, dispatchId: impl.value.id, outcome: 'succeeded', subject: 's', body: 'b', canReview: true },
      NOW
    )
    if (!done.ok) throw new Error(done.error)
    // **이 검토 Dispatch 에는 spec 파일이 없다.** 그래서 review.json 을 읽으러 가지 않는다(그 분기의
    // 조건) — 없는 것을 repair 대상 하나로 좁혀, 이 테스트가 재는 것이 그것 하나가 되게 한다.
    const rev = openReviewDispatch(
      done.state,
      { taskId: task.value.id, provider: 'codex', accountId: 'accC', sessionId: 'rev1', cwd: 'D:/p', specPath: '' },
      NOW
    )
    if (!rev.ok) throw new Error(rev.error)
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(rev.state), 'utf8')

    // 검토 세션은 지금 보고하는 중이니 당연히 살아 있다 — Host 의 등록부가 그것을 말해 준다.
    // 이 말을 하지 않으면 load 의 재시작 청소가 먼저 이 Dispatch 를 outcome_unknown 으로 닫는다.
    const orch = orchOver({ hasApp: () => false, aliveSessionIds: () => new Set(['rev1']) })
    const r = await orch.call({
      cmd: 'send',
      args: {
        type: 'worker_done',
        taskId: task.value.id,
        dispatchId: rev.value.id,
        outcome: 'failed',
        subject: 'race',
        body: 'b'
      },
      sessionId: 'rev1'
    })
    expect(r.status).toBe(200)
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')) as OrchState
    // 판정이 기록됐다: 검토 Dispatch 가 닫혔고, Task 는 사람을 기다린다.
    expect(saved.dispatches.find((d) => d.id === rev.value.id)?.endedAt).toBe(NOW)
    expect(saved.tasks.find((t) => t.id === task.value.id)?.status).toBe('blocked')
    expect(saved.gates.at(-1)?.kind).toBe('convergence-blocked')
    expect(saved.gates.at(-1)?.question).toContain('no repair target')
    // 그 Gate 가 왜 열렸는지 추적할 수 있어야 한다.
    expect(logs.some((l) => l.includes('repairTargetFor') && l.includes('APP_REQUIRED'))).toBe(true)
  })

  /**
   * **이미 일어난 일을 실패로 보고하지 않는다**(F29).
   *
   * `gate-resolve --resolution retry-once` 는 Gate 해제를 **먼저 커밋한 뒤에** repairOnce 를 부른다.
   * 그것을 거절하면 응답은 409 인데 그 명령의 주된 효과는 이미 디스크에 남아 있다 — 스크립트는
   * "아무 일도 없었다" 로 읽는다. 이 의존은 실패를 값으로 말할 줄 알고(`{ok:false,error}`), 호출부는
   * 그것을 `retryOnceFailed` 로 200 본문에 실으려고 만들어져 있다.
   */
  it('앱이 없어도 Gate 는 풀리고, 못 한 재시도는 본문에 실린다 — 409 가 아니다', async () => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p', convergence: {} }, NOW)
    if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW)
    if (!run.ok) throw new Error(run.error)
    const task = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW)
    if (!task.ok) throw new Error(task.error)
    const state: OrchState = {
      ...task.state,
      tasks: task.state.tasks.map((t) => ({ ...t, status: 'blocked' as const })),
      gates: [
        {
          id: 'gat_1',
          runId: run.value.id,
          taskId: task.value.id,
          question: '한 번 더 해 볼까요?',
          kind: 'convergence-exhausted' as const,
          status: 'open' as const,
          createdAt: NOW
        }
      ]
    }
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(state), 'utf8')

    const orch = orchOver({ hasApp: () => false })
    const r = await orch.call({ cmd: 'gate-resolve', args: { id: 'gat_1', resolution: 'retry-once' }, sessionId: '' })
    expect(r.status).toBe(200)
    // 못 한 것은 본문이 말한다 — 조용히 성공으로 넘어가지 않는다.
    expect((r.body as { retryOnceFailed?: string }).retryOnceFailed).toMatch(/APP_REQUIRED/)
    // 그리고 실제로 일어난 일(Gate 해제)은 남아 있다.
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')) as OrchState
    expect(saved.gates[0].status).toBe('resolved')
    expect(logs.some((l) => l.includes('repairOnce') && l.includes('APP_REQUIRED'))).toBe(true)
  })

  // 앱이 없어 거절한 것은 남기지 않아야 할 흔적도 남기지 않고, 로그는 남긴다.
  it('앱이 없어 거절하면 그 사실이 로그에 남는다', async () => {
    const { taskId } = await seed()
    await orchOver({ hasApp: () => false }).call({
      cmd: 'worker-start',
      args: { task: taskId, agent: 'codex', account: 'acc1', worktree: 'current' },
      sessionId: ''
    })
    expect(logs.some((l) => l.includes('startWorker') && l.includes('APP_REQUIRED'))).toBe(true)
  })

  // Host 는 자기 버전과 자기 세션 수로 답한다 — 앱이 없어도 답해야 하는 두 가지다.
  it('status 는 앱이 없어도 Host 자신의 값으로 답한다', async () => {
    await seed()
    const r = await orchOver({ hasApp: () => false }).call({ cmd: 'status', args: {}, sessionId: '' })
    expect(r.body).toMatchObject({ version: '9.9.9', sessionsRunning: 2, jobs: 1 })
  })

  describe('state-put', () => {
    const appCaller = (): OrchCaller & { pushed: HostMessage[] } => {
      const pushed: HostMessage[] = []
      return { role: 'app', toOthers: (m) => pushed.push(m), pushed }
    }

    it('앱이 민 상태가 그대로 저장되고 나머지 클라이언트에게 간다', async () => {
      const from = appCaller()
      const orch = orchOver()
      const made = createJob(emptyState(), { objective: 'x', cwd: 'D:/p' }, NOW)
      const state = made.ok ? made.state : emptyState()
      const r = await orch.call({ cmd: 'state-put', args: { state }, sessionId: '', from })
      expect(r.status).toBe(200)
      const saved = JSON.parse(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')) as OrchState
      expect(saved.jobs).toHaveLength(1)
      // 버전이 함께 간다 — 앱이 다음 쓰기에 되돌려 인용하는 값이다(ruling F56).
      expect(from.pushed).toEqual([{ t: 'orch-state', state, version: 1 }])
    })

    // 민 쪽에게 되돌려 보내면 앱이 자기 상태를 자기 위에 다시 쓴다.
    it('민 클라이언트에게는 되돌려 보내지 않는다', async () => {
      const from = appCaller()
      await orchOver().call({ cmd: 'state-put', args: { state: emptyState() }, sessionId: '', from })
      expect(from.pushed).toHaveLength(1) // toOthers 로만 나갔다 — 그 자리로는 아무것도 안 간다
    })

    // **CLI 는 상태의 주인이 아니다.** 앱만이 자기 미러를 Host 에 밀 수 있다(F2).
    it('CLI 가 부르면 403 이다', async () => {
      const cli: OrchCaller = { role: 'cli', toOthers: () => {} }
      const r = await orchOver().call({ cmd: 'state-put', args: { state: emptyState() }, sessionId: '', from: cli })
      expect(r.status).toBe(403)
    })

    // === ruling F56 — 버전이 어긋난 쓰기는 거절한다 ===
    //
    // 통째로 쓰는 명령이라, 그 사이에 Host 가 커밋한 것이 있으면 그것을 지워 버린다. 지워질 가능성이
    // 가장 높은 것은 워커의 worker_done 이고, 그 워커는 이미 나갔다.
    it('Host 가 더 나아가 있으면 409 이고 파일은 그대로다', async () => {
      const from = appCaller()
      const orch = orchOver()
      // 먼저 한 번 커밋해 Host 를 버전 1 로 올린다.
      const made = createJob(emptyState(), { objective: 'first', cwd: 'D:/p' }, NOW)
      const first = made.ok ? made.state : emptyState()
      expect((await orch.call({ cmd: 'state-put', args: { state: first, version: 0 }, sessionId: '', from })).status).toBe(200)
      const saved = await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')

      // 앱이 아직 0 을 들고 있다고 하고 빈 상태를 민다 — 고치기 전이라면 first 를 덮었다.
      const r = await orch.call({ cmd: 'state-put', args: { state: emptyState(), version: 0 }, sessionId: '', from })
      expect(r.status).toBe(409)
      expect(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')).toBe(saved)
    })

    // 거절만 하고 끝내면 앱의 거울은 틀린 채로 남는다 — 다음 커밋이 우연히 고쳐 줄 때까지.
    it('409 는 Host 가 실제로 들고 있는 상태를 함께 낸다', async () => {
      const from = appCaller()
      const orch = orchOver()
      const made = createJob(emptyState(), { objective: 'first', cwd: 'D:/p' }, NOW)
      const first = made.ok ? made.state : emptyState()
      await orch.call({ cmd: 'state-put', args: { state: first, version: 0 }, sessionId: '', from })
      const r = await orch.call({ cmd: 'state-put', args: { state: emptyState(), version: 0 }, sessionId: '', from })
      const body = r.body as { state: OrchState; version: number }
      expect(body.state.jobs).toHaveLength(1)
      expect(body.version).toBe(1)
    })

    // 맞는 버전은 그대로 지나가고, 다음 버전을 돌려준다.
    it('버전이 맞으면 통과하고 새 버전을 알려 준다', async () => {
      const from = appCaller()
      const orch = orchOver()
      const r0 = await orch.call({ cmd: 'state-put', args: { state: emptyState(), version: 0 }, sessionId: '', from })
      expect((r0.body as { version: number }).version).toBe(1)
      const r1 = await orch.call({ cmd: 'state-put', args: { state: emptyState(), version: 1 }, sessionId: '', from })
      expect(r1.status).toBe(200)
    })

    // **버전을 안 실은 쓰기는 어긋난 것이 아니다** — 인용할 버전이 없다는 뜻이고, 그것까지 거절하면
    // 고치려는 결함 대신 새 결함이 생긴다(additive, 프로토콜은 3 그대로).
    it('버전을 싣지 않으면 검사하지 않는다', async () => {
      const from = appCaller()
      const orch = orchOver()
      await orch.call({ cmd: 'state-put', args: { state: emptyState(), version: 0 }, sessionId: '', from })
      const r = await orch.call({ cmd: 'state-put', args: { state: emptyState() }, sessionId: '', from })
      expect(r.status).toBe(200)
    })

    // === 겹쳐 들어온 두 쓰기 — 진짜 소켓 순서로, 가짜 call 없이 ===
    //
    // 앱의 거울은 상태와 함께 버전을 올리므로(mirrorStore), 겹치는 둘째 쓰기는 첫째의 **다음** 번호를
    // 인용하며 나간다. Host 가 번호를 저장이 끝난 뒤에 올리면 그 둘째는 아직 옛 번호를 보고 거절당한다
    // — 창이 앱에서 Host 로 옮겨졌을 뿐 잃는 쓰기는 그대로다.
    it('겹쳐 들어온 두 쓰기가 둘 다 앉는다', async () => {
      const from = appCaller()
      const orch = orchOver()
      const one = createJob(emptyState(), { objective: 'first', cwd: 'D:/p' }, NOW)
      const s1 = one.ok ? one.state : emptyState()
      const two = createJob(s1, { objective: 'second', cwd: 'D:/p' }, NOW)
      const s2 = two.ok ? two.state : emptyState()
      // 기다리지 않고 잇달아 보낸다 — server.ts 가 orch-call 을 `void` 로 띄우는 그 모양이다.
      const a = orch.call({ cmd: 'state-put', args: { state: s1, version: 0 }, sessionId: '', from })
      const b = orch.call({ cmd: 'state-put', args: { state: s2, version: 1 }, sessionId: '', from })
      const [ra, rb] = await Promise.all([a, b])
      expect(ra.status).toBe(200)
      expect(rb.status, '둘째는 첫째 위에 지어졌다 — 낡은 쓰기가 아니다').toBe(200)
      const saved = JSON.parse(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')) as OrchState
      expect(saved.jobs).toHaveLength(2)
    })

    // 그리고 정말 낡은 것은 겹쳐 들어와도 여전히 거절돼야 한다 — 검사와 올림이 한 걸음이 아니면
    // 이 둘 중 하나는 반드시 틀린다.
    it('같은 번호를 인용한 둘째는 겹쳐 들어와도 거절된다', async () => {
      const from = appCaller()
      const orch = orchOver()
      const one = createJob(emptyState(), { objective: 'first', cwd: 'D:/p' }, NOW)
      const s1 = one.ok ? one.state : emptyState()
      const a = orch.call({ cmd: 'state-put', args: { state: s1, version: 0 }, sessionId: '', from })
      // 첫째의 커밋을 모르는 쓰기 — 앉으면 first 가 사라진다.
      const b = orch.call({ cmd: 'state-put', args: { state: emptyState(), version: 0 }, sessionId: '', from })
      const [ra, rb] = await Promise.all([a, b])
      expect(ra.status).toBe(200)
      expect(rb.status).toBe(409)
      const saved = JSON.parse(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')) as OrchState
      expect(saved.jobs, '거절당한 쓰기가 첫째를 지웠다').toHaveLength(1)
    })

    // 소켓이 없는 호출자(테스트, 스텁)도 앱이 아니다 — 모르면 거절한다.
    it('누구인지 모르면 403 이다', async () => {
      const r = await orchOver().call({ cmd: 'state-put', args: { state: emptyState() }, sessionId: '' })
      expect(r.status).toBe(403)
    })

    it('상태가 아닌 것은 400 이다 — 파일에 아무것도 쓰지 않는다', async () => {
      await seed()
      const before = await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')
      const r = await orchOver().call({ cmd: 'state-put', args: { state: { nope: 1 } }, sessionId: '', from: appCaller() })
      expect(r.status).toBe(400)
      expect(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')).toBe(before)
    })

    /**
     * **쓰기가 실패해도 답은 나간다.**
     *
     * `server.ts` 는 이 약속에서 바로 `orch-result` 를 만들고 제 `.catch` 가 없다. 여기서 빠져나간
     * 거부는 500 이 아니라 **답 자체가 없는 것**이고, 앱은 붙자마자 보내는 state-put 의 답을 영영
     * 기다린다 — 게다가 아무도 안 받은 거부가 Host 를 통째로 내린다. store.save 는 mkdir·writeFile·
     * rename 을 아무 보호 없이 한다(store.ts).
     */
    it('저장이 실패해도 5xx 로 답한다 — 침묵하지 않는다', async () => {
      // 파일이 놓일 자리에 파일을 둔다: mkdir 이 거기서 실패한다.
      const blocked = path.join(dir, 'blocked')
      await fs.writeFile(blocked, 'not a directory', 'utf8')
      const orch = createHostOrch({
        profileDir: blocked,
        version: '9.9.9',
        now: () => NOW,
        hostStartedAt: () => HOST_STARTED_AT,
        runningSessions: () => 0,
        aliveSessionIds: () => new Set<string>(),
        act: async () => ({}),
        hasApp: () => true,
        onState: () => {},
        log: (m) => logs.push(m),
        sessions: { listSessions: async () => [], readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }), sendSession: async () => {}, readChat: async () => [], sendChat: async () => {}, serial: (_id, run) => run() }
      })
      const r = await orch.call({ cmd: 'state-put', args: { state: emptyState() }, sessionId: '', from: appCaller() })
      expect(r.status).toBeGreaterThanOrEqual(500)
      expect(JSON.stringify(r.body)).toMatch(/ENOTDIR|EEXIST|ENOENT/)
    })

    // 앱이 통째로 건네준 뒤에 파일을 읽으면, 그것은 방금 받은 것의 옛 사본이다 — 그리고 load 는
    // 재시작 정리를 돌리며 파일을 쓴다(F13).
    it('상태를 받은 뒤에는 파일을 읽지 않는다', async () => {
      await seed()
      const orch = orchOver()
      const state = emptyState()
      await orch.call({ cmd: 'state-put', args: { state }, sessionId: '', from: appCaller() })
      await orch.ready()
      const r = await orch.call({ cmd: 'jobs-list', args: {}, sessionId: '' })
      expect(r.body).toEqual([]) // 파일의 Job 이 아니라 앱이 민 빈 상태다
    })
  })

  describe('state-get', () => {
    /** 워커 하나가 돌던 중에 꺼진 프로필 — 열린 Dispatch 가 하나 남아 있다. */
    const seedOpenDispatch = async (): Promise<{ taskId: string; dispatchId: string }> => {
      const job = createJob(emptyState(), { objective: '무언가', cwd: 'D:/p' }, NOW)
      if (!job.ok) throw new Error(job.error)
      const run = startJobRun(job.state, job.value.id, NOW)
      if (!run.ok) throw new Error(run.error)
      const task = createTask(run.state, { runId: run.value.id, title: '하나', spec: 's', deps: [] }, NOW)
      if (!task.ok) throw new Error(task.error)
      const dsp = openDispatch(
        task.state,
        { taskId: task.value.id, provider: 'codex', accountId: 'accA', sessionId: 'ses1', cwd: 'D:/p', specPath: 'D:/p/s.md' },
        NOW
      )
      if (!dsp.ok) throw new Error(dsp.error)
      await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(dsp.state), 'utf8')
      return { taskId: task.value.id, dispatchId: dsp.value.id }
    }

    it('상태를 통째로 답한다', async () => {
      const { jobId } = await seed()
      const r = await orchOver().call({ cmd: 'state-get', args: {}, sessionId: '' })
      expect(r.status).toBe(200)
      expect((r.body as { state: OrchState }).state.runs[0].jobId).toBe(jobId)
    })

    // **Host 는 제 등록부를 안다.** 앱이 물어보고 답을 못 들을 수 있었던 'unknown' 은 여기서 뜻이
    // 없다 — 살아 있다고 말한 세션의 Dispatch 는 열린 채로 남는다.
    it('제 등록부가 살아 있다고 하는 세션의 Dispatch 는 닫지 않는다', async () => {
      const { dispatchId } = await seedOpenDispatch()
      const orch = orchOver({ aliveSessionIds: () => new Set(['ses1']) })
      const r = await orch.call({ cmd: 'state-get', args: {}, sessionId: '' })
      const state = (r.body as { state: OrchState }).state
      expect(state.dispatches.find((d) => d.id === dispatchId)?.endedAt).toBeUndefined()
    })

    it('등록부에 없는 세션의 Dispatch 는 닫는다', async () => {
      const { dispatchId } = await seedOpenDispatch()
      const orch = orchOver({ aliveSessionIds: () => new Set<string>() })
      const r = await orch.call({ cmd: 'state-get', args: {}, sessionId: '' })
      const state = (r.body as { state: OrchState }).state
      expect(state.dispatches.find((d) => d.id === dispatchId)?.workerState).toBe('outcome_unknown')
    })

    // 대기 중인 보고가 말하는 Dispatch 는 세션이 죽었어도 열린 채로 남는다 — 그것을 닫으면 그
    // 보고가 버려지고, 복구가 그 Task 에 두 번째 에이전트를 붙인다.
    it('아직 전하지 못한 보고가 말하는 Dispatch 는 닫지 않는다', async () => {
      const { taskId, dispatchId } = await seedOpenDispatch()
      const queue = path.join(dir, 'orch', 'pending-reports')
      await fs.mkdir(queue, { recursive: true })
      await fs.writeFile(
        path.join(queue, 'r1.json'),
        JSON.stringify({
          queuedAt: NOW,
          sessionId: 'ses1',
          cmd: 'send',
          args: { type: 'worker_done', taskId, dispatchId, outcome: 'succeeded', subject: 's', body: 'b' }
        }),
        'utf8'
      )
      const orch = orchOver({ aliveSessionIds: () => new Set<string>() })
      const r = await orch.call({ cmd: 'state-get', args: {}, sessionId: '' })
      const state = (r.body as { state: OrchState }).state
      expect(state.dispatches.find((d) => d.id === dispatchId)?.endedAt).toBeUndefined()
    })

    // 청소가 무엇을 했는지는 앱이 마저 해야 하는 일이다(저널, 끊긴 검증 재시작). 한 번만 준다 —
    // 몇 시간째 떠 있던 Host 에 앱이 다시 붙었을 때 오래전의 청소를 또 실행하면 안 된다.
    it('load 가 찾은 것은 boot 를 물은 첫 번째에게만 간다', async () => {
      await seedOpenDispatch()
      const orch = orchOver({ aliveSessionIds: () => new Set<string>() })
      const from: OrchCaller = { role: 'app', toOthers: () => {} }
      const first = await orch.call({ cmd: 'state-get', args: { boot: true }, sessionId: '', from })
      expect((first.body as { boot: { unknownOutcomes: number } | null }).boot?.unknownOutcomes).toBe(1)
      const second = await orch.call({ cmd: 'state-get', args: { boot: true }, sessionId: '', from })
      expect((second.body as { boot: unknown }).boot).toBeNull()
    })

    // **`boot: true` 는 읽기가 아니다** — 가져가면 없어진다. CLI 가 (실수로든 아니든) 그것을
    // 집어 가면 앱은 boot 없이 뜨고, 재시작이 끊어 놓은 검증은 아무도 다시 시작하지 않는다.
    it('CLI 는 boot 를 물어도 받지 못하고, 앱 몫을 축내지도 않는다', async () => {
      await seedOpenDispatch()
      const orch = orchOver({ aliveSessionIds: () => new Set<string>() })
      const cli = await orch.call({
        cmd: 'state-get',
        args: { boot: true },
        sessionId: '',
        from: { role: 'cli', toOthers: () => {} }
      })
      expect(cli.status).toBe(200)
      // 상태는 준다 — 그쪽은 진짜 읽기다.
      expect((cli.body as { state: OrchState }).state.dispatches).toHaveLength(1)
      expect((cli.body as { boot: unknown }).boot).toBeNull()
      // 그리고 앱 몫은 그대로 남아 있다.
      const app = await orch.call({
        cmd: 'state-get',
        args: { boot: true },
        sessionId: '',
        from: { role: 'app', toOthers: () => {} }
      })
      expect((app.body as { boot: { unknownOutcomes: number } | null }).boot?.unknownOutcomes).toBe(1)
    })

    it('boot 를 묻지 않은 호출은 그것을 가져가지 않는다', async () => {
      await seedOpenDispatch()
      const orch = orchOver({ aliveSessionIds: () => new Set<string>() })
      const from: OrchCaller = { role: 'app', toOthers: () => {} }
      const plain = await orch.call({ cmd: 'state-get', args: {}, sessionId: '', from })
      expect((plain.body as { boot: unknown }).boot).toBeNull()
      const booting = await orch.call({ cmd: 'state-get', args: { boot: true }, sessionId: '', from })
      expect((booting.body as { boot: { unknownOutcomes: number } | null }).boot?.unknownOutcomes).toBe(1)
    })
  })
})

// === 요청 영수증 (docs/2026-09-23-request-receipts-design.md) ===
//
// **이 묶음이 세는 것은 답이 아니라 효과다.** 바이트가 같은 답을 돌려주면서 의존을 두 번 부른 재시도가
// 이 설계가 막으려는 실패 그 자체이므로, 답만 보는 시험은 없는 것보다 나쁘다 — 앱으로 나간 행동의
// 횟수와 상태에 남은 것을 함께 센다.
describe('요청 영수증', () => {
  /** 앱으로 나가는 행동을 이름별로 세는 대역. 어느 의존이 몇 번 불렸는지가 이 묶음의 판정 기준이다. */
  const counting = (
    over: Record<string, (args: unknown[], nth: number) => unknown> = {}
  ): { act: (name: string, args: unknown[]) => Promise<unknown>; calls: string[] } => {
    const calls: string[] = []
    return {
      calls,
      act: async (name, args) => {
        calls.push(name)
        const nth = calls.filter((c) => c === name).length
        if (over[name]) return over[name](args, nth)
        if (name === 'startWorker')
          return { sessionId: `ses${nth}`, cwd: 'D:/wt', specPath: 'D:/wt/s.md' }
        // run-create 가 지나가며 부른다 — 준 경로를 그대로 돌려준다(앱의 정규화가 하는 일).
        if (name === 'resolveProjectRoot') return args[0]
        return {}
      }
    }
  }
  const countOf = (calls: string[], name: string): number => calls.filter((c) => c === name).length

  /**
   * **답 자체** — 재생 표시를 뺀 `{status, body}`.
   *
   * 바이트 단위로 같아야 하는 것은 이쪽이다. `replayed` 는 일부러 다르다: 재생의 요점이 "첫 답을
   * 받은 것과 구별되지 않는다" 이지만, 그것이 재생이었다는 사실 하나는 **본문 밖에서** 말해야
   * 한다(설계 §8). `data` 의 모양은 그 명령이 공표한 계약이고 거기에 칸을 더하면 `run-create` 가
   * 돌려주는 것이 바뀐다.
   */
  const answerOf = (r: { status: number; body: unknown }): string =>
    JSON.stringify({ status: r.status, body: r.body })

  const workerArgs = (taskId: string): Record<string, unknown> => ({
    task: taskId,
    agent: 'codex',
    account: 'acc1',
    worktree: 'current'
  })

  /** 파일에 있는 상태를 손으로 고쳐 다시 쓴다 — 아직 load 하지 않은 Host 만 이것을 본다. */
  const patchFile = async (f: (s: OrchState) => OrchState): Promise<void> => {
    const file = path.join(dir, 'orchestration.json')
    const next = f(JSON.parse(await fs.readFile(file, 'utf8')) as OrchState)
    await fs.writeFile(file, JSON.stringify(next), 'utf8')
  }
  const savedState = async (): Promise<OrchState> =>
    JSON.parse(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')) as OrchState

  // === 1단계 — 무엇이 영수증을 남기는가 ===

  /**
   * **설계 §3 의 논거 전체가 이 한 줄이다.** `run-merge` 는 git 병합을 돌리고 `setState` 는 한 번도
   * 부르지 않는다 — 명령 이름으로 목록을 짰다면 놓쳤을 자리이고, 상태에는 두 번째 병합을 막을 것이
   * 아무것도 없으므로 여기서 세는 횟수가 진짜 판정이다.
   */
  it('커밋하지 않고 움직인 run-merge 도 영수증을 남긴다', async () => {
    await seed()
    await patchFile((s) => ({ ...s, runs: s.runs.map((r) => ({ ...r, worktree: 'D:/wt-run' })) }))
    const c = counting({ mergeWorktrees: () => ({ ok: true, merged: ['D:/wt-run'], uncommitted: 0 }) })
    const orch = orchOver({ act: c.act })
    const args = { run: (await savedState()).runs[0].id }
    const first = await orch.call({ cmd: 'run-merge', args, sessionId: 'sesA', request: 'req-1' })
    const second = await orch.call({ cmd: 'run-merge', args, sessionId: 'sesA', request: 'req-1' })
    expect(first.status).toBe(200)
    expect(countOf(c.calls, 'mergeWorktrees'), '재시도가 병합을 한 번 더 돌렸다').toBe(1)
    expect(answerOf(second)).toBe(answerOf(first))
    expect(second.replayed, '재생인데 그렇게 말하지 않았다').toBe(true)
  })

  // 읽기는 아무것도 바꾸지 않으므로 남길 것이 없다 — 남기면 그 뒤의 읽기가 모두 낡은 답을 받는다
  // (설계 §6 의 네 번째 원인).
  it('읽기는 영수증을 남기지 않는다 — 두 번째도 지금을 읽는다', async () => {
    await seed()
    const c = counting({ readWorker: (_a, nth) => `출력 ${nth}` })
    const orch = orchOver({ act: c.act })
    const args = { dispatch: 'dsp_1' }
    const first = await orch.call({ cmd: 'worker-read', args, sessionId: 'sesA', request: 'req-1' })
    const second = await orch.call({ cmd: 'worker-read', args, sessionId: 'sesA', request: 'req-1' })
    expect(countOf(c.calls, 'readWorker')).toBe(2)
    expect((first.body as { output: string }).output).toBe('출력 1')
    expect((second.body as { output: string }).output).toBe('출력 2')
  })

  /**
   * **행동하기 전에 거절된 호출은 아무것도 남기지 않는다.** 거절은 결정적이라 되풀이해도 안전하고,
   * 무엇보다 그 뒤에 세상이 바뀌면 같은 요청이 이번에는 되어야 한다 — 영수증을 남기면 그 재시도가
   * 영영 옛 거절을 되받는다.
   */
  it('행동하기 전에 거절된 호출은 영수증을 남기지 않는다', async () => {
    const { taskId } = await seed()
    await patchFile((s) => ({ ...s, tasks: s.tasks.map((t) => ({ ...t, status: 'blocked' as const })) }))
    const c = counting()
    const orch = orchOver({ act: c.act })
    const args = workerArgs(taskId)
    const refused = await orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-1' })
    expect(refused.status).toBe(400)
    expect(countOf(c.calls, 'startWorker')).toBe(0)
    // Gate 가 풀려 Task 가 다시 일할 수 있게 됐다 — 앱이 상태를 통째로 밀어 넣는 그 길로 재현한다.
    const now = await savedState()
    await orch.call({
      cmd: 'state-put',
      args: { state: { ...now, tasks: now.tasks.map((t) => ({ ...t, status: 'ready' as const })) } },
      sessionId: '',
      from: { role: 'app', toOthers: () => {} }
    })
    const retried = await orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-1' })
    expect(retried.status, '거절이 영수증으로 남아 재시도를 막았다').toBe(200)
    expect(countOf(c.calls, 'startWorker')).toBe(1)
  })

  // === 2단계 — 재생 ===

  /**
   * **설계의 인수 시험이다**(§13 단계 2). 같은 요청 id 로 두 번 부른 worker-start 는 워커를 한 번만
   * 띄우고, 두 번째 답은 첫 번째와 바이트 단위로 같고, 상태에는 Dispatch 가 하나만 남는다.
   *
   * 오늘 이 자리를 지키는 것은 상태 자신이다 — 열린 Dispatch 가 있으면 worker-start 가 400 으로
   * 거절한다. 그래서 재생이 없을 때 여기서 빨간 것은 **답**이고("dispatch already open"), 의존
   * 횟수가 판정하는 자리는 위의 run-merge 와 아래 run-create 다. 셋을 함께 두는 이유가 그것이다.
   */
  it('같은 요청 id 의 worker-start 는 워커를 한 번만 띄운다', async () => {
    const { taskId } = await seed()
    const c = counting()
    const orch = orchOver({ act: c.act })
    const args = workerArgs(taskId)
    const first = await orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-1' })
    const second = await orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-1' })
    expect(first.status).toBe(200)
    expect(countOf(c.calls, 'startWorker'), '재시도가 워커를 한 번 더 띄웠다').toBe(1)
    expect(answerOf(second)).toBe(answerOf(first))
    expect(second.replayed, '재생인데 그렇게 말하지 않았다').toBe(true)
    expect((await savedState()).dispatches).toHaveLength(1)
  })

  // id 를 만드는 명령(§3 의 첫 번째 갈래). 두 번 커밋되면 계획도 회차도 둘이고, 그것이 여기서 세는
  // 효과다 — 설계가 적은 문장이 "회차 하나, 두 번 다 같은 회차 id" 이므로 둘 다 센다.
  it('같은 요청 id 의 run-create 는 계획과 회차를 하나씩만 만든다', async () => {
    const c = counting()
    const orch = orchOver({ act: c.act })
    const args = { objective: '무언가', cwd: 'D:/p' }
    const first = await orch.call({ cmd: 'run-create', args, sessionId: 'sesA', request: 'req-1' })
    const second = await orch.call({ cmd: 'run-create', args, sessionId: 'sesA', request: 'req-1' })
    const saved = await savedState()
    expect(saved.jobs, '재시도가 계획을 하나 더 만들었다').toHaveLength(1)
    expect(saved.runs, '재시도가 회차를 하나 더 만들었다').toHaveLength(1)
    expect(answerOf(second)).toBe(answerOf(first))
    expect(second.replayed, '재생인데 그렇게 말하지 않았다').toBe(true)
    expect((second.body as { id: string }).id).toBe((first.body as { id: string }).id)
  })

  // phase C 의 두 쓰기. 셸이 부르는 모양이다(세션 id 가 비어 있다) — CI 가 `--request-id` 를 다는
  // 자리가 바로 이것이다.
  it('같은 요청 id 의 jobs create 와 tasks add 는 한 번씩만 만든다', async () => {
    const c = counting({ listAccounts: () => [{ id: 'acc1', label: 'a', provider: 'codex' }] })
    const orch = orchOver({ act: c.act })
    const jobArgs = { objective: '무언가', cwd: 'D:/p' }
    const first = await orch.call({ cmd: 'jobs-create', args: jobArgs, sessionId: '', request: 'req-j' })
    const second = await orch.call({ cmd: 'jobs-create', args: jobArgs, sessionId: '', request: 'req-j' })
    expect(first.status).toBe(200)
    expect(second.replayed, '재생인데 그렇게 말하지 않았다').toBe(true)
    expect(answerOf(second)).toBe(answerOf(first))
    const jobId = (first.body as { id: string }).id
    const taskArgs = { job: jobId, spec: 's', account: 'acc1' }
    const t1 = await orch.call({ cmd: 'tasks-add', args: taskArgs, sessionId: '', request: 'req-t' })
    const t2 = await orch.call({ cmd: 'tasks-add', args: taskArgs, sessionId: '', request: 'req-t' })
    expect(t1.status).toBe(200)
    expect(t2.replayed).toBe(true)
    const saved = await savedState()
    expect(saved.jobs, '재시도가 계획을 하나 더 만들었다').toHaveLength(1)
    expect(saved.runs).toHaveLength(0)
    expect(saved.tasks, '재시도가 Task 를 하나 더 만들었다').toHaveLength(1)
  })

  // **세션에 치는 것은 커밋이 아니다** — 상태 파일은 그대로이고, 영수증이 남는 까닭은 orchDeps 의
  // onEffect 하나다. 그것이 빠지면 재시도가 글자를 한 번 더 친다: 셸에 `rm` 을 두 번, 에이전트에
  // 같은 지시를 두 번. 앱이 붙어 있지 않은 모양으로 부른다 — pty 를 쥔 것은 Host 이기 때문이다.
  it('같은 요청 id 의 sessions send 는 한 번만 친다', async () => {
    // 진짜 레지스트리 위에서 — 가짜 pty 가 받은 글자를 센다.
    const written: string[] = []
    const ptys = new PtyRegistry({
      spawn: () => ({
        pid: 1,
        onData: () => {},
        onExit: () => {},
        write: (d: string) => {
          written.push(d)
        },
        resize: () => {},
        kill: () => {},
        pause: () => {},
        resume: () => {}
      }),
      log: () => {}
    })
    ptys.open({
      id: 'pty-1',
      file: 'cmd.exe',
      args: [],
      opts: { cwd: 'D:/p', cols: 80, rows: 24, env: {} },
      meta: { kind: 'session', id: 'ses-1', restore: { cwd: 'D:/p' } }
    })
    const procs = new ProcRegistry({
      spawn: () => {
        throw new Error('no line processes here')
      },
      log: () => {}
    })
    const orch = orchOver({ hasApp: () => false, sessions: registrySessions({ ptys, procs, hookEventsDir: path.join(os.tmpdir(), 'astera-orch-test-no-hook-events'), accounts: async () => [] }) })
    const args = { id: 'ses-1', text: 'echo hi' }
    const first = await orch.call({ cmd: 'sessions-send', args, sessionId: '', request: 'req-s' })
    const second = await orch.call({ cmd: 'sessions-send', args, sessionId: '', request: 'req-s' })
    expect(first.status).toBe(200)
    expect(second.replayed, '재생인데 그렇게 말하지 않았다').toBe(true)
    expect(answerOf(second)).toBe(answerOf(first))
    expect(written, '재시도가 한 번 더 쳤다').toEqual(['echo hi', '\r'])
    // 읽기는 영수증을 남기지 않는다 — 같은 id 로 다시 읽으면 지금의 화면을 받는다.
    await orch.call({ cmd: 'sessions-read', args: { id: 'ses-1' }, sessionId: '', request: 'req-r' })
    const shown = await orch.call({ cmd: 'requests-show', args: { id: 'req-r' }, sessionId: '' })
    expect(shown.body).toMatchObject({ state: 'absent' })
  })

  /**
   * **대화 세션에 치는 것도 한 번만이다 — 두 길 모두**(CLI phase D4). 앱이 없으면 Host 가 줄 프로세스에
   * 어댑터의 바이트를 쓰고, 앱이 있으면 앱에 넘긴다. 어느 쪽이든 같은 요청 id 의 재시도는 첫 답을
   * 재생하고 다시 치지 않는다. 진짜 레지스트리 위에서 — 가짜 줄 프로세스가 받은 줄을 센다.
   */
  describe('대화 세션의 sessions send', () => {
    const chatRegistries = (restore: Record<string, unknown> = { provider: 'claude', threadId: 'th' }) => {
      const written: string[] = []
      const ptys = new PtyRegistry({ spawn: () => { throw new Error('no ptys here') }, log: () => {} })
      const procs = new ProcRegistry({
        spawn: () => ({
          pid: 5,
          onData: () => {},
          onExit: () => {},
          write: (d: string) => {
            written.push(d)
          },
          kill: () => {}
        }),
        log: () => {}
      })
      procs.open({
        id: 'proc-1',
        file: 'claude',
        args: [],
        opts: { cwd: 'D:/p', env: {} },
        meta: { kind: 'chat', id: 'chat-1', restore: { accountId: 'acc', cwd: 'D:/p', ...restore } }
      })
      const sessions = registrySessions({
        ptys,
        procs,
        hookEventsDir: path.join(os.tmpdir(), 'astera-orch-test-no-hook-events'),
        accounts: async () => []
      })
      return { written, sessions, procs }
    }
    const args = { id: 'chat-1', text: '다음으로' }

    it('앱이 없을 때 같은 요청 id 의 재시도는 한 번만 쓴다', async () => {
      const { written, sessions } = chatRegistries()
      const orch = orchOver({ hasApp: () => false, sessions })
      const first = await orch.call({ cmd: 'sessions-send', args, sessionId: '', request: 'req-c1' })
      const second = await orch.call({ cmd: 'sessions-send', args, sessionId: '', request: 'req-c1' })
      expect(first).toMatchObject({ status: 200, body: { id: 'chat-1', sent: true } })
      expect(second.replayed).toBe(true)
      expect(answerOf(second)).toBe(answerOf(first))
      expect(written, '재시도가 한 번 더 썼다').toEqual([encodeUserTurn('다음으로') + '\n'])
    })

    it('앱이 있을 때 같은 요청 id 의 재시도는 앱에 한 번만 넘기고, Host 는 쓰지 않는다', async () => {
      const { written, sessions } = chatRegistries()
      const acts: Array<[string, unknown[]]> = []
      const orch = orchOver({
        sessions,
        act: async (name, a) => {
          acts.push([name, a])
          return name === 'chatPending' ? null : { sent: true }
        }
      })
      const first = await orch.call({ cmd: 'sessions-send', args, sessionId: '', request: 'req-c2' })
      const second = await orch.call({ cmd: 'sessions-send', args, sessionId: '', request: 'req-c2' })
      expect(first.status).toBe(200)
      expect(second.replayed).toBe(true)
      expect(acts.filter(([n]) => n === 'chatSend')).toEqual([['chatSend', ['chat-1', '다음으로']]])
      expect(written).toEqual([])
    })

    // M6: 첫 호출은 앱이 보냈고, 앱이 닫힌 뒤 같은 id 로 다시 왔다. 영수증은 Host 의 것이라 재생되고,
    // Host 는 아무것도 쓰지 않는다 — 앱이 이미 보낸 턴을 한 번 더 보내지 않는다.
    it('앱이 보낸 뒤 앱이 닫혀도 같은 요청 id 의 재시도는 재생이고 Host 는 쓰지 않는다', async () => {
      const { written, sessions } = chatRegistries()
      let app = true
      const acts: string[] = []
      const orch = orchOver({
        sessions,
        hasApp: () => app,
        act: async (name) => {
          acts.push(name)
          return name === 'chatPending' ? null : { sent: true }
        }
      })
      const first = await orch.call({ cmd: 'sessions-send', args, sessionId: '', request: 'req-c6' })
      app = false
      const second = await orch.call({ cmd: 'sessions-send', args, sessionId: '', request: 'req-c6' })
      expect(first.status).toBe(200)
      expect(second.replayed).toBe(true)
      expect(answerOf(second)).toBe(answerOf(first))
      expect(acts.filter((n) => n === 'chatSend')).toHaveLength(1)
      expect(written, '앱이 이미 보낸 턴을 Host 가 또 썼다').toEqual([])
    })

    // I1: 카드 때문에 돌아선 호출은 영수증을 남기지 않는다. 카드에 답한 뒤 같은 id 로 다시 치면 한 번 간다.
    it('카드로 거절된 요청 id 는 카드가 닫힌 뒤 다시 쳐서 한 번 간다', async () => {
      const { written, sessions } = chatRegistries()
      let card: unknown = { kind: 'approval', summary: 'Bash: npm test' }
      const sent: unknown[] = []
      const orch = orchOver({
        sessions,
        act: async (name, a) => {
          if (name === 'chatPending') return card
          sent.push(a)
          return { sent: true }
        }
      })
      const refused = await orch.call({ cmd: 'sessions-send', args, sessionId: '', request: 'req-c7' })
      expect(refused.status).toBe(409)
      expect(JSON.stringify(refused.body)).toMatch(/waiting on an approval: Bash: npm test/)
      card = null // 사람이 앱에서 답했다
      const retried = await orch.call({ cmd: 'sessions-send', args, sessionId: '', request: 'req-c7' })
      expect(retried.status).toBe(200)
      expect(retried.replayed, '거절이 영수증으로 남아 재생됐다').toBeFalsy()
      const again = await orch.call({ cmd: 'sessions-send', args, sessionId: '', request: 'req-c7' })
      expect(again.replayed).toBe(true)
      expect(sent).toEqual([['chat-1', '다음으로']])
      expect(written).toEqual([])
    })

    // I1: 스레드가 없어 Host 가 쓰지 못한 호출도 영수증을 남기지 않는다. 스레드가 생긴 뒤 같은 id 로 한 번 쓴다.
    it('Codex 스레드가 없어 거절된 요청 id 는 스레드가 생긴 뒤 다시 쳐서 한 번 쓴다', async () => {
      const { written, sessions, procs } = chatRegistries({ provider: 'codex' })
      const orch = orchOver({ sessions, hasApp: () => false })
      const refused = await orch.call({ cmd: 'sessions-send', args, sessionId: '', request: 'req-c8' })
      expect(refused.status).toBe(409)
      expect(JSON.stringify(refused.body)).toMatch(/no Codex thread yet/)
      procs.note('proc-1', { threadId: 'thr-1' }) // 앱이 스레드를 열고 note 에 적었다
      const retried = await orch.call({ cmd: 'sessions-send', args, sessionId: '', request: 'req-c8' })
      expect(retried.status).toBe(200)
      expect(retried.replayed).toBeFalsy()
      await orch.call({ cmd: 'sessions-send', args, sessionId: '', request: 'req-c8' })
      expect(written).toHaveLength(1)
      expect(JSON.parse(written[0])).toMatchObject({ method: 'turn/start', params: { threadId: 'thr-1' } })
    })

    // M2: 앱이 붙어 있지만 그 세션을 아직 되찾지 않았다 — 6 이고, 아무도 쓰지 않는다.
    it('앱이 그 세션을 아직 쥐지 않았으면 409 이고 아무도 쓰지 않는다', async () => {
      const { written, sessions } = chatRegistries()
      const acts: string[] = []
      const orch = orchOver({
        sessions,
        act: async (name) => {
          acts.push(name)
          return undefined
        }
      })
      const r = await orch.call({ cmd: 'sessions-send', args, sessionId: '', request: 'req-c9' })
      expect(r.status).toBe(409)
      expect(JSON.stringify(r.body)).toMatch(/try again in a moment/)
      expect(acts).toEqual(['chatPending'])
      expect(written).toEqual([])
      const shown = await orch.call({ cmd: 'requests-show', args: { id: 'req-c9' }, sessionId: '' })
      expect(shown.body).toMatchObject({ state: 'absent' })
    })

    // 카드에 답하는 것은 앱에서 사람이 한다 — 앱이 거절하면 6 이다(CONFLICT).
    it('앱이 카드가 열렸다고 하면 409 이고 아무것도 쓰지 않는다', async () => {
      const { written, sessions } = chatRegistries()
      const orch = orchOver({
        sessions,
        act: async (name) =>
          name === 'chatPending' ? null : { sent: false, pending: { kind: 'approval', summary: 'Bash: npm test' } }
      })
      const r = await orch.call({ cmd: 'sessions-send', args, sessionId: '' })
      expect(r.status).toBe(409)
      expect(JSON.stringify(r.body)).toMatch(/waiting on an approval: Bash: npm test/)
      expect(written).toEqual([])
    })

    // 앱이 붙어 있으면 read 는 앱에 카드를 묻고 싣는다. 앱이 없으면 그 칸이 없다.
    it('read 의 pending 은 앱이 있을 때만 있다', async () => {
      const { sessions } = chatRegistries()
      const withApp = orchOver({ sessions, act: async () => ({ kind: 'question', summary: '어느 쪽?' }) })
      const r = await withApp.call({ cmd: 'sessions-read', args: { id: 'chat-1' }, sessionId: '' })
      expect(r.body).toEqual({ id: 'chat-1', kind: 'chat', alive: true, turns: [], pending: { kind: 'question', summary: '어느 쪽?' } })
      const noApp = orchOver({ sessions, hasApp: () => false })
      const q = await noApp.call({ cmd: 'sessions-read', args: { id: 'chat-1' }, sessionId: '' })
      expect(q.body).toEqual({ id: 'chat-1', kind: 'chat', alive: true, turns: [] })
    })
  })

  // 앱이 닫힌 채 하위 폴더에서 만든 Job 이 어느 프로젝트 목록에도 안 보이던 자리다. 앱에 물어
  // APP_REQUIRED 를 받고 명령 층이 그것을 삼켜, 받은 하위 폴더를 그대로 저장했다.
  it('앱이 없으면 jobs create --cwd <알려진 프로젝트의 하위 폴더> 가 프로젝트 루트를 저장한다', async () => {
    const project = path.join(dir, 'work', 'proj')
    const configDir = path.join(dir, 'cfg', 'acc1')
    await fs.writeFile(
      path.join(dir, 'accounts.json'),
      JSON.stringify({ accounts: [{ id: 'acc1', label: '일', configDir, color: '#fff', createdAt: 'T', provider: 'claude' }] }),
      'utf8'
    )
    const slug = path.join(configDir, 'projects', 'proj')
    await fs.mkdir(slug, { recursive: true })
    await fs.writeFile(
      path.join(slug, 's1.jsonl'),
      JSON.stringify({ type: 'user', sessionId: 's1', cwd: project, message: { role: 'user', content: 'hi' } }),
      'utf8'
    )
    const act = vi.fn()
    const roots = createHostProjectRoots({ profileDir: dir, repoPaths: () => [], repoRoot: async () => null })
    const orch = orchOver({ act, hasApp: () => false, resolveProjectRoot: roots.resolve })
    const job = await orch.call({
      cmd: 'jobs-create',
      args: { objective: 'o', cwd: path.join(project, 'src', 'deep') },
      sessionId: ''
    })
    expect(job.status).toBe(200)
    expect(orch.state().jobs.map((j) => j.cwd)).toEqual([project])
    expect(act).not.toHaveBeenCalled()
  })

  // 앱이 닫혀 있어도 셸이 계획을 짤 수 있다 — 계정 목록은 프로필의 accounts.json 이 답한다.
  it('앱이 없으면 accounts.json 으로 계정을 답하고 tasks add 가 돈다', async () => {
    await fs.writeFile(
      path.join(dir, 'accounts.json'),
      JSON.stringify({
        accounts: [
          { id: 'acc1', label: '일', configDir: 'D:/cfg', color: '#fff', createdAt: 'T', provider: 'claude' }
        ]
      }),
      'utf8'
    )
    const act = vi.fn()
    const orch = orchOver({ act, hasApp: () => false })
    const list = await orch.call({ cmd: 'accounts-list', args: {}, sessionId: '' })
    expect(list.status).toBe(200)
    expect(list.body).toEqual([{ id: 'acc1', label: '일', provider: 'claude' }])
    const job = await orch.call({
      cmd: 'jobs-create',
      args: { objective: 'o', cwd: 'D:/p', coordinatorAccount: 'acc1' },
      sessionId: ''
    })
    expect(job.status).toBe(200)
    const add = await orch.call({
      cmd: 'tasks-add',
      args: { job: (job.body as { id: string }).id, spec: 's', account: 'acc1' },
      sessionId: ''
    })
    expect(add.status).toBe(200)
    expect(act).not.toHaveBeenCalledWith('listAccounts', expect.anything())
  })

  // phase D. 실행 구성도 같다 — 프로필의 run-configs.json 과 계획의 폴더를 Host 가 읽는다.
  it('앱이 없으면 run-configs.json 과 폴더로 구성을 답하고 tasks add --validate 가 돈다', async () => {
    const project = path.join(dir, 'proj')
    await fs.mkdir(project)
    await fs.writeFile(path.join(project, 'package.json'), '{"scripts":{"test":"vitest"}}', 'utf8')
    await fs.writeFile(
      path.join(dir, 'run-configs.json'),
      JSON.stringify({ [project]: [{ id: 'cfg1', name: 'unit', type: 'shell', command: 'echo', env: { K: 'v' } }] }),
      'utf8'
    )
    await fs.writeFile(
      path.join(dir, 'accounts.json'),
      JSON.stringify({
        accounts: [
          { id: 'acc1', label: '일', configDir: 'D:/cfg', color: '#fff', createdAt: 'T', provider: 'claude' }
        ]
      }),
      'utf8'
    )
    const act = vi.fn()
    const orch = orchOver({ act, hasApp: () => false })
    const job = await orch.call({ cmd: 'jobs-create', args: { objective: 'o', cwd: project }, sessionId: '' })
    const jobId = (job.body as { id: string }).id
    const list = await orch.call({ cmd: 'run-configs-list', args: { job: jobId }, sessionId: '' })
    expect(list.status).toBe(200)
    expect(list.body).toEqual([
      { id: 'cfg1', name: 'unit', type: 'shell' },
      { id: 'seed:npm:test', name: 'test', type: 'npm' }
    ])
    const add = await orch.call({
      cmd: 'tasks-add',
      args: { job: jobId, spec: 's', account: 'acc1', validate: 'cfg1,seed:npm:test' },
      sessionId: ''
    })
    expect(add.status).toBe(200)
    expect(add.body).toMatchObject({ validateConfigIds: ['cfg1', 'seed:npm:test'] })
    const unknown = await orch.call({
      cmd: 'tasks-add',
      args: { job: jobId, spec: 's', account: 'acc1', validate: 'nope' },
      sessionId: ''
    })
    expect(unknown.status).toBe(404)
    expect(unknown.body).toMatchObject({ jobId })
    expect(act).not.toHaveBeenCalled()
  })

  // **우리 마음대로 합치지 않는다.** 두 호출이 한 요청이라는 말은 부르는 쪽만 할 수 있고, 그 말이
  // 요청 id 다 — id 가 다르면 두 번 하는 것이 맞다.
  it('요청 id 가 다르면 두 번 만든다', async () => {
    const c = counting()
    const orch = orchOver({ act: c.act })
    const args = { objective: '무언가', cwd: 'D:/p' }
    await orch.call({ cmd: 'run-create', args, sessionId: 'sesA', request: 'req-1' })
    await orch.call({ cmd: 'run-create', args, sessionId: 'sesA', request: 'req-2' })
    expect((await savedState()).jobs).toHaveLength(2)
  })

  // **범위는 세션이다**(설계 §5). 재생은 기록된 답을 그대로 돌려주는 일이라, 남의 요청 id 를 맞히는
  // 것이 남의 답을 읽는 두 번째 문이 되어서는 안 된다.
  it('세션이 다르면 같은 요청 id 라도 다른 요청이다', async () => {
    const c = counting()
    const orch = orchOver({ act: c.act })
    const args = { objective: '무언가', cwd: 'D:/p' }
    await orch.call({ cmd: 'run-create', args, sessionId: 'sesA', request: 'req-1' })
    await orch.call({ cmd: 'run-create', args, sessionId: 'sesB', request: 'req-1' })
    expect((await savedState()).jobs).toHaveLength(2)
  })

  /**
   * `ask` 를 두 번 만들면 사람이 같은 것을 두 번 보고 하나에만 답하며, 워커는 다른 하나를 계속
   * 기다린다(설계 §7).
   *
   * **여기서도 질문의 수를 지키는 것은 오늘 이미 상태다** — `createQuestion` 이 같은 Dispatch 의
   * 두 번째 미답 질문을 거절한다. 그래서 재생이 없을 때 빨간 것은 답이다: 재시도가 400 "a pending
   * question already exists" 를 받아 exit 2 로 떨어지고, 부르는 쪽은 자기 인자를 고치려 든다.
   * 관찰해서 되돌려 주는 재생(`timedOut` 을 그대로 돌려주지 않는 것)은 9단계의 몫이다.
   */
  it('같은 요청 id 의 ask 는 질문을 하나만 만들고 같은 답을 돌려준다', async () => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW)
    if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW)
    if (!run.ok) throw new Error(run.error)
    const task = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW)
    if (!task.ok) throw new Error(task.error)
    const dsp = openDispatch(
      task.state,
      { taskId: task.value.id, provider: 'codex', accountId: 'accA', sessionId: 'ses1', cwd: 'D:/p', specPath: 'D:/p/s.md' },
      NOW
    )
    if (!dsp.ok) throw new Error(dsp.error)
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(dsp.state), 'utf8')
    const orch = orchOver({ aliveSessionIds: () => new Set(['ses1']) })
    const args = { taskId: task.value.id, dispatchId: dsp.value.id, question: '이대로 갈까요?', timeoutMs: 1 }
    const first = await orch.call({ cmd: 'ask', args, sessionId: 'ses1', request: 'req-1' })
    const second = await orch.call({ cmd: 'ask', args, sessionId: 'ses1', request: 'req-1' })
    expect(first.status).toBe(200)
    expect(answerOf(second), '재시도가 자기 인자를 탓하는 400 을 받았다').toBe(answerOf(first))
    expect((await savedState()).messages.filter((m) => m.type === 'question')).toHaveLength(1)
  })

  // === 3단계 — 진행 중인 요청 ===

  /**
   * **합류시키지 않고 거절한다**(설계 §7). `ask` 는 10분, `check --wait` 은 5분, `runs wait` 은 한
   * 시간을 소켓에 매달려 있으므로, 이미 실패했다고 믿는 호출을 그만큼 더 붙잡아 두는 것이 회복하려던
   * 실패보다 나쁘다. 409 는 이미 있는 뜻("지금 상태로는 못 한다")이고, 열한 번째 종료 코드는 없다.
   */
  it('진행 중인 요청의 재시도는 409 로 거절한다 — 합류시키지 않는다', async () => {
    const { taskId } = await seed()
    let release = (): void => {}
    const blocked = new Promise<void>((r) => {
      release = () => r()
    })
    const c = counting({
      startWorker: async () => {
        await blocked
        return { sessionId: 'ses1', cwd: 'D:/wt', specPath: 'D:/wt/s.md' }
      }
    })
    const orch = orchOver({ act: c.act })
    const args = workerArgs(taskId)
    const inFlight = orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-1' })
    // 첫 호출이 startWorker 에 닿을 때까지 이벤트 루프를 돌린다.
    while (countOf(c.calls, 'startWorker') === 0) await new Promise((r) => setImmediate(r))
    const retry = await orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-1' })
    expect(retry.status).toBe(409)
    expect(JSON.stringify(retry.body)).toContain('req-1')
    // **문장 안에만이 아니라 칸으로도 댄다.** 이 거절을 받은 쪽이 다음에 할 일은 *그 요청*을 묻는
    // 것이고, CLI 는 문구를 읽지 않고는 이 409 를 "Job 이 이미 돈다" 와 가를 수 없다 — 칸이 있으면
    // 그 실패의 `nextSteps` 가 `astera status` 대신 `requests show --id` 가 된다.
    expect((retry.body as { requestId?: string }).requestId).toBe('req-1')
    // **거절은 재생이 아니다.** 뒤에 영수증이 없는 답이므로 재생 표시를 달면, 부르는 쪽은 자기 명령이
    // 이미 한 번 끝났다고 읽는다 — 아직 돌고 있는데.
    expect(retry.replayed, '거절에 재생 표시가 붙었다').toBeUndefined()
    expect(countOf(c.calls, 'startWorker'), '거절이 의존을 한 번 더 건드렸다').toBe(1)
    release()
    expect((await inFlight).status).toBe(200)
  })

  /** 검사와 자리 잡기가 한 걸음이 아니면 둘 다 자리가 비어 있는 것을 본다 — `reserveVersion` 이 같은
   *  이유로 지키는 규율이다(설계 §7). */
  it('같은 틱에 온 두 호출 중 하나만 이긴다', async () => {
    const c = counting()
    const orch = orchOver({ act: c.act })
    const args = { objective: '무언가', cwd: 'D:/p' }
    const [a, b] = await Promise.all([
      orch.call({ cmd: 'run-create', args, sessionId: 'sesA', request: 'req-1' }),
      orch.call({ cmd: 'run-create', args, sessionId: 'sesA', request: 'req-1' })
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect((await savedState()).jobs).toHaveLength(1)
  })

  // === 키의 생김새 ===
  //
  // 지도의 열쇠가 세션 id 와 요청 id 를 NUL 로 이은 것이라, id 안의 NUL 은 남의 범위를 위조한다.
  // 나머지 둘은 저장이 무한히 자라지 않게 하는 최소한의 울타리다.
  it('빈 id, 너무 긴 id, 제어문자가 든 id 는 400 이다', async () => {
    const orch = orchOver()
    const args = { objective: '무언가', cwd: 'D:/p' }
    const NUL = String.fromCharCode(0)
    const LF = String.fromCharCode(10)
    for (const wrong of ['', 'x'.repeat(201), `a${NUL}b`, `a${LF}b`]) {
      const r = await orch.call({ cmd: 'run-create', args, sessionId: 'sesA', request: wrong })
      expect(r.status, JSON.stringify(wrong)).toBe(400)
    }
    // 그리고 아무것도 커밋되지 않았다 — 거절은 명령에 닿기 전이다.
    expect((await orch.call({ cmd: 'jobs-list', args: {}, sessionId: '' })).body).toEqual([])
  })

  /**
   * **받아 놓고 조용히 버리지 않는다.** 이 둘은 영수증 선 **위에서** 답하므로, 실린 요청 id 는
   * 아무 일도 하지 못한다. 그것을 잠자코 두면 Orca 의 `check --peek` 이 `--retry-request` 를 받고
   * 버리는 그 모양이 되고, §3 의 논거 전체가 그 위에 지어져 있다("플래그를 넘기는 이유는 다음에
   * 무슨 일이 일어날지에 대한 믿음이다").
   *
   * 오늘 닿을 수 있는 클라이언트는 없다 — 이 둘을 보내는 것은 앱뿐이고 앱은 id 를 싣지 않는다.
   * 그래도 적는다: 닿지 못하는 이유가 오늘의 클라이언트에 대한 사실이지 이 코드의 성질이 아니다.
   */
  it('state-put·state-get 에 실린 요청 id 는 버려지지 않고 400 이다', async () => {
    await seed()
    const orch = orchOver()
    const app: OrchCaller = { role: 'app', toOthers: () => {} }
    const put = await orch.call({
      cmd: 'state-put',
      args: { state: emptyState() },
      sessionId: '',
      from: app,
      request: 'req-1'
    })
    expect(put.status).toBe(400)
    const got = await orch.call({ cmd: 'state-get', args: {}, sessionId: '', from: app, request: 'req-1' })
    expect(got.status).toBe(400)
    // 거절이지 절반의 실행이 아니다 — 빈 상태가 앉았다면 계획이 사라졌을 것이다.
    expect((await orch.call({ cmd: 'jobs-list', args: {}, sessionId: '' })).body).toHaveLength(1)
  })

  /**
   * **앱이 없어 거절된 worker-start 는 영수증을 남긴다 — 받아들인 동작이고, 못을 박아 둔다.**
   *
   * 그 명령은 Dispatch 를 열고 시작에 실패하면 되돌리므로 두 번 커밋한다. 그래서 "커밋했으면
   * 남긴다" 규칙에 걸리고, 남긴 것이 없는 호출인데 영수증이 생긴다. 앱이 돌아온 뒤에 같은 id 로
   * 재시도해도 그 409 를 되받는다.
   *
   * **계약대로는 옳다.** 영수증은 "이 요청은 이렇게 답했다" 이고 실패 봉투도 그대로 기록한다(§8).
   * 그리고 8단계가 재시도 명령을 실어 주는 것은 답이 **아예 없었던** 끝(`unreachable`·`stuck`)
   * 뿐이므로, 409 를 받은 호출자는 답을 받은 것이고 그 id 를 다시 내밀 이유가 없다. 이 시험이
   * 지키는 것은 그 판단이 나중에 조용히 뒤집히지 않는 것이다.
   */
  it('앱이 없어 거절된 worker-start 는 영수증을 남긴다 — 앱이 돌아와도 재생이다', async () => {
    const { taskId } = await seed()
    let appIsUp = false
    const c = counting()
    const orch = orchOver({ hasApp: () => appIsUp, act: c.act })
    const args = workerArgs(taskId)
    const first = await orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-1' })
    expect(first.status).toBe(409)
    // 앱이 돌아왔다. 요청 id 를 안 실었다면 이 재시도는 워커를 띄웠을 것이다.
    appIsUp = true
    const second = await orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-1' })
    expect(answerOf(second)).toBe(answerOf(first))
    expect(second.replayed, '재생인데 그렇게 말하지 않았다').toBe(true)
    expect(countOf(c.calls, 'startWorker'), '재생이 아니라 두 번째 실행이었다').toBe(0)
    // 첫 호출이 되돌렸으므로 Dispatch 는 없다 — 영수증은 남았지만 상태에는 아무것도 남지 않았다.
    expect((await savedState()).dispatches).toEqual([])
  })

  // === 4단계 — requests show ===
  //
  // **"내 호출이 닿았나"에 답하는 자리**(설계 §6). 세 상태 모두 200 이다 — 못 찾은 것은 실패가 아니라
  // 답이다. 404 가 아닌 이유가 그것이다: NOT_FOUND 는 "여기 있고 그런 id 는 모른다" 이고 가이드는 4 를
  // 재시도하지 말라고 하는데, `absent` 에서 내려야 할 결론은 정확히 그 반대다.

  type Shown = {
    id: string
    state: 'completed' | 'pending' | 'absent'
    cmd?: string
    at?: string
    hostStartedAt: string
    interpretation: string
    response?: { status: number; body: unknown }
  }
  /** 요청 id 하나를 물어본다. **부르는 쪽의 정체가 곧 범위이므로** 세션을 함께 준다(설계 §5). */
  const show = async (
    orch: ReturnType<typeof createHostOrch>,
    sessionId: string,
    id: string
  ): Promise<{ status: number; body: Shown }> => {
    const r = await orch.call({ cmd: 'requests-show', args: { id }, sessionId })
    return { status: r.status, body: r.body as Shown }
  }
  const runArgs = { objective: '무언가', cwd: 'D:/p' }

  it('기록이 있으면 completed 와 그때의 답을 그대로 돌려준다', async () => {
    const c = counting()
    const orch = orchOver({ act: c.act })
    const made = await orch.call({ cmd: 'run-create', args: runArgs, sessionId: 'sesA', request: 'req-1' })
    const r = await show(orch, 'sesA', 'req-1')
    expect(r.status).toBe(200)
    expect(r.body.state).toBe('completed')
    // id 밖에 안 들고 있는 호출자에게 "이 id 는 run-create 였다" 는 알아야 할 것의 절반이다.
    expect(r.body.cmd).toBe('run-create')
    expect(r.body.at).toBe(NOW)
    expect(r.body.hostStartedAt).toBe(HOST_STARTED_AT)
    // 기록한 답은 상태까지 통째다 — 404 였는지 200 이었는지가 되찾은 답의 절반이고, CLI 는 그것으로
    // 원래의 봉투와 종료 코드를 다시 만든다.
    expect(r.body.response).toEqual({ status: made.status, body: made.body })
    expect(r.body.interpretation).toContain('run-create')
    expect(r.body.interpretation).toContain('Do not send the command again')
  })

  it('진행 중인 요청은 pending 이다 — 아무것도 잃지 않았고 아무것도 정해지지 않았다', async () => {
    const { taskId } = await seed()
    let release = (): void => {}
    const blocked = new Promise<void>((r) => {
      release = () => r()
    })
    const c = counting({
      startWorker: async () => {
        await blocked
        return { sessionId: 'ses1', cwd: 'D:/wt', specPath: 'D:/wt/s.md' }
      }
    })
    const orch = orchOver({ act: c.act })
    const inFlight = orch.call({ cmd: 'worker-start', args: workerArgs(taskId), sessionId: 'sesA', request: 'req-1' })
    while (countOf(c.calls, 'startWorker') === 0) await new Promise((r) => setImmediate(r))
    const r = await show(orch, 'sesA', 'req-1')
    expect(r.status).toBe(200)
    expect(r.body.state).toBe('pending')
    expect(r.body.cmd).toBe('worker-start')
    expect(r.body.response, '아직 답이 없는 요청에 답을 실어 보냈다').toBeUndefined()
    expect(r.body.interpretation).toContain('wait and ask again')
    release()
    expect((await inFlight).status).toBe(200)
  })

  /**
   * **`absent` 는 "안전하게 재시도해도 된다" 로 읽히면 안 된다**(설계 §6). 그래서 hostStartedAt 이
   * 함께 나간다 — 영수증은 메모리에 있으므로, 요청을 보낸 뒤에 선 Host 는 그 요청을 본 적이 없고 본
   * 쪽은 이미 영수증과 함께 사라졌다. 그 한 줄이 침묵을 사실로 바꾼다.
   */
  it('없는 요청은 absent 이고, hostStartedAt 을 싣고, 재시도해도 된다고 말하지 않는다', async () => {
    const r = await show(orchOver(), 'sesA', 'req-없는것')
    expect(r.status, 'absent 를 실패로 답했다').toBe(200)
    expect(r.body.state).toBe('absent')
    expect(r.body.hostStartedAt).toBe(HOST_STARTED_AT)
    expect(r.body.cmd).toBeUndefined()
    expect(r.body.response).toBeUndefined()
    expect(r.body.interpretation).toContain('not proof that nothing happened')
    expect(r.body.interpretation, '무엇과 견주라는 말이 빠지면 hostStartedAt 은 그냥 숫자다').toContain('hostStartedAt')
  })

  /**
   * **남의 세션 영수증은 absent 다**(설계 §5). 재생은 기록된 답을 그대로 돌려주는 일이고, 그 답에는
   * 다른 워커의 질문이나 코디네이터가 보낸 답의 본문이 들어 있을 수 있다 — `COORDINATOR_ONLY` 가
   * 막아 둔 그 방이다. 요청 id 를 맞히는 것이 그 방의 두 번째 문이 되어서는 안 된다.
   */
  it('다른 세션이 남긴 영수증은 absent 로 답한다', async () => {
    const c = counting()
    const orch = orchOver({ act: c.act })
    await orch.call({ cmd: 'run-create', args: runArgs, sessionId: 'sesA', request: 'req-1' })
    expect((await show(orch, 'sesA', 'req-1')).body.state).toBe('completed')
    const other = await show(orch, 'sesB', 'req-1')
    expect(other.status).toBe(200)
    expect(other.body.state).toBe('absent')
    expect(other.body.response, '남의 답이 새어 나왔다').toBeUndefined()
  })

  // **§6 의 네 번째 원인.** 키를 달아도 아무것도 바꾸지 않은 명령은 기록할 것이 없다. 이것이 없으면
  // 읽기에 키를 단 호출자가 absent 를 보고 완벽히 잘 도는 Host 에 대해 무언가를 결론짓는다.
  it('키를 단 읽기는 영수증을 남기지 않으므로 그 id 는 absent 다', async () => {
    await seed()
    const c = counting({ readWorker: () => '출력' })
    const orch = orchOver({ act: c.act })
    await orch.call({ cmd: 'worker-read', args: { dispatch: 'dsp_1' }, sessionId: 'sesA', request: 'req-1' })
    expect((await show(orch, 'sesA', 'req-1')).body.state).toBe('absent')
  })

  /**
   * **`requests-show` 는 영수증 선 **아래**에 있다.** 8단계가 오면 CLI 는 모든 명령에 id 를 싣는다.
   * 그때 `state-put`·`state-get` 처럼 실린 id 를 400 으로 거절했다면, 모든 명령이 id 를 갖기 시작하는
   * 바로 그 순간에 이 명령만 멈춘다 — 그리고 그 순간은 정확히 이 명령이 필요해지는 순간이다.
   *
   * 아래에 두면 따로 정할 규칙이 없다: 읽기라 커밋도 행동도 없으므로 자리는 반납되고 남는 것이 없다.
   */
  it('키를 단 requests-show 는 받아들여지고 자기 영수증을 남기지 않는다', async () => {
    const orch = orchOver()
    const r = await orch.call({ cmd: 'requests-show', args: { id: 'req-1' }, sessionId: 'sesA', request: 'req-2' })
    expect(r.status, '실린 요청 id 때문에 거절당했다').toBe(200)
    expect((await show(orch, 'sesA', 'req-2')).body.state, 'requests-show 가 자기 영수증을 남겼다').toBe('absent')
  })

  // **읽는 쪽에도 같은 울타리가 있다.** 지도의 열쇠가 `세션\0요청` 이므로, NUL 이 든 id 로 물어보면
  // 자기 id 에 NUL 이 든 세션의 영수증을 가리킬 수 있다 — 쓰는 쪽만 막으면 읽는 쪽으로 넘어간다.
  it('id 가 없거나 못 쓸 모양이면 400 이다', async () => {
    const orch = orchOver()
    const NUL = String.fromCharCode(0)
    expect((await orch.call({ cmd: 'requests-show', args: {}, sessionId: 'sesA' })).status).toBe(400)
    for (const wrong of ['', 'x'.repeat(201), `a${NUL}b`])
      expect(
        (await orch.call({ cmd: 'requests-show', args: { id: wrong }, sessionId: 'sesA' })).status,
        JSON.stringify(wrong)
      ).toBe(400)
  })

  // === 6단계 — 관찰해서 되돌려 주는 재생 ===
  //
  // **규칙**(설계 §7): 영수증은 그대로 재생된다. **커밋하고 나서 기다린 명령**만이 예외이고, 그때의
  // 재생은 *관찰*이다 — 지금 참인 것을 답하지, 앞선 호출이 기다리기를 그만둔 순간에 참이던 것을
  // 답하지 않는다. 기록된 `timedOut: true` 는 세상에 대한 사실이 아니라 한 호출이 얼마나 기다렸는지에
  // 대한 사실이고, **더 기다리고 싶어서** 재시도하는 호출자에게 그것을 돌려주면 끝날 수 없는 고리에
  // 가둔다 — 회복하려던 그 실패보다 나쁘다.

  const appCallerFrom: OrchCaller = { role: 'app', toOthers: () => {} }
  /** 워커 세션 `ses1` 이 물을 수 있는 자리까지 세운 상태 — 계획·회차·Task·Dispatch. */
  const workerFixture = async (): Promise<{ taskId: string; dispatchId: string }> => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW)
    if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW)
    if (!run.ok) throw new Error(run.error)
    const task = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW)
    if (!task.ok) throw new Error(task.error)
    const dsp = openDispatch(
      task.state,
      { taskId: task.value.id, provider: 'codex', accountId: 'accA', sessionId: 'ses1', cwd: 'D:/p', specPath: 'D:/p/s.md' },
      NOW
    )
    if (!dsp.ok) throw new Error(dsp.error)
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(dsp.state), 'utf8')
    return { taskId: task.value.id, dispatchId: dsp.value.id }
  }
  const askArgs = (f: { taskId: string; dispatchId: string }): Record<string, unknown> => ({
    taskId: f.taskId,
    dispatchId: f.dispatchId,
    question: '이대로 갈까요?',
    timeoutMs: 1
  })

  /**
   * **`ask` — 다시 돌리면 질문이 둘이 되므로, 영수증이 가리키는 질문을 다시 읽는다.** 재생이 기록된
   * `timedOut: true` 를 돌려주면 워커는 답이 이미 와 있는데도 영영 기다린다.
   */
  it('시간이 다 된 ask 의 재생은 그때의 timedOut 이 아니라 그 사이 온 답을 준다', async () => {
    const f = await workerFixture()
    const orch = orchOver({ aliveSessionIds: () => new Set(['ses1']) })
    const first = await orch.call({ cmd: 'ask', args: askArgs(f), sessionId: 'ses1', request: 'req-1' })
    expect(first.body).toMatchObject({ answered: false, timedOut: true })
    const questionId = (first.body as { questionId: string }).questionId
    // 사람이 답했다.
    const answered = await orch.call({ cmd: 'reply', args: { id: questionId, body: '그렇게 가요' }, sessionId: '' })
    expect(answered.status).toBe(200)
    const again = await orch.call({ cmd: 'ask', args: askArgs(f), sessionId: 'ses1', request: 'req-1' })
    expect(again.body, '멈춘 시계를 그대로 돌려줬다').toEqual({ answered: true, answer: '그렇게 가요', questionId })
    expect(
      (await savedState()).messages.filter((m) => m.type === 'question'),
      '관찰한다면서 질문을 하나 더 만들었다'
    ).toHaveLength(1)
  })

  /**
   * **관찰을 부르는 것은 명령의 이름이 아니라 멈춘 시계다.** 답을 받고 끝난 `ask` 의 영수증은 세상에
   * 대한 사실이므로 그대로 돌려준다. 이름으로 갈랐다면 여기서도 질문을 다시 읽었을 것이고, 그 질문이
   * 사라진 뒤에는 기록된 답 대신 404 를 답했을 것이다.
   *
   * **그래서 관찰한 답이 영수증을 대신한다.** 멈춘 시계를 그대로 두면 그 뒤의 재시도가 계속 관찰하고,
   * 세상은 그 사이에 움직인다 — Dispatch 가 닫히거나 `reset` 이 돌면 질문은 사라지고, 답을 잃은
   * 호출자는 자기 답 대신 `unknown question` 을 받는다. 그 갱신이 빠지면 이 시험이 바로 그 404 로
   * 깨진다.
   */
  it('멈춘 시계가 아닌 ask 의 영수증은 그대로 재생한다', async () => {
    const f = await workerFixture()
    const orch = orchOver({ aliveSessionIds: () => new Set(['ses1']) })
    const first = await orch.call({ cmd: 'ask', args: askArgs(f), sessionId: 'ses1', request: 'req-1' })
    const questionId = (first.body as { questionId: string }).questionId
    await orch.call({ cmd: 'reply', args: { id: questionId, body: '그렇게 가요' }, sessionId: '' })
    const observed = await orch.call({ cmd: 'ask', args: askArgs(f), sessionId: 'ses1', request: 'req-1' })
    expect((observed.body as { answered: boolean }).answered).toBe(true)
    // **관찰한 답은 `observed` 이고 `replayed` 가 아니다**(§7). id 는 이미 효력을 냈고 그 커밋(질문
    // 만들기)은 되풀이되지 않았지만, 명령은 다시 돌았고 본문은 지금 참인 것이다 — `replayed` 가
    // 공표한 문장("명령을 두 번 돌리지 않았다")은 `check` 의 관찰에서 거짓이 된다.
    expect(observed.observed, '관찰한 답이 그렇다고 말하지 않았다').toBe(true)
    expect(observed.replayed, '관찰한 답이 재생으로도 나갔다').toBeUndefined()
    // 질문을 상태에서 지운다 — 다시 읽는다면 여기서 404 다.
    const now = await savedState()
    await orch.call({
      cmd: 'state-put',
      args: { state: { ...now, messages: [] } },
      sessionId: '',
      from: appCallerFrom
    })
    const third = await orch.call({ cmd: 'ask', args: askArgs(f), sessionId: 'ses1', request: 'req-1' })
    expect(answerOf(third), '기록된 답 대신 질문을 다시 읽었다').toBe(answerOf(observed))
    // 그리고 이번에는 **그대로 재생**이다 — 앞선 관찰이 낳은 답이 영수증에 앉았으므로 다시 볼 것이
    // 없다. 낱말이 갈리는 것이 그 차이를 그대로 말한다.
    expect(third.replayed).toBe(true)
    expect(third.observed).toBeUndefined()
  })

  /**
   * **`check --ack <id> --wait` — 둘 중 나쁜 쪽이다.** ack 은 폴링 **앞에서** 커밋되므로, 마감에 닿은
   * 호출은 `{count: 0, messages: [], timedOut: true}` 를 영수증에 남긴다. 가이드는 `check --wait` 의
   * 시간 초과를 체크포인트로 삼아 다시 부르라고 이미 말하고 있으니, 그 id 를 다시 내밀 때마다 즉시
   * 같은 `{count: 0}` 이 돌아오고 진짜 메시지는 이미 닫힌 ack 뒤에 쌓인다.
   *
   * 이쪽의 관찰은 **다시 돌리는 것**이다 — 이미 ack 된 배달의 ack 은 상태를 그대로 돌려주므로 두 번째
   * ack 은 아무 일도 하지 않고, 호출자가 원하는 전부인 폴링만 새로 돈다.
   */
  it('시간이 다 된 check --ack --wait 의 재생은 그 사이 온 메시지를 준다', async () => {
    const f = await workerFixture()
    const orch = orchOver({ aliveSessionIds: () => new Set(['ses1']) })
    const send = (subject: string): Promise<{ status: number; body: unknown }> =>
      orch.call({
        cmd: 'send',
        args: { type: 'status', taskId: f.taskId, dispatchId: f.dispatchId, subject, body: 'b' },
        sessionId: 'ses1'
      })
    expect((await send('첫 소식')).status).toBe(200)
    const took = await orch.call({ cmd: 'check', args: {}, sessionId: '' })
    const deliveryId = (took.body as { deliveryId: string }).deliveryId
    const args = { ack: deliveryId, wait: true, timeoutMs: 1 }
    const first = await orch.call({ cmd: 'check', args, sessionId: '', request: 'req-1' })
    expect(first.body).toEqual({ count: 0, messages: [], timedOut: true })
    const ackedAt = (await savedState()).deliveries.find((d) => d.id === deliveryId)?.ackedAt
    expect(ackedAt).toBeTruthy()
    // 그 사이에 소식이 왔다.
    expect((await send('두 번째 소식')).status).toBe(200)
    const again = await orch.call({ cmd: 'check', args, sessionId: '', request: 'req-1' })
    const body = again.body as { count: number; messages: { subject: string }[]; timedOut?: boolean }
    expect(body.timedOut, '멈춘 시계를 그대로 돌려줬다').toBeUndefined()
    expect(body.messages.map((m) => m.subject)).toEqual(['두 번째 소식'])
    // 같은 배달이 두 번 닫히지 않는다 — 두 번째 ack 은 아무 일도 하지 않는다.
    const after = await savedState()
    expect(after.deliveries.find((d) => d.id === deliveryId)?.ackedAt).toBe(ackedAt)
    expect(after.deliveries.filter((d) => d.ackedAt)).toHaveLength(1)
  })

  /**
   * **이 가드가 규칙을 지킨다 — 위의 두 항목이 아니라**(설계 §13 단계 6).
   *
   * 항목을 나열해서 만든 집합은 뒤처지는 집합이고, 그것이 §3 이 명령 목록을 거부한 이유다. 명령 층에서
   * **커밋도 하고 폴링도 하는** 모든 case 는 관찰 표에 있어야 한다. 다음 사람이 그런 명령을 하나 더
   * 만들면, 세 번째 예외가 조용히 생기는 대신 여기가 깨진다.
   *
   * 문서가 아니라 소스를 읽는 텍스트 가드다 — `cliUsage.test.ts` 가 `docs/cli.md` 에 하는 것과 같은
   * 부류이고, 저 switch 의 case 들은 데이터가 아니라서 타입으로 붙들 방법이 없다.
   */
  it('커밋하고 폴링하는 명령은 빠짐없이 관찰 표에 있다', () => {
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core/orchestration/command.ts'),
      'utf8'
    )
    /** case 이름 → 그 블록의 본문. 라벨이 잇달아 붙은 것(`case 'jobs-wait':` + `case 'runs-wait': {`)은
     *  한 블록을 함께 쓴다. 주석은 지운다 — 이 파일의 주석은 `deps.setState` 와 `pollUntil` 을 산문으로
     *  인용하므로, 남겨 두면 가드가 주석을 읽고 판정한다. */
    const blocks = new Map<string, string>()
    let group: string[] = []
    let body: string[] = []
    const flush = (): void => {
      if (group.length > 0 && body.length > 0) for (const name of group) blocks.set(name, body.join('\n'))
      if (body.length > 0) group = []
      body = []
    }
    for (const line of source.split('\n').slice(source.split('\n').findIndex((l) => l.includes('switch (routed)')))) {
      const label = /^\s*case '([^']+)':/.exec(line)
      if (label) {
        flush()
        group.push(label[1])
        continue
      }
      if (/^\s*default:/.test(line)) break
      const code = line.trim()
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue
      body.push(line)
    }
    flush()
    // 가드가 헛돌지 않는지부터 — 파싱이 조용히 아무것도 못 찾으면 이 시험은 늘 통과한다.
    expect(blocks.size, 'switch 를 읽지 못했다').toBeGreaterThan(30)
    const commitsAndPolls = [...blocks]
      .filter(([, text]) => text.includes('pollUntil(') && (text.includes('deps.setState(') || /\bcommit\(/.test(text)))
      .map(([name]) => name)
      .sort()
    expect(commitsAndPolls).toEqual(Object.keys(OBSERVED).sort())
  })

  // === 7단계 — 보존 ===
  //
  // **정책은 정해져 있고 숫자만 보정거리다: 비우되, 거절하지 않는다**(설계 §4). Orca 의
  // `mutation_ledger_full` 은 장부가 차면 새 변경을 거절한다 — 어떤 크기에서도 들여오지 않을 하나다.
  // 진짜 일을 거절하는 장부질은 그것이 막으려는 실패보다 나쁘다.

  /** 커밋하는 가장 싼 명령 하나. 상태는 메시지 하나씩만 자라고, 영수증은 요청 id 마다 하나 남는다. */
  const fill = (
    orch: ReturnType<typeof createHostOrch>,
    f: { taskId: string; dispatchId: string },
    request: string
  ): Promise<{ status: number; body: unknown }> =>
    orch.call({
      cmd: 'send',
      args: { type: 'status', taskId: f.taskId, dispatchId: f.dispatchId, subject: request, body: 'b' },
      sessionId: 'ses1',
      request
    })

  // 상한을 넘기려고 영수증을 RECEIPTS_PER_CALLER 개 넘게 채우고, 하나마다 디스크에 쓴다. 혼자 돌면
  // 1초 안쪽이지만 전체 스위트가 병렬로 디스크를 쓰면 기본 10초를 넘긴다. 상한은 코드에 고정된 값이라
  // 채우는 수를 줄일 수 없으므로 이 셋만 기다리는 시간을 늘린다.
  const FILL_TIMEOUT_MS = 30_000
  it('세션마다 최근 것만 남는다 — 넘친 가장 오래된 것은 absent 이고 가장 새것은 재생한다', async () => {
    const f = await workerFixture()
    const orch = orchOver({ aliveSessionIds: () => new Set(['ses1']) })
    const first = await fill(orch, f, 'req-0')
    for (let i = 1; i <= RECEIPTS_PER_CALLER; i++) await fill(orch, f, `req-${i}`)
    expect((await show(orch, 'ses1', 'req-0')).body.state, '상한을 넘겼는데 가장 오래된 것이 남아 있다').toBe('absent')
    const newest = await show(orch, 'ses1', `req-${RECEIPTS_PER_CALLER}`)
    expect(newest.body.state, '가장 새것이 쓸려 나갔다').toBe('completed')
    // 밀려난 id 를 다시 내밀면 그것은 재생이 아니라 새 명령이다 — 그리고 그것이 옳다. 영수증이 없으면
    // 없다고 답하는 것이 설계의 `absent` 이고, 그 뒤는 상태를 보라는 것이 §6 의 규율이다.
    const again = await fill(orch, f, 'req-0')
    expect(again.status).toBe(200)
    expect(JSON.stringify(again), '쓸려 나간 영수증이 그대로 재생됐다').toBe(JSON.stringify(first))
  }, FILL_TIMEOUT_MS)

  /**
   * **자리는 저장이 아무리 차도 비워지지 않는다.** 자리는 호출의 기록이 아니라 호출 그 자체다 —
   * 비우면 그 자리가 막고 있던 재시도가 통과하고, 그것이 이 기구 전체가 막으려는 실패다.
   */
  it('진행 중인 자리는 상한을 넘겨 채워도 그대로 있다', async () => {
    const f = await workerFixture()
    let release = (): void => {}
    const blocked = new Promise<void>((r) => {
      release = () => r()
    })
    const c = counting({
      readWorker: async () => {
        await blocked
        return '출력'
      }
    })
    const orch = orchOver({ aliveSessionIds: () => new Set(['ses1']), act: c.act })
    const reading = orch.call({ cmd: 'worker-read', args: { dispatch: f.dispatchId }, sessionId: 'ses1', request: 'hold' })
    while (countOf(c.calls, 'readWorker') === 0) await new Promise((r) => setImmediate(r))
    for (let i = 0; i <= RECEIPTS_PER_CALLER; i++) await fill(orch, f, `req-${i}`)
    expect((await show(orch, 'ses1', 'hold')).body.state, '자리가 쓸려 나갔다').toBe('pending')
    release()
    expect((await reading).status).toBe(200)
  }, FILL_TIMEOUT_MS)

  // **가득 찬 저장이 명령을 막지 않는다.** 위의 두 시험이 비우는 것을 보고, 이것이 비우기가 거절로
  // 새지 않는 것을 본다 — 설계가 Orca 에서 유일하게 들여오지 않기로 한 행동에 못을 박는다.
  it('저장이 가득 차도 새 명령은 그대로 받아들여진다', async () => {
    const f = await workerFixture()
    const orch = orchOver({ aliveSessionIds: () => new Set(['ses1']) })
    for (let i = 0; i <= RECEIPTS_PER_CALLER; i++) await fill(orch, f, `req-${i}`)
    const after = await fill(orch, f, 'req-그다음')
    expect(after.status, '저장이 찼다고 명령을 거절했다').toBe(200)
    expect((await show(orch, 'ses1', 'req-그다음')).body.state).toBe('completed')
    expect((await savedState()).messages.filter((m) => m.subject === 'req-그다음')).toHaveLength(1)
  }, FILL_TIMEOUT_MS)

  // 나이로도 비운다. **다음 쓰기가 비질을 부른다** — 타이머도 아니고 시작할 때도 아니다.
  it('한 시간이 지난 영수증은 다음 쓰기에 쓸려 나간다', async () => {
    const f = await workerFixture()
    let clock = NOW
    const orch = orchOver({ aliveSessionIds: () => new Set(['ses1']), now: () => clock })
    await fill(orch, f, 'req-옛것')
    expect((await show(orch, 'ses1', 'req-옛것')).body.state).toBe('completed')
    clock = new Date(Date.parse(NOW) + RECEIPT_TTL_MS + 1_000).toISOString()
    await fill(orch, f, 'req-새것')
    expect((await show(orch, 'ses1', 'req-옛것')).body.state, '한 시간이 지났는데 남아 있다').toBe('absent')
    expect((await show(orch, 'ses1', 'req-새것')).body.state).toBe('completed')
  })

  // === 11단계 — 지문 ===
  //
  // **범위를 세션으로 좁힌 것이 충돌을 안전하게 만들지는 않는다**(설계 §5). 한 세션 안에서도 두
  // 스크립트가 같은 `req-1` 을 고를 수 있고, `ASTERA_SESSION` 이 없는 쪽은 아예 한 통을 나눠 쓴다.
  // 안전하게 만드는 것은 지문이다: 같은 id, 다른 부름이면 남의 답이 아니라 거절이 나간다.

  it('같은 id 로 다른 인자를 보내면 400 이고, 그 id 가 무엇이었는지 말한다', async () => {
    const c = counting()
    const orch = orchOver({ act: c.act })
    const first = await orch.call({
      cmd: 'run-create',
      args: { objective: '첫 번째', cwd: 'D:/p' },
      sessionId: 'sesA',
      request: 'req-1'
    })
    expect(first.status).toBe(200)
    const clash = await orch.call({
      cmd: 'run-create',
      args: { objective: '두 번째', cwd: 'D:/p' },
      sessionId: 'sesA',
      request: 'req-1'
    })
    // 400 은 exit 2 다 — 부르는 쪽이 고칠 것은 인자(자기가 고른 id)이고, 그것이 이 코드의 뜻이다.
    expect(clash.status).toBe(400)
    expect(JSON.stringify(clash.body), '무슨 명령에 쓴 id 인지 말하지 않았다').toContain('run-create')
    expect(clash.replayed, '거절에 재생 표시가 붙었다').toBeUndefined()
    // 그리고 아무 일도 일어나지 않았다 — 거절이지 절반의 실행이 아니다.
    expect((await savedState()).jobs).toHaveLength(1)
  })

  it('같은 id 로 다른 명령을 보내도 400 이다', async () => {
    const c = counting()
    const orch = orchOver({ act: c.act })
    await orch.call({ cmd: 'run-create', args: { objective: 'o', cwd: 'D:/p' }, sessionId: 'sesA', request: 'req-1' })
    const other = await orch.call({ cmd: 'jobs-list', args: {}, sessionId: 'sesA', request: 'req-1' })
    expect(other.status).toBe(400)
    expect(JSON.stringify(other.body)).toContain('run-create')
  })

  /**
   * **시한만 다른 재시도는 같은 부름이다**(설계 §12/6). 더 기다리겠다는 말은 무엇을 할지를 바꾸지
   * 않는다 — 그리고 이것을 거절하면, 답을 가장 잘 잃는 명령들(기다리는 명령들)에서 id 가 쓸모를
   * 잃는다.
   */
  it('시한만 바꾼 재시도는 거절되지 않고 그 요청을 잇는다', async () => {
    const f = await workerFixture()
    const orch = orchOver({ aliveSessionIds: () => new Set(['ses1']) })
    const first = await orch.call({ cmd: 'ask', args: askArgs(f), sessionId: 'ses1', request: 'req-1' })
    expect((first.body as { timedOut: boolean }).timedOut).toBe(true)
    const patient = await orch.call({
      cmd: 'ask',
      args: { ...askArgs(f), timeoutMs: 5 },
      sessionId: 'ses1',
      request: 'req-1'
    })
    expect(patient.status, '시한이 다르다고 다른 부름으로 봤다').toBe(200)
    expect(patient.observed).toBe(true)
    expect((patient.body as { questionId: string }).questionId).toBe(
      (first.body as { questionId: string }).questionId
    )
    // 질문은 여전히 하나다 — 이 시험이 지키는 것은 결국 그것이다.
    expect((await savedState()).messages.filter((m) => m.type === 'question')).toHaveLength(1)
  })
})

/**
 * **지문 자체를 규칙으로 본다.** 위의 세 시험은 진짜 명령이 지나가는 길로 충돌과 그 문장을 지키고,
 * 이쪽은 무엇을 같은 부름으로 볼 것인가라는 규칙을 잰다 — 명령 하나를 골라 그 인자로 재면 그 명령의
 * 인자에 대한 시험이 되지, 정규화에 대한 시험이 되지 않는다.
 */
describe('fingerprintOf — 무엇이 같은 부름인가', () => {
  it('객체의 키 순서는 부름을 바꾸지 않는다', () => {
    expect(fingerprintOf('run-create', { objective: 'o', cwd: 'D:/p' })).toBe(
      fingerprintOf('run-create', { cwd: 'D:/p', objective: 'o' })
    )
  })

  /** 설계가 이름을 댄 자리다 — `--deps` 는 JSON 배열이고, 그 안의 객체 키 순서는 JSON.stringify 가
   *  받은 순서를 그대로 쓰므로, 정규화하지 않으면 같은 값이 다른 해시가 된다. */
  it('JSON 배열 안 객체의 키 순서도 부름을 바꾸지 않는다', () => {
    expect(fingerprintOf('task-create', { deps: [{ id: 'a', kind: 'k' }] })).toBe(
      fingerprintOf('task-create', { deps: [{ kind: 'k', id: 'a' }] })
    )
  })

  /** **배열의 차례는 다르다.** 객체의 키 순서는 쓴 사람이 고르지 않은 것이지만 배열의 차례는 고른
   *  것이다 — `ask --options` 는 사람에게 그 차례로 보인다. 정렬해 버리면 두 부름이 하나가 된다. */
  it('배열의 차례가 다르면 다른 부름이다', () => {
    expect(fingerprintOf('task-create', { deps: ['a', 'b'] })).not.toBe(
      fingerprintOf('task-create', { deps: ['b', 'a'] })
    )
  })

  it('시한과 요청 id 자신은 보지 않는다', () => {
    const plain = fingerprintOf('ask', { question: 'q' })
    expect(fingerprintOf('ask', { question: 'q', timeoutMs: 1 })).toBe(plain)
    expect(fingerprintOf('ask', { question: 'q', timeoutMs: 600_000 })).toBe(plain)
    expect(fingerprintOf('ask', { question: 'q', requestId: 'req-1' })).toBe(plain)
  })

  it('명령 이름이 다르면 인자가 같아도 다른 부름이다', () => {
    expect(fingerprintOf('run-start', { id: 'x' })).not.toBe(fingerprintOf('run-delete', { id: 'x' }))
  })

  /**
   * **`__proto__` 는 해시에서 사라질 수 있었다.** `JSON.parse` 는 그 이름의 **자기 속성**을 만들고
   * (전선에서 오는 인자가 바로 그것이다), 그것을 평범한 `{}` 에 넣으면 프로토타입 설정자로 빨려
   * 들어가 키가 없어진다 — 그러면 서로 다른 인자가 같은 지문을 받는다. 이 함수가 절대 하면 안 되는
   * 한 가지다. `Object.create(null)` 이 그 구멍을 막는다.
   */
  it('JSON 이 만든 __proto__ 키도 지문에 들어간다', () => {
    const withKey = JSON.parse('{"deps":{"__proto__":"a"}}') as Record<string, unknown>
    const without = JSON.parse('{"deps":{}}') as Record<string, unknown>
    const other = JSON.parse('{"deps":{"__proto__":"b"}}') as Record<string, unknown>
    expect(fingerprintOf('task-create', withKey)).not.toBe(fingerprintOf('task-create', without))
    expect(fingerprintOf('task-create', withKey)).not.toBe(fingerprintOf('task-create', other))
    // 맨 위에서도 마찬가지다 — 거기도 같은 방식으로 담는다.
    expect(fingerprintOf('x', JSON.parse('{"__proto__":"a"}') as Record<string, unknown>)).not.toBe(
      fingerprintOf('x', {})
    )
  })
})

/**
 * **가이드는 런타임의 문장을 인용한다**(설계 §13 단계 12).
 *
 * Orca 의 가이드와 런타임은 `pending` 을 두고 서로 다른 말을 한다 — 가이드는 다시 보내라 하고 런타임은
 * 거절한다 — 문장을 두 번 썼기 때문이다. 여기서는 한 번 쓰고, 가이드가 그것을 옮긴다. 이 시험이 그
 * 옮긴 것이 여전히 같은 문장인지 본다.
 *
 * **빈칸을 지우고 비교한다.** 가이드 쪽은 마크다운이라 줄바꿈과 인용 표시(`>`)가 섞이고, 그것을
 * 그대로 묶으면 옳은 문서를 줄바꿈 하나 고쳤다는 이유로 시험이 깨진다. 지키는 것은 낱말이다.
 */
describe('orchestration-guide 는 영수증의 세 문장을 런타임에서 인용한다', () => {
  const guide = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../resources/skills/orchestration-guide.md'),
    'utf8'
  )
  /** 인용 표시와 줄바꿈과 강조를 걷어 낸 낱말들. */
  const words = (s: string): string => s.replace(/[>`*]/g, '').replace(/\s+/g, ' ').trim()
  const flat = words(guide)

  it('세 상태의 문장이 그대로 있다', () => {
    expect(flat, 'completed').toContain(words(interpretationOf.completed('<requestId>', '<command>')))
    expect(flat, 'pending').toContain(words(interpretationOf.pending('<requestId>', '<command>')))
    expect(flat, 'absent').toContain(words(interpretationOf.absent('<requestId>')))
  })
})

/**
 * **정책 자체를 규칙으로 본다.** 위의 보존 시험들은 진짜 명령이 지나가는 길로 세션 상한과 나이와
 * "거절하지 않는다" 를 지키지만, 전체 천장은 그 길로는 2000번의 커밋 — 2000번의 파일 통째 쓰기 —
 * 이어야 닿는다. 그것은 규칙이 아니라 저장소의 속도를 재는 시험이고, 실제로 묶음 전체와 함께 돌 때
 * 10초를 넘겨 깨졌다. 그래서 규칙은 순수 함수로 떼어 여기서 잰다.
 */
describe('receiptsToEvict — 무엇이 떨어져 나가는가', () => {
  const entry = (key: string, at = NOW, pending = false): { key: string; pending: boolean; at: string } => ({
    key,
    pending,
    at
  })
  const nowMs = Date.parse(NOW)

  it('세션마다 최근 것만 남기고 넘친 옛것을 뱉는다', () => {
    const held = Array.from({ length: RECEIPTS_PER_CALLER + 3 }, (_, i) => entry(`sesA\u0000req-${i}`))
    expect(receiptsToEvict(held, nowMs)).toEqual(['sesA\u0000req-2', 'sesA\u0000req-1', 'sesA\u0000req-0'])
  })

  // **통마다 따로 센다** — 한 세션이 제 몫을 다 써도 다른 세션의 영수증은 밀려나지 않는다.
  it('한 세션이 제 상한을 채워도 다른 세션은 그대로다', () => {
    const held = [
      entry('sesB\u0000하나'),
      ...Array.from({ length: RECEIPTS_PER_CALLER + 1 }, (_, i) => entry(`sesA\u0000req-${i}`))
    ]
    expect(receiptsToEvict(held, nowMs)).toEqual(['sesA\u0000req-0'])
  })

  /**
   * **세션 상한은 통 하나를 묶을 뿐, 통의 수를 묶지 않는다.** 앱이 다시 뜰 때마다 세션 id 는 새것이라,
   * 보름을 서 있는 Host 는 새 통을 끝없이 만난다. 전체 천장이 그것을 묶는다.
   */
  it('통이 여럿이어도 전체 천장을 넘지 않는다', () => {
    const callers = 20
    const per = 120 // 세션 상한 아래 — 여기서 비우는 것은 천장뿐이다
    expect(per).toBeLessThan(RECEIPTS_PER_CALLER)
    const held = Array.from({ length: callers * per }, (_, i) => entry(`c${i % callers}\u0000req-${i}`))
    const gone = receiptsToEvict(held, nowMs)
    expect(held.length - gone.length).toBe(RECEIPTS_TOTAL)
    // 떨어진 것은 가장 오래된 쪽이다.
    expect(gone).toContain('c0\u0000req-0')
    expect(gone).not.toContain(`c${(held.length - 1) % callers}\u0000req-${held.length - 1}`)
  })

  it('한 시간이 지난 것은 수와 무관하게 떨어진다', () => {
    const old = new Date(nowMs - RECEIPT_TTL_MS - 1_000).toISOString()
    const held = [entry('sesA\u0000옛것', old), entry('sesA\u0000새것')]
    expect(receiptsToEvict(held, nowMs)).toEqual(['sesA\u0000옛것'])
  })

  /**
   * **자리는 어떤 상한으로도 비워지지 않고, 어느 상한에도 세어지지 않는다.** 긴 폴링을 여럿 쥔
   * 호출자가 제 답들을 스스로 밀어내면 안 된다 — 자리는 기록이 아니라 지금 도는 호출이다.
   */
  it('자리는 비워지지도, 상한에 세어지지도 않는다', () => {
    const old = new Date(nowMs - RECEIPT_TTL_MS - 1_000).toISOString()
    const held = [
      entry('sesA\u0000오래된자리', old, true),
      ...Array.from({ length: RECEIPTS_PER_CALLER }, (_, i) => entry(`sesA\u0000req-${i}`)),
      entry('sesA\u0000자리', NOW, true)
    ]
    // 자리 둘을 빼면 완료된 것이 정확히 상한만큼이므로, 자리가 세어졌다면 가장 오래된 것이 떨어진다.
    expect(receiptsToEvict(held, nowMs)).toEqual([])
  })

  // 시계를 읽을 수 없으면 "만료됨" 이 아니라 "만료되지 않음" 으로 읽는다 — 오래 두는 값은 메모리지만,
  // 일찍 버리는 값은 호출자의 답이다.
  it('읽을 수 없는 시각은 만료로 치지 않는다', () => {
    expect(receiptsToEvict([entry('sesA\u0000req-1', '시각 아님')], nowMs)).toEqual([])
  })
})

describe('Host-local spawn (S2)', () => {
  const local = (over: Partial<HostLocal> = {}): HostLocal => ({
    owns: () => true,
    startWorker: vi.fn(async () => ({ sessionId: 'ses_host', cwd: 'D:/p', specPath: 'D:/specs/s.md' })),
    startCoordinator: vi.fn(async () => ({ sessionId: 'ses_coord' })),
    releaseWorker: vi.fn(async () => {}),
    readWorker: vi.fn(async () => 'worker output'),
    probeLimit: vi.fn(async () => null),
    readReviewFile: vi.fn(async () => null),
    makeRunWorktree: vi.fn(async () => 'D:/wt-run'),
    mergeWorktrees: vi.fn(async () => ({ ok: true as const, merged: [], uncommitted: 0 })),
    removeWorktrees: vi.fn(async () => ({ failed: [] })),
    ...over
  })
  const worker = (taskId: string, worktree = 'current') => ({ task: taskId, agent: 'claude', account: 'acc1', worktree })

  it('starts a worker with no app attached and records the real session id', async () => {
    const { taskId } = await seed()
    const act = vi.fn()
    const orch = orchOver({ hasApp: () => false, act, local: local() })
    const r = await orch.call({ cmd: 'worker-start', args: worker(taskId), sessionId: '' })
    expect(r.status).toBe(200)
    expect(act).not.toHaveBeenCalled()
    expect(orch.state().dispatches[0].sessionId).toBe('ses_host')
  })
  it('stops and reads a worker with no app attached', async () => {
    const { taskId } = await seed()
    const l = local()
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), local: l })
    const started = await orch.call({ cmd: 'worker-start', args: worker(taskId), sessionId: '' })
    const dispatchId = (started.body as { dispatchId: string }).dispatchId
    expect((await orch.call({ cmd: 'worker-read', args: { dispatch: dispatchId }, sessionId: '' })).body).toEqual({ output: 'worker output' })
    expect((await orch.call({ cmd: 'worker-stop', args: { dispatch: dispatchId }, sessionId: '' })).status).toBe(200)
    expect(l.releaseWorker).toHaveBeenCalledWith({ dispatchId })
  })
  // Fix round I1: a Stop that arrives while the Host is still spawning the worker. The Dispatch holds
  // the `pending:` placeholder, so nothing could be killed; recording it stopped would leave the agent
  // that is about to start on a closed Dispatch.
  it('refuses worker-stop while the Host is still starting the worker, and the worker then starts on an open Dispatch', async () => {
    const { taskId } = await seed()
    let finish: () => void = () => {}
    const l = local({
      startWorker: vi.fn(() => new Promise<{ sessionId: string; cwd: string; specPath: string }>((resolve) => {
        finish = () => resolve({ sessionId: 'ses_host', cwd: 'D:/p', specPath: 'D:/specs/s.md' })
      }))
    })
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), local: l })
    const starting = orch.call({ cmd: 'worker-start', args: worker(taskId), sessionId: '' })
    await vi.waitFor(() => expect(l.startWorker).toHaveBeenCalled())
    const pending = orch.state().dispatches[0]
    expect(pending.sessionId.startsWith('pending:')).toBe(true)
    const r = await orch.call({ cmd: 'worker-stop', args: { dispatch: pending.id }, sessionId: '' })
    expect(r.status).toBe(409)
    expect(exitCodeFor(codeForStatus(r.status))).toBe(6)
    expect((r.body as { error: string }).error).toContain('the worker is still starting; try again in a moment')
    expect(l.releaseWorker).not.toHaveBeenCalled()
    finish()
    expect((await starting).status).toBe(200)
    const d = orch.state().dispatches[0]
    expect(d.sessionId).toBe('ses_host')
    expect(d.endedAt).toBeUndefined()
    expect(d.workerState).not.toBe('stopped')
  })
  // Fix round 2, N1: a placeholder past its start window is a start that died, and nothing else will
  // ever close it. The Host's stop closes it as a Stop always did, with no release to call.
  it('stops a Dispatch left on a placeholder long past its start window, and releases nothing', async () => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW); if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW); if (!run.ok) throw new Error(run.error)
    const task = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW); if (!task.ok) throw new Error(task.error)
    const stale = new Date(Date.parse(NOW) - PENDING_START_WINDOW_MS - 60_000).toISOString()
    const dsp = openDispatch(task.state, { taskId: task.value.id, provider: 'claude', accountId: 'acc1', sessionId: 'pending:dead', cwd: 'D:/p', specPath: '' }, stale)
    if (!dsp.ok) throw new Error(dsp.error)
    const l = local()
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), local: l })
    // Pushed by an app rather than loaded: a load's restart cleanup would close it on its own, and the
    // case is a Host that is not restarting.
    await orch.call({ cmd: 'state-put', args: { state: dsp.state }, sessionId: '', from: { role: 'app', toOthers: () => {} } })
    expect(orch.state().dispatches[0].endedAt).toBeUndefined()
    const r = await orch.call({ cmd: 'worker-stop', args: { dispatch: dsp.value.id }, sessionId: '' })
    expect(r.status).toBe(200)
    expect(l.releaseWorker).not.toHaveBeenCalled()
    expect(orch.state().dispatches[0]).toMatchObject({ workerState: 'stopped', closedBy: 'stop' })
  })
  // Fix round 1, M3: through the real spawner, not the fake `local()` above — that fake always owns
  // everything, so this test could not have failed before spawner.ts's own `owns()` actually let
  // `--worktree new` through with no app (spawner.test.ts's `owns` test carries that claim on its
  // own). This one proves the whole path really wires through: command.ts, orchDeps.ts, orch.ts and
  // the real spawner together, ending in a worker spawned in the folder the fork returned.
  it('starts a --worktree new worker with no app attached, through the real spawner', async () => {
    const { taskId } = await seed()
    for (const f of ['Astera.exe', 'cli.js']) await fs.writeFile(path.join(dir, f), '')
    await fs.mkdir(path.join(dir, 'skills'), { recursive: true })
    await fs.writeFile(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'acc1', label: 'one', configDir: 'D:/cfg', color: '#888', createdAt: NOW, provider: 'claude' }] }))
    const forkedDir = path.join(dir, 'wt-a'); await fs.mkdir(forkedDir)
    const spawned: { cwd: string }[] = []
    const registry = new PtyRegistry({
      spawn: (file, args, opts) => {
        spawned.push({ cwd: opts.cwd })
        return { pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pause() {}, resume() {} }
      },
      log: () => {}
    })
    const box: { orch?: ReturnType<typeof orchOver> } = {}
    const act = vi.fn()
    const spawner = createHostSpawner({
      profileDir: dir,
      env: { PATH: process.env.PATH, ASTERA_HOST_CLI_EXEC: path.join(dir, 'Astera.exe'), ASTERA_HOST_CLI_ENTRY: path.join(dir, 'cli.js'), ASTERA_HOST_SKILLS: path.join(dir, 'skills') },
      platform: process.platform,
      homeDir: path.join(dir, 'home'),
      registry,
      broadcast: () => {},
      getState: () => box.orch!.state(),
      log: () => {},
      appKeepsWorktrees: () => false,
      worktrees: { fork: async () => forkedDir, makeRunWorktree: vi.fn(), mergeWorktrees: vi.fn(), removeWorktrees: vi.fn() }
    })
    box.orch = orchOver({ hasApp: () => false, act, local: spawner })
    const r = await box.orch.call({ cmd: 'worker-start', args: { ...worker(taskId, 'new'), name: 'n' }, sessionId: '' })
    expect(r.status).toBe(200)
    expect(spawned).toEqual([{ cwd: forkedDir }])
    expect(act).not.toHaveBeenCalled()
  })
  // §1.2's S3 line: a coordinator Job advances with no app in every placement.
  it('runs the first jobs run of a coordinator Job with no app: makes the Run worktree, then starts the coordinator', async () => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p', coordinatorAccountId: 'acc1' }, NOW); if (!job.ok) throw new Error(job.error)
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(job.state))
    const l = local()
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), local: l })
    const r = await orch.call({ cmd: 'run-start', args: { run: job.value.id }, sessionId: '' })
    expect(r.status).toBe(200)
    expect(l.makeRunWorktree).toHaveBeenCalledTimes(1)
    expect(l.startCoordinator).toHaveBeenCalledTimes(1)
    const run = orch.state().runs.find((x) => x.jobId === job.value.id)!
    expect(run).toMatchObject({ worktree: 'D:/wt-run', coordinatorSessionId: 'ses_coord' })
  })
  // Fix round 1, I1: risk-6's cleanup calls the Host's own removeWorktrees, which can itself throw
  // AppUnreachable (an unattached app is alive). That must never turn a spawn failure into a 409 —
  // "could not start the coordinator" is the true reason, and the app has nothing to do with it.
  it('keeps 400 for a failed coordinator start even when the risk-6 cleanup is itself refused', async () => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p', coordinatorAccountId: 'acc1' }, NOW); if (!job.ok) throw new Error(job.error)
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(job.state))
    const detached = new AppUnreachable('Astera is running but not connected to this Host')
    const l = local({
      startCoordinator: vi.fn(async () => { throw new Error('spawn failed') }),
      removeWorktrees: vi.fn(async () => { throw detached })
    })
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), local: l })
    const r = await orch.call({ cmd: 'run-start', args: { run: job.value.id }, sessionId: '' })
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toMatch(/could not start the coordinator: Error: spawn failed/)
    expect((r.body as { error: string }).error).toMatch(/could not be removed/)
    expect(orch.state().runs).toEqual([])
  })
  it('merges and removes a run\'s worktrees with no app, and a retried merge merges once', async () => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW); if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW); if (!run.ok) throw new Error(run.error)
    const task = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW); if (!task.ok) throw new Error(task.error)
    const opened = openDispatch(task.state, { taskId: task.value.id, provider: 'claude', accountId: 'acc1', sessionId: 'ses_w', cwd: 'D:/wt-a', specPath: '' }, NOW)
    if (!opened.ok) throw new Error(opened.error)
    const closed = closeDispatch(opened.state, { sessionId: 'ses_w', exitCode: 0 }, NOW); if (!closed.ok) throw new Error(closed.error)
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(closed.state))
    const l = local({ mergeWorktrees: vi.fn(async (_c: string, p: string[]) => ({ ok: true as const, merged: p, uncommitted: 0 })) })
    const act = vi.fn()
    const orch = orchOver({ hasApp: () => false, act, local: l })
    const first = await orch.call({ cmd: 'run-merge', args: { run: run.value.id }, sessionId: 'sesA', request: 'req-m' })
    const again = await orch.call({ cmd: 'run-merge', args: { run: run.value.id }, sessionId: 'sesA', request: 'req-m' })
    expect(first).toMatchObject({ status: 200, body: { merged: ['D:/wt-a'], uncommitted: 0 } })
    expect(again.replayed).toBe(true)
    expect(l.mergeWorktrees).toHaveBeenCalledTimes(1)
    expect(l.mergeWorktrees).toHaveBeenCalledWith('D:/p', ['D:/wt-a'])
    const deleted = await orch.call({ cmd: 'run-delete', args: { id: run.value.id, removeWorktrees: true }, sessionId: '' })
    expect(deleted.status).toBe(200)
    expect(l.removeWorktrees).toHaveBeenCalledWith(['D:/wt-a'])
    expect(act).not.toHaveBeenCalled()
  })
  // Fix round 2: the Host's own removeWorktrees throws AppUnreachable when an app is running but not
  // attached (worktrees.ts's DETACHED_APP) — that app's pid names a live process, so this is not "the
  // app could not be reached" and yet orchDeps maps it to the same conflict (4388931). End to end: the
  // command answers 409 and deletes no state, the way a merge failure already refuses to delete.
  it('answers 409 and deletes no state when the Host refuses removeWorktrees for an app it cannot ask', async () => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW); if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW); if (!run.ok) throw new Error(run.error)
    const task = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW); if (!task.ok) throw new Error(task.error)
    const opened = openDispatch(task.state, { taskId: task.value.id, provider: 'claude', accountId: 'acc1', sessionId: 'ses_w', cwd: 'D:/wt-a', specPath: '' }, NOW)
    if (!opened.ok) throw new Error(opened.error)
    const closed = closeDispatch(opened.state, { sessionId: 'ses_w', exitCode: 0 }, NOW); if (!closed.ok) throw new Error(closed.error)
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(closed.state))
    const detached = new AppUnreachable('Astera is running but not connected to this Host')
    const l = local({ removeWorktrees: vi.fn(async () => { throw detached }) })
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), local: l })
    const r = await orch.call({ cmd: 'run-delete', args: { id: run.value.id, removeWorktrees: true }, sessionId: '' })
    expect(r.status).toBe(409)
    expect(orch.state().runs.some((x) => x.id === run.value.id)).toBe(true)
    expect(orch.state().jobs.some((x) => x.id === job.value.id)).toBe(true)
  })
  // Fix round 1, I2: a refusal that closed or removed nothing yet keeps no receipt, so the same keyed
  // `run-delete` really does the removal once the reason clears (Astera quits) rather than replaying
  // the stale 409 for the rest of the Host's life.
  it('keeps no receipt for a keyed run-delete refused up front by a detached app, and the retry after it quits really removes the folder', async () => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW); if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW); if (!run.ok) throw new Error(run.error)
    const task = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW); if (!task.ok) throw new Error(task.error)
    const opened = openDispatch(task.state, { taskId: task.value.id, provider: 'claude', accountId: 'acc1', sessionId: 'ses_w', cwd: 'D:/wt-a', specPath: '' }, NOW)
    if (!opened.ok) throw new Error(opened.error)
    const closed = closeDispatch(opened.state, { sessionId: 'ses_w', exitCode: 0 }, NOW); if (!closed.ok) throw new Error(closed.error)
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(closed.state))
    let appAlive = true
    const l = local({
      removeWorktrees: vi.fn(async () => {
        if (appAlive) throw refusedBeforeActing(new AppUnreachable('Astera is running but not connected to this Host'))
        return { failed: [] }
      })
    })
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), local: l })
    const first = await orch.call({ cmd: 'run-delete', args: { id: run.value.id, removeWorktrees: true }, sessionId: 'sesA', request: 'req-d' })
    expect(first.status).toBe(409)
    // The app quits: the same reason no longer applies, and the same request id is sent again, as the
    // refusal itself said to.
    appAlive = false
    const again = await orch.call({ cmd: 'run-delete', args: { id: run.value.id, removeWorktrees: true }, sessionId: 'sesA', request: 'req-d' })
    expect(again.status).toBe(200)
    expect(again.replayed).toBeUndefined()
    expect(l.removeWorktrees).toHaveBeenCalledTimes(2)
    expect(orch.state().runs.some((x) => x.id === run.value.id)).toBe(false)
  })
  // The other half: a refusal that is not tagged might have half-acted, and keeps its receipt exactly
  // as every other HOST_LOCAL name's does.
  it('keeps its receipt for a keyed run-delete that failed after already acting', async () => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW); if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW); if (!run.ok) throw new Error(run.error)
    const task = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW); if (!task.ok) throw new Error(task.error)
    const opened = openDispatch(task.state, { taskId: task.value.id, provider: 'claude', accountId: 'acc1', sessionId: 'ses_w', cwd: 'D:/wt-a', specPath: '' }, NOW)
    if (!opened.ok) throw new Error(opened.error)
    const closed = closeDispatch(opened.state, { sessionId: 'ses_w', exitCode: 0 }, NOW); if (!closed.ok) throw new Error(closed.error)
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(closed.state))
    const l = local({ removeWorktrees: vi.fn(async () => { throw new Error('git left the tree dirty') }) })
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), local: l })
    const first = await orch.call({ cmd: 'run-delete', args: { id: run.value.id, removeWorktrees: true }, sessionId: 'sesA', request: 'req-y' })
    expect(first.status).toBe(500)
    const again = await orch.call({ cmd: 'run-delete', args: { id: run.value.id, removeWorktrees: true }, sessionId: 'sesA', request: 'req-y' })
    expect(again.replayed).toBe(true)
    expect(l.removeWorktrees).toHaveBeenCalledTimes(1)
  })
  // Host S3 follow-up A36: the three receipts below go through the real spawner, because what they
  // pin is where the spawner says "no process was started" and how the counted marks net out.
  /** A real Host spawner over a fake pty layer and fake worktrees, with the orchestration on top. */
  const realSpawner = async (worktrees: HostSpawnerDeps['worktrees'], spawnFails: () => boolean = () => false) => {
    for (const f of ['Astera.exe', 'cli.js']) await fs.writeFile(path.join(dir, f), '')
    await fs.mkdir(path.join(dir, 'skills'), { recursive: true })
    await fs.writeFile(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'acc1', label: 'one', configDir: path.join(dir, 'cfg'), color: '#888', createdAt: NOW, provider: 'claude' }] }))
    const spawned: { cwd: string }[] = []
    const registry = new PtyRegistry({
      spawn: (_file, _args, opts) => {
        if (spawnFails()) throw new Error('node-pty is incomplete')
        spawned.push({ cwd: opts.cwd })
        return { pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pause() {}, resume() {} }
      },
      log: () => {}
    })
    const box: { orch?: ReturnType<typeof orchOver>; current?: HostSpawner } = {}
    const make = (): HostSpawner => createHostSpawner({
      profileDir: dir,
      env: { PATH: process.env.PATH, ASTERA_HOST_CLI_EXEC: path.join(dir, 'Astera.exe'), ASTERA_HOST_CLI_ENTRY: path.join(dir, 'cli.js'), ASTERA_HOST_SKILLS: path.join(dir, 'skills') },
      platform: process.platform,
      homeDir: path.join(dir, 'home'),
      registry,
      broadcast: () => {},
      getState: () => box.orch!.state(),
      log: (m) => logs.push(m),
      appKeepsWorktrees: () => false,
      worktrees
    })!
    box.current = make()
    // The orchestration talks to whichever spawner is current, so a test can put a fresh one in
    // place of one that is retiring: the next Host, with the same receipts.
    const local = new Proxy({} as HostLocal, {
      get: (_t, k) => {
        const v = (box.current as unknown as Record<string | symbol, unknown>)[k]
        return typeof v === 'function' ? (v as (...xs: unknown[]) => unknown).bind(box.current) : v
      }
    })
    box.orch = orchOver({ hasApp: () => false, act: vi.fn(), local })
    return { orch: box.orch, spawned, spawner: () => box.current!, replaceSpawner: () => { box.current = make() } }
  }
  const coordinatorJob = async () => {
    const job = createJob(emptyState(), { objective: 'o', cwd: dir, coordinatorAccountId: 'acc1' }, NOW); if (!job.ok) throw new Error(job.error)
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(job.state))
    return job.value.id
  }
  it('keeps no receipt for a keyed run-start whose coordinator was refused before spawning and whose fresh worktree was removed, and the retry after the repair really starts', async () => {
    const jobId = await coordinatorJob()
    await fs.writeFile(path.join(dir, 'app-settings.json'), '{ not json')
    const runWt = path.join(dir, 'wt-run')
    const worktrees = { fork: vi.fn(), makeRunWorktree: vi.fn(async () => runWt), mergeWorktrees: vi.fn(), removeWorktrees: vi.fn(async () => ({ failed: [] as string[] })) }
    const { orch, spawned } = await realSpawner(worktrees)
    const first = await orch.call({ cmd: 'run-start', args: { run: jobId }, sessionId: 'sesA', request: 'req-rs' })
    expect(first.status).toBe(409)
    expect(first.body).toMatchObject({ repair: 'app-settings.json' })
    expect(worktrees.removeWorktrees).toHaveBeenCalledWith([runWt])
    expect(spawned).toEqual([])
    // The person repairs the file and sends the same request again, as the refusal said to.
    await fs.writeFile(path.join(dir, 'app-settings.json'), JSON.stringify({ agentPermissionMode: 'yolo' }))
    const again = await orch.call({ cmd: 'run-start', args: { run: jobId }, sessionId: 'sesA', request: 'req-rs' })
    expect(again.status).toBe(200)
    expect(again.replayed).toBeUndefined()
    expect(worktrees.makeRunWorktree).toHaveBeenCalledTimes(2)
    expect(spawned).toEqual([{ cwd: dir }])
    expect(orch.state().runs.find((r) => r.jobId === jobId)).toMatchObject({ worktree: runWt })
  })
  // The other half: a removal the in-use check refused leaves the fresh folder on disk, so that call
  // did leave something, and its receipt is kept.
  it('keeps its receipt for a keyed run-start whose coordinator was refused but whose fresh worktree is still in use', async () => {
    const jobId = await coordinatorJob()
    await fs.writeFile(path.join(dir, 'app-settings.json'), '{ not json')
    const runWt = path.join(dir, 'wt-run')
    const worktrees = { fork: vi.fn(), makeRunWorktree: vi.fn(async () => runWt), mergeWorktrees: vi.fn(), removeWorktrees: vi.fn(async (p: string[]) => ({ failed: p })) }
    const { orch, spawned } = await realSpawner(worktrees)
    const first = await orch.call({ cmd: 'run-start', args: { run: jobId }, sessionId: 'sesA', request: 'req-rs' })
    expect(first.status).toBe(409)
    expect((first.body as { error: string }).error).toMatch(/is still in use and was left behind/)
    await fs.writeFile(path.join(dir, 'app-settings.json'), JSON.stringify({ agentPermissionMode: 'yolo' }))
    const again = await orch.call({ cmd: 'run-start', args: { run: jobId }, sessionId: 'sesA', request: 'req-rs' })
    expect(again.replayed).toBe(true)
    expect(again.body).toEqual(first.body)
    expect(worktrees.makeRunWorktree).toHaveBeenCalledTimes(1)
    expect(spawned).toEqual([])
  })
  it('removes the fork of a keyed --worktree new worker whose spawn failed, answers the same error, and keeps no receipt', async () => {
    const { taskId } = await seed()
    const forkedDir = path.join(dir, 'wt-a'); await fs.mkdir(forkedDir)
    let failing = true
    const worktrees = { fork: vi.fn(async () => forkedDir), makeRunWorktree: vi.fn(), mergeWorktrees: vi.fn(), removeWorktrees: vi.fn(async () => ({ failed: [] as string[] })) }
    const { orch, spawned } = await realSpawner(worktrees, () => failing)
    const args = { ...worker(taskId, 'new'), name: 'n' }
    const first = await orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-w' })
    expect(first.status).toBe(400)
    expect((first.body as { error: string }).error).toBe('failed to start worker: Error: node-pty is incomplete')
    expect(worktrees.removeWorktrees).toHaveBeenCalledWith([forkedDir])
    expect(orch.state().dispatches).toEqual([])
    failing = false
    const again = await orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-w' })
    expect(again.status).toBe(200)
    expect(again.replayed).toBeUndefined()
    expect(worktrees.fork).toHaveBeenCalledTimes(2)
    expect(spawned).toEqual([{ cwd: forkedDir }])
  })
  // Follow-up round m6: a worker-start with no fork, refused by the settings file before any process
  // was started, is the same bug class as bug 1. Once the file is repaired the same id really starts.
  it('keeps no receipt for a keyed worker-start with no fork refused by a damaged settings file, and the retry after the repair starts', async () => {
    const { taskId } = await seed()
    await fs.writeFile(path.join(dir, 'app-settings.json'), '{ not json')
    const worktrees = { fork: vi.fn(), makeRunWorktree: vi.fn(), mergeWorktrees: vi.fn(), removeWorktrees: vi.fn() }
    const { orch, spawned } = await realSpawner(worktrees)
    const args = worker(taskId, dir)
    const first = await orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-s' })
    expect(first.status).toBe(409)
    expect(first.body).toMatchObject({ repair: 'app-settings.json' })
    expect(spawned).toEqual([])
    await fs.writeFile(path.join(dir, 'app-settings.json'), JSON.stringify({ agentPermissionMode: 'yolo' }))
    const again = await orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-s' })
    expect(again.status).toBe(200)
    expect(again.replayed).toBeUndefined()
    expect(spawned).toEqual([{ cwd: dir }])
  })
  // Follow-up round m2: the wider effect A36 accepted, pinned the way the no-app case is pinned the
  // other way. A start a retiring Host refused touched nothing, so the same id acts on the next Host.
  it('keeps no receipt for a keyed worker-start a retiring Host refused, and the retry on the next Host starts', async () => {
    const { taskId } = await seed()
    const worktrees = { fork: vi.fn(), makeRunWorktree: vi.fn(), mergeWorktrees: vi.fn(), removeWorktrees: vi.fn() }
    const { orch, spawned, spawner, replaceSpawner } = await realSpawner(worktrees)
    await spawner().closeAndSettle(1_000)
    const args = worker(taskId, dir)
    const first = await orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-r' })
    expect(first.status).toBe(409)
    expect(first.body).toMatchObject({ retry: 'host-retiring' })
    replaceSpawner()
    const again = await orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-r' })
    expect(again.status).toBe(200)
    expect(again.replayed).toBeUndefined()
    expect(spawned).toEqual([{ cwd: dir }])
  })
  it('keeps no receipt for a keyed run-start a retiring Host refused, and the retry on the next Host starts', async () => {
    const jobId = await coordinatorJob()
    const runWt = path.join(dir, 'wt-run')
    const worktrees = { fork: vi.fn(), makeRunWorktree: vi.fn(async () => runWt), mergeWorktrees: vi.fn(), removeWorktrees: vi.fn(async () => ({ failed: [] as string[] })) }
    const { orch, spawned, spawner, replaceSpawner } = await realSpawner(worktrees)
    await spawner().closeAndSettle(1_000)
    const first = await orch.call({ cmd: 'run-start', args: { run: jobId }, sessionId: 'sesA', request: 'req-rr' })
    expect(first.status).toBe(409)
    expect(worktrees.removeWorktrees).toHaveBeenCalledWith([runWt])
    replaceSpawner()
    const again = await orch.call({ cmd: 'run-start', args: { run: jobId }, sessionId: 'sesA', request: 'req-rr' })
    expect(again.status).toBe(200)
    expect(again.replayed).toBeUndefined()
    expect(spawned).toEqual([{ cwd: dir }])
  })
  // The damaged worktrees.json refusal is tagged in worktrees.ts's fresh() (worktrees.test.ts pins the
  // tag); here the fork throws it the way fresh() does, and the start passes it through.
  it('keeps no receipt for a keyed --worktree new worker whose fork a damaged worktrees.json refused, and the retry forks and starts', async () => {
    const { taskId } = await seed()
    const forkedDir = path.join(dir, 'wt-a'); await fs.mkdir(forkedDir)
    let damaged = true
    const fork = vi.fn(async () => {
      if (damaged) throw refusedBeforeActing(new RepairNeeded('worktrees.json is damaged; quit and reopen Astera', 'worktrees.json'))
      return forkedDir
    })
    const worktrees = { fork, makeRunWorktree: vi.fn(), mergeWorktrees: vi.fn(), removeWorktrees: vi.fn(async () => ({ failed: [] as string[] })) }
    const { orch, spawned } = await realSpawner(worktrees)
    const args = { ...worker(taskId, 'new'), name: 'n' }
    const first = await orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-f' })
    expect(first.status).toBe(409)
    expect(first.body).toMatchObject({ repair: 'worktrees.json' })
    damaged = false
    const again = await orch.call({ cmd: 'worker-start', args, sessionId: 'sesA', request: 'req-f' })
    expect(again.status).toBe(200)
    expect(again.replayed).toBeUndefined()
    expect(worktrees.removeWorktrees).not.toHaveBeenCalled()
    expect(spawned).toEqual([{ cwd: forkedDir }])
  })
  // Follow-up round m1: two concurrent starts receive one and the same rejection, the way two first
  // spawns share a `once()` setup promise. The start that left nothing is tagged; the other, standing
  // in for a start whose fork is still on disk, must keep its receipt.
  it('tags only the start that left nothing when two concurrent starts share one rejection', async () => {
    const jobId = await coordinatorJob()
    const seeded = JSON.parse(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')) as OrchState
    const job = createJob(seeded, { objective: 'w', cwd: 'D:/p' }, NOW); if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW); if (!run.ok) throw new Error(run.error)
    const task = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW); if (!task.ok) throw new Error(task.error)
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(task.state))
    const shared = new Error('statusline files could not be written')
    let coordinatorThrew!: () => void
    const coordinatorDone = new Promise<void>((r) => { coordinatorThrew = r })
    const tagged: unknown[] = []
    const l = local({
      startCoordinator: vi.fn(async () => {
        const err = refusedBeforeActing(shared)
        tagged.push(err)
        coordinatorThrew()
        throw err
      }),
      startWorker: vi.fn(async () => { await coordinatorDone; throw shared })
    })
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), local: l })
    const [started, worked] = await Promise.all([
      orch.call({ cmd: 'run-start', args: { run: jobId }, sessionId: 'sesA', request: 'req-c' }),
      orch.call({ cmd: 'worker-start', args: worker(task.value.id), sessionId: 'sesA', request: 'req-w' })
    ])
    expect(started.status).toBe(400)
    expect(worked.status).toBe(400)
    expect(wasRefusedBeforeActing(tagged[0])).toBe(true)
    expect(leftNothingBehind(shared)).toBe(false)
    const again = await orch.call({ cmd: 'worker-start', args: worker(task.value.id), sessionId: 'sesA', request: 'req-w' })
    expect(again.replayed).toBe(true)
    expect(l.startWorker).toHaveBeenCalledTimes(1)
  })
  it('routes the worktree-* calls to the Host worktrees, app or not, and refuses a request id on them', async () => {
    const call = vi.fn(async () => ({ status: 200, body: { file: { items: [] } } }))
    const orch = orchOver({ worktrees: { call } })
    const from = { role: 'app' as const, toOthers: () => {} }
    expect((await orch.call({ cmd: 'worktree-list', args: {}, sessionId: '', from })).status).toBe(200)
    expect(call).toHaveBeenCalledWith('worktree-list', {}, from)
    expect((await orch.call({ cmd: 'worktree-add', args: {}, sessionId: '', from, request: 'r1' })).status).toBe(400)
    expect((await orchOver().call({ cmd: 'worktree-list', args: {}, sessionId: '', from })).status).toBe(501)
  })
  // Receipts replay safety.
  it('spawns once for a worker-start retried under the same request id', async () => {
    const { taskId } = await seed()
    const l = local()
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), local: l })
    const first = await orch.call({ cmd: 'worker-start', args: worker(taskId), sessionId: 'sesA', request: 'req-1' })
    const second = await orch.call({ cmd: 'worker-start', args: worker(taskId), sessionId: 'sesA', request: 'req-1' })
    expect(first.status).toBe(200)
    expect(second.replayed).toBe(true)
    expect(l.startWorker).toHaveBeenCalledTimes(1)
  })
  /** The six HOST_DRIVES names as no-ops, and the rest of HostChecks beside them so the type holds. */
  const noChecks = (): HostChecks => ({
    startValidation: vi.fn(), startReview: vi.fn(), startRepair: vi.fn(),
    repairTargetFor: vi.fn(() => null), repairOnce: vi.fn(async () => ({ ok: true as const })), lang: vi.fn(async () => 'en' as const),
    stopValidation: vi.fn(() => false), stopForeignValidations: vi.fn(async () => 0), checking: vi.fn(() => false), resumeSweep: vi.fn(), langNow: vi.fn(() => 'en' as const),
    accounts: vi.fn(async () => []), loginStatus: vi.fn(async () => false)
  })
  /** R10's fixture: a --validate Task whose Host-spawned worker has just reported, with no app. */
  const reportWithNoApp = async (drive: Parameters<typeof createHostOrch>[0]['drive']) => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW); if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW); if (!run.ok) throw new Error(run.error)
    const task = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [], validateConfigIds: ['seed:npm:test'] }, NOW)
    if (!task.ok) throw new Error(task.error)
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(task.state))
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), local: local(), drive })
    const started = await orch.call({ cmd: 'worker-start', args: worker(task.value.id), sessionId: '' })
    expect(started.status).toBe(200)
    const dispatchId = (started.body as { dispatchId: string }).dispatchId
    const done = await orch.call({
      cmd: 'send',
      args: { type: 'worker_done', taskId: task.value.id, dispatchId, outcome: 'succeeded', subject: 's' },
      sessionId: 'ses_host'
    })
    expect(done.status).toBe(200)
    return { orch, task, run }
  }
  // R10's successor: with no app, the Host runs the check itself, and the Task reads validated only
  // after the check passed.
  it('validates a --validate Task in the Host after its worker reports, with no app', async () => {
    const startValidation = vi.fn()
    const { orch, task } = await reportWithNoApp({ owns: () => true, checks: { ...noChecks(), startValidation } })
    expect(orch.state().tasks.find((t) => t.id === task.value.id)?.status).toBe('validating')
    expect(startValidation).toHaveBeenCalledWith({ taskId: task.value.id, cwd: expect.any(String) })
    expect(logs.some((l) => l.startsWith('startValidation was not forwarded'))).toBe(false)
  })
  it('still leaves it validating, and says so, when the Host does not drive and no app is attached', async () => {
    const checks = noChecks()
    const { orch, task, run } = await reportWithNoApp({ owns: () => false, checks })
    expect(orch.state().tasks.find((t) => t.id === task.value.id)?.status).toBe('validating')
    expect(outcomeOf(orch.state(), run.value.id)).toBe('running')
    // Nobody drives, so nothing runs the check or fakes one: logged as not forwarded.
    expect(logs.some((l) => l.startsWith('startValidation was not forwarded'))).toBe(true)
    expect(checks.startValidation).not.toHaveBeenCalled()
  })
  it('answers validation-stop for the app only', async () => {
    const validationStop = vi.fn(() => true)
    const orch = orchOver({ validationStop })
    const app = { role: 'app' as const, toOthers: () => {} }
    expect((await orch.call({ cmd: 'validation-stop', args: { runId: 'r1' }, sessionId: '', from: app })).body).toEqual({ stopped: true })
    expect((await orch.call({ cmd: 'validation-stop', args: { runId: 'r1' }, sessionId: '', from: { role: 'cli', toOthers: () => {} } })).status).toBe(403)
    expect((await orchOver().call({ cmd: 'validation-stop', args: { runId: 'r1' }, sessionId: '', from: app })).status).toBe(501)
    // Beside the worktree-* calls: no string runId is a bad call, and a request id on it is refused.
    expect((await orch.call({ cmd: 'validation-stop', args: {}, sessionId: '', from: app })).status).toBe(400)
    expect((await orch.call({ cmd: 'validation-stop', args: { runId: 'r1' }, sessionId: '', from: app, request: 'q1' })).status).toBe(400)
    expect(validationStop).toHaveBeenCalledTimes(1)
    expect(validationStop).toHaveBeenCalledWith('r1')
  })
  it('answers roll-state and roll-force for the app only (S6 §3.4)', async () => {
    const event = { sessionId: 's1', state: 'waiting' as const, nextRetryAt: '2026-09-25T10:00:00.000Z' }
    const rolling = { unregister: vi.fn(), stateOf: vi.fn((id: string) => (id === 's1' ? event : null)), forceRoll: vi.fn(async (_id: string) => false), has: (id: string) => id === 's1' }
    const orch = orchOver({ rolling })
    const app = { role: 'app' as const, toOthers: () => {} }
    const cli = { role: 'cli' as const, toOthers: () => {} }
    expect((await orch.call({ cmd: 'roll-state', args: { sessionId: 's1' }, sessionId: '', from: app })).body).toEqual({ state: event })
    expect((await orch.call({ cmd: 'roll-state', args: { sessionId: 's2' }, sessionId: '', from: app })).body).toEqual({ state: null })
    expect((await orch.call({ cmd: 'roll-state', args: { sessionId: 's1' }, sessionId: '', from: cli })).status).toBe(403)
    rolling.forceRoll.mockResolvedValueOnce(true)
    expect((await orch.call({ cmd: 'roll-force', args: { sessionId: 's1' }, sessionId: '', from: app })).body).toEqual({ forced: true })
    // A chain that declined (here it waits) answers 200 with forced:false and why (S6 final review M1).
    rolling.forceRoll.mockResolvedValueOnce(false)
    const quiet = await orch.call({ cmd: 'roll-force', args: { sessionId: 's1' }, sessionId: '', from: app })
    expect(quiet.status).toBe(200)
    expect(quiet.body).toMatchObject({ forced: false, why: expect.stringContaining('roll state: waiting') })
    expect((await orch.call({ cmd: 'roll-force', args: { sessionId: 's9' }, sessionId: '', from: app })).status).toBe(404)
    expect((await orchOver().call({ cmd: 'roll-state', args: { sessionId: 's1' }, sessionId: '', from: app })).status).toBe(501)
    expect((await orch.call({ cmd: 'roll-state', args: {}, sessionId: '', from: app })).status).toBe(400)
  })
  it('answers roll-journal for the app only, with the entries after the ack (S6 limits D5)', async () => {
    const entry = { seq: 3, at: '2026-09-25T00:00:00.000Z', kind: 'rolled' as const, sessionId: 's2', oldSessionId: 's1' }
    const rollJournal = { take: vi.fn(async (_ack?: number) => ({ entries: [entry], lastSeq: 3 })) }
    const orch = orchOver({ rollJournal })
    const app = { role: 'app' as const, toOthers: () => {} }
    const cli = { role: 'cli' as const, toOthers: () => {} }
    const got = await orch.call({ cmd: 'roll-journal', args: {}, sessionId: '', from: app })
    expect(got).toMatchObject({ status: 200, body: { entries: [entry], lastSeq: 3 } })
    expect(rollJournal.take).toHaveBeenLastCalledWith(undefined)
    expect((await orch.call({ cmd: 'roll-journal', args: { ack: 2 }, sessionId: '', from: app })).status).toBe(200)
    expect(rollJournal.take).toHaveBeenLastCalledWith(2)
    expect((await orch.call({ cmd: 'roll-journal', args: {}, sessionId: '', from: cli })).status).toBe(403)
    expect((await orch.call({ cmd: 'roll-journal', args: {}, sessionId: '' })).status).toBe(403)
    expect((await orchOver().call({ cmd: 'roll-journal', args: {}, sessionId: '', from: app })).status).toBe(501)
    for (const ack of [-1, 1.5, '2', null, Number.NaN])
      expect((await orch.call({ cmd: 'roll-journal', args: { ack }, sessionId: '', from: app })).status).toBe(400)
    expect((await orch.call({ cmd: 'roll-journal', args: {}, sessionId: '', from: app, request: 'q1' })).status).toBe(400)
    expect(rollJournal.take).toHaveBeenCalledTimes(2)
  })
  // Review M2 of Task 9: a worker whose pty is app-local is the app's to kill. With no app the stop is
  // refused, and the Dispatch is not marked stopped over a worker that is still running.
  it('forwards the stop of a worker the Host does not hold, and refuses it honestly with no app', async () => {
    const { taskId } = await seed()
    const l = local({ owns: (name) => name !== 'releaseWorker' })
    let app = true
    const act = vi.fn().mockResolvedValue(undefined)
    const orch = orchOver({ hasApp: () => app, act, local: l })
    const started = await orch.call({ cmd: 'worker-start', args: worker(taskId), sessionId: '' })
    const dispatchId = (started.body as { dispatchId: string }).dispatchId
    app = false
    const refused = await orch.call({ cmd: 'worker-stop', args: { dispatch: dispatchId }, sessionId: '' })
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toContain('APP_REQUIRED')
    expect(l.releaseWorker).not.toHaveBeenCalled()
    expect(orch.state().dispatches[0].workerState).not.toBe('stopped')
    app = true
    const stopped = await orch.call({ cmd: 'worker-stop', args: { dispatch: dispatchId }, sessionId: '' })
    expect(stopped.status).toBe(200)
    expect(act).toHaveBeenCalledWith('releaseWorker', [{ dispatchId }])
    expect(l.releaseWorker).not.toHaveBeenCalled()
  })
  it('behaves exactly as before with no spawner: worker-start with no app is refused', async () => {
    const { taskId } = await seed()
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), local: null })
    const r = await orch.call({ cmd: 'worker-start', args: worker(taskId), sessionId: '' })
    expect(r.status).toBe(409)
    expect(orch.state().dispatches).toEqual([])
  })
})

/**
 * **A profile file only the app can repair refuses as a conflict that names the file** (Task 11 fix
 * round, I1 and I2). Through the real spawner, so the accounts.json the spawner reads itself and the
 * settings file it reads at the spawn are both on the path: 409 (exit 6), `repair: <file>` in the body,
 * the reader's own message, and no Dispatch left. Never 400: an agent told its arguments are wrong
 * edits the one thing that was right.
 */
describe('repair refusals (S2)', () => {
  const ACCOUNTS = JSON.stringify({ accounts: [{ id: 'acc1', label: 'one', configDir: 'D:/cfg', color: '#888', createdAt: NOW, provider: 'claude' }] })
  const withSpawner = async () => {
    for (const f of ['Astera.exe', 'cli.js']) await fs.writeFile(path.join(dir, f), '')
    await fs.mkdir(path.join(dir, 'skills'), { recursive: true })
    const registry = new PtyRegistry({
      spawn: () => ({ pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pause() {}, resume() {} }),
      log: () => {}
    })
    const box: { orch?: ReturnType<typeof orchOver> } = {}
    const spawner = createHostSpawner({
      profileDir: dir,
      env: { PATH: process.env.PATH, ASTERA_HOST_CLI_EXEC: path.join(dir, 'Astera.exe'), ASTERA_HOST_CLI_ENTRY: path.join(dir, 'cli.js'), ASTERA_HOST_SKILLS: path.join(dir, 'skills') },
      platform: process.platform,
      homeDir: path.join(dir, 'home'),
      registry,
      broadcast: () => {},
      getState: () => box.orch!.state(),
      log: () => {},
      appKeepsWorktrees: () => false,
      worktrees: { fork: () => Promise.reject(new Error('not in this test')), makeRunWorktree: vi.fn(), mergeWorktrees: vi.fn(), removeWorktrees: vi.fn() }
    })
    expect(spawner).not.toBeNull()
    box.orch = orchOver({ hasApp: () => false, act: vi.fn(), local: spawner })
    return box.orch
  }
  const worker = (taskId: string) => ({ task: taskId, agent: 'claude', account: 'acc1', worktree: 'current' })
  const refusedForRepair = (r: { status: number; body: unknown }, file: string) => {
    expect(r.status).toBe(409)
    expect(exitCodeFor(codeForStatus(r.status))).toBe(6)
    expect(r.body).toMatchObject({ repair: file })
    expect((r.body as { error: string }).error).toMatch(/open Astera to repair it/)
  }

  it('answers a Host-local worker-start over a corrupt accounts.json with 409 and repair, leaving no Dispatch', async () => {
    const { taskId } = await seed()
    await fs.writeFile(path.join(dir, 'accounts.json'), '{not json')
    const orch = await withSpawner()
    refusedForRepair(await orch.call({ cmd: 'worker-start', args: worker(taskId), sessionId: '' }), 'accounts.json')
    expect(orch.state().dispatches).toEqual([])
    // Said as what it was, a refusal here, not as a question the app was asked.
    expect(logs.some((l) => l.includes('startWorker refused by the Host') && l.includes('accounts.json'))).toBe(true)
    expect(logs.some((l) => l.includes('startWorker could not be put to the app'))).toBe(false)
  })

  it('answers a Host-local worker-start over a corrupt app-settings.json with 409 and repair', async () => {
    const { taskId } = await seed()
    await fs.writeFile(path.join(dir, 'accounts.json'), ACCOUNTS)
    await fs.writeFile(path.join(dir, 'app-settings.json'), '{not json')
    const orch = await withSpawner()
    const r = await orch.call({ cmd: 'worker-start', args: worker(taskId), sessionId: '' })
    refusedForRepair(r, 'app-settings.json')
    expect((r.body as { error: string }).error).toMatch(/the Host will not start a session/)
    expect(orch.state().dispatches).toEqual([])
  })

  it('answers a Host-local run-start over a corrupt accounts.json with 409 and repair', async () => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p', coordinatorAccountId: 'acc1' }, NOW); if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW); if (!run.ok) throw new Error(run.error)
    const tree = setRunWorktree(run.state, run.value.id, 'D:/wt'); if (!tree.ok) throw new Error(tree.error)
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(tree.state))
    await fs.writeFile(path.join(dir, 'accounts.json'), '{not json')
    const orch = await withSpawner()
    refusedForRepair(await orch.call({ cmd: 'run-start', args: { run: job.value.id }, sessionId: '' }), 'accounts.json')
  })

  it('answers accounts and run configurations read from a corrupt file with 409 and repair', async () => {
    await fs.writeFile(path.join(dir, 'accounts.json'), '{not json')
    await fs.writeFile(path.join(dir, 'run-configs.json'), '{not json')
    const orch = orchOver({ hasApp: () => false, act: vi.fn() })
    refusedForRepair(await orch.call({ cmd: 'accounts-list', args: {}, sessionId: '' }), 'accounts.json')
    const job = await orch.call({ cmd: 'jobs-create', args: { objective: 'o', cwd: 'D:/p' }, sessionId: '' })
    refusedForRepair(
      await orch.call({ cmd: 'run-configs-list', args: { job: (job.body as { id: string }).id }, sessionId: '' }),
      'run-configs.json'
    )
  })

  it('carries no repair on a 409 that is not one', async () => {
    const { taskId } = await seed()
    const r = await orchOver({ hasApp: () => false, act: vi.fn() }).call({ cmd: 'worker-start', args: worker(taskId), sessionId: '' })
    expect(r.status).toBe(409)
    expect(r.body).not.toHaveProperty('repair')
  })
})

// §8.4, R8, through the real spawner: a worker-start that reaches a Host already on its way out is
// refused, and the command rolls its Dispatch back, so nothing is left half written.
describe('a retiring Host refuses new spawns (S2)', () => {
  it('answers worker-start with an error and leaves no Dispatch once the spawner is closed', async () => {
    const { taskId } = await seed()
    for (const f of ['Astera.exe', 'cli.js']) await fs.writeFile(path.join(dir, f), '')
    await fs.mkdir(path.join(dir, 'skills'), { recursive: true })
    await fs.writeFile(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'acc1', label: 'one', configDir: 'D:/cfg', color: '#888', createdAt: NOW, provider: 'claude' }] }))
    const spawned: string[] = []
    const registry = new PtyRegistry({
      spawn: (file) => { spawned.push(file); return { pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pause() {}, resume() {} } },
      log: () => {}
    })
    const box: { orch?: ReturnType<typeof orchOver> } = {}
    const spawner = createHostSpawner({
      profileDir: dir,
      env: { PATH: process.env.PATH, ASTERA_HOST_CLI_EXEC: path.join(dir, 'Astera.exe'), ASTERA_HOST_CLI_ENTRY: path.join(dir, 'cli.js'), ASTERA_HOST_SKILLS: path.join(dir, 'skills') },
      platform: process.platform,
      homeDir: path.join(dir, 'home'),
      registry,
      broadcast: () => {},
      getState: () => box.orch!.state(),
      log: () => {},
      appKeepsWorktrees: () => false,
      worktrees: { fork: () => Promise.reject(new Error('not in this test')), makeRunWorktree: vi.fn(), mergeWorktrees: vi.fn(), removeWorktrees: vi.fn() }
    })!
    box.orch = orchOver({ hasApp: () => false, act: vi.fn(), local: spawner })
    await spawner.closeAndSettle(1_000)
    const r = await box.orch.call({ cmd: 'worker-start', args: { task: taskId, agent: 'claude', account: 'acc1', worktree: 'current' }, sessionId: '' })
    expect(r.status).toBe(409)
    expect(exitCodeFor(codeForStatus(r.status))).toBe(6)
    expect((r.body as { retry?: string }).retry).toBe('host-retiring')
    expect((r.body as { error: string }).error).toMatch(/the Host is retiring/)
    expect(box.orch.state().dispatches).toEqual([])
    expect(spawned).toEqual([])
  })
})

describe('the spec sweep at the Host load (S2)', () => {
  it('sweeps stale spec files once, at its own load, where it is the only writer (§2.7)', async () => {
    await seed()
    const specs = path.join(dir, 'orch', 'specs'); await fs.mkdir(specs, { recursive: true })
    await fs.writeFile(path.join(specs, 'stale.md'), 'x')
    const orch = orchOver({ specsDir: specs })
    await orch.ready()
    expect(await fs.readdir(specs)).toEqual([])
  })
  it('sweeps nothing when it was given no specs folder — a Host that does not spawn leaves it to the app', async () => {
    await seed()
    const specs = path.join(dir, 'orch', 'specs'); await fs.mkdir(specs, { recursive: true })
    await fs.writeFile(path.join(specs, 'stale.md'), 'x')
    await orchOver().ready()
    expect(await fs.readdir(specs)).toEqual(['stale.md'])
  })
})

describe('the Host handles exits (S2)', () => {
  /** One Job, one Run, and one open Dispatch per session id given, each on its own Task. */
  const withDispatches = (sessionIds: string[]): { state: OrchState; runId: string; taskIds: string[] } => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW); if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW); if (!run.ok) throw new Error(run.error)
    let state = run.state
    const taskIds: string[] = []
    for (const sessionId of sessionIds) {
      const task = createTask(state, { runId: run.value.id, title: sessionId, spec: 's', deps: [] }, NOW); if (!task.ok) throw new Error(task.error)
      const dsp = openDispatch(task.state, { taskId: task.value.id, provider: 'claude', accountId: 'acc1', sessionId, cwd: 'D:/p', specPath: 'D:/p/s.md' }, NOW)
      if (!dsp.ok) throw new Error(dsp.error)
      state = dsp.state
      taskIds.push(task.value.id)
    }
    return { state, runId: run.value.id, taskIds }
  }
  const write = (s: OrchState): Promise<void> => fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(s), 'utf8')

  it('sessionExited closes the open Dispatch of that session and keeps the Task for a retry', async () => {
    const { state, taskIds } = withDispatches(['ses_x'])
    await write(state)
    // Alive at load, as a Host-held worker is: otherwise the restart cleanup closes it first.
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), aliveSessionIds: () => new Set(['ses_x']) })
    await orch.sessionExited({ sessionId: 'ses_x', exitCode: 1 })
    const d = orch.state().dispatches.find((x) => x.sessionId === 'ses_x')
    expect(d?.endedAt).toBe(NOW)
    expect(d?.workerState).toBe('failed')
    expect(orch.state().tasks.find((t) => t.id === taskIds[0])?.status).toBe('dispatched')
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'orchestration.json'), 'utf8')) as OrchState
    expect(saved.dispatches[0].endedAt).toBe(NOW)
  })

  it('sessionExited empties a coordinator slot held by that session', async () => {
    const { state, runId } = withDispatches([])
    const attached = attachCoordinator(state, { runId, sessionId: 'ses_c' }); if (!attached.ok) throw new Error(attached.error)
    await write(attached.state)
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), aliveSessionIds: () => new Set(['ses_c']) })
    await orch.sessionExited({ sessionId: 'ses_c', exitCode: 0 })
    expect(orch.state().runs.find((r) => r.id === runId)?.coordinatorSessionId).toBeUndefined()
    expect(logs).toContain(`coordinator gone run=${runId} session=ses_c — restart it from the Jobs list`)
  })

  // Review of Task 12, M3: releaseCoordinator's rule, whole. An exit that only says the session was
  // lost sight of keeps the slot, as handleExit keeps the Dispatch.
  it('sessionExited keeps a coordinator slot on an exit that only says the session was lost sight of', async () => {
    const { state, runId } = withDispatches([])
    const attached = attachCoordinator(state, { runId, sessionId: 'ses_c' }); if (!attached.ok) throw new Error(attached.error)
    await write(attached.state)
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), aliveSessionIds: () => new Set(['ses_c']) })
    await orch.sessionExited({ sessionId: 'ses_c', exitCode: PTY_LOST_SIGHT_EXIT_CODE })
    expect(orch.state().runs.find((r) => r.id === runId)?.coordinatorSessionId).toBe('ses_c')
  })

  // Review of Task 12, M8: the app's mirror hears the closure.
  it('pushes the state sessionExited commits to the clients', async () => {
    const { state } = withDispatches(['ses_x'])
    await write(state)
    const pushed: OrchState[] = []
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), aliveSessionIds: () => new Set(['ses_x']), onState: (s) => pushed.push(s) })
    await orch.sessionExited({ sessionId: 'ses_x', exitCode: 1 })
    expect(pushed.at(-1)?.dispatches[0].endedAt).toBe(NOW)
  })

  it('orphanedSessions is empty before the first load, then names dead sessions but never pending ones', async () => {
    const { state, runId } = withDispatches(['ses_dead', 'pending:ab', 'ses_alive'])
    // The dead worker's session also holds the coordinator slot: named once.
    const attached = attachCoordinator(state, { runId, sessionId: 'ses_dead' }); if (!attached.ok) throw new Error(attached.error)
    await write(attached.state)
    const orch = orchOver({ aliveSessionIds: () => new Set(['ses_dead', 'pending:ab', 'ses_alive']) })
    const isAlive = (s: string): boolean => s === 'ses_alive'
    expect(orch.orphanedSessions(isAlive)).toEqual([])
    await orch.ready()
    expect(orch.orphanedSessions(isAlive)).toEqual(['ses_dead'])
  })

  it('orphanedSessions reads the state an app pushed, with no load of its own', async () => {
    const { state } = withDispatches(['ses_dead'])
    const orch = orchOver()
    await orch.call({ cmd: 'state-put', args: { state }, sessionId: '', from: { role: 'app', toOthers: () => {} } })
    expect(orch.orphanedSessions(() => false)).toEqual(['ses_dead'])
  })

  it('names a dead coordinator slot with no open Dispatch', async () => {
    const { state, runId } = withDispatches([])
    const attached = attachCoordinator(state, { runId, sessionId: 'ses_c' }); if (!attached.ok) throw new Error(attached.error)
    await write(attached.state)
    const orch = orchOver({ aliveSessionIds: () => new Set(['ses_c']) })
    await orch.ready()
    expect(orch.orphanedSessions(() => false)).toEqual(['ses_c'])
  })

  it('rekeys to the session a live pty says was rolled from this one, instead of closing (S6 R7, Review Focus 2)', async () => {
    const { state } = withDispatches(['ses_old'])
    await write(state)
    const rekeyRolled = vi.fn(async () => {})
    const orch = orchOver({
      hasApp: () => false,
      act: vi.fn(),
      aliveSessionIds: () => new Set(['ses_old']),
      rolledInto: (id) => (id === 'ses_old' ? { id: 'ses_new', accountId: 'acc2' } : null),
      rekeyRolled
    })
    await orch.sessionExited({ sessionId: 'ses_old', exitCode: 1 })
    expect(rekeyRolled).toHaveBeenCalledWith('ses_old', { id: 'ses_new', accountId: 'acc2' })
    expect(orch.state().dispatches.find((x) => x.sessionId === 'ses_old')?.endedAt).toBeUndefined()
  })
  // Task 11 review, carried to Task 16: a rekey that left the Dispatch on the old id is not reported as
  // one that landed.
  it('a rekey that leaves the Dispatch on the old id says the rekey did not land (Task 11 review)', async () => {
    const { state } = withDispatches(['ses_old'])
    await write(state)
    const orch = orchOver({
      hasApp: () => false,
      act: vi.fn(),
      aliveSessionIds: () => new Set(['ses_old']),
      rolledInto: (id) => (id === 'ses_old' ? { id: 'ses_new', accountId: 'acc2' } : null),
      rekeyRolled: vi.fn(async () => {})
    })
    await orch.sessionExited({ sessionId: 'ses_old', exitCode: 1 })
    expect(logs.some((m) => m.includes('rekeyed, not closed'))).toBe(false)
    expect(logs).toContain('session ses_old was rolled into ses_new — the rekey did not land, the Dispatch stays on the old id')
  })
  it('with nothing rolled from it, the exit closes the Dispatch as before', async () => {
    const { state } = withDispatches(['ses_x'])
    await write(state)
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), aliveSessionIds: () => new Set(['ses_x']), rolledInto: () => null, rekeyRolled: vi.fn() })
    await orch.sessionExited({ sessionId: 'ses_x', exitCode: 1 })
    expect(orch.state().dispatches[0].endedAt).toBe(NOW)
  })

  // S6 R14, the Host half: a real coordinator exit empties its slot by the app's rule
  // (`coordinatorReleaseOf`), and only after the exit defer, which host/exits.ts owns: the Host's
  // `sessionExited` is that defer's callback, so a roll's rekey always lands first.
  it('a real Host coordinator exit releases the slot only after the exit defer (S6 R14)', async () => {
    const { state, runId } = withDispatches([])
    const attached = attachCoordinator(state, { runId, sessionId: 'ses_c' }); if (!attached.ok) throw new Error(attached.error)
    await write(attached.state)
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), aliveSessionIds: () => new Set(['ses_c']), rolledInto: () => null, rekeyRolled: vi.fn() })
    await orch.ready()
    let exitPty: (code: number) => void = () => {}
    const registry = new PtyRegistry({
      spawn: () => ({ pid: 1, onData() {}, onExit(cb) { exitPty = (exitCode) => cb({ exitCode }) }, write() {}, resize() {}, kill() {}, pause() {}, resume() {} }),
      log: () => {}
    })
    createHostExits({ registry, sessionExited: (e) => orch.sessionExited(e), orphanedSessions: () => [], log: () => {} })
    const opened = registry.open({ id: 'pc', file: 'cmd.exe', args: [], opts: { cwd: 'D:/p', cols: 80, rows: 24, env: {} }, meta: { kind: 'session', id: 'ses_c', restore: {} } })
    if (!opened.ok) throw new Error(opened.error)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      exitPty(0)
      await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS - 1)
      expect(orch.state().runs.find((r) => r.id === runId)?.coordinatorSessionId).toBe('ses_c')
      await vi.advanceTimersByTimeAsync(1)
    } finally {
      vi.useRealTimers()
    }
    // The store moves memory before the disk write the log line waits on, so both are waited for.
    await vi.waitFor(() => expect(logs).toContain(`coordinator gone run=${runId} session=ses_c — restart it from the Jobs list`))
    expect(orch.state().runs.find((r) => r.id === runId)?.coordinatorSessionId).toBeUndefined()
  })

  // S6 R14 with R7: the slot follows the roll, through the Host's own roll tap. Never released.
  it('a coordinator a live pty says was rolled from this one keeps its slot: rekeyed, not released (S6 R14, R7)', async () => {
    const { state, runId } = withDispatches([])
    const attached = attachCoordinator(state, { runId, sessionId: 'ses_c' }); if (!attached.ok) throw new Error(attached.error)
    await write(attached.state)
    const box: { orch?: ReturnType<typeof orchOver> } = {}
    const tap = createHostRollTap({ orch: () => box.orch!, retarget: vi.fn(), log: (m) => logs.push(m), now: () => NOW })
    box.orch = orchOver({
      hasApp: () => false,
      act: vi.fn(),
      aliveSessionIds: () => new Set(['ses_c']),
      rolledInto: (id) => (id === 'ses_c' ? { id: 'ses_c2', accountId: 'acc2' } : null),
      rekeyRolled: (old, info) => tap.onRolled(old, info)
    })
    await box.orch.sessionExited({ sessionId: 'ses_c', exitCode: 1 })
    expect(box.orch.state().runs.find((r) => r.id === runId)?.coordinatorSessionId).toBe('ses_c2')
    expect(logs.some((m) => m.startsWith('coordinator gone'))).toBe(false)
    expect(logs).toContain('session ses_c was rolled into ses_c2 — rekeyed, not closed')
  })

  // Preflight C13: every Host respawn carries rolledFrom, so the old pty's exit reaches the rolledFrom
  // branch after the Host's own tap already rekeyed. The second call finds nothing on the old id.
  it('after the Host’s own roll already rekeyed, the old pty’s exit rekeys nothing again and says so (preflight C13)', async () => {
    const { state, runId } = withDispatches(['ses_w2'])
    const attached = attachCoordinator(state, { runId, sessionId: 'ses_c2' }); if (!attached.ok) throw new Error(attached.error)
    await write(attached.state)
    const rekeyRolled = vi.fn(async () => {})
    const orch = orchOver({
      hasApp: () => false,
      act: vi.fn(),
      aliveSessionIds: () => new Set(['ses_c2', 'ses_w2']),
      rolledInto: (id) => (id === 'ses_c' ? { id: 'ses_c2', accountId: 'acc2' } : id === 'ses_w' ? { id: 'ses_w2', accountId: 'acc2' } : null),
      rekeyRolled
    })
    await orch.sessionExited({ sessionId: 'ses_c', exitCode: 1 })
    await orch.sessionExited({ sessionId: 'ses_w', exitCode: 1 })
    expect(rekeyRolled).not.toHaveBeenCalled()
    expect(orch.state().runs.find((r) => r.id === runId)?.coordinatorSessionId).toBe('ses_c2')
    expect(orch.state().dispatches[0].endedAt).toBeUndefined()
    expect(logs.some((m) => m.includes('rekeyed, not closed'))).toBe(false)
    expect(logs).toContain('session ses_c was rolled into ses_c2 — already rekeyed, nothing left on the old id')
    expect(logs).toContain('session ses_w was rolled into ses_w2 — already rekeyed, nothing left on the old id')
  })
})

describe('the driver’s hooks (R3–R6)', () => {
  /** 워커 하나가 보고를 남기고 끝난 프로필 — 열린 Dispatch 가 하나, 그 세션은 살아 있지 않다. */
  const seedOpenDispatch = async (): Promise<{ taskId: string; dispatchId: string; sessionId: string }> => {
    const job = createJob(emptyState(), { objective: '무언가', cwd: 'D:/p' }, NOW)
    if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW)
    if (!run.ok) throw new Error(run.error)
    const task = createTask(run.state, { runId: run.value.id, title: '하나', spec: 's', deps: [] }, NOW)
    if (!task.ok) throw new Error(task.error)
    const sessionId = 'ses_gone'
    const dsp = openDispatch(
      task.state,
      { taskId: task.value.id, provider: 'codex', accountId: 'accA', sessionId, cwd: 'D:/p', specPath: 'D:/p/s.md' },
      NOW
    )
    if (!dsp.ok) throw new Error(dsp.error)
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(dsp.state), 'utf8')
    return { taskId: task.value.id, dispatchId: dsp.value.id, sessionId }
  }
  /** pendingDrain.test.ts 의 모양 그대로 — 워커가 앱에 닿지 못해 파일로 남긴 worker_done 하나. */
  const writeQueuedDone = async (a: { taskId: string; dispatchId: string; sessionId: string }): Promise<void> => {
    const queue = pendingReportsDirIn(dir)
    await fs.mkdir(queue, { recursive: true })
    await fs.writeFile(
      path.join(queue, pendingReportFileName({ queuedAt: NOW, nonce: 'aaaaaaaa' })),
      serializePendingReport({
        queuedAt: NOW,
        sessionId: a.sessionId,
        cmd: 'send',
        args: { type: 'worker_done', taskId: a.taskId, dispatchId: a.dispatchId, outcome: 'succeeded', subject: 's', body: 'b' }
      }),
      'utf8'
    )
  }
  const local = (over: Partial<HostLocal> = {}): HostLocal => ({
    owns: () => true,
    startWorker: vi.fn(async () => ({ sessionId: 'ses_host', cwd: 'D:/p', specPath: 'D:/specs/s.md' })),
    startCoordinator: vi.fn(async () => ({ sessionId: 'ses_coord' })),
    releaseWorker: vi.fn(async () => {}),
    readWorker: vi.fn(async () => 'worker output'),
    probeLimit: vi.fn(async () => null),
    readReviewFile: vi.fn(async () => null),
    makeRunWorktree: vi.fn(async () => 'D:/wt-run'),
    mergeWorktrees: vi.fn(async () => ({ ok: true as const, merged: [], uncommitted: 0 })),
    removeWorktrees: vi.fn(async () => ({ failed: [] })),
    ...over
  })
  const worker = (taskId: string) => ({ task: taskId, agent: 'claude', account: 'acc1', worktree: 'current' })

  it('calls onCommit after a command’s commit and after an accepted state-put, never after a refused one', async () => {
    const { taskId } = await seed()
    const onCommit = vi.fn()
    const orch = orchOver({ onCommit })
    // task-update's convergence-off commits once and asks nobody (task-create would need an account).
    await orch.call({ cmd: 'task-update', args: { id: taskId, convergence: 'off' }, sessionId: '' })
    expect(onCommit).toHaveBeenCalledTimes(1)
    const got = await orch.call({ cmd: 'state-get', args: {}, sessionId: '' })
    const { state, version } = got.body as { state: OrchState; version: number }
    const app = { role: 'app' as const, toOthers: () => {} }
    await orch.call({ cmd: 'state-put', args: { state, version }, sessionId: '', from: app })
    expect(onCommit).toHaveBeenCalledTimes(2)
    await orch.call({ cmd: 'state-put', args: { state, version: 0 }, sessionId: '', from: app })
    expect(onCommit).toHaveBeenCalledTimes(2)
  })
  it('drains the queued reports inside the load when it may, under each worker’s own session', async () => {
    const { taskId, dispatchId, sessionId } = await seedOpenDispatch() // a Dispatch whose session is not alive
    await writeQueuedDone({ taskId, dispatchId, sessionId }) // a worker_done in pending-reports, the pendingDrain.test.ts shape
    const orch = orchOver({ mayDrain: async () => true })
    // An app's state-get awaits ready(), so what it is handed already has the report applied (R4).
    const got = await orch.call({ cmd: 'state-get', args: {}, sessionId: '' })
    expect((got.body as { state: OrchState }).state.tasks.find((t) => t.id === taskId)?.status).toBe('completed')
    expect(await fs.readdir(pendingReportsDirIn(dir))).toEqual([])
    // The load drained, so the after-load pass's drainOnce must not drain a second time (C6).
    expect(await orch.drainOnce()).toBe(false)
  })
  it('awaits mayDrain: a decision that is still being computed is waited for, not read as no (N2)', async () => {
    const { taskId, dispatchId, sessionId } = await seedOpenDispatch()
    await writeQueuedDone({ taskId, dispatchId, sessionId })
    const orch = orchOver({ mayDrain: () => new Promise((r) => setTimeout(() => r(true), 30)) })
    await orch.ready()
    expect(orch.state().tasks.find((t) => t.id === taskId)?.status).toBe('completed')
  })
  it('leaves the queue to the app when it may not (an old app caused the load), and drains it later once', async () => {
    const { taskId, dispatchId, sessionId } = await seedOpenDispatch()
    await writeQueuedDone({ taskId, dispatchId, sessionId })
    const orch = orchOver({ mayDrain: async () => false })
    await orch.ready()
    expect(orch.state().tasks.find((t) => t.id === taskId)?.status).toBe('dispatched')
    expect(await orch.drainOnce()).toBe(true)
    expect(orch.state().tasks.find((t) => t.id === taskId)?.status).toBe('completed')
    expect(await orch.drainOnce()).toBe(false) // once per Host life (C6)
  })
  it('calls onLoaded once, after the drain, with loaded() already true (B2)', async () => {
    await seed()
    const seen: boolean[] = []
    const orch: ReturnType<typeof orchOver> = orchOver({ onLoaded: () => seen.push(orch.loaded()) })
    await orch.ready(); await orch.ready()
    expect(seen).toEqual([true])
  })
  it('adds driver and appAttached to status only when this Host drives (R6)', async () => {
    await seed()
    const withIt = orchOver({ driverStatus: () => ({ driver: 'host', appAttached: false }) })
    expect((await withIt.call({ cmd: 'status', args: {}, sessionId: '' })).body).toMatchObject({ driver: 'host', appAttached: false })
    const without = await orchOver().call({ cmd: 'status', args: {}, sessionId: '' })
    expect(without.body).not.toHaveProperty('driver')
  })
  it('handle() runs a command under HOST_CALLER after the load', async () => {
    const { taskId } = await seed()
    const orch = orchOver()
    const r = await orch.handle('task-update', { id: taskId, convergence: 'off' })
    expect(r.status).toBe(200)
    expect(orch.loaded()).toBe(true)
    expect(orch.state().tasks.find((t) => t.id === taskId)?.convergenceOff).toBe(true)
  })
  // B1: the loop matches 409 + retry (R15), which only the rewrite produces.
  it('handle() answers a retiring spawner’s refusal as 409 with retry, the way call does', async () => {
    const { taskId } = await seed()
    const l = local({ startWorker: vi.fn(async () => { throw refusedBeforeActing(new HostRetiring()) }) })
    const orch = orchOver({ hasApp: () => false, act: vi.fn(), local: l })
    const viaHandle = await orch.handle('worker-start', worker(taskId))
    const viaCall = await orch.call({ cmd: 'worker-start', args: worker(taskId), sessionId: '' })
    expect(viaHandle.status).toBe(409)
    expect(viaHandle.body).toMatchObject({ retry: expect.any(String) })
    expect(viaHandle).toEqual(viaCall)
  })

  // A drain that fails as a whole is logged, not thrown: the driver awaits drainOnce before its resume
  // sweep and its pass, and an escaping failure would cost both. The report stays for the next start.
  it('drainOnce resolves when the drain itself throws, and leaves the report on disk', async () => {
    const { taskId, dispatchId, sessionId } = await seedOpenDispatch()
    await writeQueuedDone({ taskId, dispatchId, sessionId })
    let asked = 0
    // The load asks once; the drain's own held-only-by-report reading is the second ask.
    const aliveSessionIds = (): ReadonlySet<string> => {
      asked += 1
      if (asked > 1) throw new Error('registry broke')
      return new Set<string>()
    }
    const orch = orchOver({ mayDrain: async () => false, aliveSessionIds })
    await orch.ready()
    await expect(orch.drainOnce()).resolves.toBe(true)
    expect(logs.some((l) => l.includes('registry broke'))).toBe(true)
    expect(await fs.readdir(pendingReportsDirIn(dir))).toHaveLength(1)
    expect(orch.state().tasks.find((t) => t.id === taskId)?.status).toBe('dispatched')
  })
  // A refused state-put changed nothing, so it must not stand in for the load: a fresh Host that
  // refuses a stale first write would otherwise answer every later read with an empty state, and the
  // app's next write, built from that, could be saved over the file (ruling F56's data-loss class).
  it('a fresh Host that refuses a stale first state-put still loads the file', async () => {
    const { jobId } = await seed()
    const orch = orchOver()
    const app = { role: 'app' as const, toOthers: () => {} }
    const put = await orch.call({ cmd: 'state-put', args: { state: emptyState(), version: 7 }, sessionId: '', from: app })
    expect(put.status).toBe(409)
    // The refusal already carries the real state, so the app's mirror is put right from the file.
    expect((put.body as { state: OrchState }).state.jobs.map((j) => j.id)).toEqual([jobId])
    const got = await orch.call({ cmd: 'state-get', args: {}, sessionId: '', from: app })
    expect((got.body as { state: OrchState }).state.jobs.map((j) => j.id)).toEqual([jobId])
  })

  // Constraint 14: the three hooks are the driver's, and a driver that throws costs nobody a commit or
  // a load.
  it('a throwing onCommit costs neither the command’s commit nor the state-put', async () => {
    const { taskId } = await seed()
    const orch = orchOver({ onCommit: () => { throw new Error('driver broke') } })
    const r = await orch.call({ cmd: 'task-update', args: { id: taskId, convergence: 'off' }, sessionId: '' })
    expect(r.status).toBe(200)
    expect(orch.state().tasks.find((t) => t.id === taskId)?.convergenceOff).toBe(true)
    const got = await orch.call({ cmd: 'state-get', args: {}, sessionId: '' })
    const { state, version } = got.body as { state: OrchState; version: number }
    const put = await orch.call({ cmd: 'state-put', args: { state, version }, sessionId: '', from: { role: 'app', toOthers: () => {} } })
    expect(put.status).toBe(200)
    expect(logs.some((l) => l.includes('driver broke'))).toBe(true)
  })
  it('a throwing onLoaded costs not the load', async () => {
    const { jobId } = await seed()
    const orch = orchOver({ onLoaded: () => { throw new Error('pass broke') } })
    const r = await orch.call({ cmd: 'jobs-list', args: {}, sessionId: '' })
    expect((r.body as { id: string }[]).map((j) => j.id)).toEqual([jobId])
    expect(orch.loaded()).toBe(true)
    expect(logs.some((l) => l.includes('pass broke'))).toBe(true)
  })
  it('a rejecting mayDrain is read as no and costs not the load', async () => {
    const { taskId, dispatchId, sessionId } = await seedOpenDispatch()
    await writeQueuedDone({ taskId, dispatchId, sessionId })
    const orch = orchOver({ mayDrain: async () => { throw new Error('settings broke') } })
    const r = await orch.call({ cmd: 'state-get', args: {}, sessionId: '' })
    expect(r.status).toBe(200)
    expect(orch.state().tasks.find((t) => t.id === taskId)?.status).toBe('dispatched')
    expect(logs.some((l) => l.includes('settings broke'))).toBe(true)
    // Read as no, so the drain is still this Host's to run, once.
    expect(await orch.drainOnce()).toBe(true)
  })
})

// Final round 2, I-A: every CLI call reaches the Host, so the Host's command server holds the one record
// of the `check --wait` calls in flight, for its whole life. The driver's own command (a fire, or the
// loop's run-coordinator-stop, under HOST_CALLER) reads the wait a coordinator's call entered.
describe('the Host sees a coordinator parked in check --wait (I-A)', () => {
  it('stops a Run-with-no-Tasks coordinator only while its check --wait is in flight', async () => {
    const job = createJob(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW)
    if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, NOW)
    if (!run.ok) throw new Error(run.error)
    const state = {
      ...run.state,
      jobs: run.state.jobs.map((j) => ({ ...j, schedule: { kind: 'daily' as const, time: '09:00' }, coordinatorAccountId: 'accA' })),
      runs: run.state.runs.map((r) => ({ ...r, coordinatorSessionId: 'ses_c' }))
    }
    await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(state, null, 2), 'utf8')
    const act = vi.fn(async () => ({}))
    // Alive, so the load's sweep keeps the slot.
    const orch = orchOver({ act, aliveSessionIds: () => new Set(['ses_c']) })
    await orch.ready()
    const runId = run.value.id
    expect((await orch.handle('run-coordinator-stop', { run: runId })).status).toBe(409)
    const waiting = orch.call({ cmd: 'check', args: { run: runId, wait: true, timeoutMs: 300 }, sessionId: 'ses_c' })
    await new Promise((r) => setTimeout(r, 30))
    const r = await orch.handle('run-coordinator-stop', { run: runId })
    await waiting
    expect(r.status).toBe(200)
    expect(act).toHaveBeenCalledWith('stopCoordinator', ['ses_c'])
  })
})
