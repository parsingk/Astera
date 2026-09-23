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
import {
  applyWorkerDone,
  createJob,
  createTask,
  emptyState,
  openDispatch,
  openReviewDispatch,
  startJobRun,
  type OrchState
} from '../core/orchestration/state'
import type { OrchCaller } from '../core/host/orchProtocol'
import type { HostMessage } from '../core/host/protocol'

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
        log: (m) => logs.push(m)
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
    // **관찰한 재생도 재생이다.** 표시가 말하는 것은 본문이 아니라 id 다 — 이 호출자가 이미 효력을
    // 낸 id 를 다시 내밀었고, 그 뒤의 커밋(질문 만들기)은 되풀이되지 않았다. 새것은 관찰뿐이고,
    // 그것이 기다림을 다시 거는 호출자가 부탁한 전부다(§7).
    expect(observed.replayed, '관찰한 재생이 재생이라고 말하지 않았다').toBe(true)
    // 질문을 상태에서 지운다 — 다시 읽는다면 여기서 404 다.
    const now = await savedState()
    await orch.call({
      cmd: 'state-put',
      args: { state: { ...now, messages: [] } },
      sessionId: '',
      from: appCallerFrom
    })
    const third = await orch.call({ cmd: 'ask', args: askArgs(f), sessionId: 'ses1', request: 'req-1' })
    expect(JSON.stringify(third), '기록된 답 대신 질문을 다시 읽었다').toBe(JSON.stringify(observed))
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
  })

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
  })

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
  })

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
    expect(patient.replayed).toBe(true)
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
