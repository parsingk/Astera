import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OrchRollTap, EXIT_DEFER_MS } from './rollTap'
import type { OrchServerDeps } from './server'
import {
  createRun,
  createTask,
  openDispatch,
  emptyState,
  type OrchState
} from '../../core/orchestration/state'

const NOW = '2026-08-25T00:00:00.000Z'

const unwrap = <T>(r: { ok: boolean } & Record<string, unknown>): { state: OrchState; value: T } => {
  if (!r.ok) throw new Error(`expected ok, got ${String(r.error)}`)
  return { state: r.state as OrchState, value: r.value as T }
}

/** run + task + 열린 Dispatch(sessionId 'sess1', accountId 'acc1') */
const seed = (): { s: OrchState; taskId: string; dispatchId: string } => {
  const run = unwrap<{ id: string }>(
    createRun(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW) as never
  )
  const t = unwrap<{ id: string }>(
    createTask(run.state, { runId: run.value.id, title: 't', spec: 'do it', deps: [] }, NOW) as never
  )
  const d = unwrap<{ id: string }>(
    openDispatch(
      t.state,
      {
        taskId: t.value.id,
        provider: 'claude',
        accountId: 'acc1',
        sessionId: 'sess1',
        cwd: 'D:/p',
        specPath: 'D:/p/orch/specs/x.md'
      },
      NOW
    ) as never
  )
  return { s: d.state, taskId: t.value.id, dispatchId: d.value.id }
}

const makeDeps = (initial: OrchState): OrchServerDeps & { state: () => OrchState } => {
  const box = { state: initial }
  return {
    state: () => box.state,
    getState: () => box.state,
    setState: async (next: OrchState) => {
      box.state = next
    },
    startWorker: async () => ({ sessionId: 'x', cwd: 'D:/p', specPath: 'D:/p/s.md' }),
    releaseWorker: async () => {},
    listAccounts: () => [{ id: 'acc1', label: '계정1', provider: 'claude' }],
    readWorker: async () => '',
    enabled: () => true,
    now: () => NOW
  } as OrchServerDeps & { state: () => OrchState }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('OrchRollTap', () => {
  it('exit 는 곧바로 처리하지 않는다 — EXIT_DEFER_MS 전에는 Dispatch 가 열린 채다', async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    new OrchRollTap(deps).onExit({ sessionId: 'sess1', exitCode: 1 })
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS - 1)
    expect(deps.state().dispatches.find((d) => d.id === dispatchId)?.endedAt).toBeUndefined()
  })

  it('롤이 오지 않으면 EXIT_DEFER_MS 뒤에 Dispatch 를 닫는다', async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    new OrchRollTap(deps).onExit({ sessionId: 'sess1', exitCode: 1 })
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
    const d = deps.state().dispatches.find((x) => x.id === dispatchId)
    expect(d?.endedAt).toBeDefined()
    expect(d?.workerState).toBe('failed')
  })

  it('창 안에 롤이 오면 Dispatch 를 닫지 않고 새 세션으로 옮긴다', async () => {
    const { s, dispatchId, taskId } = seed()
    const deps = makeDeps(s)
    const tap = new OrchRollTap(deps)
    tap.onExit({ sessionId: 'sess1', exitCode: 1 })
    await tap.onRolled('sess1', { id: 'sess2', accountId: 'acc2' })
    // 창을 넉넉히 넘겨도 닫히지 않아야 한다 — 취소됐기 때문이다
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS * 2)
    const d = deps.state().dispatches.find((x) => x.id === dispatchId)
    expect(d?.endedAt).toBeUndefined()
    expect(d?.sessionId).toBe('sess2')
    expect(d?.accountId).toBe('acc2')
    // 실패로 세지 않는다
    expect(deps.state().tasks.find((t) => t.id === taskId)?.consecutiveFailures).toBe(0)
  })

  it('exit 가 롤보다 늦게 도착해도 닫지 않는다 — 키가 이미 옮겨졌기 때문이다', async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const tap = new OrchRollTap(deps)
    await tap.onRolled('sess1', { id: 'sess2', accountId: 'acc2' })
    tap.onExit({ sessionId: 'sess1', exitCode: 1 }) // 죽은 옛 id 로 도착
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
    expect(deps.state().dispatches.find((x) => x.id === dispatchId)?.endedAt).toBeUndefined()
  })

  it('워커가 아닌 세션의 롤은 아무 상태도 바꾸지 않는다', async () => {
    const { s } = seed()
    const deps = makeDeps(s)
    await new OrchRollTap(deps).onRolled('other-session', { id: 'sess9', accountId: 'acc2' })
    expect(deps.state()).toBe(s)
  })

  it('같은 세션의 두 번째 exit 는 무시한다', async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const tap = new OrchRollTap(deps)
    tap.onExit({ sessionId: 'sess1', exitCode: 1 })
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS / 2)
    tap.onExit({ sessionId: 'sess1', exitCode: 137 }) // 두 번째 — 창을 다시 늘리면 안 된다
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS / 2)
    expect(deps.state().dispatches.find((x) => x.id === dispatchId)?.endedAt).toBeDefined()
  })

  it('dispose 는 미뤄 둔 exit 를 버린다', async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const tap = new OrchRollTap(deps)
    tap.onExit({ sessionId: 'sess1', exitCode: 1 })
    tap.dispose()
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS * 2)
    expect(deps.state().dispatches.find((x) => x.id === dispatchId)?.endedAt).toBeUndefined()
  })
})
