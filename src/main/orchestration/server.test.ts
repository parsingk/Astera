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
  rekeyDispatch,
  type OrchState
} from '../../core/orchestration/state'
import { TaskValidator } from './validator'
import { FAILURE_LIMIT } from '../../core/orchestration/types'
import { parseArgs } from '../../core/orchestration/cliArgs'

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
  it('run-create 가 concurrency·auto 를 Run 에 싣는다', async () => {
    const r = await call(makeDeps(), 'run-create', {
      objective: '무언가',
      cwd: '/p',
      concurrency: 5,
      auto: true
    })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ concurrency: 5, autoDispatch: true })
    // provider 는 이제 Run 의 것이 아니다 — Task 의 계정이 정한다(Task.accountIds)
    expect(r.body).not.toHaveProperty('provider')
  })
  it('run-create 에 셋이 없으면 Run 에도 없다 — 옛 동작이 그대로다', async () => {
    const r = await call(makeDeps(), 'run-create', { objective: '무언가', cwd: '/p' })
    expect(r.body).not.toHaveProperty('provider')
    expect(r.body).not.toHaveProperty('concurrency')
    expect(r.body).not.toHaveProperty('autoDispatch')
  })
  it('concurrency 가 1 미만이거나 정수가 아니면 거절한다', async () => {
    const r = await call(makeDeps(), 'run-create', { objective: 'x', cwd: '/p', concurrency: 0 })
    expect(r.status).toBe(400)
  })
  // 조용히 무시하지 않는 이유: 이 플래그를 보내는 호출자는 "이 Run 은 이 CLI 로 돈다"고 믿고
  // 있고, 무시하면 그 믿음이 틀렸다는 것을 알 방법이 없다. 값이 맞는 provider 여도 거절한다 —
  // 옮길 자리가 없기 때문이다(한 Run 에 두 provider 의 Task 가 섞일 수 있다).
  it('run-create 는 provider 를 더 받지 않는다 — 값이 맞아도 거절한다', async () => {
    for (const provider of ['claude', 'codex', 'gpt']) {
      const r = await call(makeDeps(), 'run-create', { objective: 'x', cwd: '/p', provider })
      expect(r.status).toBe(400)
      expect(String((r.body as { error?: string }).error)).toContain('--provider is no longer accepted')
    }
  })
  it('run-create 가 schedule 을 담아 템플릿을 만든다', async () => {
    const deps = makeDeps()
    const r = await call(deps, 'run-create', {
      objective: '매일 점검',
      cwd: 'D:/p',
      schedule: { kind: 'daily', time: '09:00' }
    })
    expect(r.status).toBe(200)
    expect(deps.getState().runs[0].schedule).toEqual({ kind: 'daily', time: '09:00' })
  })

  // 예약은 자신이 돌지 않는다. auto 를 함께 받았더라도 템플릿에는 켜지 않는다 — 켜면
  // slotsToFill 의 방어에 기대게 되고, 그 방어는 손으로 고친 파일을 위한 것이다
  it('예약 Run 에는 autoDispatch 를 켜지 않는다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', {
      objective: 'o',
      cwd: 'D:/p',
      auto: true,
      schedule: { kind: 'daily', time: '09:00' }
    })
    expect(deps.getState().runs[0].autoDispatch).toBeUndefined()
  })

  it('잘못된 schedule 은 400 으로 거절한다', async () => {
    const r = await call(makeDeps(), 'run-create', {
      objective: 'o',
      cwd: 'D:/p',
      schedule: { kind: 'daily', time: '25:00' }
    })
    expect(r.status).toBe(400)
  })

  it('schedule 이 없으면 평범한 Run 이다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p', auto: true })
    expect(deps.getState().runs[0].schedule).toBeUndefined()
    expect(deps.getState().runs[0].autoDispatch).toBe(true)
  })
})

describe('handleCommand — 역할 인가', () => {
  /** worker-start까지 진행해 sess1이 워커인 상태를 만든다 */
  const seedWorker = async (): Promise<OrchServerDeps> => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
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

describe('handleCommand — 롤링이 세션을 rekey 한 뒤 (worker-rolling-phase-1a)', () => {
  /** worker-start까지 진행해 sess1이 워커인 상태를 만든다 (위 seedWorker와 동일한 절차) */
  const seedWorker = async (): Promise<OrchServerDeps> => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
    const taskId = (task.body as { id: string }).id
    await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    return deps
  }

  it('rekey 된 세션의 worker_done 이 Task 를 정상적으로 마무리한다 — 이 브랜치의 존재 이유', async () => {
    const deps = await seedWorker()
    const d = deps.getState().dispatches[0]
    // sess1 -> sess2 로 롤 — OrchRollTap.onRolled 가 실제로 하는 일을 여기서는 직접 부른다
    // (rollTap.test.ts 가 그 함수 자체를 이미 pin 한다. 여기서는 그 결과가 handleCommand 의
    // send/worker_done 경로와 맞물리는지를 본다).
    const rekeyed = rekeyDispatch(
      deps.getState(),
      { oldSessionId: 'sess1', newSessionId: 'sess2', accountId: 'acc2' },
      NOW
    )
    if (!rekeyed.ok) throw new Error(`expected ok, got ${rekeyed.error}`)
    await deps.setState(rekeyed.state)

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
      'sess2' // 옛 sessionId(sess1)가 아니라 rekey 된 새 세션으로 보고한다
    )
    expect(r.status).toBe(200)
    const closed = deps.getState().dispatches.find((x) => x.id === d.id)
    expect(closed?.outcome).toBe('succeeded')
    expect(closed?.endedAt).toBeDefined()
    const task = deps.getState().tasks.find((t) => t.id === d.taskId)
    expect(task?.status).toBe('completed')
  })

  it('rekey 되지 않은 새 세션 id는 워커로 인식되지 않는다 — COORDINATOR_ONLY 를 부를 수 있다(해저드)', async () => {
    const deps = await seedWorker()
    // handleCommand 는 caller.sessionId 가 dispatches.find(d => d.sessionId === caller.sessionId) 로
    // 걸리는지로 워커 여부를 정한다. 'sess2'는 롤이 만든 새 세션 id 라고 해도, rekeyDispatch 가 아직
    // 부르지 않았으면 어떤 Dispatch 도 그 값을 sessionId 로 갖지 않는다 — 즉 워커로 인식되지 않고
    // COORDINATOR_ONLY 가드가 적용되지 않는다.
    const before = await call(deps, 'run-create', { objective: 'o2', cwd: 'D:/p' }, 'sess2')
    expect(before.status).toBe(200) // 거부되지 않는다 — 이것이 이 브랜치가 막으려는 결함이다

    const rekeyed = rekeyDispatch(
      deps.getState(),
      { oldSessionId: 'sess1', newSessionId: 'sess2', accountId: 'acc2' },
      NOW
    )
    if (!rekeyed.ok) throw new Error(`expected ok, got ${rekeyed.error}`)
    await deps.setState(rekeyed.state)

    // rekey 된 뒤에는 'sess2'가 그 Dispatch의 sessionId이므로 워커로 인식되어 같은 명령이 막힌다
    const after = await call(deps, 'run-create', { objective: 'o3', cwd: 'D:/p' }, 'sess2')
    expect(after.status).toBe(403)
  })
})

describe('handleCommand — 역할 인가 (완료 후에도 워커)', () => {
  /** worker-start까지 진행해 sess1이 워커인 상태를 만든다 (위 seedWorker와 동일한 절차) */
  const seedWorker = async (): Promise<OrchServerDeps> => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
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
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
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
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
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
      account: 'acc1',
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
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
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
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
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
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
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

  // 템플릿의 Task 를 배치하면 그것이 terminal 이 되고, 그러면 store.ts 의 TTL 조건이 템플릿에서
  // 참이 되어 30일 뒤 예약과 모든 회차가 조용히 사라진다. slotsToFill 은 자동 배치만 막는다 —
  // 이 명령이 사람과 코디네이터가 쓰는 두 번째 문이다.
  it('예약 템플릿의 Task 로 worker-start 를 부르면 startWorker 를 부르지 않고 거부한다', async () => {
    let startWorkerCalls = 0
    const deps = {
      ...makeDeps(),
      startWorker: async () => {
        startWorkerCalls++
        return { sessionId: 'sessX', cwd: 'D:/p', specPath: 'D:/p/orch/specs/a.md' }
      }
    }
    const run = await call(deps, 'run-create', {
      objective: '매일 점검',
      cwd: 'D:/p',
      schedule: { kind: 'daily', time: '09:00' }
    })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
    const taskId = (task.body as { id: string }).id
    const r = await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toContain('template')
    expect(startWorkerCalls).toBe(0)
  })

  // 회차는 운영이 되어야 한다(설계 2절) — 위의 거절이 회차까지 막으면 예약은 아무것도 돌리지 못한다
  it('예약 회차의 Task 는 그대로 배치된다', async () => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', {
      objective: '매일 점검',
      cwd: 'D:/p',
      schedule: { kind: 'daily', time: '09:00' }
    })
    const templateId = (run.body as { id: string }).id
    await call(deps, 'task-create', { account: 'acc1', runId: templateId, title: 't', spec: 's' })
    const child = (await call(deps, 'run-spawn', { run: templateId })).body as { id: string }
    const copy = deps.getState().tasks.find((t) => t.runId === child.id)!
    const r = await call(deps, 'worker-start', {
      taskId: copy.id,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    expect(r.status).toBe(200)
  })

  // 설계 2절: 프로젝트 폴더에서는 워커가 돌지 않는다. app-managed Run(autoDispatch)이 아직
  // 워크트리를 갖지 못한 동안 --worktree 없이 worker-start 가 들어오면 기본값이 'current' 로
  // 떨어져 그 금지를 어겼다 — 그래서 이 조합만 거절한다(server.ts 의 새 조건).
  it('워크트리가 없는 app-managed Run 에 --worktree 없이 worker-start 를 부르면 거부한다', async () => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', {
      objective: 'o',
      cwd: 'D:/p',
      auto: true
    })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
    const taskId = (task.body as { id: string }).id
    const r = await call(deps, 'worker-start', { taskId, agent: 'codex', account: 'acc1' })
    expect(r.status).toBe(409)
  })

  // 위 거절이 이 조합에만 닿는다는 증거 — --worktree 를 명시하면(사람이 자리를 골랐다는 뜻) 같은
  // Run·같은 Task 로도 그대로 된다.
  it('같은 Run 이라도 --worktree 를 명시하면 그대로 된다', async () => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', {
      objective: 'o',
      cwd: 'D:/p',
      auto: true
    })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
    const taskId = (task.body as { id: string }).id
    const r = await call(deps, 'worker-start', {
      taskId,
      agent: 'codex',
      account: 'acc1',
      worktree: 'D:/wt'
    })
    expect(r.status).toBe(200)
  })
})

describe('handleCommand — check', () => {
  it('워커 세션은 check를 부를 수 없다', async () => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
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
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
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
      await call(deps, 'task-create', { account: 'acc1', runId: (run.body as { id: string }).id, spec: 's' })
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
      await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
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
      const task = await call(deps, 'task-create', { account: 'acc1', runId, title, spec: `spec ${title}` })
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
    const task = await call(deps, 'task-create', { account: 'acc1', runId: (run.body as { id: string }).id,
      title: 't',
      spec: 's' })
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
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
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
    const a = await call(deps, 'task-create', { account: 'acc1', runId, title: 'a', spec: 's' })
    const aId = (a.body as { id: string }).id
    const b = await call(deps, 'task-create', { account: 'acc1', runId, title: 'b', spec: 's', deps: [aId] })
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
    const a = await call(deps, 'task-create', { account: 'acc1', runId, title: 'a', spec: 's' })
    const aId = (a.body as { id: string }).id
    const b = await call(deps, 'task-create', { account: 'acc1', runId, title: 'b', spec: 's', deps: [aId] })
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
    const a = await call(deps, 'task-create', { account: 'acc1', runId, title: 'a', spec: 's' })
    await call(deps, 'task-create', {
      account: 'acc1',
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
    await call(deps, 'task-create', { account: 'acc1', runId: (run.body as { id: string }).id,
      title: 't',
      spec: 'x'.repeat(300) })
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
      // 실제 배선은 여기서 Task.accountIds 를 읽어 롤링 체인을 만든다(ipc.ts의 deps.startWorker) —
      // 이 테스트 배선은 그 계정 하나짜리 체인으로 충분하다(서버는 체인을 보지 않는다).
      startWorker: (a) => coordinator.startWorker({ ...a, rollAccountIds: [a.accountId] }),
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
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
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
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
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
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
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
    // closeDispatch(handleExit 경로, state.ts)와 같은 형식의 별도 status 메시지가 추가된다.
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

describe('unregisterRolling — Dispatch 가 닫히는데 세션은 살아 있는 자리', () => {
  /** run + task + 열린 dispatch(sessionId='sess1') + unregisterRolling 기록 */
  const seed = async (): Promise<{
    deps: OrchServerDeps & { state: OrchState }
    taskId: string
    dispatchId: string
    dropped: string[]
  }> => {
    const deps = makeDeps()
    const dropped: string[] = []
    deps.unregisterRolling = (sessionId) => dropped.push(sessionId)
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
    const taskId = (task.body as { id: string }).id
    await call(deps, 'worker-start', { taskId, agent: 'codex', account: 'acc1', worktree: 'current' })
    return { deps, taskId, dispatchId: deps.getState().dispatches[0].id, dropped }
  }

  it('worker_done 이 그 세션의 롤링 체인을 걷는다', async () => {
    const { deps, taskId, dispatchId, dropped } = await seed()
    const r = await call(
      deps,
      'send',
      { type: 'worker_done', taskId, dispatchId, outcome: 'succeeded', subject: 's', body: 'b' },
      'sess1'
    )
    expect(r.status).toBe(200)
    expect(dropped).toEqual(['sess1'])
  })

  // 재전송은 아무것도 닫지 않는다(alreadyReported) — 그때 걷는 것은 이미 걷힌 것을 또 부르는 일이다
  it('worker_done 재전송에서는 다시 걷지 않는다', async () => {
    const { deps, taskId, dispatchId, dropped } = await seed()
    const done = { type: 'worker_done', taskId, dispatchId, outcome: 'succeeded', subject: 's', body: 'b' }
    await call(deps, 'send', done, 'sess1')
    const again = await call(deps, 'send', done, 'sess1')
    expect(again.body).toBe('alreadyReported')
    expect(dropped).toEqual(['sess1'])
  })

  // 이 명령은 어떤 프로세스도 건드리지 않는다 — Dispatch 만 닫히고 세션은 살아 있을 수 있다
  it('worker-abandon 도 걷는다', async () => {
    const { deps, dispatchId, dropped } = await seed()
    const r = await call(deps, 'worker-abandon', { dispatch: dispatchId })
    expect(r.status).toBe(200)
    expect(dropped).toEqual(['sess1'])
  })

  // 세션을 죽이는 경로에서는 부르지 않는다 — 종료가 스스로 체인을 버린다(handleExit → disposeChain)
  it('worker-stop 은 걷지 않는다 — 세션을 죽이는 경로다', async () => {
    const { deps, dispatchId, dropped } = await seed()
    const r = await call(deps, 'worker-stop', { dispatch: dispatchId })
    expect(r.status).toBe(200)
    expect(dropped).toEqual([])
  })

  it('세션 종료(handleExit)도 걷지 않는다 — 롤링이 이미 버렸다', async () => {
    const { deps, dropped } = await seed()
    await handleExit(deps, { sessionId: 'sess1', exitCode: 0 })
    expect(deps.getState().dispatches[0].endedAt).toBeDefined()
    expect(dropped).toEqual([])
  })

  // 주입되지 않은 배선(기존 테스트 포함)에서 보고 경로가 그대로 도는지 — 선택적 dep 관례
  it('주입되지 않아도 worker_done 은 그대로 200 이다', async () => {
    const { deps, taskId, dispatchId } = await seed()
    deps.unregisterRolling = undefined
    const r = await call(
      deps,
      'send',
      { type: 'worker_done', taskId, dispatchId, outcome: 'succeeded', subject: 's', body: 'b' },
      'sess1'
    )
    expect(r.status).toBe(200)
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
    const r = await call(deps, 'task-create', { account: 'acc1', spec: '작업', validate: 'cfg1' })
    expect(r.status).toBe(200)
    expect(deps.getState().tasks[0].validateConfigId).toBe('cfg1')
  })

  it('--validate 없이 만든 Task 에는 그 필드가 없다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { account: 'acc1', spec: '작업' })
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
    await call(deps, 'task-create', { account: 'acc1', spec: '작업' })
    const taskId = deps.getState().tasks[0].id
    await call(deps, 'worker-start', { task: taskId, agent: 'claude', account: 'acc1' })
    const workerSession = deps.getState().dispatches[0].sessionId
    const r = await call(deps, 'run-configs', {}, workerSession)
    expect(r.status).toBe(200)
  })
})

describe('task-create --account', () => {
  // 기본 makeDeps 는 계정을 하나만 준다 — 목록 문법을 보려면 같은 provider 의 계정이 둘 있어야 한다
  const accountDeps = () => ({
    ...makeDeps(),
    listAccounts: () => [
      { id: 'acc1', label: '계정1', provider: 'codex' as const },
      { id: 'acc2', label: '계정2', provider: 'codex' as const }
    ]
  })

  /** claude 와 codex 를 함께 가진 목록 — 섞인 지정을 거절하는지 보려면 두 provider 가 필요하다 */
  const mixedDeps = (): OrchServerDeps & { state: OrchState } =>
    Object.assign(makeDeps(), {
      listAccounts: () => [
        { id: 'cl1', label: 'claude1', provider: 'claude' as const },
        { id: 'cl2', label: 'claude2', provider: 'claude' as const },
        { id: 'cx1', label: 'codex1', provider: 'codex' as const }
      ]
    })

  // 이 목록이 provider 의 유일한 출처이므로(Task.accountIds), 없으면 어느 CLI 로 띄울지 알 방법이
  // 없다. 예전에는 Run 이 provider 를 들고 있어 비워 두면 그 provider 의 기본 계정으로 갔다.
  it('--account 가 없으면 거절한다 — provider 의 출처가 이 목록뿐이다', async () => {
    const deps = accountDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const r = await call(deps, 'task-create', { runId, spec: 's' })
    expect(r.status).toBe(400)
    expect(String((r.body as { error?: string }).error)).toContain('--account is required')
    expect(deps.getState().tasks).toHaveLength(0)
  })

  // 섞이면 첫 계정으로 띄운 CLI 가 한도에 걸렸을 때 다른 CLI 의 계정으로 갈아타려 한다 — 그것은
  // 갈아타기가 아니라 다른 프로그램을 띄우는 일이다
  it('서로 다른 provider 가 섞인 목록을 거절한다', async () => {
    const deps = mixedDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const r = await call(deps, 'task-create', { runId, spec: 's', account: 'cl1,cx1' })
    expect(r.status).toBe(400)
    const err = String((r.body as { error?: string }).error)
    // 어느 칸이 어긋났는지 말한다 — 목록이 셋 넷이면 "섞였다"만으로는 어디를 고칠지 알 수 없다
    expect(err).toContain('must not mix providers')
    expect(err).toContain('cl1 is claude')
    expect(err).toContain('cx1 is codex')
    expect(deps.getState().tasks).toHaveLength(0)
  })

  it('같은 provider 끼리면 그대로 받는다 — 순서도 그대로다', async () => {
    const deps = mixedDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const r = await call(deps, 'task-create', { runId, spec: 's', account: 'cl2,cl1' })
    expect(r.status).toBe(200)
    expect(deps.getState().tasks.at(-1)?.accountIds).toEqual(['cl2', 'cl1'])
  })

  // 한 Run 에 두 provider 의 Task 가 섞이는 것은 **막지 않는다** — provider 를 Run 에서 Task 로
  // 내린 이유가 그것이다. 거절은 한 Task 안의 목록에만 적용된다.
  it('같은 Run 에 claude Task 와 codex Task 가 함께 있을 수 있다', async () => {
    const deps = mixedDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    expect((await call(deps, 'task-create', { runId, spec: 'a', account: 'cl1' })).status).toBe(200)
    expect((await call(deps, 'task-create', { runId, spec: 'b', account: 'cx1' })).status).toBe(200)
    expect(deps.getState().tasks.map((t) => t.accountIds)).toEqual([['cl1'], ['cx1']])
  })

  it('--account 는 쉼표로 순서 있는 목록을 받는다', async () => {
    const deps = accountDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const r = await call(deps, 'task-create', { runId, spec: 's', account: 'acc2,acc1' })
    expect(r.status).toBe(200)
    expect(deps.getState().tasks.at(-1)?.accountIds).toEqual(['acc2', 'acc1'])
  })

  it('--account 하나는 원소 하나인 목록이다 (기존 호출)', async () => {
    const deps = accountDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const r = await call(deps, 'task-create', { runId, spec: 's', account: 'acc1' })
    expect(r.status).toBe(200)
    expect(deps.getState().tasks.at(-1)?.accountIds).toEqual(['acc1'])
  })

  it('목록의 어느 한 칸이라도 모르는 계정이면 거절한다', async () => {
    const deps = accountDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const r = await call(deps, 'task-create', { runId, spec: 's', account: 'acc1,nope' })
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toMatch(/nope/)
  })

  it('같은 계정을 두 번 적으면 거절한다', async () => {
    const deps = accountDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const r = await call(deps, 'task-create', { runId, spec: 's', account: 'acc1,acc1' })
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toMatch(/acc1/)
  })

  it('쉼표만 있거나 빈 칸이 섞이면 거절한다', async () => {
    const deps = accountDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    // 상태 코드만으로는 이 검사를 못 박지 못한다 — 빈 칸은 언제나 동시에 "모르는 계정"이거나
    // (트림하면 빈 문자열은 목록에 없다) 중복(빈 문자열끼리는 서로 같다)이기도 해서, 이 검사를
    // 지워도 다른 두 검사 중 하나가 대신 400 을 낸다. 메시지까지 맞춰야 이 검사 자체를 본다.
    const commaOnly = await call(deps, 'task-create', { runId, spec: 's', account: ',' })
    expect(commaOnly.status).toBe(400)
    expect((commaOnly.body as { error: string }).error).toBe(
      '--account must not contain an empty entry'
    )
    const mixedEmpty = await call(deps, 'task-create', { runId, spec: 's', account: 'acc1,,acc2' })
    expect(mixedEmpty.status).toBe(400)
    expect((mixedEmpty.body as { error: string }).error).toBe(
      '--account must not contain an empty entry'
    )
  })
})

describe('worker_done 이 검증을 시작한다', () => {
  it('검증이 걸린 Task 가 끝나면 startValidation 을 부른다', async () => {
    const deps = makeDeps()
    const started: { taskId: string; cwd: string }[] = []
    deps.startValidation = (a) => void started.push(a)
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { account: 'acc1', spec: '작업', validate: 'cfg1' })
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
    await call(deps, 'task-create', { account: 'acc1', spec: '작업' })
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
    await call(deps, 'task-create', { account: 'acc1', spec: '작업', validate: 'cfg1' })
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
    await call(deps, 'task-create', { account: 'acc1', spec: '작업', validate: 'cfg1' })
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
    await call(deps, 'task-create', { account: 'acc1', spec: '작업', review: true })
    expect(deps.getState().tasks[0].reviewRequested).toBe(true)
  })

  it('--review 없이 만든 Task 는 reviewRequested 가 없다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { account: 'acc1', spec: '작업' })
    expect(deps.getState().tasks[0].reviewRequested).toBeUndefined()
  })

  // 이것이 이 Task 의 핵심이다 — 검토 Dispatch 의 보고가 구현 보고로 처리되면 Task 가 두 번 끝난다
  it('검토 Dispatch 로 온 worker_done 은 applyReviewResult 로 간다', async () => {
    // review: true 인 Dispatch, reviewing 인 Task → worker_done succeeded → completed
    // 그리고 'review passed' status 메시지가 남는다
    const deps = makeDeps()
    deps.startReview = () => {}
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { account: 'acc1', spec: '작업', review: true })
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
    await call(deps, 'task-create', { account: 'acc1', spec: '작업' })
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
    await call(deps, 'task-create', { account: 'acc1', spec: '작업', review: true })
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
    await call(deps, 'task-create', { account: 'acc1', spec: '작업', review: true })
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
    await call(deps, 'task-create', { account: 'acc1', spec: '작업', review: true })
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
  it('task-update --status reviewing 이 거절되지 않는다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    const task = await call(deps, 'task-create', { account: 'acc1', spec: '작업' })
    const taskId = (task.body as { id: string }).id
    const r = await call(deps, 'task-update', { id: taskId, status: 'reviewing' })
    expect(r.status).toBe(200)
  })
})

// 검토 Dispatch 는 앱이 띄운 것이고, 코디네이터에게는 그것을 다시 띄우는 명령이 없다 — 그래서 그것이
// 스스로 끝나지 못한 두 경우(세션이 죽는다 / 한도에 걸려 실패를 보고한다)를 서버가 각각 받아 준다.
describe('검토 Dispatch 가 스스로 끝나지 못했을 때 — handleExit 의 Gate 와 한도 탐침', () => {
  /** Task 를 reviewing 까지 보내고 열린 검토 Dispatch(sessionId='sess_review')를 넣는다 — '검토
   *  라우팅' 블록과 같은 주입 방식이다(검토 Dispatch 를 여는 배선은 ipc.ts 의 몫이라 서버에 없다).
   *  consecutiveFailures 는 2 로 둔다: FAILURE_LIMIT 이 3 이므로, 여기서 한 번 더 오르면 회로가
   *  끊긴다 — 검토자가 죽은 것만으로 그렇게 되어서는 안 된다는 것이 이 블록의 요점이다. */
  const seedReviewing = async (): Promise<{
    deps: OrchServerDeps & { state: OrchState }
    taskId: string
    reviewId: string
  }> => {
    const deps = makeDeps()
    deps.startReview = () => {}
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { account: 'acc1', spec: '작업', review: true })
    const taskId = deps.getState().tasks[0].id
    await call(deps, 'worker-start', { task: taskId, agent: 'claude', account: 'acc1' })
    const impl = deps.getState().dispatches[0]
    await call(
      deps,
      'send',
      { type: 'worker_done', taskId, dispatchId: impl.id, outcome: 'succeeded', subject: 's', body: 'b' },
      impl.sessionId
    )
    const reviewId = 'dsp_review'
    await deps.setState({
      ...deps.getState(),
      tasks: deps.getState().tasks.map((t) => (t.id === taskId ? { ...t, consecutiveFailures: 2 } : t)),
      dispatches: [
        ...deps.getState().dispatches,
        {
          id: reviewId,
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
      ]
    })
    return { deps, taskId, reviewId }
  }

  it('검토자 세션이 보고 없이 죽으면 Gate 가 열리고 Task 가 blocked 로 간다', async () => {
    const { deps, taskId, reviewId } = await seedReviewing()
    await handleExit(deps, { sessionId: 'sess_review', exitCode: 1 })
    const st = deps.getState()
    expect(st.dispatches.find((d) => d.id === reviewId)!.endedAt).toBeDefined()
    expect(st.tasks[0].status).toBe('blocked')
    expect(st.gates).toHaveLength(1)
    expect(st.gates[0].taskId).toBe(taskId)
    // 끝난 일을 버리지 않는 탈출구가 질문에 실린다(blockForReview)
    expect(st.gates[0].question).toContain('task-update --status completed')
    // 코디네이터를 깨우는 수단은 메시지뿐이다 — Gate 만 만들고 알리지 않으면 아무도 오지 않는다
    expect(st.messages.some((m) => m.type === 'decision_gate' && m.taskId === taskId)).toBe(true)
  })

  // closeDispatch 가 올린 값을 되돌린다. 남겨 두면 검토자가 세 번 죽는 것만으로 멀쩡한 작업의 회로가
  // 끊기고, 그것은 이 Gate 가 막으려는 바로 그 일이다.
  it('검토자가 죽어 열린 Gate 는 consecutiveFailures 를 올리지 않는다', async () => {
    const { deps } = await seedReviewing()
    await handleExit(deps, { sessionId: 'sess_review', exitCode: 1 })
    expect(deps.getState().tasks[0].consecutiveFailures).toBe(2)
    expect(deps.getState().tasks[0].consecutiveFailures).toBeLessThan(FAILURE_LIMIT)
  })

  // 구현 Dispatch 의 종료는 한 글자도 달라지지 않는다 — Task 는 dispatched 에 남고(--retry-of 가
  // 집어 간다) 카운터는 올라간다.
  it('구현 Dispatch 가 죽으면 Gate 를 열지 않고 기존 동작 그대로다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: '목표', cwd: 'D:/p' })
    await call(deps, 'task-create', { account: 'acc1', spec: '작업' })
    const taskId = deps.getState().tasks[0].id
    await call(deps, 'worker-start', { task: taskId, agent: 'codex', account: 'acc1' })
    await handleExit(deps, { sessionId: 'sess1', exitCode: 1 })
    expect(deps.getState().gates).toHaveLength(0)
    expect(deps.getState().tasks[0].status).toBe('dispatched')
    expect(deps.getState().tasks[0].consecutiveFailures).toBe(1)
  })

  // 탐침이 검토 분기보다 위에 있어야 한다. 아래에 있으면 이 보고는 탐침을 지나지 못하고 코디네이터는
  // "검토자가 반려했다"만 읽는다 — 멀쩡한 작업에 구현자를 다시 띄우고, 계정이 언제 풀리는지는 아무도
  // 모른다. 가이드 7절의 "limitResetsAt 이 붙으면 받은편지함에도 status 메시지로 온다"가 이 경로에도
  // 적용된다.
  it('한도에 걸린 검토자의 failed 보고도 limitResetsAt 과 status 메시지를 남긴다', async () => {
    const { deps, taskId, reviewId } = await seedReviewing()
    const probed: string[] = []
    deps.probeLimit = async (d) => {
      probed.push(d.id)
      return 1_700_000_000_000
    }
    const r = await call(
      deps,
      'send',
      { type: 'worker_done', taskId, dispatchId: reviewId, outcome: 'failed', subject: '반려', body: '부족하다' },
      'sess_review'
    )
    expect(r.status).toBe(200)
    expect(probed).toEqual([reviewId])
    const st = deps.getState()
    expect(st.dispatches.find((d) => d.id === reviewId)!.limitResetsAt).toBe(1_700_000_000_000)
    const status = st.messages.find(
      (m) => m.dispatchId === reviewId && m.subject === 'session ended at a usage limit'
    )
    expect(status?.body).toContain(new Date(1_700_000_000_000).toISOString())
    // 검토 판정 자체는 그대로 반영된다 — 탐침이 그것을 덮지 않는다
    expect(st.tasks[0].status).toBe('failed')
    expect(st.messages.some((m) => m.subject === 'review failed')).toBe(true)
  })

  it('검토자가 succeeded 로 보고하면 탐침을 부르지 않는다', async () => {
    const { deps, taskId, reviewId } = await seedReviewing()
    let calls = 0
    deps.probeLimit = async () => {
      calls++
      return 1_700_000_000_000
    }
    await call(
      deps,
      'send',
      { type: 'worker_done', taskId, dispatchId: reviewId, outcome: 'succeeded', subject: 's', body: 'b' },
      'sess_review'
    )
    expect(calls).toBe(0)
    expect(deps.getState().tasks[0].status).toBe('completed')
    expect('limitResetsAt' in deps.getState().dispatches.find((d) => d.id === reviewId)!).toBe(false)
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
    await call(deps, 'task-create', { account: 'acc1', spec: '작업', validate: 'cfg1' })
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
    await call(deps, 'task-create', { account: 'acc1', spec: '작업', validate: 'cfg1' })
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

// 자동 정리(store.ts 의 TTL)는 **끝난** Run 만, 그것도 30일 뒤에 버린다. 끝나지 않은 Run 은 영원히
// 남으므로 사람이 물러나게 할 길이 있어야 한다 — 이 명령이 그 자리다.
describe('run-delete', () => {
  it('없는 Run 은 거절한다', async () => {
    const deps = makeDeps()
    const r = await call(deps, 'run-delete', { id: 'run_nope' })
    expect(r.status).toBe(400)
  })

  it('--id 가 없으면 거절한다', async () => {
    const deps = makeDeps()
    expect((await call(deps, 'run-delete', {})).status).toBe(400)
  })

  // reset 과 같은 판정이고 같은 이유다: 삭제는 되돌릴 수 없으므로 도는 상태에서 다룰 것을 하나 더
  // 만들지 않는다. 세션까지 죽이게 하면 커밋 안 된 작업이 조용히 사라진다
  it('그 Run 에 열린 Dispatch 가 있으면 409 로 거절한다', async () => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
    await call(deps, 'worker-start', {
      taskId: (task.body as { id: string }).id,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    const r = await call(deps, 'run-delete', { id: runId })
    expect(r.status).toBe(409)
    expect(deps.getState().runs).toHaveLength(1)
  })

  it('도는 워커가 없으면 그 Run 과 딸린 것을 지운다', async () => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
    const r = await call(deps, 'run-delete', { id: runId })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ deleted: runId, tasks: 1 })
    expect(deps.getState().runs).toHaveLength(0)
    expect(deps.getState().tasks).toHaveLength(0)
  })

  // 다른 Run 의 열린 Dispatch 는 이 Run 의 삭제를 막지 않는다 — 판정이 폴더나 앱 전체가 아니라
  // **그 Run** 을 봐야 한다. reset 과 다른 점이 이것이다
  it('다른 Run 이 돌고 있어도 이 Run 은 지운다', async () => {
    const deps = makeDeps()
    const busy = await call(deps, 'run-create', { objective: 'busy', cwd: 'D:/p' })
    const busyId = (busy.body as { id: string }).id
    const bt = await call(deps, 'task-create', { account: 'acc1', runId: busyId, title: 'bt', spec: 's' })
    await call(deps, 'worker-start', {
      taskId: (bt.body as { id: string }).id,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    const idle = await call(deps, 'run-create', { objective: 'idle', cwd: 'D:/p' })
    const idleId = (idle.body as { id: string }).id
    expect((await call(deps, 'run-delete', { id: idleId })).status).toBe(200)
    expect(deps.getState().runs.map((r) => r.id)).toEqual([busyId])
  })

  // 되돌릴 수 없는 삭제이므로 지우기 전에 .bak 을 남긴다 — reset 과 같은 관례다
  it('지우기 전에 백업을 부른다', async () => {
    let backups = 0
    const deps = { ...makeDeps(), backup: async () => void backups++ }
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    await call(deps, 'run-delete', { id: (run.body as { id: string }).id })
    expect(backups).toBe(1)
  })

  // 워커는 Run 을 지울 이유가 없다 — COORDINATOR_ONLY 에 들어 있어야 한다
  it('워커 세션은 부를 수 없다', async () => {
    const deps = makeDeps()
    const run = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = (run.body as { id: string }).id
    const task = await call(deps, 'task-create', { account: 'acc1', runId, title: 't', spec: 's' })
    await call(deps, 'worker-start', {
      taskId: (task.body as { id: string }).id,
      agent: 'codex',
      account: 'acc1',
      worktree: 'current'
    })
    // 그 워커의 세션 id 로 부른다 — handleCommand 가 Dispatch 를 가진 세션을 워커로 본다
    const r = await call(deps, 'run-delete', { id: runId }, 'sess1')
    expect(r.status).toBe(403)
  })
})

describe('run-spawn — 예약 회차', () => {
  const withTemplate = async (): Promise<{
    deps: OrchServerDeps & { state: OrchState }
    templateId: string
  }> => {
    const deps = makeDeps()
    const r = await call(deps, 'run-create', {
      objective: '매일 점검',
      cwd: 'D:/p',
      schedule: { kind: 'daily', time: '09:00' }
    })
    return { deps, templateId: (r.body as { id: string }).id }
  }

  it('템플릿의 회차를 만들고 자식 Run 을 돌려준다', async () => {
    const { deps, templateId } = await withTemplate()
    const r = await call(deps, 'run-spawn', { run: templateId })
    expect(r.status).toBe(200)
    const child = r.body as { id: string; templateId?: string; autoDispatch?: boolean }
    expect(child.templateId).toBe(templateId)
    expect(child.autoDispatch).toBe(true)
    expect(deps.getState().runs).toHaveLength(2)
  })

  it('--run 이 없으면 400', async () => {
    const { deps } = await withTemplate()
    expect((await call(deps, 'run-spawn', {})).status).toBe(400)
  })

  it('예약이 아닌 Run 은 400', async () => {
    const deps = makeDeps()
    const r = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const plain = (r.body as { id: string }).id
    expect((await call(deps, 'run-spawn', { run: plain })).status).toBe(400)
  })

  // 워커가 회차를 만들 수 있으면 워커가 자기 일을 무한히 복제할 수 있다
  it('워커 세션은 부를 수 없다', async () => {
    const { deps, templateId } = await withTemplate()
    const withDispatch: OrchState = {
      ...deps.getState(),
      dispatches: [
        {
          id: 'dsp1',
          taskId: 'tsk1',
          provider: 'claude',
          accountId: 'acc1',
          sessionId: 'worker1',
          cwd: 'D:/p',
          specPath: 'D:/p/spec.md',
          startedAt: NOW,
          workerState: 'ready',
          retained: false
        }
      ]
    }
    await deps.setState(withDispatch)
    const r = await call(deps, 'run-spawn', { run: templateId }, 'worker1')
    expect(r.status).toBe(403)
  })

  it('템플릿을 지우면 그 회차도 함께 지운다', async () => {
    const { deps, templateId } = await withTemplate()
    await call(deps, 'run-spawn', { run: templateId })
    await call(deps, 'run-spawn', { run: templateId })
    expect(deps.getState().runs).toHaveLength(3)
    const r = await call(deps, 'run-delete', { id: templateId })
    expect(r.status).toBe(200)
    expect(deps.getState().runs).toHaveLength(0)
  })

  // 정의는 템플릿에 있으므로 회차 하나를 버리는 것은 기록 하나를 버리는 일이다
  it('회차 하나만 지우면 템플릿과 다른 회차는 남는다', async () => {
    const { deps, templateId } = await withTemplate()
    const child = (await call(deps, 'run-spawn', { run: templateId })).body as { id: string }
    await call(deps, 'run-spawn', { run: templateId })
    await call(deps, 'run-delete', { id: child.id })
    const ids = deps.getState().runs.map((x) => x.id)
    expect(ids).toContain(templateId)
    expect(ids).not.toContain(child.id)
    expect(ids).toHaveLength(2)
  })

  /** 회차 하나에 열린 Dispatch 를 심는다. retained 를 바꿔 붙잡아 둔 세션도 만든다 */
  const withRunningChild = async (
    retained = false
  ): Promise<{
    deps: OrchServerDeps & { state: OrchState }
    templateId: string
    childId: string
    released: string[]
  }> => {
    const released: string[] = []
    const base = await withTemplate()
    const deps = Object.assign(base.deps, {
      releaseWorker: async ({ dispatchId }: { dispatchId: string }) => {
        released.push(dispatchId)
      }
    })
    const child = (await call(deps, 'run-spawn', { run: base.templateId })).body as { id: string }
    await deps.setState({
      ...deps.getState(),
      tasks: [
        ...deps.getState().tasks,
        {
          id: 'tsk_live',
          runId: child.id,
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
          id: 'dsp_live',
          taskId: 'tsk_live',
          provider: 'claude',
          accountId: 'acc1',
          sessionId: 'worker1',
          cwd: 'D:/p',
          specPath: 'D:/p/spec.md',
          startedAt: NOW,
          workerState: 'ready',
          retained
        }
      ]
    })
    return { deps, templateId: base.templateId, childId: child.id, released }
  }

  // **예약에서는 "먼저 워커를 멈춰라"가 충족될 수 없다** — 템플릿이 계속 새 회차를 띄우므로 멈춘
  // 자리에 다음 발화가 또 띄운다. 그래서 템플릿 삭제만은 도는 워커를 스스로 정리한다.
  it('템플릿 삭제는 도는 워커를 정지시키고 전부 지운다', async () => {
    const { deps, templateId, released } = await withRunningChild()
    const r = await call(deps, 'run-delete', { id: templateId })
    expect(r.status).toBe(200)
    expect(released).toEqual(['dsp_live'])
    expect(deps.getState().runs).toHaveLength(0)
  })

  // 붙잡아 둔 세션은 죽이지 않는다 — 사람이 일부러 살려 둔 것이고, 기록만 지우면 그 세션이 고아가
  // 된다(coordinator.releaseWorker 가 retained 를 건너뛴다). 이것은 풀 수 있는 거절이다
  it('붙잡아 둔(retained) 워커가 있으면 거절하고 아무것도 지우지 않는다', async () => {
    const { deps, templateId, released } = await withRunningChild(true)
    const r = await call(deps, 'run-delete', { id: templateId })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.body)).toContain('retain')
    expect(released).toEqual([])
    expect(deps.getState().runs).toHaveLength(2)
  })

  it('예약이 아닌 Run 은 여전히 거절한다 — 그쪽은 멈추면 다시 뜨지 않는다', async () => {
    const { deps, childId, released } = await withRunningChild()
    const r = await call(deps, 'run-delete', { id: childId })
    expect(r.status).toBe(409)
    expect(released).toEqual([])
    expect(deps.getState().runs).toHaveLength(2)
  })

})

describe('run-start — 코디네이터 인계', () => {
  /** startCoordinator 를 기록하는 deps. 계정은 claude 둘 + codex 하나. */
  const coordDeps = (
    over: Partial<OrchServerDeps> = {}
  ): OrchServerDeps & { state: OrchState; spawned: { runId: string; prompt: string }[] } => {
    const spawned: { runId: string; prompt: string }[] = []
    const base = Object.assign(makeDeps(), {
      listAccounts: () => [
        { id: 'cl1', label: 'claude1', provider: 'claude' as const },
        { id: 'cl2', label: 'claude2', provider: 'claude' as const },
        { id: 'cx1', label: 'codex1', provider: 'codex' as const }
      ],
      startCoordinator: async (a: { runId: string; prompt: string }) => {
        spawned.push({ runId: a.runId, prompt: a.prompt })
        return { sessionId: 'coord-sess' }
      },
      ...over
    })
    return Object.assign(base, { spawned }) as never
  }

  const mkRun = async (
    deps: OrchServerDeps,
    args: Record<string, unknown> = {}
  ): Promise<string> => {
    const r = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p', auto: true, ...args })
    return (r.body as { id: string }).id
  }

  it('코디네이터 계정이 있으면 실행이 코디네이터를 띄우고 운전자를 넘긴다', async () => {
    const deps = coordDeps()
    const runId = await mkRun(deps, { coordinatorAccount: 'cl1,cl2' })
    const r = await call(deps, 'run-start', { run: runId })
    expect(r.status).toBe(200)
    expect(deps.spawned.map((x) => x.runId)).toEqual([runId])
    const run = deps.getState().runs.find((x) => x.id === runId)!
    expect(run.coordinatorSessionId).toBe('coord-sess')
    // **운전자를 넘기는 방식이 autoDispatch 를 지우는 것이다** — 켜 둔 채로 코디네이터를 붙이면
    // 둘이 같은 ready Task 를 두고 경합한다(Run.autoDispatch 의 주석)
    expect(run).not.toHaveProperty('autoDispatch')
    expect(run).not.toHaveProperty('pendingStart')
  })

  it('인수 프롬프트에 그 Run 의 한도와 Task 수가 실린다', async () => {
    const deps = coordDeps()
    const runId = await mkRun(deps, { coordinatorAccount: 'cl1', concurrency: 2 })
    await call(deps, 'task-create', { account: 'cl1', runId, spec: 'a' })
    await call(deps, 'run-start', { run: runId })
    const prompt = deps.spawned[0].prompt
    expect(prompt).toContain(runId)
    expect(prompt).toContain('CONCURRENCY IS 2')
    expect(prompt).toContain('tasks already defined: 1')
  })

  it('코디네이터 계정이 없으면 띄우지 않고 앱이 계속 돌린다 — 옛 동작', async () => {
    const deps = coordDeps()
    const runId = await mkRun(deps)
    expect((await call(deps, 'run-start', { run: runId })).status).toBe(200)
    expect(deps.spawned).toEqual([])
    const run = deps.getState().runs.find((x) => x.id === runId)!
    expect(run.autoDispatch).toBe(true)
    expect(run).not.toHaveProperty('coordinatorSessionId')
  })

  it('배선이 그 기능을 주입하지 않으면 띄우지 않는다', async () => {
    const deps = coordDeps({ startCoordinator: undefined })
    const runId = await mkRun(deps, { coordinatorAccount: 'cl1' })
    expect((await call(deps, 'run-start', { run: runId })).status).toBe(200)
    expect(deps.getState().runs[0].autoDispatch).toBe(true)
  })

  // 걷어 버리면 실행 버튼이 사라져 사람이 다시 누를 수 없고, 운전자도 없는 Run 이 남는다
  it('코디네이터 띄우기가 실패하면 아무것도 바뀌지 않는다 — pendingStart 가 남는다', async () => {
    const deps = coordDeps({
      startCoordinator: async () => {
        throw new Error('no session')
      }
    })
    const runId = await mkRun(deps, { coordinatorAccount: 'cl1' })
    const r = await call(deps, 'run-start', { run: runId })
    expect(r.status).toBe(400)
    const run = deps.getState().runs.find((x) => x.id === runId)!
    expect(run.pendingStart).toBe(true)
    expect(run.autoDispatch).toBe(true)
    expect(run).not.toHaveProperty('coordinatorSessionId')
  })

  it('--coordinator-account 는 섞인 provider 를 거절한다 — 코디네이터도 한 CLI 다', async () => {
    const deps = coordDeps()
    const r = await call(deps, 'run-create', {
      objective: 'o',
      cwd: 'D:/p',
      coordinatorAccount: 'cl1,cx1'
    })
    expect(r.status).toBe(400)
    expect(String((r.body as { error?: string }).error)).toContain('must not mix providers')
  })

  it('--coordinator-account 는 모르는 계정을 거절한다', async () => {
    const deps = coordDeps()
    const r = await call(deps, 'run-create', {
      objective: 'o',
      cwd: 'D:/p',
      coordinatorAccount: 'nope'
    })
    expect(r.status).toBe(400)
  })
})

describe('run-start — 사람이 실행을 누를 때까지 기다린다', () => {
  it('run-create --auto 는 pendingStart 를 함께 켠다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p', auto: true })
    const run = deps.getState().runs[0]
    expect(run.autoDispatch).toBe(true)
    expect(run.pendingStart).toBe(true)
  })

  // **예약도 이 게이트를 쓴다.** 템플릿 자신은 돌지 않지만 발화는 시작이고, Task 를 다 짜기 전에
  // 첫 회차가 도는 것은 보통 Run 에서 없앤 바로 그 문제다. 게이트가 걷히는 순간부터 무장한다
  // (firesDue) — 그래서 '실행' 뒤의 첫 예약 시각이 첫 회차가 된다.
  it('예약 Run 에도 pendingStart 를 켠다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', {
      objective: 'o',
      cwd: 'D:/p',
      auto: true,
      schedule: { kind: 'daily', time: '09:00' }
    })
    expect(deps.getState().runs[0].pendingStart).toBe(true)
  })

  // autoDispatch 는 여전히 켜지 않는다 — 템플릿이 스스로 배치되면 자기 Task 를 자기가 돌린다.
  // 두 칸은 다른 질문에 답한다: autoDispatch 는 "누가 돌리는가", pendingStart 는 "시작했는가"
  it('예약 Run 에는 autoDispatch 를 켜지 않는다', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', {
      objective: 'o',
      cwd: 'D:/p',
      auto: true,
      schedule: { kind: 'daily', time: '09:00' }
    })
    expect(deps.getState().runs[0].autoDispatch).toBeUndefined()
  })

  // 게이트를 걷는 명령은 템플릿에도 그대로 듣는다 — startRun 은 Run 종류를 가리지 않는다
  it('run-start 가 예약 템플릿의 게이트도 걷는다', async () => {
    const deps = makeDeps()
    const c = await call(deps, 'run-create', {
      objective: 'o',
      cwd: 'D:/p',
      auto: true,
      schedule: { kind: 'daily', time: '09:00' }
    })
    const id = (c.body as { id: string }).id
    expect((await call(deps, 'run-start', { run: id })).status).toBe(200)
    expect(deps.getState().runs[0].pendingStart).toBeUndefined()
  })

  it('run-spawn 이 만든 회차에는 pendingStart 가 없다', async () => {
    const deps = makeDeps()
    const t = await call(deps, 'run-create', {
      objective: 'o',
      cwd: 'D:/p',
      schedule: { kind: 'daily', time: '09:00' }
    })
    const r = await call(deps, 'run-spawn', { run: (t.body as { id: string }).id })
    expect((r.body as { pendingStart?: boolean }).pendingStart).toBeUndefined()
  })

  it('run-start 가 pendingStart 를 걷는다', async () => {
    const deps = makeDeps()
    const c = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p', auto: true })
    const id = (c.body as { id: string }).id
    const r = await call(deps, 'run-start', { run: id })
    expect(r.status).toBe(200)
    expect(deps.getState().runs[0].pendingStart).toBeUndefined()
  })

  // 두 번 눌리는 것을 오류로 만들지 않는다 — 버튼이 사라지기 전에 두 번 눌릴 수 있고, 그때
  // 사람이 손쓸 수 없는 실패 문구를 띄우는 것은 이 명령이 하려는 일과 무관하다
  it('이미 시작한 Run 에 다시 불러도 200 이다', async () => {
    const deps = makeDeps()
    const c = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p', auto: true })
    const id = (c.body as { id: string }).id
    await call(deps, 'run-start', { run: id })
    expect((await call(deps, 'run-start', { run: id })).status).toBe(200)
  })

  it('없는 Run 은 400, --run 이 없으면 400', async () => {
    const deps = makeDeps()
    expect((await call(deps, 'run-start', { run: 'run_nope' })).status).toBe(400)
    expect((await call(deps, 'run-start', {})).status).toBe(400)
  })

  it('워커 세션은 부를 수 없다', async () => {
    const deps = makeDeps()
    const c = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p', auto: true })
    const id = (c.body as { id: string }).id
    await deps.setState({
      ...deps.getState(),
      dispatches: [
        {
          id: 'dsp1',
          taskId: 'tsk1',
          provider: 'claude',
          accountId: 'acc1',
          sessionId: 'worker1',
          cwd: 'D:/p',
          specPath: 'D:/p/spec.md',
          startedAt: NOW,
          workerState: 'ready',
          retained: false
        }
      ]
    })
    expect((await call(deps, 'run-start', { run: id }, 'worker1')).status).toBe(403)
  })
})

/** 워크트리에서 끝난 Dispatch 하나를 가진 평범한 Run. 지우기가 거절되지 않도록 Dispatch 는 끝난
 *  상태로 둔다(열려 있으면 409 다 — 그 규칙은 다른 테스트가 지킨다) */
const withFinishedWorktree = async (): Promise<{
  deps: OrchServerDeps & { state: OrchState }
  runId: string
  merged: string[][]
  removed: string[][]
  mergeOk: { value: boolean }
}> => {
  const merged: string[][] = []
  const removed: string[][] = []
  const mergeOk = { value: true }
  const base = makeDeps()
  const deps = Object.assign(base, {
    mergeWorktrees: async (_cwd: string, paths: string[]) => {
      merged.push(paths)
      return mergeOk.value
        ? { ok: true as const, merged: paths }
        : { ok: false as const, reason: '프로젝트 폴더가 지저분합니다' }
    },
    removeWorktrees: async (paths: string[]) => {
      removed.push(paths)
      return { failed: [] as string[] }
    }
  })
  const c = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
  const runId = (c.body as { id: string }).id
  await deps.setState({
    ...deps.getState(),
    tasks: [
      {
        id: 'tsk_w',
        runId,
        title: 't',
        spec: 's',
        deps: [],
        status: 'completed',
        consecutiveFailures: 0,
        createdAt: NOW,
        updatedAt: NOW
      }
    ],
    dispatches: [
      {
        id: 'dsp_w',
        taskId: 'tsk_w',
        provider: 'claude',
        accountId: 'acc1',
        sessionId: 'sess_w',
        cwd: 'D:/wt/a',
        specPath: 'D:/wt/a/spec.md',
        startedAt: NOW,
        endedAt: NOW,
        outcome: 'succeeded',
        workerState: 'ready',
        retained: false
      }
    ]
  })
  return { deps, runId, merged, removed, mergeOk }
}

describe('run-delete — 병합·워크트리 선택', () => {
  it('아무것도 고르지 않으면 오늘과 같다 — 병합도 폴더 삭제도 없다', async () => {
    const { deps, runId, merged, removed } = await withFinishedWorktree()
    expect((await call(deps, 'run-delete', { id: runId })).status).toBe(200)
    expect(merged).toEqual([])
    expect(removed).toEqual([])
    expect(deps.getState().runs).toHaveLength(0)
  })

  it('merge 를 고르면 그 Run 의 워크트리를 합친 뒤 지운다', async () => {
    const { deps, runId, merged } = await withFinishedWorktree()
    expect((await call(deps, 'run-delete', { id: runId, merge: true })).status).toBe(200)
    expect(merged).toEqual([['D:/wt/a']])
    expect(deps.getState().runs).toHaveLength(0)
  })

  // 이 테스트가 이 기능의 급소다. 병합을 원했는데 실패한 뒤 지우면 워커의 일이 브랜치째 사라진다
  it('병합이 실패하면 아무것도 지우지 않고 이유를 돌려준다', async () => {
    const { deps, runId, mergeOk, removed } = await withFinishedWorktree()
    mergeOk.value = false
    const r = await call(deps, 'run-delete', { id: runId, merge: true, removeWorktrees: true })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.body)).toContain('지저분')
    expect(removed).toEqual([])
    expect(deps.getState().runs).toHaveLength(1)
  })

  it('removeWorktrees 를 고르면 폴더를 지운다', async () => {
    const { deps, runId, removed } = await withFinishedWorktree()
    expect((await call(deps, 'run-delete', { id: runId, removeWorktrees: true })).status).toBe(200)
    expect(removed).toEqual([['D:/wt/a']])
  })

  it('폴더 삭제가 실패한 경로는 응답에 실어 보낸다 — 삭제 자체는 막지 않는다', async () => {
    const { deps, runId } = await withFinishedWorktree()
    const withFailure = Object.assign(deps, {
      removeWorktrees: async () => ({ failed: ['D:/wt/a'] })
    })
    const r = await call(withFailure, 'run-delete', { id: runId, removeWorktrees: true })
    expect(r.status).toBe(200)
    expect((r.body as { worktreesFailed?: string[] }).worktreesFailed).toEqual(['D:/wt/a'])
    expect(withFailure.getState().runs).toHaveLength(0)
  })

  it('워크트리를 쓰지 않은 Run 은 merge 를 골라도 병합을 부르지 않는다', async () => {
    const merged: string[][] = []
    const deps = Object.assign(makeDeps(), {
      mergeWorktrees: async (_c: string, p: string[]) => {
        merged.push(p)
        return { ok: true as const, merged: p }
      }
    })
    const c = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const id = (c.body as { id: string }).id
    expect((await call(deps, 'run-delete', { id, merge: true })).status).toBe(200)
    expect(merged).toEqual([])
  })
})

// **예약 템플릿을 지울 때 회차들의 워크트리가 대상이다.** 템플릿 자신은 한 번도 돌지 않아 폴더가
// 없고, id 하나만 보면 그 목록이 비어서 병합도 폴더 삭제도 조용히 건너뛰어진다
describe('run-delete — 예약 템플릿의 회차 워크트리', () => {
  /** 템플릿 + 회차 하나. 그 회차만 워크트리에서 끝난 Dispatch 를 갖는다 */
  const templateWithRound = async (): Promise<{
    deps: OrchServerDeps & { state: OrchState }
    templateId: string
    merged: string[][]
    removed: string[][]
  }> => {
    const merged: string[][] = []
    const removed: string[][] = []
    const deps = Object.assign(makeDeps(), {
      mergeWorktrees: async (_c: string, paths: string[]) => {
        merged.push(paths)
        return { ok: true as const, merged: paths, uncommitted: 0 }
      },
      removeWorktrees: async (paths: string[]) => {
        removed.push(paths)
        return { failed: [] as string[] }
      }
    })
    const c = await call(deps, 'run-create', {
      objective: 'o',
      cwd: 'D:/p',
      auto: true,
      schedule: { kind: 'daily', time: '09:00' }
    })
    const templateId = (c.body as { id: string }).id
    // 회차와 그 회차의 Task·Dispatch 를 직접 얹는다 — run-spawn 은 템플릿의 Task 를 복사하므로
    // 여기서는 Task 를 템플릿에 두지 않고 회차에만 둔다(그것이 이 테스트가 보는 모양이다)
    await deps.setState({
      ...deps.getState(),
      runs: [
        ...deps.getState().runs,
        {
          id: 'run_kid',
          objective: 'o',
          cwd: 'D:/p',
          createdAt: NOW,
          autoDispatch: true,
          templateId,
          fireOrdinal: 1
        }
      ],
      tasks: [
        {
          id: 'tsk_kid',
          runId: 'run_kid',
          title: 't',
          spec: 's',
          deps: [],
          status: 'completed',
          consecutiveFailures: 0,
          createdAt: NOW,
          updatedAt: NOW
        }
      ],
      dispatches: [
        {
          id: 'dsp_kid',
          taskId: 'tsk_kid',
          provider: 'claude',
          accountId: 'acc1',
          sessionId: 'sess_kid',
          cwd: 'D:/wt/kid',
          specPath: 'D:/wt/kid/spec.md',
          startedAt: NOW,
          endedAt: NOW,
          outcome: 'succeeded',
          workerState: 'ready',
          retained: false
        }
      ]
    })
    return { deps, templateId, merged, removed }
  }

  it('회차의 폴더를 지운다 — 템플릿 자신에는 폴더가 없다', async () => {
    const { deps, templateId, removed } = await templateWithRound()
    const r = await call(deps, 'run-delete', { id: templateId, removeWorktrees: true })
    expect(r.status).toBe(200)
    expect(removed).toEqual([['D:/wt/kid']])
  })

  it('회차의 일을 합친다', async () => {
    const { deps, templateId, merged } = await templateWithRound()
    expect((await call(deps, 'run-delete', { id: templateId, merge: true })).status).toBe(200)
    expect(merged).toEqual([['D:/wt/kid']])
  })

  it('템플릿과 회차가 함께 사라진다', async () => {
    const { deps, templateId } = await templateWithRound()
    await call(deps, 'run-delete', { id: templateId, removeWorktrees: true })
    expect(deps.getState().runs).toHaveLength(0)
  })
})

describe('run-pause', () => {
  /** 예약 템플릿 + 회차 하나. 그 회차에 열린 Dispatch 가 하나 있다 */
  const runningSchedule = async (
    over: Record<string, unknown> = {}
  ): Promise<{
    deps: OrchServerDeps & { state: OrchState }
    templateId: string
    released: string[]
  }> => {
    const released: string[] = []
    const deps = Object.assign(makeDeps(), {
      releaseWorker: async (a: { dispatchId: string }) => {
        released.push(a.dispatchId)
      }
    })
    const c = await call(deps, 'run-create', {
      objective: 'o',
      cwd: 'D:/p',
      auto: true,
      schedule: { kind: 'daily', time: '09:00' }
    })
    const templateId = (c.body as { id: string }).id
    // 템플릿의 게이트는 걷어 둔다 — 도는 예약을 멈추는 것이 이 명령의 자리다
    await call(deps, 'run-start', { run: templateId })
    await deps.setState({
      ...deps.getState(),
      runs: [
        ...deps.getState().runs,
        {
          id: 'run_kid',
          objective: 'o',
          cwd: 'D:/p',
          createdAt: NOW,
          autoDispatch: true,
          templateId,
          fireOrdinal: 1
        }
      ],
      tasks: [
        {
          id: 'tsk_running',
          runId: 'run_kid',
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
          id: 'dsp_running',
          taskId: 'tsk_running',
          provider: 'claude',
          accountId: 'acc1',
          sessionId: 'sess_running',
          cwd: 'D:/wt/kid',
          specPath: 'D:/wt/kid/spec.md',
          startedAt: NOW,
          workerState: 'ready',
          retained: false,
          ...over
        }
      ]
    })
    return { deps, templateId, released }
  }

  it('도는 세션을 닫고 Dispatch 를 stopped 로 남긴다', async () => {
    const { deps, templateId, released } = await runningSchedule()
    expect((await call(deps, 'run-pause', { run: templateId })).status).toBe(200)
    expect(released).toEqual(['dsp_running'])
    const d = deps.getState().dispatches[0]
    expect(d.workerState).toBe('stopped')
    expect(d.endedAt).toBe(NOW)
    // 보고하지 않은 워커에 결과를 적지 않는다 — 그래프가 거짓말을 하게 된다
    expect(d.outcome).toBeUndefined()
  })

  // **회차까지 세우는 것이 요점이다.** Dispatch 만 닫으면 그 회차의 다음 ready Task 가 곧바로 뜬다
  it('템플릿과 회차 모두에 paused 를 세운다', async () => {
    const { deps, templateId } = await runningSchedule()
    await call(deps, 'run-pause', { run: templateId })
    const byId = new Map(deps.getState().runs.map((r) => [r.id, r]))
    expect(byId.get(templateId)!.paused).toBe(true)
    expect(byId.get('run_kid')!.paused).toBe(true)
  })

  // **pendingStart 를 건드리지 않는다.** 그 칸은 '실행' 의 것이다 — 일시 중지가 그것을 다시 세우면
  // 세운 뒤에 '실행' 버튼과 '▶' 가 같은 일을 하는 둘로 나란히 뜬다
  it('pendingStart 는 건드리지 않는다', async () => {
    const { deps, templateId } = await runningSchedule()
    await call(deps, 'run-pause', { run: templateId })
    expect(deps.getState().runs.find((r) => r.id === templateId)!.pendingStart).toBeUndefined()
  })

  // 재개는 템플릿의 것만 걷는다 — 멈춘 회차는 이어지지 않는다
  it('run-resume 이 템플릿만 재개하고 멈춘 회차는 그대로 둔다', async () => {
    const { deps, templateId } = await runningSchedule()
    await call(deps, 'run-pause', { run: templateId })
    expect((await call(deps, 'run-resume', { run: templateId })).status).toBe(200)
    const byId = new Map(deps.getState().runs.map((r) => [r.id, r]))
    expect(byId.get(templateId)!.paused).toBeUndefined()
    expect(byId.get('run_kid')!.paused).toBe(true)
  })

  // 버튼이 사라지기 전에 두 번 눌릴 수 있다 — 요청한 끝 상태는 이미 그것이다
  it('세워 두지 않은 예약에 run-resume 을 불러도 성공이다', async () => {
    const { deps, templateId } = await runningSchedule()
    expect((await call(deps, 'run-resume', { run: templateId })).status).toBe(200)
  })

  it('예약이 아닌 Run 은 run-resume 도 거절한다', async () => {
    const deps = makeDeps()
    const c = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p', auto: true })
    expect((await call(deps, 'run-resume', { run: (c.body as { id: string }).id })).status).toBe(400)
  })

  it('붙잡아 둔 세션이 있으면 409 다 — 아무것도 멈추지 않는다', async () => {
    const { deps, templateId, released } = await runningSchedule({ retained: true })
    const r = await call(deps, 'run-pause', { run: templateId })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.body)).toContain('worker-retain')
    expect(released).toEqual([])
    expect(deps.getState().runs.find((x) => x.id === templateId)!.pendingStart).toBeUndefined()
  })

  it('예약이 아닌 Run 은 409 다', async () => {
    const deps = makeDeps()
    const c = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p', auto: true })
    const r = await call(deps, 'run-pause', { run: (c.body as { id: string }).id })
    expect(r.status).toBe(409)
  })

  it('없는 Run 은 400, --run 이 없으면 400', async () => {
    const deps = makeDeps()
    expect((await call(deps, 'run-pause', { run: 'run_nope' })).status).toBe(400)
    expect((await call(deps, 'run-pause', {})).status).toBe(400)
  })

  it('워커 세션은 부를 수 없다', async () => {
    const { deps, templateId } = await runningSchedule()
    const r = await call(deps, 'run-pause', { run: templateId }, 'sess_running')
    expect(r.status).toBe(403)
  })
})

describe('run-merge', () => {
  it('워크트리들을 프로젝트 폴더로 합친다', async () => {
    const { deps, runId, merged } = await withFinishedWorktree()
    const r = await call(deps, 'run-merge', { run: runId })
    expect(r.status).toBe(200)
    expect(merged).toEqual([['D:/wt/a']])
    expect((r.body as { merged: string[] }).merged).toEqual(['D:/wt/a'])
  })

  // 커밋되지 않은 변경의 수는 배선이 세고 이 명령은 그대로 올린다 — 그 수가 렌더러까지 닿아야
  // "합쳤습니다" 를 "일이 다 옮겨졌다" 로 읽고 폴더를 지우는 경로가 막힌다
  it('커밋되지 않은 변경의 수를 그대로 올린다', async () => {
    const { deps, runId } = await withFinishedWorktree()
    const withDirty = Object.assign(deps, {
      mergeWorktrees: async (_c: string, p: string[]) => ({
        ok: true as const,
        merged: p,
        uncommitted: 3
      })
    })
    const r = await call(withDirty, 'run-merge', { run: runId })
    expect(r.status).toBe(200)
    expect((r.body as { uncommitted?: number }).uncommitted).toBe(3)
  })

  it('합쳐도 Run 은 남는다 — 이 명령은 지우지 않는다', async () => {
    const { deps, runId } = await withFinishedWorktree()
    await call(deps, 'run-merge', { run: runId })
    expect(deps.getState().runs).toHaveLength(1)
  })

  // **합친 뒤에도 그 Run 은 계속 돌 수 있어야 한다.** 성공한 병합이 워크트리를 걷어 가면
  // `run.worktree` 는 사라진 폴더를 가리킨 채 남고(run-worktree-set 은 두 번째 쓰기를 거절한다)
  // 배치는 그 경로를 fs.stat 하므로, 그 Run 은 다시는 Task 를 띄울 수 없게 된다.
  //
  // **이 층이 볼 수 있는 것까지만 본다.** 실제 폴더 삭제는 배선의 integrateWorktrees 안에 있고
  // (src/main/ipc.ts, 사람이 누른 병합에는 reap 을 끈다) 여기서 mergeWorktrees 는 스텁이므로, 그
  // 삭제 자체는 이 테스트가 볼 수 없다. 이 자리에서 정직하게 물을 수 있는 것은 둘이다: run-merge 가
  // 폴더 삭제를 **요청하지 않는다**, 그리고 병합 뒤에도 기록된 Run 워크트리가 그대로 남아 다음
  // 워커가 거기서 뜬다.
  it('폴더 삭제를 요청하지 않고, 합친 뒤에도 Run 워크트리가 그대로 쓰인다', async () => {
    const { deps, runId, removed } = await withFinishedWorktree()
    const set = await call(deps, 'run-worktree-set', { run: runId, worktree: 'D:/wt/run' })
    expect(set.status).toBe(200)
    const placements: string[] = []
    deps.startWorker = async (a) => {
      placements.push(a.worktree)
      return { sessionId: 'sess_after', cwd: a.worktree, specPath: 'D:/wt/run/spec.md' }
    }

    expect((await call(deps, 'run-merge', { run: runId })).status).toBe(200)

    expect(removed).toEqual([])
    expect(deps.getState().runs.find((r) => r.id === runId)?.worktree).toBe('D:/wt/run')
    const t = await call(deps, 'task-create', { account: 'acc1', runId, title: '다음', spec: 's' })
    const r = await call(deps, 'worker-start', {
      taskId: (t.body as { id: string }).id,
      agent: 'codex',
      account: 'acc1'
    })
    expect(r.status).toBe(200)
    expect(placements).toEqual(['D:/wt/run'])
  })

  it('합칠 것이 없으면 병합을 부르지 않는다', async () => {
    const merged: string[][] = []
    const deps = Object.assign(makeDeps(), {
      mergeWorktrees: async (_c: string, p: string[]) => {
        merged.push(p)
        return { ok: true as const, merged: p }
      }
    })
    const c = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const r = await call(deps, 'run-merge', { run: (c.body as { id: string }).id })
    expect(r.status).toBe(200)
    expect(merged).toEqual([])
  })

  it('병합이 실패하면 409 와 그 이유다', async () => {
    const { deps, runId, mergeOk } = await withFinishedWorktree()
    mergeOk.value = false
    const r = await call(deps, 'run-merge', { run: runId })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.body)).toContain('지저분')
  })

  it('없는 Run 은 400 이다', async () => {
    expect((await call(makeDeps(), 'run-merge', { run: 'run_nope' })).status).toBe(400)
  })

  it('병합이 이 빌드에 없으면 400 이다', async () => {
    const { deps, runId } = await withFinishedWorktree()
    const noMerge = { ...deps, mergeWorktrees: undefined }
    expect((await call(noMerge, 'run-merge', { run: runId })).status).toBe(400)
  })
})

describe('run-worktree-set', () => {
  const withRun = async (): Promise<{
    deps: OrchServerDeps & { state: OrchState }
    runId: string
  }> => {
    const deps = makeDeps()
    const c = await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    return { deps, runId: (c.body as { id: string }).id }
  }

  it('워크트리를 기록한다', async () => {
    const { deps, runId } = await withRun()
    const r = await call(deps, 'run-worktree-set', { run: runId, worktree: 'D:/wt/a' })
    expect(r.status).toBe(200)
    expect(deps.getState().runs.find((x) => x.id === runId)?.worktree).toBe('D:/wt/a')
  })

  it('이미 있으면 409 다 — 배선이 워크트리를 두 개 만들었다는 뜻이다', async () => {
    const { deps, runId } = await withRun()
    await call(deps, 'run-worktree-set', { run: runId, worktree: 'D:/wt/a' })
    const again = await call(deps, 'run-worktree-set', { run: runId, worktree: 'D:/wt/b' })
    expect(again.status).toBe(409)
    // 첫 값이 그대로여야 한다 — 거절이 곧 덮어쓰지 않았다는 뜻이다
    expect(deps.getState().runs.find((x) => x.id === runId)?.worktree).toBe('D:/wt/a')
  })

  it('없는 Run 은 400 이다 — commit 이 err 를 그렇게 낸다(run-start 와 같다)', async () => {
    const r = await call(makeDeps(), 'run-worktree-set', {
      run: 'run_nope',
      worktree: 'D:/wt/a'
    })
    expect(r.status).toBe(400)
  })

  it('--worktree 가 없으면 400 이다', async () => {
    const { deps, runId } = await withRun()
    expect((await call(deps, 'run-worktree-set', { run: runId })).status).toBe(400)
  })

  it('워커 세션은 부를 수 없다 — Run 수준 변경은 워커의 것이 아니다', async () => {
    const { deps, runId } = await withRun()
    await deps.setState({
      ...deps.getState(),
      dispatches: [
        {
          id: 'dsp1',
          taskId: 'tsk1',
          provider: 'claude',
          accountId: 'acc1',
          sessionId: 'worker1',
          cwd: 'D:/p',
          specPath: 'D:/p/spec.md',
          startedAt: NOW,
          workerState: 'ready',
          retained: false
        }
      ]
    })
    const r = await call(deps, 'run-worktree-set', { run: runId, worktree: 'D:/wt/a' }, 'worker1')
    expect(r.status).toBe(403)
  })
})

// CLI 로 들어오는 길을 **파서를 거쳐** 확인한다. 여기가 비어 있던 것이 이 결함의 원인이었다 —
// 앱은 IPC 로 객체를 직접 보내고(NewTaskModal), 다른 테스트도 서버를 직접 부르므로, 파서가 만드는
// 키와 서버가 읽는 키가 어긋나도 아무 데서도 드러나지 않았다.
describe('handleCommand — CLI 인자 경로', () => {
  /** astera <cmd> ... 한 줄을 파서에 통과시켜 서버가 실제로 받는 args 로 만든다 */
  const cliArgs = (argv: string[]): Record<string, unknown> => {
    const parsed = parseArgs(argv)
    if ('error' in parsed) throw new Error(parsed.error)
    return parsed.args
  }

  const twoRuns = async (): Promise<{ deps: OrchServerDeps; older: string; newer: string }> => {
    const deps = makeDeps()
    const a = await call(deps, 'run-create', { objective: 'first', cwd: 'D:/p' })
    const b = await call(deps, 'run-create', { objective: 'second', cwd: 'D:/p' })
    return { deps, older: (a.body as { id: string }).id, newer: (b.body as { id: string }).id }
  }

  it('task-create 는 --run 이 가리키는 Run 에 붙는다', async () => {
    const { deps, older } = await twoRuns()
    const r = await call(
      deps,
      'task-create',
      cliArgs(['task-create', '--account', 'acc1', '--run', older, '--title', 't', '--spec', 's'])
    )
    expect((r.body as { runId: string }).runId).toBe(older)
  })

  // 이 결함의 본체. --run 이 무시되면 가장 최근 Run 으로 조용히 흘러가고, 코디네이터가 만든 Task 가
  // 사람이 방금 만든 Job 에 섞인다 — 오류도 나지 않아 알아챌 방법이 없다.
  it('--run 이 최신이 아닌 Run 을 가리켜도 그쪽에 붙는다', async () => {
    const { deps, older, newer } = await twoRuns()
    await call(
      deps,
      'task-create',
      cliArgs(['task-create', '--account', 'acc1', '--run', older, '--title', 't', '--spec', 's'])
    )
    const tasks = deps.getState().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0].runId).toBe(older)
    expect(tasks[0].runId).not.toBe(newer)
  })

  it('--run 이 없으면 가장 최근 Run 에 붙는다', async () => {
    const { deps, newer } = await twoRuns()
    const r = await call(deps, 'task-create', cliArgs(['task-create', '--account', 'acc1', '--title', 't', '--spec', 's']))
    expect((r.body as { runId: string }).runId).toBe(newer)
  })

  // 앱은 IPC 로 runId 를 직접 보낸다(NewTaskModal). 그 길이 계속 살아 있어야 한다
  it('앱이 보내는 runId 도 그대로 받는다', async () => {
    const { deps, older } = await twoRuns()
    const r = await call(deps, 'task-create', { account: 'acc1', runId: older, title: 't', spec: 's' })
    expect((r.body as { runId: string }).runId).toBe(older)
  })

  it('없는 Run 을 --run 으로 주면 거절한다', async () => {
    const { deps } = await twoRuns()
    const r = await call(
      deps,
      'task-create',
      cliArgs(['task-create', '--account', 'acc1', '--run', 'run_nope', '--title', 't', '--spec', 's'])
    )
    expect(r.status).toBeGreaterThanOrEqual(400)
  })
})
