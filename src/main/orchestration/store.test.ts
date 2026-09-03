import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OrchestrationStore, RUN_TTL_MS } from './store'
import { emptyState, type OrchState } from '../../core/orchestration/state'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-orch-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

// "지금"이지 특정 날짜가 아니다. 리터럴로 박아 두면 시한폭탄이 된다 — load() 의 TTL 정리는
// 실제 Date.now() 로 판정하므로, 고정 날짜는 작성 시점으로부터 RUN_TTL_MS(30일)가 지나는 순간
// 조용히 만료되어 이 파일의 여러 테스트가 한꺼번에 깨진다(실제로 2026-09-03 에 그렇게 깨졌다).
// 과거를 만드는 테스트들이 이미 쓰는 `Date.now() - RUN_TTL_MS` 와 같은 기준으로 맞춘다.
const NOW = new Date().toISOString()
const withOpenDispatch = (): OrchState => ({
  ...emptyState(),
  runs: [{ id: 'run_1', objective: 'o', cwd: 'D:/p', createdAt: NOW }],
  tasks: [
    {
      id: 'tsk_1',
      runId: 'run_1',
      title: 't',
      spec: 's',
      deps: [],
      status: 'dispatched',
      consecutiveFailures: 0,
      createdAt: NOW,
      updatedAt: NOW
    }
  ],
  dispatches: [
    {
      id: 'dsp_1',
      taskId: 'tsk_1',
      provider: 'codex',
      accountId: 'acc1',
      sessionId: 'sess1',
      cwd: 'D:/p',
      specPath: 'D:/p/orch/specs/x.md',
      startedAt: NOW,
      workerState: 'ready',
      retained: false
    }
  ]
})

describe('OrchestrationStore', () => {
  it('상태를 저장하고 새 인스턴스가 다시 읽는다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const a = new OrchestrationStore(file)
    await a.load()
    const s = withOpenDispatch()
    // 열린 dispatch는 재시작 정리 대상이므로 완료된 상태로 저장한다
    s.dispatches[0].endedAt = NOW
    s.dispatches[0].outcome = 'succeeded'
    s.tasks[0].status = 'completed'
    await a.save(s)

    const b = new OrchestrationStore(file)
    await b.load()
    expect(b.get().runs).toHaveLength(1)
    expect(b.get().tasks[0].status).toBe('completed')
  })

  it('손상 파일은 .bak을 남기고 빈 상태로 복구한다', async () => {
    const file = path.join(dir, 'orchestration.json')
    await fs.writeFile(file, '{ broken', 'utf8')
    const store = new OrchestrationStore(file)
    const r = await store.load()
    expect(r.recovered).toBe(true)
    expect(store.get()).toEqual(emptyState())
    await expect(fs.stat(file + '.bak')).resolves.toBeTruthy()
  })

  it('최상위가 배열이면 손상으로 본다', async () => {
    const file = path.join(dir, 'orchestration.json')
    await fs.writeFile(file, '[]', 'utf8')
    const r = await new OrchestrationStore(file).load()
    expect(r.recovered).toBe(true)
  })

  it('파일이 없으면 빈 상태로 시작하고 복구가 아니다', async () => {
    const r = await new OrchestrationStore(path.join(dir, 'none.json')).load()
    expect(r.recovered).toBe(false)
  })

  it('재시작 시 열린 Dispatch를 outcome_unknown으로 표시한다', async () => {
    const file = path.join(dir, 'orchestration.json')
    await fs.writeFile(file, JSON.stringify(withOpenDispatch()), 'utf8')
    const store = new OrchestrationStore(file)
    const r = await store.load()
    expect(r.unknownOutcomes).toBe(1)
    expect(store.get().dispatches[0].workerState).toBe('outcome_unknown')
    expect(store.get().dispatches[0].endedAt).toBeTruthy()
  })

  // provider 가 Run 에서 Task 로 내려간 뒤 남는 칸 — 두 칸을 함께 두면 어느 쪽이 정본인지
  // 코드마다 달라진다(위 accountId 이행과 같은 이유)
  it('옛 Run.provider 를 지운다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const s = withOpenDispatch()
    ;(s.runs[0] as unknown as Record<string, unknown>).provider = 'codex'
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    await store.load()
    expect((store.get().runs[0] as unknown as Record<string, unknown>).provider).toBeUndefined()
  })

  // **계정을 대신 채워 넣지 않는다.** 옛 provider 로 기본 계정을 찾아 넣으면 사람이 아끼려던
  // 계정에 일이 갈 수 있고, 무엇이 기본 계정인지 이 자리에서는 알 수도 없다. 계정 없는 Task 는
  // 자동 배치에서 빠지고 디스패치 시점에 Gate 를 연다.
  it('provider 를 지우면서 Task 에 계정을 지어 넣지는 않는다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const s = withOpenDispatch()
    ;(s.runs[0] as unknown as Record<string, unknown>).provider = 'codex'
    delete (s.tasks[0] as unknown as Record<string, unknown>).accountIds
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    await store.load()
    expect(store.get().tasks[0].accountIds).toBeUndefined()
  })

  it('옛 accountId 하나짜리 Task 를 accountIds 로 옮긴다 (이 칸이 생기기 전에 만든 Job)', async () => {
    const file = path.join(dir, 'orchestration.json')
    const s = withOpenDispatch()
    // 손으로 만든 옛 모양 — accountId 는 이제 스키마에 없다
    ;(s.tasks[0] as unknown as Record<string, unknown>).accountId = 'acc-1'
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    await store.load()
    expect(store.get().tasks[0].accountIds).toEqual(['acc-1'])
    // 옛 칸은 남기지 않는다 — 두 칸이 어긋나면 어느 쪽이 정본인지 코드마다 달라진다
    expect((store.get().tasks[0] as unknown as Record<string, unknown>).accountId).toBeUndefined()
  })

  it('옛 accountId 아래 목록이 들어 있으면 그 순서째 옮긴다 (이름만 옛것인 손질)', async () => {
    const file = path.join(dir, 'orchestration.json')
    const s = withOpenDispatch()
    ;(s.tasks[0] as unknown as Record<string, unknown>).accountId = ['acc-1', 'acc-2']
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    await store.load()
    expect(store.get().tasks[0].accountIds).toEqual(['acc-1', 'acc-2'])
  })

  // **읽을 수 없는 원소는 그 원소만 버린다.** 전부 아니면 전무로 보면 읽히는 'acc-1' 까지 함께
  // 사라지고, 그것도 사람이 아끼려던 계정을 지우는 일이다 — 이 이행이 막으려는 바로 그것이다
  it('옛 목록에 읽을 수 없는 원소가 섞여 있으면 그 원소만 버린다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const s = withOpenDispatch()
    ;(s.tasks[0] as unknown as Record<string, unknown>).accountId = ['acc-1', '']
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    await store.load()
    expect(store.get().tasks[0].accountIds).toEqual(['acc-1'])
    expect((store.get().tasks[0] as unknown as Record<string, unknown>).accountId).toBeUndefined()
  })

  // 문자열이 아닌 원소도 같다 — JSON 은 무엇이든 담을 수 있고 이 파일은 손으로 고쳐진다
  it('옛 목록의 문자열 아닌 원소만 버리고 읽히는 것은 남긴다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const s = withOpenDispatch()
    ;(s.tasks[0] as unknown as Record<string, unknown>).accountId = ['acc-1', 3]
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    await store.load()
    expect(store.get().tasks[0].accountIds).toEqual(['acc-1'])
  })

  // 남는 것이 하나도 없으면 칸을 만들지 않는다 — 빈 배열을 실으면 "지정 없음"과 값이 갈라지고,
  // 그것을 체인으로 넘기면 롤링이 계정 아닌 것으로 갈아타려 한다
  it('옛 목록에 읽을 수 있는 원소가 하나도 없으면 지정을 만들지 않는다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const s = withOpenDispatch()
    ;(s.tasks[0] as unknown as Record<string, unknown>).accountId = ['', 3]
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    await store.load()
    expect(store.get().tasks[0].accountIds).toBeUndefined()
    expect((store.get().tasks[0] as unknown as Record<string, unknown>).accountId).toBeUndefined()
  })

  // **두 칸이 함께 있는 파일** — 손으로 고치다 만 모양이고, 이 이행이 있는 이유가 바로 그런 편집이다.
  // 새 칸이 "있는가"만 보면 빈 목록 그대로 돌아오고 옛 칸은 지워져 지정이 통째로 사라진다.
  // 빈 배열은 "지정 없음"이므로(Task.accountIds 의 JSDoc) 옛 값이 이긴다
  it('새 칸이 빈 목록이면 옛 accountId 를 그 자리로 옮긴다 (고치다 만 파일)', async () => {
    const file = path.join(dir, 'orchestration.json')
    const s = withOpenDispatch()
    const t = s.tasks[0] as unknown as Record<string, unknown>
    t.accountId = 'acc-1'
    t.accountIds = []
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    await store.load()
    expect(store.get().tasks[0].accountIds).toEqual(['acc-1'])
    expect((store.get().tasks[0] as unknown as Record<string, unknown>).accountId).toBeUndefined()
  })

  // 새 칸에 값이 들어 있으면 그것이 정본이다 — 옛 칸은 읽지 않고 지운다
  it('새 칸에 값이 있으면 옛 accountId 는 그것을 덮지 않는다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const s = withOpenDispatch()
    const t = s.tasks[0] as unknown as Record<string, unknown>
    t.accountId = 'acc-old'
    t.accountIds = ['acc-1', 'acc-2']
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    await store.load()
    expect(store.get().tasks[0].accountIds).toEqual(['acc-1', 'acc-2'])
    expect((store.get().tasks[0] as unknown as Record<string, unknown>).accountId).toBeUndefined()
  })

  it('재시작 정리가 Task를 failed로 옮기지 않는다', async () => {
    const file = path.join(dir, 'orchestration.json')
    await fs.writeFile(file, JSON.stringify(withOpenDispatch()), 'utf8')
    const store = new OrchestrationStore(file)
    await store.load()
    expect(store.get().tasks[0].status).toBe('dispatched')
  })

  it('30일 지난 종료 Run과 그에 속한 항목을 정리한다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const old = new Date(Date.now() - RUN_TTL_MS - 1000).toISOString()
    const s = withOpenDispatch()
    s.runs[0] = { ...s.runs[0], createdAt: old }
    s.dispatches[0] = { ...s.dispatches[0], endedAt: old, outcome: 'succeeded' }
    s.tasks[0] = { ...s.tasks[0], status: 'completed', updatedAt: old }
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    const r = await store.load()
    expect(r.pruned).toBe(1)
    expect(store.get().runs).toHaveLength(0)
    expect(store.get().tasks).toHaveLength(0)
    expect(store.get().dispatches).toHaveLength(0)
  })

  it('TTL 이내의 종료 Run은 남긴다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const s = withOpenDispatch()
    s.dispatches[0] = { ...s.dispatches[0], endedAt: NOW, outcome: 'succeeded' }
    s.tasks[0] = { ...s.tasks[0], status: 'completed' }
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    const r = await store.load()
    expect(r.pruned).toBe(0)
    expect(store.get().runs).toHaveLength(1)
  })

  // 예약이 30일 뒤 조용히 사라지면 안 된다. 템플릿의 Task 는 배치되지 않아 terminal 이 되지
  // 않으므로 지금은 저절로 남지만, 그 성질이 우연히 깨지는 것을 여기서 잡는다
  it('30일이 지나도 예약 템플릿은 남기고 그 회차만 지운다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const old = new Date(Date.now() - RUN_TTL_MS - 1000).toISOString()
    const s: OrchState = {
      ...emptyState(),
      runs: [
        { id: 'tmpl', objective: '매일', cwd: 'D:/p', createdAt: old, schedule: { kind: 'daily', time: '09:00' } },
        { id: 'kid', objective: '매일', cwd: 'D:/p', createdAt: old, templateId: 'tmpl', autoDispatch: true }
      ],
      tasks: [
        { id: 't_tmpl', runId: 'tmpl', title: 'A', spec: 's', deps: [], status: 'ready', consecutiveFailures: 0, createdAt: old, updatedAt: old },
        { id: 't_kid', runId: 'kid', title: 'A', spec: 's', deps: [], status: 'completed', consecutiveFailures: 0, createdAt: old, updatedAt: old }
      ]
    }
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    const r = await store.load()
    expect(r.pruned).toBe(1)
    expect(store.get().runs.map((x) => x.id)).toEqual(['tmpl'])
  })

  it('원자 쓰기 — tmp 파일을 남기지 않는다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const store = new OrchestrationStore(file)
    await store.load()
    await store.save(emptyState())
    const files = await fs.readdir(dir)
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('오래 생성된 Run도 최근에 활동했으면 유지한다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const old = new Date(Date.now() - RUN_TTL_MS - 1000).toISOString()
    const s = withOpenDispatch()
    s.runs[0] = { ...s.runs[0], createdAt: old }
    s.dispatches[0] = { ...s.dispatches[0], endedAt: NOW, outcome: 'succeeded' }
    s.tasks[0] = { ...s.tasks[0], status: 'completed', updatedAt: NOW }
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    const r = await store.load()
    expect(r.pruned).toBe(0)
    expect(store.get().runs).toHaveLength(1)
  })

  it('활동도 오래된 종료 Run과 그 항목들을 정리한다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const old = new Date(Date.now() - RUN_TTL_MS - 1000).toISOString()
    const s = withOpenDispatch()
    s.runs[0] = { ...s.runs[0], createdAt: old }
    s.dispatches[0] = { ...s.dispatches[0], endedAt: old, outcome: 'succeeded' }
    s.tasks[0] = { ...s.tasks[0], status: 'completed', updatedAt: old }
    s.messages = [
      {
        id: 'msg_1',
        runId: 'run_1',
        type: 'status',
        subject: 'test',
        body: 'test',
        answered: false,
        createdAt: old
      }
    ]
    s.deliveries = [
      {
        id: 'dlv_1',
        runId: 'run_1',
        messageIds: ['msg_1'],
        createdAt: old
      }
    ]
    s.gates = [
      {
        id: 'gat_1',
        runId: 'run_1',
        taskId: 'tsk_1',
        question: 'test?',
        status: 'open',
        createdAt: old
      }
    ]
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    const r = await store.load()
    expect(r.pruned).toBe(1)
    expect(store.get().runs).toHaveLength(0)
    expect(store.get().tasks).toHaveLength(0)
    expect(store.get().dispatches).toHaveLength(0)
    expect(store.get().messages).toHaveLength(0)
    expect(store.get().deliveries).toHaveLength(0)
    expect(store.get().gates).toHaveLength(0)
  })

  describe('save 직렬화', () => {
    const runState = (id: string): OrchState => ({
      ...emptyState(),
      runs: [{ id, objective: id, cwd: 'D:/p', createdAt: NOW }]
    })

    /** 그 tmp 파일이 first의 상태를 담고 있는가. 도착 순서(몇 번째 rename인가)로 판정하면
     *  두 save의 mkdir·writeFile 완료 순서가 libuv 스레드풀에 달려 있어 어느 쪽이 먼저
     *  rename에 닿는지가 실행마다 바뀐다 — 내용으로 판정해야 결정적이다. */
    const isFirst = async (tmp: Parameters<typeof fs.rename>[0]): Promise<boolean> =>
      (await fs.readFile(tmp as string, 'utf8')).includes('run_first')

    it('겹쳐 부른 두 save의 순서가 뒤집히지 않는다 — 디스크가 두 번째 상태다', async () => {
      // 큐가 없으면 두 save()가 동시 in-flight가 되고 두 rename의 착륙 순서가 보장되지 않아
      // 디스크는 첫 번째, 메모리는 두 번째가 된다. 메모리가 항상 정확하므로 실사용 중에는
      // 증상이 없고 다음 앱 재시작에서만 드러난다 — 느린 첫 rename을 주입해 결정적으로 재현한다.
      const file = path.join(dir, 'orchestration.json')
      const store = new OrchestrationStore(file)
      await store.load()
      const realRename = fs.rename
      const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (await isFirst(from)) await new Promise((r) => setTimeout(r, 30))
        await realRename(from, to)
      })
      try {
        await Promise.all([store.save(runState('run_first')), store.save(runState('run_second'))])
      } finally {
        spy.mockRestore()
      }
      const disk = JSON.parse(await fs.readFile(file, 'utf8')) as OrchState
      expect(disk.runs[0].id).toBe('run_second')
      expect(store.get().runs[0].id).toBe('run_second')
    })

    it('앞 쓰기가 실패해도 뒤 쓰기는 진행된다 — 큐가 한 번의 실패로 막히지 않는다', async () => {
      const file = path.join(dir, 'orchestration.json')
      const store = new OrchestrationStore(file)
      await store.load()
      const realRename = fs.rename
      const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (await isFirst(from)) throw new Error('rename failed')
        await realRename(from, to)
      })
      const first = store.save(runState('run_first'))
      const second = store.save(runState('run_second'))
      try {
        await expect(first).rejects.toThrow('rename failed')
        await second
      } finally {
        spy.mockRestore()
      }
      const disk = JSON.parse(await fs.readFile(file, 'utf8')) as OrchState
      expect(disk.runs[0].id).toBe('run_second')
    })
  })

  it('재시작하면 validating 이던 Task 를 blocked 로 보내고 Gate 를 연다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const s = withOpenDispatch()
    s.tasks[0] = { ...s.tasks[0], status: 'validating' }
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    const r = await store.load()
    expect(r.staleValidations).toBe(1)
    expect(store.get().tasks[0].status).toBe('blocked')
    expect(store.get().gates).toHaveLength(1)
    expect(store.get().gates[0].taskId).toBe(s.tasks[0].id)
  })

  // 연속 실패로 세지 않는다 — 인프라 사정이지 작업이 틀린 것이 아니다
  it('정리된 검증은 consecutiveFailures 를 올리지 않는다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const s = withOpenDispatch()
    s.tasks[0] = { ...s.tasks[0], status: 'validating', consecutiveFailures: 1 }
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    await store.load()
    expect(store.get().tasks[0].consecutiveFailures).toBe(1)
  })

  // **한 Run 에 stale validating Task 가 둘 이상인 경우.** 정리 루프는 st.tasks 를 돌면서
  // withGates 를 이어 간다 — 그 이어짐이 유일한 누적 경로이므로, 두 번째 createGate 가 첫 번째의
  // 결과 위에서 돌지 않으면 첫 Gate 와 그 decision_gate 메시지가 조용히 사라진다. 이 슬라이스의
  // Important 하나가 정확히 그 기제에서 깨졌다.
  it('한 Run 의 validating Task 가 둘이면 둘 다 Gate 가 되고 메시지도 둘 다 남는다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const s = withOpenDispatch()
    s.tasks = [
      { ...s.tasks[0], status: 'validating' },
      { ...s.tasks[0], id: 'tsk_2', status: 'validating' }
    ]
    // 두 번째 Task 에도 자기 Dispatch 가 있다 — 열린 dispatch 는 createGate 가 거절하므로,
    // 재시작 정리가 먼저 endedAt 을 채워 주는 것에 이 케이스가 기대고 있다는 것까지 함께 고정한다
    s.dispatches = [s.dispatches[0], { ...s.dispatches[0], id: 'dsp_2', taskId: 'tsk_2', sessionId: 'sess2' }]
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    const r = await store.load()
    expect(r.staleValidations).toBe(2)
    expect(store.get().tasks.map((t) => t.status)).toEqual(['blocked', 'blocked'])
    expect(store.get().gates.map((g) => g.taskId).sort()).toEqual(['tsk_1', 'tsk_2'])
    const gateMessages = store.get().messages.filter((m) => m.type === 'decision_gate')
    expect(gateMessages.map((m) => m.taskId).sort()).toEqual(['tsk_1', 'tsk_2'])
  })

  // **reviewing 도 같은 정리 대상이다.** 검토자는 별도의 세션이라 앱과 함께 죽었고, 그것을 다시 띄우는
  // 명령은 코디네이터에게 없다 — reviewing -> dispatched 전이가 없어 --retry-of 도 거절되므로, Gate 가
  // 없으면 Task 는 영원히 reviewing 이고 의존 Task 는 영원히 pending 이다.
  it('재시작하면 reviewing 이던 Task 도 blocked 로 보내고 Gate 를 연다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const s = withOpenDispatch()
    s.tasks[0] = { ...s.tasks[0], status: 'reviewing', consecutiveFailures: 1 }
    s.dispatches[0] = { ...s.dispatches[0], review: true }
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    const r = await store.load()
    expect(r.staleReviews).toBe(1)
    expect(r.staleValidations).toBe(0) // 검증과 섞이지 않는다 — 시작 로그가 둘을 구별해 적는다
    expect(store.get().tasks[0].status).toBe('blocked')
    expect(store.get().gates).toHaveLength(1)
    // 끝난 일을 버리지 않는 탈출구가 질문에 실린다(blockForReview) — resolveGate 로 풀면 Task 가
    // pending 으로 돌아가 이미 끝난 구현이 버려진다
    expect(store.get().gates[0].question).toContain('task-update --status completed')
    // 코디네이터를 깨우는 수단은 메시지뿐이다
    expect(store.get().messages.some((m) => m.type === 'decision_gate')).toBe(true)
    // 연속 실패로 세지 않는다 — 인프라 사정이지 작업이 틀린 것이 아니다(검증 쪽과 같은 규칙)
    expect(store.get().tasks[0].consecutiveFailures).toBe(1)
  })

  it('reviewing 도 validating 도 없으면 두 카운터가 0 이다', async () => {
    const file = path.join(dir, 'orchestration.json')
    await fs.writeFile(file, JSON.stringify(withOpenDispatch()), 'utf8')
    const store = new OrchestrationStore(file)
    const r = await store.load()
    expect(r.staleReviews).toBe(0)
    expect(r.staleValidations).toBe(0)
  })

  it('validating 이 없으면 staleValidations 가 0 이고 Gate 도 생기지 않는다', async () => {
    const file = path.join(dir, 'orchestration.json')
    await fs.writeFile(file, JSON.stringify(withOpenDispatch()), 'utf8')
    const store = new OrchestrationStore(file)
    const r = await store.load()
    expect(r.staleValidations).toBe(0)
    expect(store.get().gates).toHaveLength(0)
  })

  // Gate가 tasks/gates뿐 아니라 decision_gate 메시지도 만든다 — 그 메시지가 최종 상태에서
  // 누락되면 Gate 자체는 멀쩡해 보여도 delivery 스트림(check/nextDelivery)에는 알림이 가지 않는다.
  it('재시작 Gate 가 만든 decision_gate 메시지도 최종 상태에 남는다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const s = withOpenDispatch()
    s.tasks[0] = { ...s.tasks[0], status: 'validating' }
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    await store.load()
    const msg = store
      .get()
      .messages.find((m) => m.type === 'decision_gate' && m.taskId === s.tasks[0].id)
    expect(msg).toBeTruthy()
  })

  it('Message 활동도 TTL 판정에 반영된다', async () => {
    const file = path.join(dir, 'orchestration.json')
    const old = new Date(Date.now() - RUN_TTL_MS - 1000).toISOString()
    const s = withOpenDispatch()
    s.runs[0] = { ...s.runs[0], createdAt: old }
    s.dispatches[0] = { ...s.dispatches[0], endedAt: old, outcome: 'succeeded' }
    s.tasks[0] = { ...s.tasks[0], status: 'completed', updatedAt: old }
    s.messages = [
      {
        id: 'msg_1',
        runId: 'run_1',
        type: 'status',
        subject: 'test',
        body: 'test',
        answered: false,
        createdAt: NOW
      }
    ]
    await fs.writeFile(file, JSON.stringify(s), 'utf8')
    const store = new OrchestrationStore(file)
    const r = await store.load()
    expect(r.pruned).toBe(0)
    expect(store.get().runs).toHaveLength(1)
    expect(store.get().messages).toHaveLength(1)
  })
})
