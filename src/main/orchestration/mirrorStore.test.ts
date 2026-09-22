import { describe, it, expect, vi } from 'vitest'
import { createMirrorStore, OrchStateConflict } from './mirrorStore'
import { emptyState } from '../../core/orchestration/state'

describe('createMirrorStore', () => {
  it('마지막으로 밀려온 상태를 낸다', () => {
    const m = createMirrorStore({ call: vi.fn() })
    const s = { ...emptyState(), jobs: [{ id: 'job_1' }] } as never
    m.accept(s)
    expect(m.getState()).toBe(s)
  })

  // **첫 밀기 전의 쓰기는 거절한다.** 빈 상태를 진짜 상태 위에 덮는 것이 이 설계에서 제일
  // 비싼 실수이고, 그것이 일어나는 유일한 창이 여기다.
  it('아직 아무것도 못 받았으면 쓰기를 거절한다', async () => {
    const m = createMirrorStore({ call: vi.fn() })
    await expect(m.setState(emptyState())).rejects.toThrow(/not loaded/)
  })

  // 쓰기는 Host 에게 보내는 호출이고, 답이 와야 끝난다 — 지금 store.save 가 그렇듯이.
  it('쓰기는 Host 로 가고 답을 기다린다', async () => {
    const call = vi.fn().mockResolvedValue({ status: 200, body: {} })
    const m = createMirrorStore({ call })
    m.accept(emptyState())
    const next = { ...emptyState(), jobs: [{ id: 'job_2' }] } as never
    await m.setState(next)
    expect(call).toHaveBeenCalledWith({ cmd: 'state-put', args: { state: next }, sessionId: '' })
  })

  // 읽기도 거절한다 — 빈 상태를 돌려주면 그것을 읽은 자리가 "Job 이 없다"로 읽고, 그 답으로
  // 쓴 것이 진짜 상태를 덮는다.
  it('아직 아무것도 못 받았으면 읽기도 거절한다', () => {
    const m = createMirrorStore({ call: vi.fn() })
    expect(() => m.getState()).toThrow(/not loaded/)
    expect(m.loaded()).toBe(false)
  })

  // **답을 기다리는 동안 읽으면 새 상태가 나와야 한다.** store.save 의 순서가 그랬고, 그 순서가
  // 겹친 두 흐름이 서로의 커밋을 지우는 것을 막는 유일한 장치다 — 여기서 답을 기다렸다가 넣으면
  // 그 창이 동기 대입에서 소켓 왕복으로 넓어진다.
  it('답을 기다리는 동안에도 새 상태를 낸다', async () => {
    let release: (v: { status: number; body: unknown }) => void = () => {}
    const call = vi.fn().mockReturnValue(new Promise((r) => (release = r)))
    const m = createMirrorStore({ call })
    m.accept(emptyState())
    const next = { ...emptyState(), jobs: [{ id: 'job_3' }] } as never
    const writing = m.setState(next)
    expect(m.getState()).toBe(next)
    release({ status: 200, body: {} })
    await writing
  })

  // 거절은 부르는 쪽에 닿아야 한다 — 조용히 성공한 척하지 않는다.
  it('Host 가 거절하면 던진다', async () => {
    const call = vi.fn().mockResolvedValue({ status: 403, body: { error: 'nope' } })
    const m = createMirrorStore({ call })
    m.accept(emptyState())
    await expect(m.setState({ ...emptyState(), runs: [] })).rejects.toThrow(/403/)
  })

  // **거절은 Host 가 안 썼다는 뜻이다** — 그 상태로 두면 main 의 모든 읽기가 없는 커밋을 보고하고,
  // 소켓은 끊기지 않았으니 재연결의 re-mirror 도 오지 않는다.
  it('Host 가 거절하면 거울을 되돌린다', async () => {
    const first = emptyState()
    const call = vi.fn().mockResolvedValue({ status: 500, body: { error: 'ENOSPC' } })
    const m = createMirrorStore({ call })
    m.accept(first)
    await expect(m.setState({ ...emptyState(), runs: [] })).rejects.toThrow(/500/)
    expect(m.getState()).toBe(first)
  })

  // 그 사이에 더 새로운 것이 들어왔으면 그것이 진실이다 — 거절은 그것에 대해 할 말이 없다.
  it('되돌리는 사이에 새 상태가 들어왔으면 그것을 지우지 않는다', async () => {
    let release: (v: { status: number; body: unknown }) => void = () => {}
    const call = vi.fn().mockReturnValue(new Promise((r) => (release = r)))
    const m = createMirrorStore({ call })
    m.accept(emptyState())
    const writing = m.setState({ ...emptyState(), runs: [] })
    const pushed = { ...emptyState(), jobs: [{ id: 'job_9' }] } as never
    m.accept(pushed)
    release({ status: 500, body: {} })
    await expect(writing).rejects.toThrow(/500/)
    expect(m.getState()).toBe(pushed)
  })

  // 답이 아예 안 온 것은 Host 가 안 썼다는 뜻이 아니다 — 되돌리면 이미 디스크에 앉은 것을 지운다.
  it('답이 오지 않은 쓰기는 되돌리지 않는다', async () => {
    const call = vi.fn().mockRejectedValue(new Error('the Host did not answer state-put'))
    const m = createMirrorStore({ call })
    m.accept(emptyState())
    const next = { ...emptyState(), jobs: [{ id: 'job_8' }] } as never
    await expect(m.setState(next)).rejects.toThrow(/did not answer/)
    expect(m.getState()).toBe(next)
  })

  // === ruling F56 — 버전을 인용하고, 어긋나면 Host 가 들고 있는 것으로 되맞춘다 ===

  it('받은 버전을 다음 쓰기에 인용한다', async () => {
    const call = vi.fn().mockResolvedValue({ status: 200, body: { ok: true, version: 8 } })
    const m = createMirrorStore({ call })
    m.accept(emptyState(), 7)
    await m.setState({ ...emptyState(), runs: [] } as never)
    expect(call).toHaveBeenCalledWith({
      cmd: 'state-put',
      args: { state: { ...emptyState(), runs: [] }, version: 7 },
      sessionId: ''
    })
  })

  it('쓰기가 통과하면 그 쓰기의 버전을 들고 간다', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: { ok: true, version: 8 } })
      .mockResolvedValueOnce({ status: 200, body: { ok: true, version: 9 } })
    const m = createMirrorStore({ call })
    m.accept(emptyState(), 7)
    await m.setState({ ...emptyState(), runs: [] } as never)
    await m.setState({ ...emptyState(), messages: [] } as never)
    expect(call.mock.calls[1][0].args.version).toBe(8)
  })

  // **되돌리는 곳이 previous 가 아니다.** previous 야말로 이 충돌을 만든 낡은 값이고, 거기로
  // 돌아가면 main 은 파일에 없는 상태를 계속 읽는다.
  it('409 면 Host 가 들고 있는 상태로 되맞추고 그 사실을 던진다', async () => {
    const hostState = { ...emptyState(), jobs: [{ id: 'job_host' }] } as never
    const call = vi.fn().mockResolvedValue({
      status: 409,
      body: { error: 'the state moved on', state: hostState, version: 12 }
    })
    const m = createMirrorStore({ call })
    m.accept(emptyState(), 3)
    await expect(m.setState({ ...emptyState(), runs: [] } as never)).rejects.toBeInstanceOf(
      OrchStateConflict
    )
    expect(m.getState()).toBe(hostState)
  })

  it('되맞춘 뒤의 쓰기는 Host 의 버전을 인용한다', async () => {
    const hostState = { ...emptyState(), jobs: [{ id: 'job_host' }] } as never
    const call = vi
      .fn()
      .mockResolvedValueOnce({ status: 409, body: { state: hostState, version: 12 } })
      .mockResolvedValueOnce({ status: 200, body: { ok: true, version: 13 } })
    const m = createMirrorStore({ call })
    m.accept(emptyState(), 3)
    await expect(m.setState({ ...emptyState(), runs: [] } as never)).rejects.toThrow()
    await m.setState({ ...emptyState(), messages: [] } as never)
    expect(call.mock.calls[1][0].args.version).toBe(12)
  })

  // 409 인데 상태가 안 실려 온 경우(옛 Host) — 적어도 낡은 값으로는 돌려놓는다.
  it('409 에 상태가 없으면 쓰기 전으로 되돌린다', async () => {
    const before = emptyState()
    const call = vi.fn().mockResolvedValue({ status: 409, body: { error: 'nope' } })
    const m = createMirrorStore({ call })
    m.accept(before, 3)
    await expect(m.setState({ ...emptyState(), runs: [] } as never)).rejects.toBeInstanceOf(
      OrchStateConflict
    )
    expect(m.getState()).toBe(before)
  })

  // **겹치는 두 쓰기가 둘 다 맞게 지어졌는데 둘째가 거절당하던 것**(ruling F56/d). state 는 await
  // 앞에서 동기로 옮겨지므로 둘째 흐름이 그 창에서 읽은 것은 첫째의 상태다 — 맞게 지어진 것이다.
  // 그런데 인용할 버전이 답이 올 때까지 안 움직이면 둘 다 같은 번호를 인용하고 Host 가 둘째를 막는다.
  it('겹치는 두 쓰기의 두 번째는 첫 번째의 다음 버전을 인용한다', async () => {
    const replies: ((v: { status: number; body: unknown }) => void)[] = []
    const call = vi.fn().mockImplementation(() => new Promise((r) => replies.push(r)))
    const m = createMirrorStore({ call })
    m.accept(emptyState(), 5)
    const a = m.setState({ ...emptyState(), runs: [] } as never)
    const b = m.setState({ ...emptyState(), messages: [] } as never)
    expect(call.mock.calls[0][0].args.version).toBe(5)
    expect(call.mock.calls[1][0].args.version).toBe(6)
    replies[0]({ status: 200, body: { ok: true, version: 6 } })
    replies[1]({ status: 200, body: { ok: true, version: 7 } })
    await a
    await b
  })

  // Host 가 사이에 커밋한 것은 여전히 어긋남이어야 한다 — 이 검사가 있는 이유가 그 경우다.
  it('사이에 들어온 푸시는 인용할 버전을 그쪽으로 옮긴다', async () => {
    const call = vi.fn().mockResolvedValue({ status: 200, body: { ok: true, version: 99 } })
    const m = createMirrorStore({ call })
    m.accept(emptyState(), 5)
    m.accept({ ...emptyState(), jobs: [{ id: 'job_host' }] } as never, 12)
    await m.setState({ ...emptyState(), runs: [] } as never)
    expect(call.mock.calls[0][0].args.version).toBe(12)
  })

  // 거절당한 쓰기는 상태와 버전을 함께 되돌린다 — 하나만 되돌리면 다음 쓰기가 그 상태에 맞지 않는
  // 번호를 인용한다.
  it('거절당한 쓰기는 버전도 함께 되돌린다', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ status: 500, body: {} })
      .mockResolvedValueOnce({ status: 200, body: { ok: true, version: 6 } })
    const m = createMirrorStore({ call })
    m.accept(emptyState(), 5)
    await expect(m.setState({ ...emptyState(), runs: [] } as never)).rejects.toThrow(/500/)
    await m.setState({ ...emptyState(), messages: [] } as never)
    expect(call.mock.calls[1][0].args.version).toBe(5)
  })
})
