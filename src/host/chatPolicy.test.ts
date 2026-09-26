import { describe, it, expect, vi, afterEach } from 'vitest'
import { createChatPolicy, UNATTENDED_DENY_MS, DENY_RETRY_MS } from './chatPolicy'
import type { ChatRequest } from '../core/chat/types'

const approval = (id: string): ChatRequest => ({ id, kind: 'approval', about: { tool: 'Bash', lines: ['ls'] }, decisions: ['accept', 'decline'] })
const question = (id: string): ChatRequest => ({ id, kind: 'question', form: { questions: [] } as never })
afterEach(() => vi.useRealTimers())

const rig = (over: { policy?: 'hold' | 'deny-after-60s'; answered?: string[]; open?: ChatRequest[] } = {}) => {
  vi.useFakeTimers()
  const state = { writer: true, policy: over.policy ?? 'deny-after-60s', open: over.open ?? [approval('r1')], answered: over.answered ?? [] }
  const deny = vi.fn(async (_s: string, id: string) => { state.open = state.open.filter((r) => r.id !== id) })
  const logs: string[] = []
  const p = createChatPolicy({ policyOf: () => state.policy, isWriter: () => state.writer, open: () => state.open, answered: () => state.answered, deny, log: (m) => logs.push(m) })
  return { p, state, deny, logs }
}

describe('createChatPolicy (chat takeover C3)', () => {
  it('denies an open approval 60 s after the Host became its writer, once, and logs it', async () => {
    const r = rig()
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS - 1)
    expect(r.deny).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(r.deny).toHaveBeenCalledWith('c1', 'r1')
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS * 2)
    expect(r.deny).toHaveBeenCalledTimes(1)
    expect(r.logs.join('\n')).toMatch(/denied Bash in session c1 after 60 s/)
  })
  it('holds under the hold policy', async () => {
    const r = rig({ policy: 'hold' })
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS * 5)
    expect(r.deny).not.toHaveBeenCalled()
  })
  // Review Focus 4.
  it('does not deny once an app holds the proc', async () => {
    const r = rig()
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(59_000)
    r.state.writer = false
    r.p.reviewAll(['c1'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.deny).not.toHaveBeenCalled()
  })
  it('does not deny a request the note lists as answered', async () => {
    const r = rig({ answered: ['r1'] })
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS * 2)
    expect(r.deny).not.toHaveBeenCalled()
  })
  it('counts 60 s from the writer change, not from the prompt (P12)', async () => {
    const r = rig()
    r.state.writer = false
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    r.state.writer = true
    r.p.reviewAll(['c1'])
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS - 1)
    expect(r.deny).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(r.deny).toHaveBeenCalledTimes(1)
  })
  it('never denies a question (P6)', async () => {
    const r = rig({ open: [question('q1')] })
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS * 2)
    expect(r.deny).not.toHaveBeenCalled()
  })
  it('logs a deny that rejects and never throws (R3)', async () => {
    const r = rig()
    r.deny.mockRejectedValueOnce(new Error('pipe closed'))
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS)
    expect(r.logs.join('\n')).toMatch(/pipe closed/)
  })

  // The writer change is asked again at the fire, not only at arming: a writer change nobody reviewed
  // still stops the deny.
  it('asks every condition again at the fire, even without a review in between', async () => {
    const r = rig()
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(59_000)
    r.state.writer = false
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.deny).not.toHaveBeenCalled()
  })
  it('cancels the timer of a prompt answered elsewhere, and of a session forgotten or disposed', async () => {
    const r = rig({ open: [approval('r1'), approval('r2')] })
    // The two sessions share one open list here, so a deny must not close it for the other.
    r.deny.mockImplementation(async () => {})
    r.p.review('c1')
    r.p.review('c2')
    r.state.open = [approval('r2')]
    r.p.review('c1')
    r.p.forget('c2')
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS * 2)
    // c1's r2 was armed at the second review, and fires; r1 (answered elsewhere) and c2 (forgotten) do not.
    expect(r.deny.mock.calls).toEqual([['c1', 'r2']])
    r.state.open = [approval('r3')]
    r.p.review('c1')
    r.p.dispose()
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS * 2)
    expect(r.deny).toHaveBeenCalledTimes(1)
  })
  it('does not re-arm a prompt while its deny is still in flight', async () => {
    const r = rig()
    let release: () => void = () => {}
    r.deny.mockImplementationOnce(() => new Promise<void>((res) => { release = () => { r.state.open = []; res() } }))
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS)
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS * 2)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(r.deny).toHaveBeenCalledTimes(1)
  })

  // CT-9: a failed deny no longer waits for the next review trigger; it retries on its own timer.
  it('retries a failed deny after 5, 15 and 60 s, then leaves it to the next review (CT-9)', async () => {
    const r = rig()
    expect(DENY_RETRY_MS).toEqual([5_000, 15_000, 60_000])
    r.deny.mockRejectedValue(new Error('pipe closed'))
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS)
    expect(r.deny).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(r.deny).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(r.deny).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(r.deny).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(r.deny).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(r.deny).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(r.deny).toHaveBeenCalledTimes(4)
    // Out of retries: nothing more on its own.
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS * 10)
    expect(r.deny).toHaveBeenCalledTimes(4)
    expect(r.logs.join('\n')).toMatch(/retrying in 5 s/)
    expect(r.logs.join('\n')).toMatch(/no retry left/)
    // The next review arms it again, with a fresh set of retries behind it.
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS + 5_000)
    expect(r.deny).toHaveBeenCalledTimes(6)
  })
  it('a retry that succeeds stops there, and a retry asks every condition again (CT-9)', async () => {
    const r = rig({ open: [approval('r1'), approval('r2')] })
    r.deny.mockRejectedValueOnce(new Error('pipe closed')).mockRejectedValueOnce(new Error('pipe closed'))
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS)
    expect(r.deny.mock.calls).toEqual([['c1', 'r1'], ['c1', 'r2']])
    // r1 succeeds at its first retry; r2 is answered elsewhere before its retry fires.
    r.state.open = r.state.open.filter((q) => q.id !== 'r2')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(r.deny.mock.calls).toEqual([['c1', 'r1'], ['c1', 'r2'], ['c1', 'r1']])
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS * 5)
    expect(r.deny).toHaveBeenCalledTimes(3)
  })
  it('a retry timer is cancelled by forget and dispose (CT-9)', async () => {
    const r = rig()
    r.deny.mockRejectedValue(new Error('pipe closed'))
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS)
    r.p.forget('c1')
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS * 5)
    expect(r.deny).toHaveBeenCalledTimes(1)
    r.p.review('c1')
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS)
    expect(r.deny).toHaveBeenCalledTimes(2)
    r.p.dispose()
    await vi.advanceTimersByTimeAsync(UNATTENDED_DENY_MS * 5)
    expect(r.deny).toHaveBeenCalledTimes(2)
  })
})
