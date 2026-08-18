import { describe, it, expect, vi } from 'vitest'
import { TaskValidator, ValidatorBusyError, type ValidatorRunner } from './validator'
import { absPath } from '../../core/testPaths'

const settledCalls = (): {
  onSettled: (a: { taskId: string; exitCode: number; output: string }) => Promise<void>
  calls: { taskId: string; exitCode: number; output: string }[]
} => {
  const calls: { taskId: string; exitCode: number; output: string }[] = []
  return { onSettled: async (a) => void calls.push(a), calls }
}

/** 시작 요청을 기록만 하는 러너. 종료는 테스트가 onRunExit 로 직접 만든다 */
const fakeRunner = (): ValidatorRunner & { started: { cwd: string; taskId: string }[] } => {
  const started: { cwd: string; taskId: string }[] = []
  return {
    started,
    start: async (a) => void started.push(a),
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
    expect(runner.started[0]).toEqual({ cwd: 'D:/w1', taskId: 'tsk_1' })
  })

  it('종료 코드를 onSettled 로 넘긴다', async () => {
    const runner = fakeRunner()
    const { onSettled, calls } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(runner.started).toHaveLength(1))
    v.onRunExit({ cwd: 'D:/w1', exitCode: 0 })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ taskId: 'tsk_1', exitCode: 0, output: '출력' })
  })

  // 같은 cwd 의 두 검증은 직렬화된다 — RunManager 가 그 키로 하나만 돌리기 때문이다
  it('같은 cwd 의 두 번째 검증은 첫 번째가 끝난 뒤에 시작한다', async () => {
    const runner = fakeRunner()
    const { onSettled } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    v.enqueue({ taskId: 'tsk_2', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(runner.started).toHaveLength(1))
    v.onRunExit({ cwd: 'D:/w1', exitCode: 0 })
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
      },
      output: () => ''
    }
    const v = new TaskValidator({ runner, onSettled: async () => {}, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    v.enqueue({ taskId: 'tsk_2', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(started).toEqual(['tsk_2']))
  })

  // 검증이 아닌 실행(사용자가 누른 것)의 종료가 큐를 흔들면 안 된다
  it('모르는 cwd 의 종료는 무시한다', async () => {
    const runner = fakeRunner()
    const { onSettled, calls } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    v.onRunExit({ cwd: 'D:/other', exitCode: 0 })
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
    v.onRunExit({ cwd: 'D:/w1', exitCode: 0 })
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

  // 자리가 사용 중인 것(ValidatorBusyError)은 지나가는 문제다 — NO_CONFIG 같은 진짜 실패와 달리
  // 사람에게 묻지 않고, 다음 항목으로 큐를 넘기지도 않는다.
  it('자리가 사용 중이면 onCannotRun 을 부르지 않고 큐를 넘기지도 않는다', async () => {
    const attempts: string[] = []
    const cannotRun: string[] = []
    const runner: ValidatorRunner = {
      start: async (a) => {
        attempts.push(a.taskId)
        throw new ValidatorBusyError(a.cwd)
      },
      output: () => ''
    }
    const v = new TaskValidator({
      runner,
      onSettled: async () => {},
      onCannotRun: async (a) => void cannotRun.push(a.taskId)
    })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    v.enqueue({ taskId: 'tsk_2', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(cannotRun).toHaveLength(0)
    // tsk_2 는 아직 시도조차 되지 않았다 — tsk_1 이 큐 맨 앞에 그대로 남아 있다
    expect(attempts).toEqual(['tsk_1'])
  })

  // 자리를 비운 실행(사용자가 손으로 시작한 Run)이 끝나면, 기다리던 헤드가 다시 시작을 시도하고
  // 이번에는 성공한다(started 가 true 로 바뀐다). 그 다음에 오는 종료는 이제 헤드 자신의 것이므로
  // 재시도가 아니라 정산으로 이어져야 한다 — 이 왕복 전체가 이번 교정이 기대는 메커니즘이다.
  it('자리가 사용 중이라 기다리던 항목은, 그 자리를 비운 실행이 끝나면 시작하고, 그 다음 종료로 정산된다', async () => {
    let busy = true
    const attempts: string[] = []
    const runner: ValidatorRunner = {
      start: async (a) => {
        attempts.push(a.taskId)
        if (busy) {
          busy = false
          throw new ValidatorBusyError(a.cwd)
        }
      },
      output: () => '출력'
    }
    const { onSettled, calls } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(attempts).toEqual(['tsk_1']))
    v.onRunExit({ cwd: 'D:/w1', exitCode: 0 }) // 자리를 비운 실행의 종료 — tsk_1 이 낸 것이 아니다
    await vi.waitFor(() => expect(attempts).toEqual(['tsk_1', 'tsk_1'])) // 다음 항목이 아니라 같은 헤드를 재시도한다
    expect(calls).toHaveLength(0) // 재시도일 뿐이다 — 아직 정산되지 않았다
    v.onRunExit({ cwd: 'D:/w1', exitCode: 0 }) // 이번에는 tsk_1 자신의 종료다 — started 가 true 라서 정산된다
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ taskId: 'tsk_1', exitCode: 0, output: '출력' })
  })

  // startHead 는 onRunExit 의 재시도로 재진입할 수 있다 — 겹쳐 들어온 두 번째 종료가 runner.start 를
  // 또 부르면, 첫 시도가 아직 진행 중인데도 같은 사용자 명령이 두 번 시작된다. 재진입은 조용히
  // 아무 일도 하지 않아야 하고, 첫 시도가 끝난 뒤에는 다시 정상적으로 시작할 수 있어야 한다.
  it('시작이 진행 중일 때 겹쳐 들어온 종료는 재진입해서 두 번째 시작을 만들지 않는다', async () => {
    const attempts: string[] = []
    let resolveFirst: (() => void) | undefined
    const runner: ValidatorRunner = {
      start: async (a) => {
        attempts.push(a.taskId)
        if (attempts.length === 1) {
          await new Promise<void>((r) => (resolveFirst = r)) // 첫 시도를 제어 가능한 시점에 묶어 둔다
          throw new ValidatorBusyError(a.cwd)
        }
      },
      output: () => '출력'
    }
    const v = new TaskValidator({ runner, onSettled: async () => {}, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(attempts).toHaveLength(1)) // 첫 시도가 걸려 있다

    // 첫 시도가 끝나기 전에 종료가 겹쳐 들어온다 — 재진입을 시도하지만 아무 일도 해서는 안 된다
    v.onRunExit({ cwd: 'D:/w1', exitCode: 0 })
    v.onRunExit({ cwd: 'D:/w1', exitCode: 0 })
    await new Promise((r) => setTimeout(r, 10))
    expect(attempts).toHaveLength(1) // 겹친 재진입이 두 번째 시도를 만들지 않았다

    resolveFirst?.() // 첫 시도가 (여전히 사용 중이라는) 실패로 끝난다
    await new Promise((r) => setTimeout(r, 10))
    expect(attempts).toHaveLength(1) // 시도가 끝났을 뿐, 저절로 다시 시도하지는 않는다

    v.onRunExit({ cwd: 'D:/w1', exitCode: 0 }) // 이 종료는 첫 시도가 끝난 뒤에 온다 — 재시도로 이어진다
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
  })

  // ValidatorBusyError 가 표준 경로지만, ipc.ts 의 사전 검사가 놓친 경우 RunManager 가 곧바로
  // 'ALREADY_RUNNING: ...' 로 시작하는 평범한 Error 를 던질 수 있다 — 그 모양도 같은 지나가는
  // 문제로 다뤄야 사전 검사와 실제 판정이 어긋나는 날에도 사람에게 잘못 묻지 않는다.
  it('ValidatorBusyError 가 아니어도 ALREADY_RUNNING: 로 시작하는 메시지는 사용 중으로 다룬다', async () => {
    const attempts: string[] = []
    const cannotRun: string[] = []
    const runner: ValidatorRunner = {
      start: async (a) => {
        attempts.push(a.taskId)
        throw new Error(`ALREADY_RUNNING: ${a.cwd}`) // RunManager 가 직접 던지는 것과 같은 모양
      },
      output: () => ''
    }
    const v = new TaskValidator({
      runner,
      onSettled: async () => {},
      onCannotRun: async (a) => void cannotRun.push(a.taskId)
    })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(cannotRun).toHaveLength(0) // Gate 로 가지 않는다 — 지나가는 문제로 다뤄진다
  })

  // 헤드가 아직 시작하지 못한 채로 온 종료는 다른 실행의 것이다 — 그 코드로 Task 를 정산하면 안 된다
  it('헤드가 시작하지 못한 채로 온 종료는 아무것도 정산하지 않는다', async () => {
    const attempts: string[] = []
    const runner: ValidatorRunner = {
      start: async (a) => {
        attempts.push(a.taskId)
        throw new ValidatorBusyError(a.cwd)
      },
      output: () => ''
    }
    const { onSettled, calls } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    v.onRunExit({ cwd: 'D:/w1', exitCode: 0 })
    await vi.waitFor(() => expect(attempts).toHaveLength(2)) // 재시도는 일어났지만
    expect(calls).toHaveLength(0) // 정산되지는 않았다
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
    v.onRunExit({ cwd: CWD, exitCode: 0 })
    await vi.waitFor(() => expect(settled).toEqual(['tsk_1']))
    v.onRunExit({ cwd: CWD, exitCode: 0 }) // 겹쳐 들어온 두 번째 종료
    release?.()
    await vi.waitFor(() => expect(runner.started).toHaveLength(2))
    expect(runner.started[1].taskId).toBe('tsk_2') // tsk_2 가 건너뛰어지지 않았다
    expect(settled).toEqual(['tsk_1']) // 두 번 정산하지도 않았다
  })

  // 고장난 head 의 이중 시작. startHead 에서 starting 은 finally 로 풀리는데 advance 는
  // await onCannotRun 뒤에 온다 — 그 창에 도착한 종료가 head.started === false 를 보고
  // startHead 를 다시 부르면 같은 고장난 head 로 runner.start 가 또 불리고, 두 번째
  // onCannotRun 과 두 번째 advance 가 이어져 같은 항목이 유실된다.
  it('고장난 head 가 두 번 시작돼도 다음 항목을 건너뛰지 않는다', async () => {
    const started: string[] = []
    let release: (() => void) | undefined
    const runner: ValidatorRunner = {
      start: async (a) => {
        started.push(a.taskId)
        if (a.taskId === 'tsk_1') throw new Error('NO_CONFIG')
      },
      output: () => ''
    }
    const v = new TaskValidator({
      runner,
      onSettled: async () => {},
      // Gate 커밋을 붙잡아 두어 starting 이 풀린 뒤 advance 전인 창을 만든다
      onCannotRun: async () => {
        await new Promise<void>((r) => (release = r))
      }
    })
    v.enqueue({ taskId: 'tsk_1', cwd: CWD })
    v.enqueue({ taskId: 'tsk_2', cwd: CWD })
    await vi.waitFor(() => expect(release).toBeTruthy()) // onCannotRun 안에 걸려 있다
    v.onRunExit({ cwd: CWD, exitCode: 0 }) // 그 창에 도착한 종료 — 고장난 head 를 다시 시작한다
    await vi.waitFor(() => expect(started).toEqual(['tsk_1', 'tsk_1']))
    release?.()
    await vi.waitFor(() => expect(started).toEqual(['tsk_1', 'tsk_1', 'tsk_2']))
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
    v.markStopped(CWD)
    v.onRunExit({ cwd: CWD, exitCode: 1 })
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
    v.markStopped(CWD)
    v.onRunExit({ cwd: CWD, exitCode: 1 })
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
    v.markStopped(CWD)
    v.onRunExit({ cwd: CWD, exitCode: 1 })
    await vi.waitFor(() => expect(runner.started).toHaveLength(2))
    v.onRunExit({ cwd: CWD, exitCode: 0 })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].taskId).toBe('tsk_2')
  })

  // 아직 시작하지 못한 head 에는 표시하지 않는다 — 그 cwd 에서 도는 것은 검증이 아니라 그 자리를
  // 차지하고 있는 다른 실행이므로, 그 정지는 이 검증과 아무 상관이 없다
  it('시작하지 못한 head 에는 표시하지 않는다', async () => {
    const attempts: string[] = []
    const runner: ValidatorRunner = {
      start: async (a) => {
        attempts.push(a.taskId)
        if (attempts.length === 1) throw new ValidatorBusyError(a.cwd)
      },
      output: () => '출력'
    }
    const { onSettled, calls } = settledCalls()
    const reasons: string[] = []
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async (a) => void reasons.push(a.reason) })
    v.enqueue({ taskId: 'tsk_1', cwd: CWD })
    await vi.waitFor(() => expect(attempts).toHaveLength(1))
    v.markStopped(CWD) // 자리를 차지하고 있던 사용자 실행의 정지다
    v.onRunExit({ cwd: CWD, exitCode: 1 }) // 그 실행의 종료 — head 를 다시 시작한다
    await vi.waitFor(() => expect(attempts).toHaveLength(2))
    v.onRunExit({ cwd: CWD, exitCode: 0 }) // 이번에는 검증 자신의 종료다
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(reasons).toHaveLength(0) // Gate 로 가지 않았다
  })

  // 큐가 비어 있는 cwd 의 정지는 검증이 아닌 실행의 정지다
  it('큐가 비어 있으면 아무 일도 하지 않는다', () => {
    const runner = fakeRunner()
    const { onSettled } = settledCalls()
    const v = new TaskValidator({ runner, onSettled, onCannotRun: async () => {} })
    expect(() => v.markStopped(absPath('other'))).not.toThrow()
  })
})
