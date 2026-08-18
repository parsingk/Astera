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

const NOW = '2026-08-04T00:00:00.000Z'
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
