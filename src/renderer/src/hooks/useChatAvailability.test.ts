import { describe, it, expect } from 'vitest'
import { chatAvailabilityOf, startHostStatusPoll } from './useChatAvailability'
import { vi, afterEach } from 'vitest'

// Second pass R2-5: the dialogs' Host poll took a new object every two seconds (drawing the dialog again with nothing
// changed), went on while the window was hidden, and a rejected read was an unhandled rejection every two seconds.
describe('startHostStatusPoll', () => {
  afterEach(() => vi.useRealTimers())
  const doc = (hidden: boolean) => Object.assign(new EventTarget(), { hidden })

  it('asks nothing while the window is hidden', async () => {
    vi.useFakeTimers()
    const ask = vi.fn(async () => ({ ok: true }))
    const stop = startHostStatusPoll(ask as never, () => {}, doc(true))
    await vi.advanceTimersByTimeAsync(10_000)
    stop()
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('a rejected read is not an unhandled rejection, and the next read still lands', async () => {
    vi.useFakeTimers()
    let n = 0
    const took: unknown[] = []
    const ask = async (): Promise<{ ok: boolean }> => {
      if (n++ === 0) throw new Error('the Host went')
      return { ok: true }
    }
    const stop = startHostStatusPoll(ask as never, (s) => took.push(s), doc(false))
    await vi.advanceTimersByTimeAsync(2_000)
    stop()
    expect(took).toEqual([{ ok: true }])
  })
})

describe('chatAvailabilityOf', () => {
  it('any account is enabled when the Host speaks proc', () => {
    expect(chatAvailabilityOf({ hostOk: true, answered: true })).toEqual({
      hostOk: true,
      reason: null,
      enabled: true,
      checking: false
    })
  })

  it('the Host is the only reason it can be unavailable', () => {
    expect(chatAvailabilityOf({ hostOk: false, answered: true })).toEqual({
      hostOk: false,
      reason: 'host',
      enabled: false,
      checking: false
    })
  })

  // "Not yet asked" is not "no", and telling them apart is the whole point of this flag. The Host is
  // asked asynchronously, so for the first moment of a dialog's life there is no verdict — and the
  // dialogs act on a verdict: one of them drops a 대화 selection back to 터미널, and both say the Host
  // is too old. Doing either on a question still in flight threw away the default the settings said
  // (reported: the setting was 대화 and the modal opened on 터미널 every time).
  it('while the Host has not answered, nothing is a verdict', () => {
    expect(chatAvailabilityOf({ hostOk: false, answered: false })).toEqual({
      hostOk: false,
      // Not offered, because it is not known to be available…
      enabled: false,
      // …but no reason either: there is nothing yet to tell the person, and no verdict to act on.
      reason: null,
      checking: true
    })
  })

  // Today's only caller derives hostOk from the very status that decides `answered`, so it cannot
  // produce this. A second caller that guessed hostOk before asking could, and `enabled` with
  // `checking` would be the contradiction the flag exists to remove — so the rule lives here.
  it('an unanswered question is never enabled, whatever hostOk claims', () => {
    expect(chatAvailabilityOf({ hostOk: true, answered: false })).toEqual({
      hostOk: true,
      enabled: false,
      reason: null,
      checking: true
    })
  })
})
