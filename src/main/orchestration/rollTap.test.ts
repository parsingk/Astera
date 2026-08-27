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

  // follow-up round — Fix B: 'stalled' 는 회복 시도가 실패했다는 판정이고 **뒤에 'none' 이 오지
  // 않는다**(게시하고 곧바로 return 한다). 그것을 끝으로 세지 않으면 표시가 영구히 남아 그 세션의
  // 다음 정지가 전부 건너뛰어지고, Checkpoint 는 몇 시간 전 기준점을 계속 재사용한다.
  it("'stalled' 로 끝난 에피소드 뒤의 다음 정지는 새로 남긴다", async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const g = fakeGit(['first-stop', 'second-stop'])
    const tap = new OrchRollTap(deps, { git: g.git })
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'waiting' }))
    await vi.advanceTimersByTimeAsync(0)
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'nudged' })) // 재개 프롬프트를 보낸다
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'stalled' })) // 듣지 않았다 — 'none' 은 오지 않는다
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

// task 2 — 재개의 두 경로: 계정을 유지하는 'nudged' 와 계정이 바뀌는 rekey. 둘 다 정지가 기록돼
// 있을 때만 이력의 마지막 항목을 닫는다(recordResume 자신의 no-op 규칙). 'nudged' 쪽은 추가로
// `stopped` 판별자가 필요하다 — 그 이벤트는 idle stall nudge·reset anchor 에서도 오는데, 그 둘은
// 이 세션에 정지를 남기지 않았기 때문이다.

const resumesOf = (deps: { state: () => OrchState }, dispatchId: string) =>
  deps.state().dispatches.find((d) => d.id === dispatchId)?.resumes

describe('OrchRollTap 재개 기록', () => {
  it("'nudged' 는 제자리 재개다 — 이력의 마지막 항목이 같은 계정으로 닫힌다", async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const g = fakeGit(['head-at-limit'])
    const tap = new OrchRollTap(deps, { git: g.git })
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'waiting' }))
    await vi.advanceTimersByTimeAsync(0)
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'nudged' }))
    await vi.advanceTimersByTimeAsync(0)
    const resumes = resumesOf(deps, dispatchId)
    expect(resumes).toHaveLength(1)
    expect(resumes?.[0].resumedAt).toBe(NOW)
    expect(resumes?.[0].toAccountId).toBe('acc1')
  })

  it('rekey 성공 뒤 새 계정으로 재개가 기록된다', async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const g = fakeGit(['head-at-limit'])
    const tap = new OrchRollTap(deps, { git: g.git })
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'waiting' }))
    await vi.advanceTimersByTimeAsync(0)
    const rekeyed = await tap.onRolled('sess1', { id: 'sess2', accountId: 'acc2' })
    expect(rekeyed?.id).toBe(dispatchId)
    const resumes = resumesOf(deps, dispatchId)
    expect(resumes).toHaveLength(1)
    expect(resumes?.[0].resumedAt).toBe(NOW)
    expect(resumes?.[0].toAccountId).toBe('acc2')
  })

  it("정지 기록이 없으면 'nudged' 는 아무것도 만들지 않는다", async () => {
    const { s } = seed()
    const deps = makeDeps(s)
    new OrchRollTap(deps).onRollState(rollState({ sessionId: 'sess1', state: 'nudged' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.state()).toBe(s)
  })

  // 이 테스트가 판별자(stopped)를 고정한다 — 'nudged' 를 stopped 검사 없이 무조건 재개로 기록하면
  // 이 테스트는 깨진다(레포에서 직접 확인함: 표식 검사를 지우고 이 파일을 돌리면 아래
  // resumedAt 이 정의돼 실패한다).
  it("'nudged' 가 정지 표식 없이 오면 이력의 열린 항목을 건드리지 않는다", async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const g = fakeGit(['head-at-limit'])
    const tap = new OrchRollTap(deps, { git: g.git })
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'waiting' })) // 정지 기록 + 표식
    await vi.advanceTimersByTimeAsync(0)
    // 회복이 듣지 않았다는 판정 — 표식만 지운다, 이력의 항목은 열린 채 남는다(recordStopSnapshot 의
    // "'stalled' 로 끝난 에피소드" 규칙과 같다)
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'stalled' }))
    // 표식이 없는 'nudged' — idle stall nudge 나 reset anchor 처럼 이 정지와 무관한 것일 수 있다
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'nudged' }))
    await vi.advanceTimersByTimeAsync(0)
    const resumes = resumesOf(deps, dispatchId)
    expect(resumes).toHaveLength(1)
    expect(resumes?.[0].resumedAt).toBeUndefined()
  })
})

// final round — C1: HEAD 읽기는 프로세스를 띄우는 일(Windows 에서 20~60ms)이고, 롤이 'switching'
// 게시와 session:rolled 사이에 갖는 유일한 await 는 원본과 목적지가 같으면 곧바로 돌아오는 전사
// 복사다. 그래서 재키잉이 먼저 커밋되고, git 을 기다린 뒤 **옛 세션 id** 로 Dispatch 를 찾던 동안은
// 이력도 스냅샷도 남지 않았다(계정 전환에서 대개, 같은 계정 respawn 에서는 항상).

/** 테스트가 풀어 줄 때까지 답하지 않는 git 이중체. fakeGit 과 같은 관례지만, 이것으로만 만들 수 있는
 *  순서가 있다: 재키잉이 git 보다 먼저 커밋되는 순서. */
function gatedGit(head: string): { git: typeof git; release: () => void } {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const fn = (async () => {
    await gate
    return { ok: true, stdout: head, stderr: '' }
  }) as unknown as typeof git
  return { git: fn, release: () => release() }
}

describe('OrchRollTap 정지 기록과 재키잉의 경합', () => {
  it('재키잉이 git 보다 먼저 커밋돼도 이력과 스냅샷이 남고, 재개가 그 항목을 닫는다', async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const g = gatedGit('head-at-limit')
    const tap = new OrchRollTap(deps, { git: g.git })
    // 계정 전환의 실제 순서: switching(옛 id) → 전사 복사(no-op) → kill·spawn → 재키잉 → rolled
    tap.onRollState(rollState({ sessionId: 'sess1', state: 'switching', accountLabel: 'B' }))
    await vi.advanceTimersByTimeAsync(0) // git 은 아직 잠겨 있다
    await tap.onRolled('sess1', { id: 'sess2', accountId: 'acc2' })
    const rekeyed = deps.state().dispatches.find((d) => d.id === dispatchId)
    expect(rekeyed?.sessionId).toBe('sess2') // 재키잉이 이겼다 — 옛 id 로는 이제 찾지 못한다
    // 그래도 항목은 정지 시점의 계정으로 열렸고, 뒤이은 재개가 그것을 닫았다
    expect(rekeyed?.resumes).toEqual([
      {
        stoppedAt: NOW,
        reason: 'switching',
        fromAccountId: 'acc1',
        resumedAt: NOW,
        toAccountId: 'acc2'
      }
    ])
    // 스냅샷의 정지 사유도 남았다 — 재개 브리핑의 "왜 여기 있는가" 가 이것을 읽는다
    expect(rekeyed?.stopSnapshot).toEqual({ headCommit: null, reason: 'switching' })
    // 늦게 답한 git 은 비워 둔 칸만 메운다 — 이력은 건드리지 않는다
    g.release()
    await vi.advanceTimersByTimeAsync(0)
    const after = deps.state().dispatches.find((d) => d.id === dispatchId)
    expect(after?.stopSnapshot).toEqual({ headCommit: 'head-at-limit', reason: 'switching' })
    expect(after?.resumes).toHaveLength(1)
    expect(after?.resumes?.[0].resumedAt).toBe(NOW)
  })

  it('리셋 시각도 재키잉보다 먼저 커밋된다 — 대기 뒤 계정을 바꾸는 갈래', async () => {
    const { s, dispatchId } = seed()
    const deps = makeDeps(s)
    const g = gatedGit('head-at-limit')
    const tap = new OrchRollTap(deps, { git: g.git })
    tap.onRollState(
      rollState({ sessionId: 'sess1', state: 'waiting', nextRetryAt: '2026-08-25T03:00:00.000Z' })
    )
    await vi.advanceTimersByTimeAsync(0)
    await tap.onRolled('sess1', { id: 'sess2', accountId: 'acc2' })
    const d = deps.state().dispatches.find((x) => x.id === dispatchId)
    expect(d?.resumes?.[0].resetsAt).toBe('2026-08-25T03:00:00.000Z')
    expect(d?.stopSnapshot?.resetsAt).toBe('2026-08-25T03:00:00.000Z')
    g.release()
  })
})
