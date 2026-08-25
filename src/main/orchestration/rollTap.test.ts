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

/** run + 두 Task + 두 열린 Dispatch: dispatch1(sessionId 'sess1'), dispatch2(sessionId 'sess2').
 *  rekeyDispatch 의 "대상 세션 id 가 이미 다른 열린 Dispatch 의 것" 거절 경로를 만드는 데 쓴다. */
const seedTwoOpen = (): { s: OrchState; dispatchId: string } => {
  const run = unwrap<{ id: string }>(
    createRun(emptyState(), { objective: 'o', cwd: 'D:/p' }, NOW) as never
  )
  const t1 = unwrap<{ id: string }>(
    createTask(run.state, { runId: run.value.id, title: 't1', spec: 'do it', deps: [] }, NOW) as never
  )
  const d1 = unwrap<{ id: string }>(
    openDispatch(
      t1.state,
      {
        taskId: t1.value.id,
        provider: 'claude',
        accountId: 'acc1',
        sessionId: 'sess1',
        cwd: 'D:/p',
        specPath: 'D:/p/orch/specs/x.md'
      },
      NOW
    ) as never
  )
  const t2 = unwrap<{ id: string }>(
    createTask(d1.state, { runId: run.value.id, title: 't2', spec: 'do it too', deps: [] }, NOW) as never
  )
  const d2 = unwrap<unknown>(
    openDispatch(
      t2.state,
      {
        taskId: t2.value.id,
        provider: 'codex',
        accountId: 'acc1',
        sessionId: 'sess2',
        cwd: 'D:/p',
        specPath: 'D:/p/orch/specs/y.md'
      },
      NOW
    ) as never
  )
  return { s: d2.state, dispatchId: d1.value.id }
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

  it('rekey 뒤에도 새 세션의 exit 는 평범한 종료 경로로 Dispatch 를 닫는다', async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const tap = new OrchRollTap(deps)
    const rekeyed = await tap.onRolled('sess1', { id: 'sess2', accountId: 'acc2' })
    expect(rekeyed?.id).toBe(dispatchId)
    // 새 세션(sess2)이 나중에 정말로 죽는다 — rekey 가 이 평범한 종료 경로를 망가뜨리지 않아야 한다
    tap.onExit({ sessionId: 'sess2', exitCode: 1 })
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
    const d = deps.state().dispatches.find((x) => x.id === dispatchId)
    expect(d?.endedAt).toBeDefined()
    expect(d?.workerState).toBe('failed')
  })

  it('한 창 안에 두 번 롤이 와도 마지막 세션에서 열린 채로 남는다', async () => {
    const { s, dispatchId, taskId } = seed()
    const deps = makeDeps(s)
    const tap = new OrchRollTap(deps)
    tap.onExit({ sessionId: 'sess1', exitCode: 1 }) // 타이머 대기 중
    await tap.onRolled('sess1', { id: 'sess2', accountId: 'acc2' })
    await tap.onRolled('sess2', { id: 'sess3', accountId: 'acc3' })
    // 창을 넉넉히 넘겨도 어느 쪽으로도 닫히지 않아야 한다
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS * 2)
    const d = deps.state().dispatches.find((x) => x.id === dispatchId)
    expect(d?.sessionId).toBe('sess3')
    expect(d?.endedAt).toBeUndefined()
    // 실패로 세지 않는다 — 계정만 두 번 갈렸을 뿐이다
    expect(deps.state().tasks.find((t) => t.id === taskId)?.consecutiveFailures).toBe(0)
  })

  it('rekey 가 거절되면(대상 세션을 다른 열린 Dispatch 가 이미 쓰고 있다) 미뤄 둔 exit 가 무장된 채로 남는다', async () => {
    const { s, dispatchId } = seedTwoOpen()
    const deps = makeDeps(s)
    const tap = new OrchRollTap(deps)
    tap.onExit({ sessionId: 'sess1', exitCode: 1 })
    // sess2 는 이미 dispatch2 가 쓰고 있으므로 rekeyDispatch 가 거절한다
    const rekeyed = await tap.onRolled('sess1', { id: 'sess2', accountId: 'acc2' })
    expect(rekeyed).toBeNull()
    // 거절됐다고 곧바로 닫히지도 않는다 — 창이 아직 안 끝났다
    expect(deps.state().dispatches.find((x) => x.id === dispatchId)?.endedAt).toBeUndefined()
    // 창이 끝나면 미뤄 둔 exit 가 살아서 Dispatch 를 닫아 준다 — 거절이 유일한 닫는 길을 버리지 않았다
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
    const d = deps.state().dispatches.find((x) => x.id === dispatchId)
    expect(d?.endedAt).toBeDefined()
    expect(d?.workerState).toBe('failed')
  })

  it('oldSessionId 와 newSessionId 가 같아도(계정만 바뀌는 롤) 자기 자신과 충돌한다고 거절하지 않는다', async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const tap = new OrchRollTap(deps)
    const rekeyed = await tap.onRolled('sess1', { id: 'sess1', accountId: 'acc2' })
    expect(rekeyed).not.toBeNull()
    expect(rekeyed?.id).toBe(dispatchId)
    const d = deps.state().dispatches.find((x) => x.id === dispatchId)
    expect(d?.sessionId).toBe('sess1')
    expect(d?.accountId).toBe('acc2')
  })
})
