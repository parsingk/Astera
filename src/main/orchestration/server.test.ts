import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleCommand, handleExit, type OrchServerDeps } from './server'
import { OrchCoordinator, type CoordinatorDeps } from './coordinator'
import { OrchestrationStore } from './store'
import {
  applyValidationResult,
  blockForValidation,
  emptyState,
  type OrchState
} from '../../core/orchestration/state'
import { TaskValidator } from './validator'
import { FAILURE_LIMIT } from '../../core/orchestration/types'

const NOW = '2026-08-04T00:00:00.000Z'

// 실제 파일시스템을 쓰는 통합 테스트(아래 'worker-start × OrchCoordinator' 블록)를 위한
// 임시 디렉토리 — RunConfigStore.test.ts 선례와 같은 패턴. 다른 describe들은 이 dir을 쓰지
// 않고 기존처럼 하드코딩된 'D:/p' 문자열을 그대로 쓴다(실제 fs를 건드리지 않는 mock이라 안전).
let dir: string
/** 배선이 주입하는 spec 디렉토리 — **워커 cwd 밖**이다 */
let specsDir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-orchsrv-'))
  specsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-orchsrvspec-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  await fs.rm(specsDir, { recursive: true, force: true })
})

const makeDeps = (initial: OrchState = emptyState()): OrchServerDeps & { state: OrchState } => {
  const box = { state: initial }
  return {
    state: box.state,
    getState: () => box.state,
    setState: async (next) => {
      box.state = next
    },
    startWorker: async () => ({ sessionId: 'sess1', cwd: 'D:/p', specPath: 'D:/p/orch/specs/a.md' }),
    releaseWorker: async () => {},
    listAccounts: () => [{ id: 'acc1', label: '계정1', provider: 'codex' }],
    readWorker: async () => 'output',
    enabled: () => true,
    now: () => NOW
  } as OrchServerDeps & { state: OrchState }
}

const call = (
  deps: OrchServerDeps,
  cmd: string,
  args: Record<string, unknown> = {},
  sessionId = 'coordinator'
): Promise<{ status: number; body: unknown }> => handleCommand(deps, { sessionId }, cmd, args)

describe('handleCommand — 기본', () => {
  it('토글이 off면 disabled 에러를 낸다', async () => {
    const deps = { ...makeDeps(), enabled: () => false }
    const r = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.body)).toContain('disabled')
  })
  it('알 수 없는 명령은 404를 낸다', async () => {
    const r = await call(makeDeps(), 'no-such-command')
    expect(r.status).toBe(404)
  })
  it('run-create가 Run을 만들고 id를 돌려준다', async () => {
    const deps = makeDeps()
    const r = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    expect(r.status).toBe(200)
    expect(deps.getState().runs).toHaveLength(1)
  })
  it('필수 인자가 없으면 400을 낸다', async () => {
    const r = await call(makeDeps(), 'run-create', {})
    expect(r.status).toBe(400)
  })
})

describe('handleCommand — 역할 인가', () => {
  /** worker-start까지 진행해 sess1이 워커인 상태를 만든다 */
  const seedWorker = async (): Promise<OrchServerDeps> => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { runId, title: 't', spec: 's' })
    const taskId = (task.body as { id: string }).id
    await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    return deps
  }

  it('워커 세션은 worker-start를 부를 수 없다 — 중첩 오케스트레이션 차단', async () => {
    const deps = await seedWorker()
    const r = await call(deps, 'worker-start', { taskId: 'x' }, 'sess1')
    expect(r.status).toBe(403)
  })
  it('워커 세션은 task-create·run-create·reset·gate-create를 부를 수 없다', async () => {
    const deps = await seedWorker()
    for (const cmd of ['task-create', 'run-create', 'reset', 'gate-create']) {
      expect((await call(deps, cmd, {}, 'sess1')).status).toBe(403)
    }
  })
  it('워커 세션은 자기 send·ask를 부를 수 있다', async () => {
    const deps = await seedWorker()
    const d = deps.getState().dispatches[0]
    const r = await call(
      deps,
      'send',
      {
        type: 'worker_done',
        taskId: d.taskId,
        dispatchId: d.id,
        outcome: 'succeeded',
        subject: 'a',
        body: 'b'
      },
      'sess1'
    )
    expect(r.status).toBe(200)
  })
  it('워커 세션은 다른 dispatch로 보고할 수 없다', async () => {
    const deps = await seedWorker()
    const r = await call(
      deps,
      'send',
      {
        type: 'worker_done',
        taskId: 'tsk_other',
        dispatchId: 'dsp_other',
        outcome: 'succeeded',
        subject: 'a',
        body: 'b'
      },
      'sess1'
    )
    expect(r.status).toBe(403)
  })
  it('오케스트레이터 세션은 모든 명령을 부를 수 있다', async () => {
    const deps = await seedWorker()
    expect((await call(deps, 'task-list', {})).status).toBe(200)
    expect((await call(deps, 'accounts', {})).status).toBe(200)
  })
})

describe('handleCommand — 역할 인가 (완료 후에도 워커)', () => {
  /** worker-start까지 진행해 sess1이 워커인 상태를 만든다 (위 seedWorker와 동일한 절차) */
  const seedWorker = async (): Promise<OrchServerDeps> => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { runId, title: 't', spec: 's' })
    const taskId = (task.body as { id: string }).id
    await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    return deps
  }

  it('worker_done을 보낸 직후에도 같은 세션은 계속 워커다 — 코디네이터 명령이 거부된다', async () => {
    const deps = await seedWorker()
    const d = deps.getState().dispatches[0]
    const done = await call(
      deps,
      'send',
      {
        type: 'worker_done',
        taskId: d.taskId,
        dispatchId: d.id,
        outcome: 'succeeded',
        subject: 'a',
        body: 'b'
      },
      'sess1'
    )
    expect(done.status).toBe(200)
    for (const cmd of ['task-create', 'run-create', 'worker-start', 'gate-create', 'reset']) {
      expect((await call(deps, cmd, {}, 'sess1')).status).toBe(403)
    }
  })
})

describe('handleCommand — worker_done 재전송 멱등성 (§8) — 소유권과 유효성 분리', () => {
  /** worker-start까지 진행해 sess1이 워커인 상태를 만든다 */
  const seedWorker = async (): Promise<OrchServerDeps> => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { runId, title: 't', spec: 's' })
    const taskId = (task.body as { id: string }).id
    await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    return deps
  }

  it('자기 dispatchId로 worker_done을 두 번 보내면 두 번째는 alreadyReported다(403이 아니다)', async () => {
    const deps = await seedWorker()
    const d = deps.getState().dispatches[0]
    const resend = {
      type: 'worker_done',
      taskId: d.taskId,
      dispatchId: d.id,
      outcome: 'succeeded',
      subject: 'a',
      body: 'b'
    }
    const first = await call(deps, 'send', resend, 'sess1')
    expect(first.status).toBe(200)
    expect(first.body).toBe('accepted')
    const second = await call(deps, 'send', resend, 'sess1')
    expect(second.status).toBe(200)
    expect(second.body).toBe('alreadyReported')
  })

  it('dispatch가 닫힌 워커 세션의 send --type worker_done 재전송은 크래시 없이 응답한다', async () => {
    const deps = await seedWorker()
    const d = deps.getState().dispatches[0]
    const resend = {
      type: 'worker_done',
      taskId: d.taskId,
      dispatchId: d.id,
      outcome: 'succeeded',
      subject: 'a',
      body: 'b'
    }
    await call(deps, 'send', resend, 'sess1') // 첫 번째 — 이 dispatch를 닫는다
    let thrown: unknown = null
    let r: { status: number; body: unknown } | undefined
    try {
      r = await call(deps, 'send', resend, 'sess1') // 두 번째 — 이미 닫힌 자기 dispatch로 재전송
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeNull()
    expect(r?.status).toBe(200)
  })

  it('dispatch가 닫힌 워커 세션이 ask를 불러도 크래시 없이 거부 응답한다', async () => {
    const deps = await seedWorker()
    const d = deps.getState().dispatches[0]
    await call(
      deps,
      'send',
      {
        type: 'worker_done',
        taskId: d.taskId,
        dispatchId: d.id,
        outcome: 'succeeded',
        subject: 'a',
        body: 'b'
      },
      'sess1'
    )
    let thrown: unknown = null
    let r: { status: number; body: unknown } | undefined
    try {
      r = await call(deps, 'ask', { taskId: d.taskId, dispatchId: d.id, question: 'q?' }, 'sess1')
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeNull()
    // 서버가 미리 403을 내지 않는다 — createQuestion까지 보내 'dispatch already settled'로
    // 거부되는 것이 더 정확한 에러다(닫힌 자기 dispatch이므로 소유권은 있다).
    expect(r?.status).toBe(400)
    expect(JSON.stringify(r?.body)).toContain('settled')
  })
})

describe('handleCommand — send 소유권 (워커)', () => {
  const seedWorker = async (): Promise<OrchServerDeps> => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { runId, title: 't', spec: 's' })
    const taskId = (task.body as { id: string }).id
    await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    return deps
  }

  it('워커가 dispatchId 없이 남의 taskId로 escalation을 보내면 거부된다', async () => {
    const deps = await seedWorker()
    const r = await call(
      deps,
      'send',
      { type: 'escalation', taskId: 'tsk_other', subject: 's', body: 'b' },
      'sess1'
    )
    expect(r.status).toBe(403)
  })
  it('워커의 send는 dispatchId 생략 시 자기 열린 dispatch로 채운다', async () => {
    const deps = await seedWorker()
    const d = deps.getState().dispatches[0]
    const r = await call(deps, 'send', { type: 'status', subject: 's', body: 'b' }, 'sess1')
    expect(r.status).toBe(200)
    const msg = deps.getState().messages[deps.getState().messages.length - 1]
    expect(msg.dispatchId).toBe(d.id)
  })
  it('워커가 명시적으로 다른(남의) dispatchId를 주면 거부된다', async () => {
    const deps = await seedWorker()
    const run2 = await call(deps, 'run-create', { objective: 'o2', cwd: 'D:/p' })
    const task2 = await call(deps, 'task-create', {
      runId: (run2.body as { id: string }).id,
      title: 't2',
      spec: 's2'
    })
    // sess1이 아닌 다른 세션(sess2)이 소유한 dispatch를 직접 주입한다 —
    // makeDeps의 startWorker mock은 항상 sess1을 돌려주므로 worker-start로는 두 번째
    // 세션을 만들 수 없다.
    const otherDispatch = {
      id: 'dsp_other',
      taskId: (task2.body as { id: string }).id,
      provider: 'codex' as const,
      accountId: 'acc1',
      sessionId: 'sess2',
      cwd: 'D:/p2',
      specPath: 'D:/p2/orch/specs/a.md',
      startedAt: NOW,
      workerState: 'ready' as const,
      retained: false
    }
    await deps.setState({
      ...deps.getState(),
      dispatches: [...deps.getState().dispatches, otherDispatch]
    })
    const r = await call(
      deps,
      'send',
      { type: 'status', dispatchId: otherDispatch.id, subject: 's', body: 'b' },
      'sess1'
    )
    expect(r.status).toBe(403)
  })
})

describe('handleCommand — worker-start 사전 검증 (고아 세션 방지)', () => {
  it('서킷 브레이크된 Task로 worker-start를 부르면 startWorker를 부르지 않고 거부한다', async () => {
    let startWorkerCalls = 0
    const deps = {
      ...makeDeps(),
      startWorker: async () => {
        startWorkerCalls++
        return { sessionId: 'sessX', cwd: 'D:/p', specPath: 'D:/p/orch/specs/a.md' }
      }
    }
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { runId, title: 't', spec: 's' })
    const taskId = (task.body as { id: string }).id
    await deps.setState({
      ...deps.getState(),
      tasks: deps
        .getState()
        .tasks.map((t) => (t.id === taskId ? { ...t, consecutiveFailures: FAILURE_LIMIT } : t))
    })
    const r = await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    expect(r.status).toBe(400)
    expect(startWorkerCalls).toBe(0)
  })

  it('존재하지 않는 task로 worker-start를 부르면 startWorker를 부르지 않고 거부한다', async () => {
    let startWorkerCalls = 0
    const deps = {
      ...makeDeps(),
      startWorker: async () => {
        startWorkerCalls++
        return { sessionId: 'sessX', cwd: 'D:/p', specPath: 'D:/p/orch/specs/a.md' }
      }
    }
    const r = await call(deps, 'worker-start', {
      taskId: 'tsk_missing',
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    expect(r.status).toBe(400)
    expect(startWorkerCalls).toBe(0)
  })

  it('blocked 상태인 task로 worker-start를 부르면 startWorker를 부르지 않고 거부한다', async () => {
    let startWorkerCalls = 0
    const deps = {
      ...makeDeps(),
      startWorker: async () => {
        startWorkerCalls++
        return { sessionId: 'sessX', cwd: 'D:/p', specPath: 'D:/p/orch/specs/a.md' }
      }
    }
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { runId, title: 't', spec: 's' })
    const taskId = (task.body as { id: string }).id
    const gate = await call(deps, 'gate-create', { task: taskId, question: 'q?' })
    expect(gate.status).toBe(200) // 사전조건: task가 blocked로 전이됐다
    const r = await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    expect(r.status).toBe(400)
    expect(startWorkerCalls).toBe(0)
  })

  it('같은 task에 이미 열린 dispatch가 있으면 두 번째 worker-start는 startWorker를 부르지 않고 거부한다', async () => {
    let startWorkerCalls = 0
    const deps = {
      ...makeDeps(),
      startWorker: async () => {
        startWorkerCalls++
        return { sessionId: `sess${startWorkerCalls}`, cwd: 'D:/p', specPath: 'D:/p/orch/specs/a.md' }
      }
    }
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { runId, title: 't', spec: 's' })
    const taskId = (task.body as { id: string }).id
    const first = await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    expect(first.status).toBe(200)
    expect(startWorkerCalls).toBe(1)
    const second = await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    expect(second.status).toBe(400)
    expect(startWorkerCalls).toBe(1) // 두 번째 시도에서 startWorker가 불리지 않았다
  })
})

describe('handleCommand — check', () => {
  it('워커 세션은 check를 부를 수 없다', async () => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { runId, title: 't', spec: 's' })
    await call(deps, 'worker-start', {
      taskId: (task.body as { id: string }).id,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    const r = await call(deps, 'check', {}, 'sess1')
    expect(r.status).toBe(403)
  })
})

describe('handleCommand — reset', () => {
  it('열린 Dispatch가 있으면 거부한다', async () => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { runId, title: 't', spec: 's' })
    await call(deps, 'worker-start', {
      taskId: (task.body as { id: string }).id,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    const r = await call(deps, 'reset', { all: true })
    expect(r.status).toBe(409)
  })
  it('열린 Dispatch가 없으면 상태를 비운다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const r = await call(deps, 'reset', { all: true })
    expect(r.status).toBe(200)
    expect(deps.getState().runs).toHaveLength(0)
  })
  // task-13a: args.all을 서버가 아예 읽지 않던 결함 — else 분기가 우연히 같은 전체 리셋을
  // 해서 결과는 맞았지만 플래그가 무시되고 있었다. 지금은 --all을 명시적으로 읽고, 세 플래그
  // 중 아무것도 안 주면(파괴적 연산 기본값을 "전부 지움"으로 두지 않는다) 거부한다.
  it('플래그를 하나도 주지 않으면 거부하고 상태를 건드리지 않는다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const r = await call(deps, 'reset', {})
    expect(r.status).toBe(400)
    expect(deps.getState().runs).toHaveLength(1)
  })

  // 세 곳이 다 요구하는데 미구현이었다 — 파괴적 연산의 문서화된
  // 유일한 안전망이다. 실제 스토어를 붙여 파일이 남는 것까지 확인한다.
  describe('.bak', () => {
    const withStore = async (): Promise<{ deps: OrchServerDeps; file: string }> => {
      const file = path.join(dir, 'orchestration.json')
      const store = new OrchestrationStore(file)
      await store.load()
      const deps: OrchServerDeps = {
        ...makeDeps(),
        getState: () => store.get(),
        setState: (next) => store.save(next),
        backup: () => store.backup()
      }
      return { deps, file }
    }

    it('reset --all 뒤 .bak이 존재하고 그 내용이 리셋 전 상태다', async () => {
      const { deps, file } = await withStore()
      await call(deps, 'run-create', { objective: '지워질 Run', cwd: 'D:/p' })
      expect((await call(deps, 'reset', { all: true })).status).toBe(200)
      const bak = JSON.parse(await fs.readFile(file + '.bak', 'utf8')) as OrchState
      expect(bak.runs).toHaveLength(1)
      expect(bak.runs[0].objective).toBe('지워질 Run')
      expect((JSON.parse(await fs.readFile(file, 'utf8')) as OrchState).runs).toHaveLength(0)
    })

    it('reset --tasks도 백업한다', async () => {
      const { deps, file } = await withStore()
      const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
      await call(deps, 'task-create', { runId: (run.body as { id: string }).id, spec: 's' })
      expect((await call(deps, 'reset', { tasks: true })).status).toBe(200)
      const bak = JSON.parse(await fs.readFile(file + '.bak', 'utf8')) as OrchState
      expect(bak.tasks).toHaveLength(1)
      expect(deps.getState().tasks).toHaveLength(0)
      expect(deps.getState().runs).toHaveLength(1) // --tasks는 Run을 남긴다
    })

    it('플래그가 없어 거부되는 호출은 .bak을 만들지 않는다 — 직전 백업을 갈아치우지 않는다', async () => {
      const { deps, file } = await withStore()
      await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
      expect((await call(deps, 'reset', {})).status).toBe(400)
      await expect(fs.stat(file + '.bak')).rejects.toThrow()
    })

    it('backup의 await 동안 착륙한 변경을 덮지 않는다 — 쓰기 역전 회귀', async () => {
      // backup(쓰기 큐 + copyFile)이 새 양보 지점이다. wipe가 진입 스냅샷 s를 캡처하면 그 사이
      // 착륙한 변경이 옛 배열로 되돌려진다 — 워커의 send가 그렇게 사라지면 미ack Delivery가
      // 참조하는 메시지가 없어져 이 브랜치가 두 번 못박은 Delivery 무결성이 깨진다.
      const deps = makeDeps()
      const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
      const runId = (run.body as { id: string }).id
      await call(deps, 'task-create', { runId, title: 't', spec: 's' })
      deps.backup = async (): Promise<void> => {
        const before = deps.getState()
        await deps.setState({
          ...before,
          messages: [
            ...before.messages,
            {
              id: 'msg_concurrent',
              runId,
              type: 'status',
              subject: 'backup await 동안 도착한 워커 메시지',
              body: 'b',
              answered: false,
              createdAt: NOW
            }
          ]
        })
      }
      const r = await call(deps, 'reset', { tasks: true })
      expect(r.status).toBe(200)
      expect(deps.getState().messages.some((m) => m.id === 'msg_concurrent')).toBe(true)
      expect(deps.getState().tasks).toHaveLength(0) // 지울 것은 지웠다
    })

    it('backup 미주입이면 백업을 건너뛰고 reset은 그대로 동작한다', async () => {
      const deps = makeDeps() // backup을 주입하지 않는다
      await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
      expect((await call(deps, 'reset', { all: true })).status).toBe(200)
      expect(deps.getState().runs).toHaveLength(0)
    })
  })
})

describe('handleCommand — inbox는 코디네이터 전용', () => {
  const seedTwoWorkers = async (): Promise<OrchServerDeps & { state: OrchState }> => {
    const deps = makeDeps()
    let n = 0
    deps.startWorker = async () => {
      n++
      return { sessionId: `sess${n}`, cwd: 'D:/p', specPath: `D:/p/orch/specs/${n}.md` }
    }
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    for (const title of ['A', 'B']) {
      const task = await call(deps, 'task-create', { runId, title, spec: `spec ${title}` })
      await call(deps, 'worker-start', {
        taskId: (task.body as { id: string }).id,
        agent: 'codex',
        account: 'acc1',
        worktree: 'current'
      })
    }
    return deps
  }

  it('워커 세션의 inbox는 403이다 — ask --resume의 소유권 가드를 우회하는 구멍이었다', async () => {
    const deps = await seedTwoWorkers()
    expect((await call(deps, 'inbox', { limit: 200 }, 'sess1')).status).toBe(403)
  })

  it('코디네이터의 inbox는 여전히 200이다', async () => {
    const deps = await seedTwoWorkers()
    const r = await call(deps, 'inbox', {})
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
  })

  it('워커는 자기 dispatch의 send·ask는 계속 쓸 수 있다 — 막은 것은 inbox뿐이다', async () => {
    const deps = await seedTwoWorkers()
    const d = deps.getState().dispatches.find((x) => x.sessionId === 'sess1')!
    const r = await call(
      deps,
      'send',
      { type: 'status', taskId: d.taskId, dispatchId: d.id, subject: 's', body: 'b' },
      'sess1'
    )
    expect(r.status).toBe(200)
  })
})

describe('handleCommand — retained dispatch', () => {
  const seedRetained = async (
    retain: boolean
  ): Promise<{ deps: OrchServerDeps & { state: OrchState }; released: string[]; dispatchId: string }> => {
    const released: string[] = []
    const deps = makeDeps()
    deps.releaseWorker = async ({ dispatchId }): Promise<void> => {
      released.push(dispatchId)
    }
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const task = await call(deps, 'task-create', {
      runId: (run.body as { id: string }).id,
      title: 't',
      spec: 's'
    })
    const started = await call(deps, 'worker-start', {
      taskId: (task.body as { id: string }).id,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    const dispatchId = (started.body as { dispatchId: string }).dispatchId
    if (retain) await call(deps, 'worker-retain', { dispatch: dispatchId })
    return { deps, released, dispatchId }
  }

  it('retained에 worker-stop은 409이고 상태가 불변이다', async () => {
    // 예전에는 releaseWorker 결과를 보지 않고 stopped+endedAt을 세웠다 — 세션은 살아 있는데
    // 오케스트레이터는 죽은 줄 알고 --retry-of로 같은 cwd에 새 워커를 띄웠다.
    const { deps, released, dispatchId } = await seedRetained(true)
    const r = await call(deps, 'worker-stop', { dispatch: dispatchId })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.body)).toContain('retained')
    const d = deps.getState().dispatches[0]
    expect(d.workerState).toBe('ready')
    expect(d.endedAt).toBeUndefined()
    expect(released).toEqual([]) // 세션을 닫으려는 시도조차 하지 않는다
  })

  it('retained가 아니면 worker-stop은 그대로 stopped로 닫는다', async () => {
    const { deps, released, dispatchId } = await seedRetained(false)
    const r = await call(deps, 'worker-stop', { dispatch: dispatchId })
    expect(r.status).toBe(200)
    const d = deps.getState().dispatches[0]
    expect(d.workerState).toBe('stopped')
    expect(d.endedAt).toBeDefined()
    expect(released).toEqual([dispatchId])
  })

  it('retained에 worker-release는 200이지만 skipped를 싣는다 — 조용히 건너뛰지 않는다', async () => {
    const { deps, dispatchId } = await seedRetained(true)
    const r = await call(deps, 'worker-release', { dispatch: dispatchId })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ released: dispatchId, skipped: 'retained' })
  })

  it('retained가 아니면 worker-release 응답에 skipped가 없다', async () => {
    const { deps, dispatchId } = await seedRetained(false)
    const r = await call(deps, 'worker-release', { dispatch: dispatchId })
    expect(r.body).toEqual({ released: dispatchId })
  })

  it('알 수 없는 dispatch의 worker-release는 종전처럼 통과한다 — 존재를 검증하지 않는다', async () => {
    const { deps } = await seedRetained(false)
    const r = await call(deps, 'worker-release', { dispatch: 'dsp_nope' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ released: 'dsp_nope' })
  })
})

// task-13a: COORDINATOR_ONLY에는 'task-update'가 있었는데 handleCommand의 switch에 케이스가
// 없어 인가는 통과하고 라우팅에서 404로 죽던 공백. task-update는 canTransition을 우회해
// 코디네이터가 좌초한 Task를 수동으로 정정하는 유일한 경로다.
describe('handleCommand — task-update (전이 표 우회, task-13a)', () => {
  const seedTask = async (deps: OrchServerDeps): Promise<string> => {
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { runId, title: 't', spec: 's' })
    return (task.body as { id: string }).id
  }

  /** taskId를 completed까지 실제로 진행시킨다(worker-start → send worker_done) —
   *  completed는 ALLOWED 표에서 전이가 전혀 없는 종단이라 이후 --status ready는
   *  canTransition으로는 절대 금지되는 전이다(우회 검증에 쓴다) */
  const seedCompletedTask = async (deps: OrchServerDeps): Promise<string> => {
    const taskId = await seedTask(deps)
    await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    const d = deps.getState().dispatches[0]
    await call(deps, 'send', {
      type: 'worker_done',
      taskId,
      dispatchId: d.id,
      outcome: 'succeeded',
      subject: 'a',
      body: 'b'
    })
    return taskId
  }

  it('200이고 Task 상태가 바뀐다', async () => {
    const deps = makeDeps()
    const taskId = await seedTask(deps)
    const r = await call(deps, 'task-update', { id: taskId, status: 'blocked' })
    expect(r.status).toBe(200)
    expect(deps.getState().tasks.find((t) => t.id === taskId)!.status).toBe('blocked')
  })

  // 사용자 판정: 가이드 8절이 "서킷 브레이크로 갇힌 Task를 task-update로
  // 구제한다"고 광고하는데 카운터가 남아 있으면 재디스패치가 여전히 막혀 그 구제가 성립하지
  // 않는다. D5로 세션 종료도 카운트하게 되면서 "워커 탭을 3번 닫으면 Task가 영구 불가"가
  // 실제 경로가 됐다.
  describe('서킷 카운터를 되돌린다', () => {
    /** 세션 종료로 닫힌 Dispatch를 FAILURE_LIMIT회 만들어 서킷을 연다 */
    const openCircuit = async (deps: OrchServerDeps, taskId: string): Promise<string> => {
      let dispatchId = ''
      for (let i = 1; i <= FAILURE_LIMIT; i++) {
        deps.startWorker = async () => ({
          sessionId: `sess${i}`,
          cwd: 'D:/p',
          specPath: 'D:/p/orch/specs/a.md'
        })
        const started = await call(deps, 'worker-start', {
          taskId,
          agent: 'codex',
          account: 'acc1',
          worktree: 'current',
          ...(dispatchId ? { retryOf: dispatchId } : {})
        })
        dispatchId = (started.body as { dispatchId: string }).dispatchId
        await handleExit(deps, { sessionId: `sess${i}`, exitCode: 1 })
      }
      return dispatchId
    }

    it('서킷이 열린 Task에 task-update 후 worker-start --retry-of가 통과한다', async () => {
      const deps = makeDeps()
      const taskId = await seedTask(deps)
      const dispatchId = await openCircuit(deps, taskId)
      expect(deps.getState().tasks.find((t) => t.id === taskId)!.consecutiveFailures).toBe(
        FAILURE_LIMIT
      )
      // 카운터가 남아 있으면 상태만 바뀌고 이 재시도가 circuit break로 거부된다
      const blocked = await call(deps, 'worker-start', {
        taskId,
        agent: 'codex',
        account: 'acc1',
        worktree: 'current',
        retryOf: dispatchId
      })
      expect(blocked.status).toBe(400)
      expect(JSON.stringify(blocked.body)).toContain('circuit break')

      const updated = await call(deps, 'task-update', { id: taskId, status: 'ready' })
      expect(updated.status).toBe(200)
      expect(deps.getState().tasks.find((t) => t.id === taskId)!.consecutiveFailures).toBe(0)

      deps.startWorker = async () => ({
        sessionId: 'sess-after',
        cwd: 'D:/p',
        specPath: 'D:/p/orch/specs/a.md'
      })
      const retried = await call(deps, 'worker-start', {
        taskId,
        agent: 'codex',
        account: 'acc1',
        worktree: 'current',
        retryOf: dispatchId
      })
      expect(retried.status).toBe(200)
    })

    it('실패가 없던 Task의 카운터도 0으로 유지된다 — 다른 필드는 그대로다', async () => {
      const deps = makeDeps()
      const taskId = await seedTask(deps)
      const before = deps.getState().tasks.find((t) => t.id === taskId)!
      await call(deps, 'task-update', { id: taskId, status: 'blocked' })
      const after = deps.getState().tasks.find((t) => t.id === taskId)!
      expect(after.consecutiveFailures).toBe(0)
      expect(after.spec).toBe(before.spec)
      expect(after.deps).toBe(before.deps)
    })
  })

  it('전이 표가 금지하는 전이도 통과한다 — completed에서 ready로(우회 확인)', async () => {
    const deps = makeDeps()
    const taskId = await seedCompletedTask(deps)
    expect(deps.getState().tasks.find((t) => t.id === taskId)!.status).toBe('completed')
    const r = await call(deps, 'task-update', { id: taskId, status: 'ready' })
    expect(r.status).toBe(200)
    expect(deps.getState().tasks.find((t) => t.id === taskId)!.status).toBe('ready')
  })

  it('우회 여부를 로그에 남긴다 — task id·이전 상태·새 상태·table-allowed=false', async () => {
    const logs: string[] = []
    const deps = { ...makeDeps(), log: (m: string) => logs.push(m) }
    const taskId = await seedCompletedTask(deps)
    await call(deps, 'task-update', { id: taskId, status: 'ready' })
    expect(
      logs.some(
        (l) =>
          l.includes(taskId) &&
          l.includes('completed') &&
          l.includes('ready') &&
          l.includes('table-allowed=false')
      )
    ).toBe(true)
  })

  it('허용되는 전이는 table-allowed=true로 로그에 남는다', async () => {
    const logs: string[] = []
    const deps = { ...makeDeps(), log: (m: string) => logs.push(m) }
    const taskId = await seedTask(deps)
    await call(deps, 'task-update', { id: taskId, status: 'blocked' })
    expect(logs.some((l) => l.includes('table-allowed=true'))).toBe(true)
  })

  it('--result를 주면 Task.result에 반영한다', async () => {
    const deps = makeDeps()
    const taskId = await seedTask(deps)
    const r = await call(deps, 'task-update', {
      id: taskId,
      status: 'failed',
      result: '수동 정정: 세션이 죽어 강제로 failed 처리'
    })
    expect(r.status).toBe(200)
    expect(deps.getState().tasks.find((t) => t.id === taskId)!.result).toBe(
      '수동 정정: 세션이 죽어 강제로 failed 처리'
    )
  })

  it('A를 completed로 정정하면 A에 의존하던 pending Task B가 ready로 승격된다(recomputeReady)', async () => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const a = await call(deps, 'task-create', { runId, title: 'a', spec: 's' })
    const aId = (a.body as { id: string }).id
    const b = await call(deps, 'task-create', { runId, title: 'b', spec: 's', deps: [aId] })
    const bId = (b.body as { id: string }).id
    expect(deps.getState().tasks.find((t) => t.id === bId)!.status).toBe('pending')
    const r = await call(deps, 'task-update', { id: aId, status: 'completed' })
    expect(r.status).toBe(200)
    expect(deps.getState().tasks.find((t) => t.id === bId)!.status).toBe('ready')
  })

  it('B가 blocked(Gate)면 A를 완료시켜도 B는 blocked에 머문다 — recomputeReady는 blocked를 건드리지 않는다', async () => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const a = await call(deps, 'task-create', { runId, title: 'a', spec: 's' })
    const aId = (a.body as { id: string }).id
    const b = await call(deps, 'task-create', { runId, title: 'b', spec: 's', deps: [aId] })
    const bId = (b.body as { id: string }).id
    const gate = await call(deps, 'gate-create', { task: bId, question: 'q?' })
    expect(gate.status).toBe(200) // 사전조건: B가 blocked로 전이됐다
    expect(deps.getState().tasks.find((t) => t.id === bId)!.status).toBe('blocked')
    const r = await call(deps, 'task-update', { id: aId, status: 'completed' })
    expect(r.status).toBe(200)
    expect(deps.getState().tasks.find((t) => t.id === bId)!.status).toBe('blocked')
  })

  it('유효하지 않은 --status는 400을 낸다', async () => {
    const deps = makeDeps()
    const taskId = await seedTask(deps)
    const before = deps.getState().tasks.find((t) => t.id === taskId)!.status
    const r = await call(deps, 'task-update', { id: taskId, status: 'bogus' })
    expect(r.status).toBe(400)
    expect(deps.getState().tasks.find((t) => t.id === taskId)!.status).toBe(before)
  })

  it('존재하지 않는 --id는 400을 낸다', async () => {
    const r = await call(makeDeps(), 'task-update', { id: 'tsk_missing', status: 'ready' })
    expect(r.status).toBe(400)
  })

  it('워커 세션이 부르면 403이다', async () => {
    const deps = makeDeps()
    const taskId = await seedTask(deps)
    await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    const r = await call(deps, 'task-update', { id: taskId, status: 'ready' }, 'sess1')
    expect(r.status).toBe(403)
  })
})

describe('handleCommand — task-list --ready', () => {
  it('ready 상태만 걸러 준다', async () => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const a = await call(deps, 'task-create', { runId, title: 'a', spec: 's' })
    await call(deps, 'task-create', {
      runId,
      title: 'b',
      spec: 's',
      deps: [(a.body as { id: string }).id]
    })
    const r = await call(deps, 'task-list', { ready: true })
    const list = r.body as { id: string; title: string }[]
    expect(list.map((t) => t.title)).toEqual(['a'])
  })
  it('brief는 spec을 160자에서 자르고 표시를 남긴다', async () => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    await call(deps, 'task-create', {
      runId: (run.body as { id: string }).id,
      title: 't',
      spec: 'x'.repeat(300)
    })
    const r = await call(deps, 'task-list', { brief: true })
    const list = r.body as { spec: string; spec_truncated: boolean }[]
    expect(list[0].spec.length).toBe(160)
    expect(list[0].spec_truncated).toBe(true)
  })
})

// 그 결함들의 뿌리는 server.ts와 coordinator.ts가 각각 openDispatch를 부르는
// 이중 호출이었다 — 한쪽만(Mock startWorker로) 테스트하면 이 회귀를 잡을 수 없다. 그래서
// 이 블록은 실제 OrchCoordinator를 OrchServerDeps.startWorker/releaseWorker의 구현으로
// 배선해 둘을 함께 검증한다(리뷰가 명시적으로 요구한 유일한 방법).
describe('handleCommand — worker-start × OrchCoordinator 통합 배선', () => {
  const makeWiredDeps = (
    coordOverrides: Partial<CoordinatorDeps> = {}
  ): OrchServerDeps & { state: OrchState } => {
    const box = { state: emptyState() as OrchState }
    const coordDeps: CoordinatorDeps = {
      spawnSession: async () => ({ id: 'sess1' }),
      writeToSession: () => {},
      isBusy: () => null,
      isAlive: () => true,
      killSession: () => {},
      createWorktree: async (a) => ({ path: path.join(dir, 'wt-' + a.name) }),
      accountProvider: () => 'codex',
      specsDir,
      log: () => {},
      ...coordOverrides
    }
    const coordinator = new OrchCoordinator(coordDeps)
    return {
      state: box.state,
      getState: () => box.state,
      setState: async (next) => {
        box.state = next
      },
      startWorker: (a) => coordinator.startWorker(a),
      releaseWorker: async () => {},
      listAccounts: () => [{ id: 'acc1', label: '계정1', provider: 'codex' }],
      readWorker: async () => 'output',
      enabled: () => true,
      now: () => NOW
    } as OrchServerDeps & { state: OrchState }
  }

  const seedTask = async (deps: OrchServerDeps): Promise<string> => {
    const run = await call(deps, 'run-create', { objective: 'o', cwd: dir })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { runId, title: 't', spec: 's' })
    return (task.body as { id: string }).id
  }

  it('worker-start 왕복이 200이고 dispatchId를 돌려준다 — openDispatch 이중 호출 회귀 방지', async () => {
    const deps = makeWiredDeps()
    const taskId = await seedTask(deps)
    const r = await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    expect(r.status).toBe(200)
    const body = r.body as { dispatchId: string; sessionId: string }
    expect(body.dispatchId).toBeTruthy()
    expect(body.sessionId).toBe('sess1')
    // 이중으로 openDispatch가 불렸다면 두 번째 호출이 'dispatch already open'으로 400을
    // 내거나 dispatch가 2개 생겼을 것이다 — 회귀 방지의 핵심 단정.
    expect(deps.getState().dispatches).toHaveLength(1)
    expect(deps.getState().dispatches[0].id).toBe(body.dispatchId)
    expect(deps.getState().dispatches[0].sessionId).toBe('sess1')
  })

  it('스폰 실패 후 상태가 무결하다 — dispatch 0개·Task 원상태·거짓 status 없음, 같은 Task로 재시도하면 성공한다', async () => {
    let fail = true
    const deps = makeWiredDeps({
      spawnSession: async () => {
        if (fail) throw new Error('spawn failed')
        return { id: 'sess1' }
      }
    })
    const taskId = await seedTask(deps)
    const before = deps.getState().tasks.find((t) => t.id === taskId)!.status

    const r1 = await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    expect(r1.status).toBe(400)
    expect(deps.getState().dispatches).toHaveLength(0)
    expect(deps.getState().tasks.find((t) => t.id === taskId)!.status).toBe(before)
    expect(deps.getState().messages.some((m) => m.type === 'status')).toBe(false)

    fail = false
    const r2 = await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    expect(r2.status).toBe(200)
    expect(deps.getState().dispatches).toHaveLength(1)
  })

  it('스폰 대기 중 다른 워커의 worker_done이 착륙해도 patch가 그 결과를 덮어쓰지 않는다 (C3)', async () => {
    let releaseSpawn: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })
    const deps = makeWiredDeps({
      spawnSession: async () => {
        await gate
        return { id: 'sess1' }
      }
    })
    const taskId = await seedTask(deps)
    const startPromise = call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    // handleCommand는 openDispatch를 커밋(await deps.setState)한 뒤에야 코디네이터의
    // startWorker(스폰 대기)로 들어간다 — setState mock에 내부 await가 없어 그 커밋은
    // call()이 반환을 완료한 시점에 이미 동기적으로 반영돼 있다.
    const dispatchId = deps.getState().dispatches[0].id
    const done = await call(deps, 'send', {
      type: 'worker_done',
      taskId,
      dispatchId,
      outcome: 'succeeded',
      subject: 's',
      body: 'b'
    })
    expect(done.status).toBe(200)
    releaseSpawn()
    const r = await startPromise
    expect(r.status).toBe(200)
    const d = deps.getState().dispatches.find((x) => x.id === dispatchId)!
    expect(d.outcome).toBe('succeeded') // patch가 이 값을 덮어쓰지 않았다
    expect(d.sessionId).toBe('sess1') // 그런데도 sessionId는 patch됐다
  })

  it('죽은 --terminal로 재사용을 시도하면 거부되고 dispatch가 남지 않는다', async () => {
    const deps = makeWiredDeps({ isAlive: () => false })
    const taskId = await seedTask(deps)
    // 재사용 후보 dispatch를 직접 심는다(이미 종단된, 재사용 가능한 것처럼 보이는 상태) —
    // 실제로 살아 있는지는 isAlive만이 판정한다.
    await deps.setState({
      ...deps.getState(),
      dispatches: [
        {
          id: 'dsp_prev',
          taskId: 'tsk_other',
          provider: 'codex',
          accountId: 'acc1',
          sessionId: 'sessDead',
          cwd: dir,
          specPath: path.join(specsDir, 'x.md'),
          startedAt: NOW,
          workerState: 'stopped',
          outcome: 'succeeded',
          endedAt: NOW,
          retained: false
        }
      ]
    })
    const r = await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current',
      terminal: 'sessDead'
    })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toContain('not alive')
    expect(deps.getState().dispatches.filter((x) => x.taskId === taskId)).toHaveLength(0)
  })

  it('아직 열린 dispatch가 쓰고 있는 세션은 --terminal로 재사용할 수 없다', async () => {
    // worker-start의 사전 검증(server.ts)은 "같은 taskId에 열린 dispatch"만 본다 — 다른 Task의
    // 열린 dispatch가 그 세션을 쓰고 있는 경우는 openDispatch의 sessionId 가드(state.ts)가
    // 잡는다. 이 조합이 통과하면 한 세션에 열린 dispatch가 둘이 되어, closeDispatch(첫 번째
    // 열린 것을 닫는다)와 releaseArgsFor(마지막에 열린 것이 소유자다)가 서로 다른 dispatch를
    // 가리킨다. 그 두 규칙이 만나는 경우 자체를 없애는 것이 이 거부다.
    const deps = makeWiredDeps({ isAlive: () => true })
    const taskId = await seedTask(deps)
    await deps.setState({
      ...deps.getState(),
      dispatches: [
        {
          id: 'dsp_live',
          taskId: 'tsk_other',
          provider: 'codex',
          accountId: 'acc1',
          sessionId: 'sessLive',
          cwd: dir,
          specPath: path.join(specsDir, 'x.md'),
          startedAt: NOW,
          workerState: 'ready', // 열려 있다 — endedAt·outcome이 없다
          retained: false
        }
      ]
    })
    const r = await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current',
      terminal: 'sessLive'
    })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toContain('sessionId already in use')
    expect(deps.getState().dispatches.filter((x) => x.taskId === taskId)).toHaveLength(0)
  })
})

describe('handleExit — probeLimit 배선과 쓰기 역전 회귀', () => {
  /** run + task + 열린 dispatch(sessionId='sess1')를 만든다. makeDeps().startWorker가 항상
   *  sess1을 돌려주는 스텁이라 'handleCommand — 역할 인가'의 seedWorker와 같은 모양이다. */
  const seedOpenDispatch = async (): Promise<{
    deps: OrchServerDeps & { state: OrchState }
    runId: string
  }> => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { runId, title: 't', spec: 's' })
    const taskId = (task.body as { id: string }).id
    await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    return { deps, runId }
  }

  it('probeLimit이 값을 주면 Dispatch에 실린다', async () => {
    const { deps } = await seedOpenDispatch()
    deps.probeLimit = async () => 1_700_000_000_000
    await handleExit(deps, { sessionId: 'sess1', exitCode: 1 })
    const d = deps.getState().dispatches[0]
    expect(d.limitResetsAt).toBe(1_700_000_000_000)
    expect(d.endedAt).toBeDefined()
  })

  it('probeLimit이 null이면 필드가 없다', async () => {
    const { deps } = await seedOpenDispatch()
    deps.probeLimit = async () => null
    await handleExit(deps, { sessionId: 'sess1', exitCode: 1 })
    const d = deps.getState().dispatches[0]
    expect('limitResetsAt' in d).toBe(false)
  })

  it('probeLimit이 던지면 handleExit은 던지지 않고 세션은 그대로 닫히며 log가 한 번 불린다', async () => {
    const { deps } = await seedOpenDispatch()
    const logs: string[] = []
    deps.probeLimit = async () => {
      throw new Error('probe boom')
    }
    deps.log = (m: string): void => {
      logs.push(m)
    }
    await expect(handleExit(deps, { sessionId: 'sess1', exitCode: 1 })).resolves.toBeUndefined()
    const d = deps.getState().dispatches[0]
    expect(d.endedAt).toBeDefined()
    expect(d.workerState).toBe('failed')
    expect('limitResetsAt' in d).toBe(false)
    expect(logs).toHaveLength(1)
  })

  it('probeLimit이 미주입이면 부르지 않고 기존 동작 그대로다', async () => {
    const { deps } = await seedOpenDispatch()
    await handleExit(deps, { sessionId: 'sess1', exitCode: 0 })
    const d = deps.getState().dispatches[0]
    expect(d.workerState).toBe('stopped')
    expect('limitResetsAt' in d).toBe(false)
    const msg = deps.getState().messages.find((m) => m.type === 'status')!
    expect(msg.subject).toBe('session ended without reporting')
  })

  it('무관한 세션의 exit은 상태를 한 글자도 바꾸지 않는다 (과거에 소실된 회귀)', async () => {
    // server.ts의 `r.value === null` 조기 반환이 그 가드다. 없으면 앱의 **모든** 세션 종료가
    // orchestration.json을 재기록한다 — 오케스트레이션과 무관한 사용자 탭을 닫을 때마다.
    const { deps } = await seedOpenDispatch()
    const before = deps.getState()
    let writes = 0
    const inner = deps.setState.bind(deps)
    deps.setState = async (next): Promise<void> => {
      writes++
      await inner(next)
    }
    await handleExit(deps, { sessionId: 'sess-of-a-user-tab', exitCode: 0 })
    expect(writes).toBe(0)
    expect(deps.getState()).toBe(before) // 같은 객체다 — 새 상태를 만들지도 않았다
    expect(deps.getState().dispatches[0].endedAt).toBeUndefined()
  })

  it('probeLimit의 await 동안 다른 상태 변경이 일어나도 잃지 않는다 — 쓰기 역전 회귀', async () => {
    const { deps, runId } = await seedOpenDispatch()
    // probeLimit 안에서 직접 deps.setState를 불러 상태를 바꾼다 — Run에 무관한 메시지 하나를
    // 추가한다. handleExit이 await 이전 스냅샷으로 closeDispatch를 부르면 이 변경이
    // setState(r.state)에 덮여 사라진다 (T7에서 실증된 것과 같은 쓰기 역전).
    deps.probeLimit = async () => {
      const before = deps.getState()
      await deps.setState({
        ...before,
        messages: [
          ...before.messages,
          {
            id: 'msg_concurrent',
            runId,
            type: 'status',
            subject: 'concurrent write',
            body: 'probeLimit await 동안의 다른 변경',
            answered: false,
            createdAt: NOW
          }
        ]
      })
      return null
    }
    await handleExit(deps, { sessionId: 'sess1', exitCode: 1 })
    expect(deps.getState().messages.some((m) => m.id === 'msg_concurrent')).toBe(true)
  })
})

describe("send --type worker_done --outcome failed: 한도 탐침", () => {
  /** run + task + 열린 dispatch(sessionId='sess1')를 만든다 — handleExit 블록의 seedOpenDispatch와
   *  같은 모양이다. */
  const seedOpenDispatch = async (): Promise<{
    deps: OrchServerDeps & { state: OrchState }
    runId: string
    taskId: string
    dispatchId: string
  }> => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { runId, title: 't', spec: 's' })
    const taskId = (task.body as { id: string }).id
    await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    const dispatchId = deps.getState().dispatches[0].id
    return { deps, runId, taskId, dispatchId }
  }

  it('worker_done --outcome failed에서 탐침이 불리고 값이 Dispatch에 실린다', async () => {
    const { deps, taskId, dispatchId } = await seedOpenDispatch()
    let probeCalls = 0
    deps.probeLimit = async () => {
      probeCalls++
      return 1_700_000_000_000
    }
    const r = await call(deps, 'send', {
      type: 'worker_done',
      taskId,
      dispatchId,
      outcome: 'failed',
      subject: 'a',
      body: 'b'
    })
    expect(r.status).toBe(200)
    expect(probeCalls).toBe(1)
    const d = deps.getState().dispatches.find((x) => x.id === dispatchId)!
    expect(d.limitResetsAt).toBe(1_700_000_000_000)
    expect(d.outcome).toBe('failed')
  })

  it("outcome: 'completed'(succeeded)에서는 탐침을 부르지 않는다", async () => {
    const { deps, taskId, dispatchId } = await seedOpenDispatch()
    let probeCalls = 0
    deps.probeLimit = async () => {
      probeCalls++
      return 1_700_000_000_000
    }
    const r = await call(deps, 'send', {
      type: 'worker_done',
      taskId,
      dispatchId,
      outcome: 'succeeded',
      subject: 'a',
      body: 'b'
    })
    expect(r.status).toBe(200)
    expect(probeCalls).toBe(0)
    const d = deps.getState().dispatches.find((x) => x.id === dispatchId)!
    expect('limitResetsAt' in d).toBe(false)
  })

  it('탐침이 던져도 worker_done은 200을 반환한다', async () => {
    const { deps, taskId, dispatchId } = await seedOpenDispatch()
    const logs: string[] = []
    deps.probeLimit = async () => {
      throw new Error('probe boom')
    }
    deps.log = (m: string): void => {
      logs.push(m)
    }
    const r = await call(deps, 'send', {
      type: 'worker_done',
      taskId,
      dispatchId,
      outcome: 'failed',
      subject: 'a',
      body: 'b'
    })
    expect(r.status).toBe(200)
    const d = deps.getState().dispatches.find((x) => x.id === dispatchId)!
    expect(d.outcome).toBe('failed')
    expect('limitResetsAt' in d).toBe(false)
    expect(logs).toHaveLength(1)
  })

  it('한도로 실패한 worker_done도 inbox에 status 메시지를 남긴다 (오케스트레이터 가이드 §7, 리뷰 I3)', async () => {
    const { deps, taskId, dispatchId } = await seedOpenDispatch()
    deps.probeLimit = async () => 1_700_000_000_000
    const r = await call(deps, 'send', {
      type: 'worker_done',
      taskId,
      dispatchId,
      outcome: 'failed',
      subject: '워커 자체 보고',
      body: '문구가 나오고 멈췄다'
    })
    expect(r.status).toBe(200)
    const messages = deps.getState().messages
    // 워커가 직접 보낸 worker_done 메시지(subject·body)는 그대로 남는다 — 탐침이 덮어쓰지 않는다.
    expect(
      messages.some((m) => m.type === 'worker_done' && m.subject === '워커 자체 보고')
    ).toBe(true)
    // closeDispatch(handleExit 경로, state.ts:264-284)와 같은 형식의 별도 status 메시지가 추가된다.
    const status = messages.find((m) => m.type === 'status' && m.dispatchId === dispatchId)
    expect(status?.subject).toBe('session ended at a usage limit')
    expect(status?.body).toContain(new Date(1_700_000_000_000).toISOString())
    expect(status?.body).toContain('--retry-of')
  })

  it('probeLimit의 await 동안 다른 상태 변경이 일어나도 잃지 않는다 — 쓰기 역전 회귀 (리뷰 I4)', async () => {
    const { deps, runId, taskId, dispatchId } = await seedOpenDispatch()
    // probeLimit 안에서 직접 deps.setState를 불러 상태를 바꾼다 — handleExit 블록의 "쓰기 역전
    // 회귀" 테스트와 같은 형태다. server.ts가 probeLimit의 await 이후 deps.getState()를 다시
    // 읽지 않고 진입 시점 스냅샷(s)으로 applyWorkerDone을 부르면 이 변경이 setState(nextState)에
    // 덮여 사라진다 — 이 테스트를 그 되돌린 코드로 실제로 돌려 실패를 확인했다(리뷰 I4, 보고서
    // 참고).
    deps.probeLimit = async () => {
      const before = deps.getState()
      await deps.setState({
        ...before,
        messages: [
          ...before.messages,
          {
            id: 'msg_concurrent',
            runId,
            type: 'status',
            subject: 'concurrent write',
            body: 'probeLimit await 동안의 다른 변경',
            answered: false,
            createdAt: NOW
          }
        ]
      })
      return null
    }
    await call(deps, 'send', {
      type: 'worker_done',
      taskId,
      dispatchId,
      outcome: 'failed',
      subject: 'a',
      body: 'b'
    })
    expect(deps.getState().messages.some((m) => m.id === 'msg_concurrent')).toBe(true)
  })
})

describe('run-create — cwd 정규화', () => {
  it('해석기가 주입되면 그것이 돌려준 값을 cwd로 저장한다', async () => {
    const deps = makeDeps()
    deps.resolveProjectRoot = async () => 'D:/proj'
    const r = await call(deps, 'run-create', { objective: '목표', cwd: 'D:/proj/src/main' })
    expect(r.status).toBe(200)
    expect(deps.getState().runs[0].cwd).toBe('D:/proj')
  })

  it('해석기에 주어진 --cwd 를 그대로 넘긴다', async () => {
    const deps = makeDeps()
    const seen: string[] = []
    deps.resolveProjectRoot = async (cwd) => {
      seen.push(cwd)
      return 'D:/proj'
    }
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/proj/src/main' })
    expect(seen).toEqual(['D:/proj/src/main'])
  })

  // 선택적 의존성 관례 — 주입하지 않는 기존 호출자(테스트 포함)는 그대로 동작해야 한다
  it('해석기가 없으면 주어진 --cwd 를 그대로 저장한다', async () => {
    const deps = makeDeps()
    const r = await call(deps, 'run-create', { objective: '목표', cwd: 'D:/proj/src/main' })
    expect(r.status).toBe(200)
    expect(deps.getState().runs[0].cwd).toBe('D:/proj/src/main')
  })

  // 배선(ipc.ts)은 계정마다 파일시스템을 훑고 git 까지 부른다. 거기서 난 실패가 Run 생성을
  // 막으면 코디네이터가 아무 작업도 시작하지 못한다 — handleExit 이 probeLimit 을 감싼 것과 같다
  it('해석기가 실패하면 주어진 --cwd 를 그대로 저장한다', async () => {
    const deps = makeDeps()
    const logged: string[] = []
    deps.log = (m) => logged.push(m)
    deps.resolveProjectRoot = async () => {
      throw new Error('EACCES')
    }
    const r = await call(deps, 'run-create', { objective: '목표', cwd: 'D:/proj/src/main' })
    expect(r.status).toBe(200)
    expect(deps.getState().runs[0].cwd).toBe('D:/proj/src/main')
    expect(logged.some((m) => m.includes('EACCES'))).toBe(true)
  })

  it('objective 가 비면 정규화 이전에 거절한다', async () => {
    const deps = makeDeps()
    let called = false
    deps.resolveProjectRoot = async (cwd) => {
      called = true
      return cwd
    }
    const r = await call(deps, 'run-create', { objective: '  ', cwd: 'D:/proj' })
    expect(r.status).toBe(400)
    expect(called).toBe(false)
  })
})

describe('task-create --validate 와 run-configs', () => {
  it('--validate 를 Task 에 저장한다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    const r = await call(deps, 'task-create', { spec: '작업', validate: 'cfg1' })
    expect(r.status).toBe(200)
    expect(deps.getState().tasks[0].validateConfigId).toBe('cfg1')
  })

  it('--validate 없이 만든 Task 에는 그 필드가 없다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { spec: '작업' })
    expect(deps.getState().tasks[0].validateConfigId).toBeUndefined()
  })

  it('run-configs 는 주입된 목록을 그대로 돌려준다', async () => {
    const deps = makeDeps()
    deps.listRunConfigs = async () => [{ id: 'cfg1', name: '테스트', type: 'npm' }]
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    const r = await call(deps, 'run-configs', {})
    expect(r.status).toBe(200)
    expect(r.body).toEqual([{ id: 'cfg1', name: '테스트', type: 'npm' }])
  })

  // 주입되지 않는 기존 호출자(테스트 포함)가 깨지면 안 된다 — now?/log?/backup? 와 같은 관례다
  it('listRunConfigs 가 주입되지 않으면 빈 목록이다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    const r = await call(deps, 'run-configs', {})
    expect(r.status).toBe(200)
    expect(r.body).toEqual([])
  })

  // 워커도 자기가 무엇으로 검증될지 볼 수 있어야 한다 — 상태를 바꾸지 않는 읽기 명령이다
  it('워커 세션도 run-configs 를 부를 수 있다', async () => {
    const deps = makeDeps()
    deps.listRunConfigs = async () => [{ id: 'cfg1', name: '테스트', type: 'npm' }]
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { spec: '작업' })
    const taskId = deps.getState().tasks[0].id
    await call(deps, 'worker-start', { task: taskId, agent: 'claude', account: 'acc1' })
    const workerSession = deps.getState().dispatches[0].sessionId
    const r = await call(deps, 'run-configs', {}, workerSession)
    expect(r.status).toBe(200)
  })
})

describe('worker_done 이 검증을 시작한다', () => {
  it('검증이 걸린 Task 가 끝나면 startValidation 을 부른다', async () => {
    const deps = makeDeps()
    const started: { taskId: string; cwd: string }[] = []
    deps.startValidation = (a) => void started.push(a)
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { spec: '작업', validate: 'cfg1' })
    const taskId = deps.getState().tasks[0].id
    await call(deps, 'worker-start', { task: taskId, agent: 'claude', account: 'acc1' })
    const d = deps.getState().dispatches[0]
    await call(
      deps,
      'send',
      { type: 'worker_done', taskId, dispatchId: d.id, outcome: 'succeeded', subject: 's', body: 'b' },
      d.sessionId
    )
    expect(deps.getState().tasks[0].status).toBe('validating')
    expect(started).toEqual([{ taskId, cwd: d.cwd }])
  })

  it('검증이 없는 Task 는 startValidation 을 부르지 않는다', async () => {
    const deps = makeDeps()
    const started: { taskId: string; cwd: string }[] = []
    deps.startValidation = (a) => void started.push(a)
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { spec: '작업' })
    const taskId = deps.getState().tasks[0].id
    await call(deps, 'worker-start', { task: taskId, agent: 'claude', account: 'acc1' })
    const d = deps.getState().dispatches[0]
    await call(
      deps,
      'send',
      { type: 'worker_done', taskId, dispatchId: d.id, outcome: 'succeeded', subject: 's', body: 'b' },
      d.sessionId
    )
    expect(deps.getState().tasks[0].status).toBe('completed')
    expect(started).toEqual([])
  })

  // **주입되지 않으면 검증이 없는 것으로 동작한다**(스펙 5절). validating 으로 보내면 결과를
  // 가져다줄 것이 아무것도 없어 Task 가 영원히 그 상태이고, recomputeReady 는 completed 만
  // 승격시키므로 의존 Task 는 전부 pending 에 멈춘다 — 선택적 의존성이 저하하는 대신 Task 를
  // 고립시키는 것이다. 같은 자루의 listRunConfigs 는 빈 목록으로 올바르게 저하한다.
  it('startValidation 이 주입되지 않으면 검증 없이 completed 로 간다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { spec: '작업', validate: 'cfg1' })
    const taskId = deps.getState().tasks[0].id
    await call(deps, 'worker-start', { task: taskId, agent: 'claude', account: 'acc1' })
    const d = deps.getState().dispatches[0]
    const r = await call(
      deps,
      'send',
      { type: 'worker_done', taskId, dispatchId: d.id, outcome: 'succeeded', subject: 's', body: 'b' },
      d.sessionId
    )
    expect(r.status).toBe(200)
    expect(deps.getState().tasks[0].status).toBe('completed')
  })

  // 재전송(재시도 네트워크 요청 등)은 applyWorkerDone 이 상태를 바꾸지 않고 'alreadyReported' 를
  // 돌려주는 문서화된 idempotent 경로다 — 이 경우 startValidation 을 다시 부르면 같은 cwd 에
  // 검증이 중복으로 큐잉되고, 그 사이 Task 가 재시도돼 validating 으로 다시 들어왔다면 낡은
  // 검증의 종료 코드가 새 시도를 정산해 버린다.
  it('재전송된 worker_done 은 startValidation 을 다시 부르지 않는다', async () => {
    const deps = makeDeps()
    const started: { taskId: string; cwd: string }[] = []
    deps.startValidation = (a) => void started.push(a)
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { spec: '작업', validate: 'cfg1' })
    const taskId = deps.getState().tasks[0].id
    await call(deps, 'worker-start', { task: taskId, agent: 'claude', account: 'acc1' })
    const d = deps.getState().dispatches[0]
    const args = {
      type: 'worker_done',
      taskId,
      dispatchId: d.id,
      outcome: 'succeeded',
      subject: 's',
      body: 'b'
    }
    await call(deps, 'send', args, d.sessionId)
    expect(started).toHaveLength(1)
    const r2 = await call(deps, 'send', args, d.sessionId)
    expect(r2.body).toBe('alreadyReported')
    expect(started).toHaveLength(1) // 재전송으로 다시 큐잉되지 않는다
  })
})

describe('task-create --review 와 검토 라우팅', () => {
  it('task-create --review 가 reviewRequested 를 켠다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { spec: '작업', review: true })
    expect(deps.getState().tasks[0].reviewRequested).toBe(true)
  })

  it('--review 없이 만든 Task 는 reviewRequested 가 없다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { spec: '작업' })
    expect(deps.getState().tasks[0].reviewRequested).toBeUndefined()
  })

  // 이것이 이 Task 의 핵심이다 — 검토 Dispatch 의 보고가 구현 보고로 처리되면 Task 가 두 번 끝난다
  it('검토 Dispatch 로 온 worker_done 은 applyReviewResult 로 간다', async () => {
    // review: true 인 Dispatch, reviewing 인 Task → worker_done succeeded → completed
    // 그리고 'review passed' status 메시지가 남는다
    const deps = makeDeps()
    deps.startReview = () => {}
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { spec: '작업', review: true })
    const taskId = deps.getState().tasks[0].id
    await call(deps, 'worker-start', { task: taskId, agent: 'claude', account: 'acc1' })
    const impl = deps.getState().dispatches[0]
    await call(
      deps,
      'send',
      {
        type: 'worker_done',
        taskId,
        dispatchId: impl.id,
        outcome: 'succeeded',
        subject: 's',
        body: 'b'
      },
      impl.sessionId
    )
    expect(deps.getState().tasks[0].status).toBe('reviewing')
    // 검토 Dispatch를 직접 주입한다 — 그것을 여는 배선(startReview 구현)은 이 Task의 몫이 아니다.
    // 다른 provider(codex)를 쓴다 — 구현은 claude였다.
    const reviewDispatch = {
      id: 'dsp_review',
      taskId,
      provider: 'codex' as const,
      accountId: 'acc1',
      sessionId: 'sess_review',
      cwd: 'D:/p',
      specPath: 'D:/p/orch/specs/review.md',
      review: true,
      startedAt: NOW,
      workerState: 'ready' as const,
      retained: false
    }
    await deps.setState({
      ...deps.getState(),
      dispatches: [...deps.getState().dispatches, reviewDispatch]
    })
    const r = await call(
      deps,
      'send',
      {
        type: 'worker_done',
        taskId,
        dispatchId: reviewDispatch.id,
        outcome: 'succeeded',
        subject: 's',
        body: '리뷰 통과'
      },
      reviewDispatch.sessionId
    )
    expect(r.status).toBe(200)
    expect(deps.getState().tasks[0].status).toBe('completed')
    expect(
      deps.getState().messages.some((m) => m.subject === 'review passed')
    ).toBe(true)
  })

  it('구현 Dispatch 로 온 worker_done 은 지금과 똑같이 처리된다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { spec: '작업' })
    const taskId = deps.getState().tasks[0].id
    await call(deps, 'worker-start', { task: taskId, agent: 'claude', account: 'acc1' })
    const d = deps.getState().dispatches[0]
    const r = await call(
      deps,
      'send',
      { type: 'worker_done', taskId, dispatchId: d.id, outcome: 'succeeded', subject: 's', body: 'b' },
      d.sessionId
    )
    expect(r.status).toBe(200)
    expect(r.body).toBe('accepted')
    expect(deps.getState().tasks[0].status).toBe('completed')
  })

  it('startReview 가 주입되지 않으면 canReview: false 가 넘어간다', async () => {
    // reviewRequested 가 걸린 Task 도 성공 보고에 곧바로 completed 로 간다
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { spec: '작업', review: true })
    const taskId = deps.getState().tasks[0].id
    await call(deps, 'worker-start', { task: taskId, agent: 'claude', account: 'acc1' })
    const d = deps.getState().dispatches[0]
    const r = await call(
      deps,
      'send',
      { type: 'worker_done', taskId, dispatchId: d.id, outcome: 'succeeded', subject: 's', body: 'b' },
      d.sessionId
    )
    expect(r.status).toBe(200)
    expect(deps.getState().tasks[0].status).toBe('completed')
  })

  it('Task 가 reviewing 이 되면 startReview 를 taskId 로 부른다', async () => {
    // cwd 는 넘기지 않는다 — 배선이 구현 Dispatch 에서 얻는다(그 Dispatch 를 어차피 찾아야 한다)
    const deps = makeDeps()
    const started: { taskId: string }[] = []
    deps.startReview = (a) => void started.push(a)
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { spec: '작업', review: true })
    const taskId = deps.getState().tasks[0].id
    await call(deps, 'worker-start', { task: taskId, agent: 'claude', account: 'acc1' })
    const d = deps.getState().dispatches[0]
    await call(
      deps,
      'send',
      { type: 'worker_done', taskId, dispatchId: d.id, outcome: 'succeeded', subject: 's', body: 'b' },
      d.sessionId
    )
    expect(deps.getState().tasks[0].status).toBe('reviewing')
    expect(started).toEqual([{ taskId }])
  })

  it('재전송(alreadyReported)에는 startReview 를 부르지 않는다', async () => {
    // startValidation 이 같은 이유로 result.value === 'accepted' 를 본다
    const deps = makeDeps()
    const started: { taskId: string }[] = []
    deps.startReview = (a) => void started.push(a)
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { spec: '작업', review: true })
    const taskId = deps.getState().tasks[0].id
    await call(deps, 'worker-start', { task: taskId, agent: 'claude', account: 'acc1' })
    const d = deps.getState().dispatches[0]
    const args = {
      type: 'worker_done',
      taskId,
      dispatchId: d.id,
      outcome: 'succeeded',
      subject: 's',
      body: 'b'
    }
    await call(deps, 'send', args, d.sessionId)
    expect(started).toHaveLength(1)
    const r2 = await call(deps, 'send', args, d.sessionId)
    expect(r2.body).toBe('alreadyReported')
    expect(started).toHaveLength(1)
  })

  // TASK_STATUSES 는 손수 쓴 목록이라 빠뜨려도 컴파일은 통과한다 — task-update가 그 목록으로
  // --status 를 검증하는 실제 지점이다(task-list는 필터일 뿐 검증하지 않는다).
  it('task-list --status reviewing 이 거절되지 않는다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    const task = await call(deps, 'task-create', { spec: '작업' })
    const taskId = (task.body as { id: string }).id
    const r = await call(deps, 'task-update', { id: taskId, status: 'reviewing' })
    expect(r.status).toBe(200)
  })
})

// ── 이음매를 통과하는 통합 테스트 ──────────────────────────────────────────────
// 층마다 테스트가 있었는데 리뷰가 낸 Critical 은 그 사이에 살아 있었다: 검증 결과가 Message 를
// 만들지 않아 코디네이터가 영원히 알지 못한다는 것. handleCommand('send', worker_done) 에서
// 시작해 가짜 ValidatorRunner 와 TaskValidator 를 지나, **Task 상태와 결과 받은편지함(check)을
// 함께** 단언한다 — 코디네이터를 깨우는 수단은 메시지뿐이므로 상태만 보는 단언으로는 이 결함이
// 잡히지 않는다.
describe('worker_done → 검증 실행 → 결과 (배선 통합)', () => {
  /** ipc.ts 가 하는 배선과 같은 모양으로 서버·검증기·순수 계층을 잇는다 */
  const wire = async (): Promise<{
    deps: OrchServerDeps
    validator: TaskValidator
    started: { cwd: string; taskId: string }[]
    taskId: string
    cwd: string
  }> => {
    const deps = makeDeps()
    const started: { cwd: string; taskId: string }[] = []
    const validator = new TaskValidator({
      runner: {
        start: async (a) => void started.push(a),
        output: () => '빌드 로그 꼬리'
      },
      onSettled: async ({ taskId, exitCode, output }) => {
        const r = applyValidationResult(deps.getState(), { taskId, exitCode, output }, NOW)
        if (r.ok) await deps.setState(r.state)
      },
      onCannotRun: async ({ taskId, reason }) => {
        const r = blockForValidation(deps.getState(), { taskId, reason }, NOW)
        if (r.ok) await deps.setState(r.state)
      }
    })
    deps.startValidation = (a) => validator.enqueue(a)
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { spec: '작업', validate: 'cfg1' })
    const taskId = deps.getState().tasks[0].id
    await call(deps, 'worker-start', { task: taskId, agent: 'claude', account: 'acc1' })
    const d = deps.getState().dispatches[0]
    await call(
      deps,
      'send',
      { type: 'worker_done', taskId, dispatchId: d.id, outcome: 'succeeded', subject: 's', body: 'b' },
      d.sessionId
    )
    // 코디네이터가 실제로 하는 일: worker_done 배치를 받아 ack 한다. 이 ack 뒤에는 새 메시지가
    // 붙지 않는 한 check 가 아무것도 돌려주지 않는다 — 그것이 이 결함의 증상이었다.
    const first = (await call(deps, 'check', {})).body as { deliveryId: string }
    await call(deps, 'check', { ack: first.deliveryId })
    await vi.waitFor(() => expect(started).toHaveLength(1))
    return { deps, validator, started, taskId, cwd: d.cwd }
  }

  it('worker_done 성공은 Task 를 validating 으로 보내고 그 cwd 에서 검증을 시작한다', async () => {
    const { deps, started, taskId, cwd } = await wire()
    expect(deps.getState().tasks[0].status).toBe('validating')
    expect(started).toEqual([{ taskId, cwd }])
  })

  it('검증 실패는 Task 를 failed 로 보내고 status 메시지를 코디네이터에게 배달한다', async () => {
    const { deps, validator, taskId, cwd } = await wire()
    validator.onRunExit({ cwd, exitCode: 2 })
    await vi.waitFor(() => expect(deps.getState().tasks[0].status).toBe('failed'))
    const r = await call(deps, 'check', {})
    const body = r.body as { count: number; messages: { type: string; subject: string; body: string; taskId?: string }[] }
    expect(body.count).toBe(1)
    expect(body.messages[0].type).toBe('status')
    expect(body.messages[0].subject).toBe('validation failed')
    expect(body.messages[0].taskId).toBe(taskId)
    expect(body.messages[0].body).toContain('exitCode=2')
    expect(body.messages[0].body).toContain('빌드 로그 꼬리')
  })

  // 통과도 배달돼야 한다 — 의존 Task 가 풀린 것을 모르면 코디네이터는 다음 Task 를 띄우지 않는다
  it('검증 통과는 Task 를 completed 로 보내고 그것도 배달된다', async () => {
    const { deps, validator, cwd } = await wire()
    validator.onRunExit({ cwd, exitCode: 0 })
    await vi.waitFor(() => expect(deps.getState().tasks[0].status).toBe('completed'))
    const r = await call(deps, 'check', {})
    const body = r.body as { messages: { subject: string }[] }
    expect(body.messages.map((m) => m.subject)).toEqual(['validation passed'])
  })

  // 검증을 아예 돌릴 수 없으면 Gate 다. 이쪽은 createGate 가 decision_gate 메시지를 붙여 원래부터
  // 통보되고 있었다 — 그 비대칭이 위의 두 경로에 메시지가 없다는 것을 확정해 준 근거다.
  it('검증을 돌릴 수 없으면 Gate 가 열리고 decision_gate 가 배달된다', async () => {
    const deps = makeDeps()
    const validator = new TaskValidator({
      runner: {
        start: async () => {
          throw new Error('NO_CONFIG: cfg1')
        },
        output: () => ''
      },
      onSettled: async () => {},
      onCannotRun: async ({ taskId, reason }) => {
        const r = blockForValidation(deps.getState(), { taskId, reason }, NOW)
        if (r.ok) await deps.setState(r.state)
      }
    })
    deps.startValidation = (a) => validator.enqueue(a)
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { spec: '작업', validate: 'cfg1' })
    const taskId = deps.getState().tasks[0].id
    await call(deps, 'worker-start', { task: taskId, agent: 'claude', account: 'acc1' })
    const d = deps.getState().dispatches[0]
    await call(
      deps,
      'send',
      { type: 'worker_done', taskId, dispatchId: d.id, outcome: 'succeeded', subject: 's', body: 'b' },
      d.sessionId
    )
    await vi.waitFor(() => expect(deps.getState().tasks[0].status).toBe('blocked'))
    const r = await call(deps, 'check', { types: 'decision_gate' })
    const body = r.body as { messages: { type: string; body: string }[] }
    expect(body.messages.some((m) => m.type === 'decision_gate' && m.body.includes('NO_CONFIG'))).toBe(true)
  })
})
