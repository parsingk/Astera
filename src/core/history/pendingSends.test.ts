import { describe, it, expect } from 'vitest'
import { sendPending, unsettledSends, dropPending, isAwaitingReply } from './pendingSends'
import type { ConvTurn } from './convTypes'

const said = (id: string, role: 'user' | 'assistant', text: string): ConvTurn =>
  ({ id, role, parts: [{ kind: 'text', text }] }) as ConvTurn

const MAX = 60_000

describe('sendPending / unsettledSends', () => {
  it('shows a message the transcript has not caught up with yet', () => {
    const p = sendPending([], [], '안녕', 'p1', 1000)
    expect(unsettledSends(p, [], 1100, MAX)).toHaveLength(1)
  })

  it('lets it go the moment the transcript carries it', () => {
    const p = sendPending([], [], '안녕', 'p1', 1000)
    expect(unsettledSends(p, [said('t1', 'user', '안녕')], 1100, MAX)).toEqual([])
  })

  // The reason a match alone is not enough: an identical message further up the conversation would
  // settle this one on the spot, and the bubble would blink out and back when the real turn landed.
  it('is not settled by the same words said earlier', () => {
    const before = [said('t1', 'user', '안녕'), said('t2', 'assistant', '네')]
    const p = sendPending([], before, '안녕', 'p1', 1000)
    expect(unsettledSends(p, before, 1100, MAX)).toHaveLength(1)
    expect(unsettledSends(p, [...before, said('t3', 'user', '안녕')], 1200, MAX)).toEqual([])
  })

  it('settles two identical messages one at a time', () => {
    let p = sendPending([], [], '또', 'p1', 1000)
    p = sendPending(p, [], '또', 'p2', 1100)
    expect(unsettledSends(p, [said('t1', 'user', '또')], 1200, MAX).map((x) => x.id)).toEqual(['p2'])
    expect(unsettledSends(p, [said('t1', 'user', '또'), said('t2', 'user', '또')], 1300, MAX)).toEqual([])
  })

  // A message a dialog swallowed is never written down, and a bubble that stayed forever would be a
  // worse lie than the delay this exists to cover.
  it('gives up on one the CLI never recorded', () => {
    const p = sendPending([], [], '삼켜짐', 'p1', 1000)
    expect(unsettledSends(p, [], 1000 + MAX + 1, MAX)).toEqual([])
  })

  it('keeps them in the order they were sent', () => {
    let p = sendPending([], [], 'A', 'p1', 1000)
    p = sendPending(p, [], 'B', 'p2', 1100)
    expect(unsettledSends(p, [], 1200, MAX).map((x) => x.text)).toEqual(['A', 'B'])
  })
})

describe('dropPending', () => {
  // A chat session's send can be refused outright — a turn already running, the process gone — and
  // the refusal comes back after the copy is already on screen. The copy claims the message was
  // sent, so it goes in the same breath as the toast that says it was not. Waiting for the sweep to
  // age it out would leave that claim standing for a minute.
  it('takes back the copy of a send that was refused', () => {
    const p = sendPending([], [], '보냄', 'p1', 1000)
    expect(dropPending(p, 'p1')).toEqual([])
  })

  it('leaves the others alone', () => {
    let p = sendPending([], [], '하나', 'p1', 1000)
    p = sendPending(p, [], '둘', 'p2', 1100)
    expect(dropPending(p, 'p2').map((x) => x.id)).toEqual(['p1'])
  })

  // Same reference back when there is nothing to take out, so a refusal for a copy the sweep already
  // aged out costs nothing downstream — the bailout the other reducers here make.
  it('gives the same list back when the id is not there', () => {
    const p = sendPending([], [], '하나', 'p1', 1000)
    expect(dropPending(p, 'p9')).toBe(p)
  })
})

describe('isAwaitingReply', () => {
  it('is true while something sent has not been written down yet', () => {
    expect(isAwaitingReply([], 1, false)).toBe(true)
  })

  it('is true while the last turn is the person’s own and the CLI is still at it', () => {
    expect(isAwaitingReply([said('t1', 'user', '안녕')], 0, true)).toBe(true)
  })

  // The case that reported this: `/model`, `/effort` and `/clear` are answered on the CLI's own screen
  // and leave a user turn with nothing after it for good. The transcript's shape says "unanswered"
  // forever; the CLI, sitting idle at its prompt, says otherwise, and it is the one that knows.
  it('is false once the CLI is no longer working, whatever the transcript looks like', () => {
    expect(isAwaitingReply([said('t1', 'user', '/model default')], 0, false)).toBe(false)
    expect(isAwaitingReply([said('t1', 'user', '안녕')], 0, false)).toBe(false)
  })

  // Once the answer starts being written, the answer itself is the sign that something is happening.
  it('is false once an answer follows it', () => {
    expect(
      isAwaitingReply([said('t1', 'user', '안녕'), said('t2', 'assistant', '네')], 0, true)
    ).toBe(false)
  })

  it('is false for a conversation that has not started', () => {
    expect(isAwaitingReply([], 0, true)).toBe(false)
  })
})
