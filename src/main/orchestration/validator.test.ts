import { describe, it, expect, vi } from 'vitest'
import { TaskValidator, ValidatorBusyError, type ValidatorRunner } from './validator'

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

  // 자리를 비운 실행(사용자가 손으로 시작한 Run)이 끝나면, 기다리던 헤드가 다시 시작을 시도한다.
  // 타이머 없이 그 종료 이벤트 자체가 재시도 신호다.
  it('자리가 사용 중이라 기다리던 항목은, 그 자리를 비운 실행이 끝나면 시작한다', async () => {
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
    const v = new TaskValidator({ runner, onSettled: async () => {}, onCannotRun: async () => {} })
    v.enqueue({ taskId: 'tsk_1', cwd: 'D:/w1' })
    await vi.waitFor(() => expect(attempts).toEqual(['tsk_1']))
    v.onRunExit({ cwd: 'D:/w1', exitCode: 0 }) // 자리를 비운 실행의 종료 — tsk_1 이 낸 것이 아니다
    await vi.waitFor(() => expect(attempts).toEqual(['tsk_1', 'tsk_1'])) // 다음 항목이 아니라 같은 헤드를 재시도한다
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
