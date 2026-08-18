import { describe, it, expect, vi } from 'vitest'
import { TaskValidator, type ValidatorRunner } from './validator'

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
})
