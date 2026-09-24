// createDispatchLoop(dispatchLoop.ts) — 앱(ipc.ts 의 bootOrch)과 Host 가 같은 것을 짓는 배치 루프.
//
// **진짜 handleCommand 위에서 돈다**(commitHook.test.ts 의 rig 와 같은 모양). 상태는 이 파일의 변수
// 하나이고, 가짜는 세션을 실제로 띄우는 startWorker 와 DispatchLoopContext 의 바깥 자리(계정·로그인·
// 워크트리·세션)뿐이다. **setState 는 상태를 갈아 끼운 뒤 `loop.run()` 을 다시 부른다** — 앱의 커밋
// 훅이 하는 일 그대로라(B4), 루프의 scheduleAgain 갈래가 운영에서처럼 돈다.
import { describe, it, expect, vi } from 'vitest'
import { createDispatchLoop, type DispatchLoop, type DispatchLoopContext } from './dispatchLoop'
import { handleCommand, type OrchServerDeps } from '../command'
import { emptyState, type OrchState } from '../state'
import type { Job, Message, Task } from '../types'
import type { Account } from '../../types'

const NOW = '2026-09-24T00:00:00.000Z'
const NOW_MS = Date.parse(NOW)

const claudeAccount = (id: string): Account => ({
  id,
  label: id,
  configDir: `/cfg/${id}`,
  color: '#000',
  createdAt: NOW,
  provider: 'claude'
})

const task = (over: Partial<Task> & Pick<Task, 'id'>): Task => ({
  runId: 'run_1',
  jobId: 'job_1',
  title: over.id,
  spec: 's',
  deps: [],
  status: 'ready',
  accountIds: ['accA'],
  consecutiveFailures: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over
})

const message = (over: Partial<Message> & Pick<Message, 'id' | 'type'>): Message => ({
  runId: 'run_1',
  subject: 's',
  body: 'b',
  answered: false,
  createdAt: NOW,
  ...over
})

interface RigOpts {
  concurrency?: number
  /** 몇 번째 startWorker 호출(0부터)이 던지는가. 'all' 이면 전부. */
  startFailsFor?: number | 'all'
  /** gate-create 가 거절된다(열린 Dispatch 가 있는 Task 의 Gate 처럼). */
  gateRefused?: boolean
  /** 답할 코디네이터가 없는 Run 에서 워커 하나가 질문을 두고 기다린다. */
  question?: boolean
  /** 계정이 없는 ready Task 하나가 더 있다. */
  noAccountTask?: boolean
  /** 예약 템플릿 Job 하나가 더 있다. */
  schedule?: { every: 'minute' }
  /** 코디네이터가 있는 Run 에, 오래전에 온 읽지 않은 상향 메일이 있다. */
  coordinatorMail?: boolean
  /** Run 워크트리가 아직 없다 — 루프가 게으르게 만든다. */
  runWithoutWorktree?: boolean
}

const TEMPLATE_ID = 'job_sched'

function fixture(o: RigOpts): OrchState {
  const jobs: Job[] = [
    {
      id: 'job_1',
      objective: 'two ready tasks',
      cwd: '/p',
      createdAt: NOW,
      concurrency: o.concurrency ?? 1,
      autoDispatch: true
    }
  ]
  // 발화 판정이 보는 것은 Job 의 schedule 이다(fire.ts). 1분 간격 — fire.test.ts 의 규칙 모양이다.
  if (o.schedule) jobs.push({ id: TEMPLATE_ID, objective: 'every minute', cwd: '/p', createdAt: NOW, schedule: { kind: 'interval', minutes: 1 } })
  const tasks = [task({ id: 'tsk_1' }), task({ id: 'tsk_2' })]
  if (o.noAccountTask) tasks.push(task({ id: 'tsk_na', accountIds: [] }))
  const state: OrchState = {
    ...emptyState(),
    jobs,
    runs: [
      {
        id: 'run_1',
        jobId: 'job_1',
        ordinal: 1,
        createdAt: NOW,
        ...(o.runWithoutWorktree ? {} : { worktree: '/wt1' }),
        ...(o.coordinatorMail ? { coordinatorSessionId: 'coord-1' } : {})
      }
    ],
    tasks
  }
  if (o.question) {
    // 이미 도는 워커 하나(한도 1 을 채운다)와 그 워커의 질문.
    state.tasks = [task({ id: 'tsk_q', status: 'dispatched' }), ...state.tasks]
    state.dispatches = [
      {
        id: 'dsp_q',
        taskId: 'tsk_q',
        provider: 'claude',
        accountId: 'accA',
        sessionId: 'sess_q',
        cwd: '/wt1',
        specPath: '/specs/q.md',
        startedAt: NOW,
        workerState: 'ready',
        retained: false
      }
    ]
    state.messages = [message({ id: 'msg_q', type: 'question', taskId: 'tsk_q', dispatchId: 'dsp_q' })]
  }
  if (o.coordinatorMail) {
    // COORDINATOR_NUDGE_MS(90초)보다 오래전에 왔고 아직 ack 되지 않았다.
    state.messages = [
      ...state.messages,
      message({ id: 'msg_up', type: 'status', createdAt: new Date(NOW_MS - 120_000).toISOString() })
    ]
  }
  return state
}

type StartArgs = Parameters<OrchServerDeps['startWorker']>[0]

function rig(o: RigOpts = {}) {
  let state = fixture(o)
  const cmds: string[] = []
  const typed: string[] = []
  const forked: { repoPath: string; name: string }[] = []
  let calls = 0
  let inFlight = 0
  // 안전판: 회전하는 루프(attempted 를 지운 변이)가 이 파일을 멈춰 세우지 않고 횟수로 실패하게 한다.
  let commits = 0

  const startWorker = vi.fn(async (a: StartArgs) => {
    const n = calls++
    if (o.startFailsFor === 'all' || o.startFailsFor === n) throw new Error(`spawn ${n} failed`)
    return { sessionId: `s-${n}`, cwd: a.runCwd ?? 'x', specPath: 'x' }
  })

  const deps = {
    getState: () => state,
    // 앱의 커밋 훅처럼: 갈아 끼우고, 루프를 다시 부른다(B4). 종단 catch 는 앱의 schedule 과 같다.
    setState: async (next: OrchState) => {
      state = next
      if (++commits > 200) return
      inFlight++
      void loop
        .run()
        .catch(() => {})
        .finally(() => inFlight--)
    },
    now: () => new Date(h.clock).toISOString(),
    startWorker,
    listAccounts: async () => [{ id: 'accA', label: 'accA', provider: 'claude' as const }],
    log: () => {},
    runningSessions: () => 0,
    appVersion: () => '1.0.0'
  } as unknown as OrchServerDeps

  /** 진짜 command layer — 테스트가 ctx.handle 을 갈아 끼워도 그 안에서 부를 수 있게 따로 둔다. */
  const real = (cmd: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown }> => {
    if (o.gateRefused && cmd === 'gate-create')
      return Promise.resolve({ status: 409, body: { error: 'task has an open dispatch' } })
    return handleCommand(deps, { sessionId: 'astera:test' }, cmd, args)
  }

  const ctx: DispatchLoopContext = {
    handle: real,
    getState: () => state,
    accounts: () => [claudeAccount('accA')],
    loginStatus: async () => true,
    lang: () => 'en',
    forkRunWorktree: async (a) => {
      forked.push(a)
      return '/wt-forked'
    },
    integrate: async () => ({ kind: 'clean' }) as never,
    reap: async () => true,
    isRegisteredWorktree: () => false,
    sessionAlive: () => true,
    sessionBusy: () => false,
    typeInto: (_id, text) => {
      typed.push(text)
    },
    mayStart: () => true,
    log: () => {},
    nowMs: () => h.clock
  }

  // 모듈은 c.* 를 부를 때마다 읽는다(C5) — 그래서 테스트가 ctx 의 칸을 갈아 끼우면 곧바로 먹는다.
  // handle 만은 이 겹을 지나 기록된다: 갈아 끼운 handle 이 부른 명령도 h.handled() 에 남는다.
  const recorded = new Proxy(ctx, {
    get(target, key, receiver) {
      if (key === 'handle')
        return (cmd: string, args: Record<string, unknown>) => {
          cmds.push(cmd)
          return target.handle(cmd, args)
        }
      return Reflect.get(target, key, receiver)
    }
  })
  const loop: DispatchLoop = createDispatchLoop(recorded)

  const h = {
    clock: NOW_MS,
    ctx,
    loop,
    real,
    startWorker,
    typed,
    forked,
    templateRunId: TEMPLATE_ID,
    state: () => state,
    handled: () => [...cmds],
    /** 떠 있는 run() 이 없을 때까지 — 마지막 handle 이 풀린 뒤 두 macrotask. */
    settle: async (): Promise<void> => {
      for (;;) {
        await new Promise<void>((r) => setImmediate(r))
        await new Promise<void>((r) => setImmediate(r))
        if (inFlight === 0) return
      }
    }
  }
  return h
}

describe('createDispatchLoop', () => {
  it('fills the free slot through worker-start and nothing else', async () => {
    const h = rig()
    await h.loop.run()
    await h.settle()
    expect(h.startWorker).toHaveBeenCalledTimes(1)
    expect(h.handled()).toEqual(['worker-start'])
  })

  it('asks mayStart before every slot: a driver that changes mid-activation starts no further slot (§4.3)', async () => {
    const h = rig({ concurrency: 2 })
    let allowed = 2 // the entry check, then the first slot (B4)
    h.ctx.mayStart = () => allowed-- > 0
    await h.loop.run()
    await h.settle()
    expect(h.startWorker).toHaveBeenCalledTimes(1)
  })

  it('does nothing at all when mayStart is false on entry', async () => {
    const h = rig()
    h.ctx.mayStart = () => false
    await h.loop.run()
    await h.settle()
    expect(h.handled()).toEqual([])
  })

  // Review Focus 1, R15.
  it('a retiring Host’s refusal stops the activation and gates nothing', async () => {
    const h = rig({ concurrency: 2 })
    h.ctx.handle = async (cmd) =>
      cmd === 'worker-start'
        ? { status: 409, body: { error: 'the Host is retiring', retry: 'the same command' } }
        : { status: 200, body: {} }
    await h.loop.run()
    await h.settle()
    expect(h.handled()).toEqual(['worker-start']) // not a second slot, and no gate-create
  })

  // R15 through the commit path: the refused start really opened a Dispatch and rolled it back, and
  // both commits re-ran the loop (scheduleAgain). The activation still stops — a `break` out of the
  // slot loop alone would let the next pass ask the leaving Host once more for the other Task.
  it('a retiring Host’s refusal stops the activation even when the refused start committed and rolled back', async () => {
    const h = rig({ concurrency: 2, startFailsFor: 'all' })
    h.ctx.handle = async (cmd, args) => {
      const reply = await h.real(cmd, args)
      return cmd === 'worker-start'
        ? { status: 409, body: { error: 'the Host is retiring', retry: 'the same command' } }
        : reply
    }
    await h.loop.run()
    await h.settle()
    expect(h.startWorker).toHaveBeenCalledTimes(1)
    expect(h.handled()).toEqual(['worker-start'])
    expect(h.state().tasks.filter((t) => t.status === 'blocked')).toEqual([])
  })

  it('any other failed start gates that one Task and goes on with the next slot', async () => {
    const h = rig({ concurrency: 2, startFailsFor: 0 })
    await h.loop.run()
    await h.settle()
    expect(h.state().tasks.filter((t) => t.status === 'blocked')).toHaveLength(1)
    expect(h.startWorker).toHaveBeenCalledTimes(2)
  })

  // B4: concurrency 1, both Tasks fail and their Gates are refused. The rollbacks commit, the commit
  // re-runs the loop (scheduleAgain), and the attempted set is what keeps each Task to one try.
  //
  // **One start, not two** (the brief said 2). slotsToFill cuts to the Run's room (1) *before* the
  // loop filters by `attempted`, so once tsk_1 is back at ready with its Gate refused it holds the only
  // slot, the filter leaves nothing, and tsk_2 waits for the next state change. That is the moved code
  // unchanged (ipc.ts did the same); what the test pins is that the pass ends instead of spinning —
  // without `attempted` it restarts tsk_1 on every rollback commit, forever.
  it('never retries the same Task twice in one activation (the attempted set)', async () => {
    const h = rig({ startFailsFor: 'all', gateRefused: true })
    await h.loop.run()
    await h.settle()
    expect(h.startWorker).toHaveBeenCalledTimes(1) // once, not a spin
    expect(h.startWorker.mock.calls[0][0].taskId).toBe('tsk_1')
    expect(h.handled()).toEqual(['worker-start', 'gate-create'])
  })

  // R14.
  it('does nothing more with a Task once worker-start answered 2xx: a throwing log after it costs nothing', async () => {
    const h = rig()
    h.ctx.log = () => {
      throw new Error('log down')
    }
    await expect(h.loop.run()).resolves.toBeUndefined()
    await h.settle()
    expect(h.handled()).toEqual(['worker-start'])
  })

  // R14, the log itself: the question path logs after its reply, and a gate logs before its command. A
  // log that throws must reach neither the caller nor the Gate — `log` is a notice, not a step.
  it('a throwing log never breaks the loop: the reply and the gate still go out, and run() resolves', async () => {
    const h = rig({ question: true, noAccountTask: true })
    h.ctx.log = () => {
      throw new Error('log down')
    }
    await expect(h.loop.run()).resolves.toBeUndefined()
    await h.settle()
    expect(h.handled()).toEqual(['gate-create', 'reply'])
  })

  it('answers an unattended question with NO_COORDINATOR_ANSWER on a Run with no coordinator', async () => {
    const h = rig({ question: true })
    await h.loop.run()
    await h.settle()
    expect(h.handled()).toContain('reply')
  })

  it('gates a ready Task with no account (tasksMissingAccounts)', async () => {
    const h = rig({ noAccountTask: true })
    await h.loop.run()
    await h.settle()
    expect(h.handled()).toContain('gate-create')
  })

  it('fires a due schedule only after one tick has armed it (D2)', async () => {
    const h = rig({ schedule: { every: 'minute' } })
    await h.loop.fireTick()
    expect(h.handled()).not.toContain('run-spawn')
    h.clock += 61_000
    await h.loop.fireTick()
    expect(h.handled()).toContain('run-spawn')
    h.loop.forgetArming()
    h.clock += 61_000
    await h.loop.fireTick()
    expect(h.handled().filter((c) => c === 'run-spawn')).toHaveLength(1)
  })

  // N3: the app arms without firing in front of a driving Host, and the sidebar reads the arming.
  it('armOnly arms a template without firing it, and nextFireOf reads that arming', async () => {
    const h = rig({ schedule: { every: 'minute' } })
    expect(h.loop.nextFireOf(h.templateRunId)).toBeNull()
    h.loop.armOnly()
    const armed = h.loop.nextFireOf(h.templateRunId)
    expect(typeof armed).toBe('number')
    h.clock += 61_000
    h.loop.armOnly()
    expect(h.handled()).not.toContain('run-spawn')
    expect(h.loop.nextFireOf(h.templateRunId)).toBeGreaterThan(armed!)
  })

  it('nudges an idle coordinator with unread upward mail, and never a busy one', async () => {
    const h = rig({ coordinatorMail: true })
    h.ctx.sessionBusy = () => true
    await h.loop.nudge()
    expect(h.typed).toEqual([])
    h.ctx.sessionBusy = () => false
    await h.loop.nudge()
    expect(h.typed[0]).toMatch(/unread message/)
    expect(h.typed[1]).toBe('\r')
  })

  it('forks the Run worktree lazily and records it before the first worker', async () => {
    const h = rig({ runWithoutWorktree: true })
    await h.loop.run()
    await h.settle()
    expect(h.forked).toHaveLength(1)
    expect(h.handled().slice(0, 2)).toEqual(['run-worktree-set', 'worker-start'])
  })
})
