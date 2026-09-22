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
})
