import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OrchRollTap, EXIT_DEFER_MS } from './rollTap'
import type { OrchServerDeps } from './server'
import type { RollStateEvent } from '../../core/types'
import type { git } from '../../core/worktrees/git'
import { buildCheckpoint } from '../../core/orchestration/checkpoint'
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

// fix round 2 — 이 describe 가 막는 사고: 스냅샷을 롤 상태 게시마다 남기면 기준점이 정지 시점에서
// 재개 직전으로 밀리고, 그러면 브리핑이 "네가 멈춘 뒤로 워크트리는 바뀌지 않았다" 를 **확인하지
// 않은 채** 사실로 단정한다. 한 번의 정지에 한 번만 남아야 한다.

/** 그 순간의 HEAD 를 돌려주는 git 이중체. 값을 테스트가 정하므로 실제 저장소가 필요 없다 —
 *  gitSummary.test.ts 의 fakeGit 과 같은 관례다(호출 목록도 함께 남긴다). */
function fakeGit(heads: string[]): { git: typeof git; calls: number } {
  const box = { calls: 0 }
  const fn = (async () => {
    const stdout = heads[Math.min(box.calls, heads.length - 1)]
    box.calls++
    return { ok: true, stdout, stderr: '' }
  }) as unknown as typeof git
  return {
    git: fn,
    get calls() {
      return box.calls
    }
  }
}

const rollState = (e: Partial<RollStateEvent> & { sessionId: string }): RollStateEvent => ({
  state: 'waiting',
  ...e
})

const snapshotOf = (deps: { state: () => OrchState }, dispatchId: string) =>
  deps.state().dispatches.find((d) => d.id === dispatchId)?.stopSnapshot

describe('OrchRollTap 정지 스냅샷', () => {
  it("'waiting' 은 HEAD·정지 사유·리셋 시각을 남긴다", async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const g = fakeGit(['head-at-limit'])
    new OrchRollTap(deps, { git: g.git }).onRollState(
      rollState({ sessionId: 'sess1', state: 'waiting', nextRetryAt: '2026-08-25T03:00:00.000Z' })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshotOf(deps, dispatchId)).toEqual({
      headCommit: 'head-at-limit',
      reason: 'waiting',
      resetsAt: '2026-08-25T03:00:00.000Z'
    })
  })

  it("같은 정지의 kill 앞 'switching' 은 앞선 'waiting' 을 덮어쓰지 않는다", async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    // 두 번째 호출이 있었다면 HEAD 는 'head-now' 가 됐을 것이다 — 그 값이 나오면 덮어썼다는 뜻이다
    const g = fakeGit(['head-at-limit', 'head-now'])
    const tap = new OrchRollTap(deps, { git: g.git })
    tap.onRollState(
      rollState({ sessionId: 'sess1', state: 'waiting', nextRetryAt: '2026-08-25T03:00:00.000Z' })
    )
    await vi.advanceTimersByTimeAsync(0)
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'switching', accountLabel: 'B' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshotOf(deps, dispatchId)).toEqual({
      headCommit: 'head-at-limit',
      reason: 'waiting',
      resetsAt: '2026-08-25T03:00:00.000Z'
    })
    expect(g.calls).toBe(1) // git 을 두 번 읽지도 않는다
  })

  it("respawn 뒤의 reattach 'switching' 은 스냅샷을 남기지 않는다", async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const g = fakeGit(['head-now'])
    new OrchRollTap(deps, { git: g.git }).onRollState(
      rollState({ sessionId: 'sess1', state: 'switching', accountLabel: 'B', reattach: true })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshotOf(deps, dispatchId)).toBeUndefined()
    expect(g.calls).toBe(0)
  })

  it('롤 뒤 새 세션 id 로 오는 게시도 같은 에피소드로 본다', async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const g = fakeGit(['head-at-limit', 'head-now'])
    const tap = new OrchRollTap(deps, { git: g.git })
    // 계정을 바꾸는 롤의 실제 순서: switching(옛 id) → rolled → switching(reattach, 새 id) → none
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'switching', accountLabel: 'B' }))
    await vi.advanceTimersByTimeAsync(0)
    await tap.onRolled('sess1', { id: 'sess2', accountId: 'acc2' })
    tap.onRollState(
      rollState({ sessionId: 'sess2', state: 'switching', accountLabel: 'B', reattach: true })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshotOf(deps, dispatchId)).toEqual({ headCommit: 'head-at-limit', reason: 'switching' })
    expect(g.calls).toBe(1)
  })

  it("에피소드가 'none' 으로 끝난 뒤의 다음 정지는 새로 남긴다", async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const g = fakeGit(['first-stop', 'second-stop'])
    const tap = new OrchRollTap(deps, { git: g.git })
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'waiting' }))
    await vi.advanceTimersByTimeAsync(0)
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'none' })) // 재개가 실제로 이뤄졌다
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'waiting' })) // 다음 한도
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshotOf(deps, dispatchId)?.headCommit).toBe('second-stop')
    expect(g.calls).toBe(2)
  })

  it('워커가 아닌 세션의 정지는 상태를 바꾸지 않는다', async () => {
    const { s } = seed()
    const deps = makeDeps(s)
    const g = fakeGit(['x'])
    new OrchRollTap(deps, { git: g.git }).onRollState(
      rollState({ sessionId: 'plain-tab-session', state: 'waiting' })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.state()).toBe(s)
    expect(g.calls).toBe(0)
  })

  it('기록한 리셋 시각이 Checkpoint 까지 도달한다', async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const g = fakeGit(['head-at-limit'])
    new OrchRollTap(deps, { git: g.git }).onRollState(
      rollState({ sessionId: 'sess1', state: 'waiting', nextRetryAt: '2026-08-25T03:00:00.000Z' })
    )
    await vi.advanceTimersByTimeAsync(0)
    const c = buildCheckpoint(deps.state(), { dispatchId, git: null, now: NOW })
    expect(c?.stop).toEqual({ reason: 'waiting', resetsAt: '2026-08-25T03:00:00.000Z' })
  })

  it('워크트리가 움직였는지를 정지 시점 HEAD 로 판정한다 — respawn 시점이 아니라', async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const g = fakeGit(['head-at-limit', 'head-at-respawn'])
    const tap = new OrchRollTap(deps, { git: g.git })
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'waiting' }))
    await vi.advanceTimersByTimeAsync(0)
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'switching', accountLabel: 'B' }))
    await vi.advanceTimersByTimeAsync(0)
    // 재개 직전에 읽은 HEAD 는 respawn 시점의 것과 같다 — 정지 시점 값이 살아 있어야만 "움직였다"가 나온다
    const c = buildCheckpoint(deps.state(), {
      dispatchId,
      git: { branch: 'main', head: 'head-at-respawn', changed: [], diffstat: null },
      now: NOW
    })
    expect(c?.worktreeMoved).toBe(true)
  })
})
