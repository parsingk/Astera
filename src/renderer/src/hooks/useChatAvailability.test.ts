import { describe, it, expect } from 'vitest'
import { chatAvailabilityOf } from './useChatAvailability'

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
