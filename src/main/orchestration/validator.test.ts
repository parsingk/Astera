import { describe, it, expect, vi } from 'vitest'
import { TaskValidator, type ValidatorRunner } from './validator'
import { absPath } from '../../core/testPaths'

const settledCalls = (): {
  onSettled: (a: { taskId: string; exitCode: number; output: string }) => Promise<void>
  calls: { taskId: string; exitCode: number; output: string }[]
} => {
  const calls: { taskId: string; exitCode: number; output: string }[] = []
  return { onSettled: async (a) => void calls.push(a), calls }
}

/** Records start requests and hands each a runId. Exits are made by the test through onRunExit. */
const fakeRunner = (): ValidatorRunner & { started: { cwd: string; taskId: string; runId: string }[] } => {
  const started: { cwd: string; taskId: string; runId: string }[] = []
  return {
    started,
    start: async (a) => {
      const runId = `run_${started.length + 1}`
      started.push({ ...a, runId })
      return { runId }
    },
    output: () => '출력'
  }
}

describe('TaskValidator', () => {
  it('큐에 넣으면 러너를 시작한다', async () => {
    const runner = fakeRunner()
    const { onSettled } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(runner.started).toHaveLength(1))
    expect(runner.started[0]).toEqual({ cwd: 'D:/w1', taskId: 'tsk_1', runId: 'run_1' })
  })

  it('종료 코드를 onSettled 로 넘긴다', async () => {
    const runner = fakeRunner()
    const { onSettled, calls } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(runner.started).toHaveLength(1))
    v.onRunExit({ runId: runner.started[0].runId, exitCode: 0 })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ taskId: 'tsk_1', exitCode: 0, output: '출력' })
  })

  // 검증 출력은 PTY 원문이라 이스케이프가 섞인다. 이 값은 Task.result 와 status 메시지 본문으로
  // 들어가고 코디네이터 LLM 이 그것을 읽어 재시도를 판단하므로, 화면이 아니라 여기서 지운다
  it('출력의 ANSI 이스케이프를 지운다', async () => {
    const runner: ValidatorRunner = {
      start: async () => ({ runId: 'run_x' }),
      output: () => '\u001b[32mPASS\u001b[0m\r\n\u001b]0;title\u0007done\r\n'
    }
    const { onSettled, calls } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(calls).toHaveLength(0))
    v.onRunExit({ runId: 'run_x', exitCode: 0 })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].output).toBe('PASS\r\ndone\r\n')
  })

  // Same-cwd validations are serialised as a policy — two in one tree share a build directory and
  // ports — not because a seat has to free up
  it('같은 cwd 의 두 번째 검증은 첫 번째가 끝난 뒤에 시작한다', async () => {
    const runner = fakeRunner()
    const { onSettled } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    v.enqueue({ taskId: 'tsk_2', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(runner.started).toHaveLength(1))
    v.onRunExit({ runId: runner.started[0].runId, exitCode: 0 })
    await vi.waitFor(() => expect(runner.started).toHaveLength(2))
    expect(runner.started[1].taskId).toBe('tsk_2')
  })

  // 다른 cwd 는 서로 막지 않는다 — 워크트리 워커들이 동시에 검증될 수 있어야 한다
  it('다른 cwd 의 검증은 동시에 시작한다', async () => {
    const runner = fakeRunner()
    const { onSettled } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    v.enqueue({ taskId: 'tsk_2', cwd: 'D:/w2' })
    await vi.waitFor(() => expect(runner.started).toHaveLength(2))
  })

  it('러너가 실패하면 onCannotRun 으로 이유를 넘긴다', async () => {
    const runner: ValidatorRunner = {
      start: async () => {
        throw new Error('NO_CONFIG: cfg1')
      },
      output: () => ''
    }
    const reasons: { taskId: string; reason: string }[] = []
    const v = new TaskValidator({
      runner,
      onSettled: async () => {},
      onCannotRun: async (a) => void reasons.push(a)
    })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(reasons).toHaveLength(1))
    expect(reasons[0].reason).toContain('NO_CONFIG')
  })

  // 시작에 실패해도 큐가 막히면 안 된다
  it('시작 실패 뒤에도 같은 cwd 의 다음 검증이 돈다', async () => {
    let first = true
    const started: string[] = []
    const runner: ValidatorRunner = {
      start: async (a) => {
        if (first) {
          first = false
          throw new Error('NO_CONFIG')
        }
        started.push(a.taskId)
        return { runId: 'run_2' }
      },
      output: () => ''
    }
    const v = new TaskValidator({ runner, onSettled: async () => {}, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    v.enqueue({ taskId: 'tsk_2', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(started).toEqual(['tsk_2']))
  })

  // The user's own runs end too, and now nothing about them is a signal — an exit that names no queue
  // head is ignored
  it('an exit for a run that is not a head is ignored', async () => {
    const runner = fakeRunner()
    const { onSettled, calls } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(runner.started).toHaveLength(1))
    v.onRunExit({ runId: 'somebody-elses', exitCode: 0 })
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toHaveLength(0)
  })

  // onSettled 는 실제 배선에서 상태를 커밋한다 — 실패할 수 있다. 그 실패가 advance 를 막으면
  // 그 cwd 의 다음 검증들이 영원히 돌지 않는다. 그래서 거부되어도 큐는 넘어가야 한다.
  it('onSettled 가 거부돼도 같은 cwd 의 다음 검증은 시작한다', async () => {
    const runner = fakeRunner()
    const v = new TaskValidator({
      runner,
      onSettled: async () => {
        throw new Error('commit failed')
      },
      onCannotRun: async () => {}
    })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    v.enqueue({ taskId: 'tsk_2', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(runner.started).toHaveLength(1))
    v.onRunExit({ runId: runner.started[0].runId, exitCode: 0 })
    await vi.waitFor(() => expect(runner.started).toHaveLength(2))
    expect(runner.started[1].taskId).toBe('tsk_2')
  })

  // onCannotRun 도 실제 배선에서 상태를 커밋한다 — 실패할 수 있다. startHead 의 catch 블록이
  // 이 거부에 걸려 advance 를 못 부르면 그 cwd 는 첫 실패 이후로 영원히 막힌다.
  it('onCannotRun 이 거부돼도 같은 cwd 의 다음 검증은 시작한다', async () => {
    let first = true
    const started: string[] = []
    const runner: ValidatorRunner = {
      start: async (a) => {
        if (first) {
          first = false
          throw new Error('NO_CONFIG')
        }
        started.push(a.taskId)
        return { runId: 'run_2' }
      },
      output: () => ''
    }
    const v = new TaskValidator({
      runner,
      onSettled: async () => {},
      onCannotRun: async () => {
        throw new Error('commit failed')
      }
    })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    v.enqueue({ taskId: 'tsk_2', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(started).toEqual(['tsk_2']))
  })

  // The queue no longer waits for the user's run to finish — that was RunManager's one-per-project
  // constraint, which is gone. A validation starts beside whatever is running.
  it('starts immediately even though the runner reports other runs alive', async () => {
    const runner = fakeRunner()
    const { onSettled } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(runner.started).toHaveLength(1))
    expect(runner.started[0].taskId).toBe('tsk_1')
  })
})

// ── 큐 유실 (advance 의 항등성 검사) ──────────────────────────────────────────
// 결과가 이 브랜치가 막으려는 바로 그 실패다: 시작되지 않은 채 큐에서 사라진 항목의 Task 는
// 종료가 오지 않아 영원히 validating 이고, recomputeReady 는 completed 만 승격시키므로 그 의존
// 서브트리 전체가 pending 에 멈춘다. 회복 수단은 앱 재시작뿐이다.
describe('TaskValidator — 큐 항목 유실 방지', () => {
  const CWD = absPath('w1')

  // 같은 head 의 종료가 겹쳐 들어오면 advance 가 두 번 돌아 아직 시작하지 않은 다음 항목이
  // 큐에서 사라진다
  it('같은 head 의 종료가 두 번 와도 다음 항목을 건너뛰지 않는다', async () => {
    const runner = fakeRunner()
    let release: (() => void) | undefined
    const settled: string[] = []
    const v = new TaskValidator({
      runner,
      // 정산을 붙잡아 두어 두 번째 종료가 같은 창에 들어오게 만든다
      onSettled: async (a) => {
        settled.push(a.taskId)
        await new Promise<void>((r) => (release = r))
      },
      onCannotRun: async () => {}
    })
    v.enqueue({ taskId: 'tsk_1', cwd: CWD })
    v.enqueue({ taskId: 'tsk_2', cwd: CWD })
    v.enqueue({ taskId: 'tsk_3', cwd: CWD })
    await vi.waitFor(() => expect(runner.started).toHaveLength(1))
    v.onRunExit({ runId: runner.started[0].runId, exitCode: 0 })
    await vi.waitFor(() => expect(settled).toEqual(['tsk_1']))
    v.onRunExit({ runId: runner.started[0].runId, exitCode: 0 }) // 겹쳐 들어온 두 번째 종료
    release?.()
    await vi.waitFor(() => expect(runner.started).toHaveLength(2))
    expect(runner.started[1].taskId).toBe('tsk_2') // tsk_2 가 건너뛰어지지 않았다
    expect(settled).toEqual(['tsk_1']) // 두 번 정산하지도 않았다
  })
})

// ── 사용자가 정지시킨 검증 ────────────────────────────────────────────────────
// 정지된 PTY 는 0 이 아닌 종료 코드를 낸다. 그것을 실패로 정산하면 남의 빌드를 치우려던 사용자가
// 오케스트레이션 Task 를 실패시키고, 세 번이면 회로가 영구히 끊긴다. --worktree current 가
// 기본값이므로 검증은 보통 사용자가 열어 둔 프로젝트 루트에서 돈다 — 흔한 경우다.
describe('TaskValidator — markStopped', () => {
  const CWD = absPath('w1')

  it('정지 표시가 선 head 의 종료는 onSettled 가 아니라 onCannotRun 으로 간다', async () => {
    const runner = fakeRunner()
    const { onSettled, calls } = settledCalls()
    const reasons: { taskId: string; reason: string }[] = []
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async (a) => void reasons.push(a) })
    v.enqueue({ taskId: 'tsk_1', cwd: CWD })
    await vi.waitFor(() => expect(runner.started).toHaveLength(1))
    v.markStopped(runner.started[0].runId)
    v.onRunExit({ runId: runner.started[0].runId, exitCode: 1 })
    await vi.waitFor(() => expect(reasons).toHaveLength(1))
    expect(reasons[0].taskId).toBe('tsk_1')
    expect(reasons[0].reason).toContain('정지')
    expect(calls).toHaveLength(0) // 실패로 정산되지 않았다 — consecutiveFailures 가 오르지 않는다
  })

  it('정지된 검증 뒤에도 같은 cwd 의 다음 검증은 시작한다', async () => {
    const runner = fakeRunner()
    const { onSettled } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: CWD })
    v.enqueue({ taskId: 'tsk_2', cwd: CWD })
    await vi.waitFor(() => expect(runner.started).toHaveLength(1))
    v.markStopped(runner.started[0].runId)
    v.onRunExit({ runId: runner.started[0].runId, exitCode: 1 })
    await vi.waitFor(() => expect(runner.started).toHaveLength(2))
    expect(runner.started[1].taskId).toBe('tsk_2')
  })

  // 표시는 한 번만 쓰인다 — 남아 있으면 다음 검증이 정상적으로 끝나도 Gate 가 된다
  it('표시는 소비 후 지워진다 — 다음 검증은 정상 정산된다', async () => {
    const runner = fakeRunner()
    const { onSettled, calls } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: CWD })
    v.enqueue({ taskId: 'tsk_2', cwd: CWD })
    await vi.waitFor(() => expect(runner.started).toHaveLength(1))
    v.markStopped(runner.started[0].runId)
    v.onRunExit({ runId: runner.started[0].runId, exitCode: 1 })
    await vi.waitFor(() => expect(runner.started).toHaveLength(2))
    v.onRunExit({ runId: runner.started[1].runId, exitCode: 0 })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].taskId).toBe('tsk_2')
  })

  // 큐가 비어 있는 cwd 의 정지는 검증이 아닌 실행의 정지다
  it('큐가 비어 있으면 아무 일도 하지 않는다', () => {
    const runner = fakeRunner()
    const { onSettled } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    expect(() => v.markStopped('run_none')).not.toThrow()
  })
})

// ── 더 이상 할 일이 아닌 항목 ────────────────────────────────────────────────
// 큐에서 기다리는 동안 Task 가 validating 을 떠날 수 있다 — task-update 로 사람이 손수 구해 낸
// 경우다. 그 검증은 실패가 아니라 없어진 할 일이므로 Gate 를 열어서는 안 된다:
// ready/failed -> blocked 는 전이표가 허용하므로, 열면 사람의 결정을 낡은 검증이 되돌린다.
describe('TaskValidator — 없어진 할 일', () => {
  const CWD = absPath('w1')

  it("러너가 'skip' 을 돌려주면 onCannotRun 도 정산도 없이 큐에서 빠진다", async () => {
    const attempts: string[] = []
    const runner: ValidatorRunner = {
      start: async (a) => {
        attempts.push(a.taskId)
        return 'skip'
      },
      output: () => '출력'
    }
    const { onSettled, calls } = settledCalls()
    const reasons: string[] = []
    const v = new TaskValidator({
      runner,
      onSettled,
      onCannotRun: async (a) => void reasons.push(a.reason)
    })
    v.enqueue({ taskId: 'tsk_1', cwd: CWD })
    await vi.waitFor(() => expect(attempts).toEqual(['tsk_1']))
    await new Promise((r) => setTimeout(r, 10))
    expect(reasons).toHaveLength(0) // Gate 가 열리지 않았다 — 사람의 결정을 되돌리지 않는다
    expect(calls).toHaveLength(0) // 실패로 정산되지도 않았다
    // 항목이 큐에서 빠졌다: 뒤늦게 온 종료가 그 항목을 되살려 정산하지 않는다 — 'skip' 은 runId 를
    // 남기지 않으므로 이 id 는 어떤 head 도 가리키지 않는다
    v.onRunExit({ runId: 'run_1', exitCode: 1 })
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toHaveLength(0)
    expect(attempts).toEqual(['tsk_1'])
  })

  // 큐는 계속 움직여야 한다. 건너뛴 항목에서 멈추면 그 cwd 의 나머지 검증이 영원히 돌지 않는다
  it('건너뛴 항목 뒤의 항목이 시작하고 정상으로 정산된다', async () => {
    const attempts: string[] = []
    const runner: ValidatorRunner = {
      start: async (a) => {
        attempts.push(a.taskId)
        if (a.taskId === 'tsk_1') return 'skip'
        return { runId: `run_${a.taskId}` }
      },
      output: () => '출력'
    }
    const { onSettled, calls } = settledCalls()
    const reasons: string[] = []
    const v = new TaskValidator({
      runner,
      onSettled,
      onCannotRun: async (a) => void reasons.push(a.reason)
    })
    v.enqueue({ taskId: 'tsk_1', cwd: CWD })
    v.enqueue({ taskId: 'tsk_2', cwd: CWD })
    v.enqueue({ taskId: 'tsk_3', cwd: CWD })
    await vi.waitFor(() => expect(attempts).toEqual(['tsk_1', 'tsk_2']))
    // tsk_2 는 실제로 시작했으므로 그 종료는 자기 것이다 — 항등성 검사가 건너뛴 항목을 이미
    // 지웠으니, 이 정산이 tsk_3 을 함께 밀어내지 않는지도 여기서 함께 고정된다
    v.onRunExit({ runId: 'run_tsk_2', exitCode: 0 })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].taskId).toBe('tsk_2')
    await vi.waitFor(() => expect(attempts).toEqual(['tsk_1', 'tsk_2', 'tsk_3']))
    expect(reasons).toHaveLength(0)
  })
})
