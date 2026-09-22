import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostOrch } from './orch'
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
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
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
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect((await savedState()).dispatches).toHaveLength(1)
  })

  // id 를 만드는 명령(§3 의 첫 번째 갈래). 두 번 커밋되면 계획이 둘이고, 그것이 여기서 세는 효과다.
  it('같은 요청 id 의 run-create 는 계획을 하나만 만든다', async () => {
    const c = counting()
    const orch = orchOver({ act: c.act })
    const args = { objective: '무언가', cwd: 'D:/p' }
    const first = await orch.call({ cmd: 'run-create', args, sessionId: 'sesA', request: 'req-1' })
    const second = await orch.call({ cmd: 'run-create', args, sessionId: 'sesA', request: 'req-1' })
    expect((await savedState()).jobs, '재시도가 계획을 하나 더 만들었다').toHaveLength(1)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
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
    expect(JSON.stringify(second), '재시도가 자기 인자를 탓하는 400 을 받았다').toBe(JSON.stringify(first))
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
})
