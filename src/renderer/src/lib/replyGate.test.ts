import { describe, it, expect } from 'vitest'
import { createReplyGate } from './replyGate'

describe('createReplyGate (remote runtime design §2.7, X1-11)', () => {
  it('accepts the newest reply for the selected runtime', () => {
    const g = createReplyGate()
    const t = g.begin('jobs', 'rt_a')
    expect(g.accept('jobs', 'rt_a', t, 'rt_a')).toBe(true)
  })
  it('drops an older reply for the same view', () => {
    const g = createReplyGate()
    const old = g.begin('jobs', 'rt_a')
    const fresh = g.begin('jobs', 'rt_a')
    expect(g.accept('jobs', 'rt_a', old, 'rt_a')).toBe(false)
    expect(g.accept('jobs', 'rt_a', fresh, 'rt_a')).toBe(true)
  })
  it("drops runtime A's reply that arrives after B was selected", () => {
    const g = createReplyGate()
    const a = g.begin('jobs', 'rt_a')
    g.begin('jobs', 'rt_b')
    expect(g.accept('jobs', 'rt_a', a, 'rt_b')).toBe(false)
  })
  it('keeps views apart', () => {
    const g = createReplyGate()
    const list = g.begin('jobs', 'local')
    const detail = g.begin('detail', 'local')
    expect(g.accept('jobs', 'local', list, 'local')).toBe(true)
    expect(g.accept('detail', 'local', detail, 'local')).toBe(true)
  })
})
