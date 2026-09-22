import { describe, it, expect, vi } from 'vitest'
import { createMirrorStore } from './mirrorStore'
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
})
