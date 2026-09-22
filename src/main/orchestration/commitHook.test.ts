// F54 의 회귀 테스트. **함수 하나가 아니라 순서를 고정한다** — 결함은 훅의 내용이 아니라 "Host 가
// 커밋한 것에는 아무도 이 훅을 부르지 않는다" 였고, 그것은 워커 보고 한 번을 실제로 통과시켜야만
// 드러난다.
//
// 이 파일의 rig 는 이제 두 프로세스다. **Host 쪽**은 core 의 `handleCommand` 를 그대로 돌린다 —
// src/host/orch.ts 가 하는 일과 같다. **앱 쪽**은 `orch-state` 푸시를 받아 거울을 바꾸고
// `createOrchCommitHook` 을 부른다(ipc.ts 의 그 핸들러와 같은 두 줄), 그리고 그 훅의 `schedule` 이
// 진짜 `slotsToFill` 로 자리를 찾아 `worker-start` 를 보낸다 — ipc.ts 의 runScheduler 가 하는 일의
// 핵심만. 가짜는 세션을 실제로 띄우는 `startWorker` 하나뿐이다.
import { describe, it, expect, vi } from 'vitest'
import { createOrchCommitHook } from './commitHook'
import { handleCommand, type OrchServerDeps } from '../../core/orchestration/command'
import { slotsToFill } from '../../core/orchestration/schedule'
import { emptyState, type OrchState } from '../../core/orchestration/state'
import type { Task } from '../../core/orchestration/types'

const NOW = '2026-09-22T12:00:00.000Z'
const UI = 'ui:test'

const task = (over: Partial<Task> & Pick<Task, 'id'>): Task => ({
  runId: 'run_1',
  jobId: 'job_1',
  title: over.id,
  spec: 's',
  deps: [],
  status: 'pending',
  accountIds: ['accA'],
  consecutiveFailures: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over
})

/** 앱이 만든 Job(autoDispatch) 하나, 순서가 있는 Task 둘, 그리고 이미 떠 있는 1번 워커.
 *  검사 구성은 없다 — 그것이 결함이 보이는 조건이다: 검사가 있는 Run 은 startValidation 이 앱으로
 *  넘어와 앱 쪽 쓰기가 한 번 더 일어나는 바람에 우연히 이어졌다. */
const twoSequentialTasks = (): OrchState => ({
  ...emptyState(),
  jobs: [
    {
      id: 'job_1',
      objective: 'two in a row',
      cwd: 'D:/p',
      createdAt: NOW,
      concurrency: 1,
      autoDispatch: true
    }
  ],
  // 워크트리가 이미 있는 회차 — worker-start 는 없으면 409 다(프로젝트 폴더에 바로 쓰지 않는다).
  runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: NOW, worktree: 'D:/wt1' }],
  tasks: [
    task({ id: 'tsk_1', status: 'dispatched' }),
    task({ id: 'tsk_2', status: 'pending', deps: ['tsk_1'] })
  ],
  dispatches: [
    {
      id: 'dsp_1',
      taskId: 'tsk_1',
      provider: 'claude',
      accountId: 'accA',
      sessionId: 'sess_1',
      cwd: 'D:/wt1',
      specPath: 'C:/specs/1.md',
      startedAt: NOW,
      workerState: 'ready',
      retained: false
    }
  ]
})

/** Host 한 쪽과 앱 한 쪽. `wireCommitHook` 이 거짓이면 푸시 핸들러가 거울만 바꾸고 사이드바만
 *  미는 — F54 이전의 — 두 줄이 된다. */
function rig(a: { wireCommitHook: boolean }): {
  hostSend: (cmd: string, args: Record<string, unknown>, sessionId: string) => Promise<{ status: number }>
  state: () => OrchState
  started: string[]
  pushed: OrchState[]
  refusals: string[]
  scheduled: () => number
} {
  // Host 가 소유한 상태. 앱은 자기 거울만 본다.
  const box = { state: twoSequentialTasks() }
  const mirror = { state: box.state }
  const started: string[] = []
  const pushed: OrchState[] = []
  const refusals: string[] = []
  let scheduleCount = 0
  let prev: OrchState | null = null

  const startWorker: OrchServerDeps['startWorker'] = async (x) => {
    started.push(x.taskId)
    return { sessionId: `sess_${x.taskId}`, cwd: 'D:/wt', specPath: `C:/specs/${x.taskId}.md` }
  }

  // Host 쪽 deps — src/host/orchDeps.ts 가 감싸는 것과 같은 모양. setState 는 커밋한 뒤 앱에게
  // 민다(toOthers): 그것이 이 테스트가 재현하려는 유일한 전달 경로다.
  const hostDeps = (): OrchServerDeps =>
    ({
      getState: () => box.state,
      setState: async (n: OrchState) => {
        box.state = n
        onPush(n)
      },
      enabled: () => true,
      now: () => NOW,
      startWorker,
      listAccounts: async () => [{ id: 'accA', label: 'A', provider: 'claude' as const }],
      log: () => {},
      runningSessions: () => 0,
      appVersion: () => '1.0.0'
    }) as unknown as OrchServerDeps

  /** ipc.ts 의 runScheduler 가 하는 일의 핵심 — 진짜 `slotsToFill` 로 자리를 찾아 `worker-start`
   *  를 보낸다. 명령은 Host 의 command layer 가 받는다(지금 그쪽이 그 명령의 주인이다). */
  const schedule = (): void => {
    scheduleCount++
    void (async () => {
      for (const slot of slotsToFill(mirror.state)) {
        // ipc.ts 의 그 호출과 같은 인자다(task·agent·account) — provider 는 계정 목록이 정한다.
        const rep = await handleCommand(hostDeps(), { sessionId: UI }, 'worker-start', {
          task: slot.taskId,
          agent: 'claude',
          account: slot.accountIds[0]
        })
        // 조용히 삼키지 않는다 — 여기서 409 를 흘리면 "2번이 안 떴다" 의 원인이 배선인지 인자인지
        // 구별되지 않는다(실제로 한 번 그렇게 헤맸다).
        if (rep.status >= 400) refusals.push(`${rep.status} ${JSON.stringify(rep.body)}`)
      }
    })()
  }

  const hook = createOrchCommitHook({
    push: (n) => pushed.push(n),
    onRunFinished: () => {},
    previous: () => prev,
    remember: (n) => {
      prev = n
    },
    schedule,
    log: () => {}
  })

  /** `orch-state` 핸들러 그 자체. */
  const onPush = (n: OrchState): void => {
    const before = mirror.state
    mirror.state = n
    if (a.wireCommitHook) hook({ prev: before, next: n })
    else pushed.push(n) // F54 이전: 거울과 사이드바뿐
  }

  return {
    hostSend: (cmd, args, sessionId) =>
      handleCommand(hostDeps(), { sessionId }, cmd, args).then((r) => ({ status: r.status })),
    state: () => box.state,
    started,
    pushed,
    refusals,
    scheduled: () => scheduleCount
  }
}

/** 1번 워커가 끝났다고 보고한다 — Host 가 받고, Host 가 커밋하고, Host 가 민다. */
const reportDone = async (r: ReturnType<typeof rig>): Promise<void> => {
  const reply = await r.hostSend(
    'send',
    { type: 'worker_done', taskId: 'tsk_1', dispatchId: 'dsp_1', outcome: 'succeeded', result: 'done' },
    'sess_1'
  )
  expect(reply.status, 'worker_done 자체가 거절됐다면 이 테스트는 아무것도 확인하지 못한다').toBe(200)
  // 스케줄러는 fire-and-forget 이다 — 그 안의 await 들이 풀릴 틈을 준다.
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('Host 가 커밋한 worker_done', () => {
  // **이것이 F54 다.** 훅이 푸시 경로에 연결돼 있지 않으면 2번 Task 는 ready 에서 멈춘다 — 화면은
  // 멀쩡히 갱신되고 로그에는 아무 일도 없다.
  it('훅이 연결돼 있지 않으면 다음 Task 가 뜨지 않는다 (회귀 재현)', async () => {
    const r = rig({ wireCommitHook: false })
    await reportDone(r)
    expect(r.state().tasks.find((t) => t.id === 'tsk_2')?.status).toBe('ready')
    expect(r.started).toEqual([])
    expect(r.scheduled()).toBe(0)
  })

  it('훅이 연결돼 있으면 두 번째 Task 가 곧바로 뜬다', async () => {
    const r = rig({ wireCommitHook: true })
    await reportDone(r)
    expect(r.refusals, '스케줄러가 거절당했다면 그 이유가 결론이다').toEqual([])
    expect(r.started).toEqual(['tsk_2'])
    expect(r.state().tasks.find((t) => t.id === 'tsk_2')?.status).toBe('dispatched')
    expect(r.state().dispatches.some((d) => d.taskId === 'tsk_2' && !d.endedAt)).toBe(true)
  })

  it('그 커밋으로 사이드바도 밀린다', async () => {
    const r = rig({ wireCommitHook: true })
    await reportDone(r)
    expect(r.pushed.length).toBeGreaterThan(0)
    expect(r.pushed[0].tasks.find((t) => t.id === 'tsk_1')?.status).toBe('completed')
  })
})

describe('createOrchCommitHook', () => {
  const s0 = twoSequentialTasks()
  const build = (
    over: Partial<Parameters<typeof createOrchCommitHook>[0]> = {}
  ): {
    hook: ReturnType<typeof createOrchCommitHook>
    calls: { push: OrchState[]; schedule: number; remembered: OrchState[] }
    record: ReturnType<typeof vi.fn>
    checkpoint: ReturnType<typeof vi.fn>
  } => {
    const calls = { push: [] as OrchState[], schedule: 0, remembered: [] as OrchState[] }
    const record = vi.fn(() => [{ id: 'evt_1' } as never])
    const checkpoint = vi.fn(async () => {})
    const hook = createOrchCommitHook({
      record,
      checkpoint,
      push: (n) => calls.push.push(n),
      onRunFinished: () => {},
      previous: () => null,
      remember: (n) => calls.remembered.push(n),
      schedule: () => {
        calls.schedule++
      },
      log: () => {},
      ...over
    })
    return { hook, calls, record, checkpoint }
  }

  // Host 가 커밋한 전이는 아무도 journal 에 적지 않았다 — 그리고 그 공백을 recoverOne 은
  // "확인받지 못했다" 라는 **긍정**으로 읽는다.
  // **거절당할 수 있는 쓰기 뒤로 옮겼다**(ruling F56/d). 앱 경로도 커밋이 받아들여진 뒤에 적는다 —
  // 409 로 거절당한 쓰기가 "일어나지 않은 전이" 의 journal 을 남기면 화해기가 그것을 사실로 읽는다.
  it('journal 은 커밋이 받아들여진 뒤에 적는다', () => {
    const { hook, record, checkpoint } = build()
    hook({ prev: s0, next: s0 })
    expect(record).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalledTimes(1)
  })

  // **따라잡는 중에는 체크포인트를 안 찍는다.** journal 행은 "이 전이가 있었다" 이고 늦어도 참이지만,
  // 체크포인트는 그 순간의 git 사실이라 지금 찍으면 다른 값이 된다 — 그리고 그 값이
  // changedFilesSince 의 기준점이다.
  it('따라잡는 중이면 journal 은 적고 체크포인트는 건너뛴다', () => {
    const { hook, record, checkpoint } = build()
    hook({ prev: s0, next: s0, catchingUp: true })
    expect(record).toHaveBeenCalledTimes(1)
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it('따라잡는 중에도 사이드바·기준점·스케줄러는 그대로다', () => {
    const { hook, calls } = build()
    hook({ prev: s0, next: s0, catchingUp: true })
    expect(calls.push).toHaveLength(1)
    expect(calls.remembered).toEqual([s0])
    expect(calls.schedule).toBe(1)
  })

  it('네 가지를 모두 한다 — 사이드바·체크포인트·기준점·스케줄러', () => {
    const { hook, calls, checkpoint } = build()
    hook({ prev: s0, next: s0 })
    expect(calls.push).toHaveLength(1)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(calls.remembered).toEqual([s0])
    expect(calls.schedule).toBe(1)
  })

  it('journal 이 비면 체크포인트는 부르지 않는다', () => {
    const { hook, checkpoint } = build({ record: () => [] })
    hook({ prev: s0, next: s0 })
    expect(checkpoint).not.toHaveBeenCalled()
  })
})
