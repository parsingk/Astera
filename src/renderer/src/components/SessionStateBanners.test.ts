import { describe, it, expect } from 'vitest'
import type { RollStateEvent, SchedStateEvent } from '../../../core/types'
import { rollBannerVisible, stateBannerHeight, waitingBannerKey } from './SessionStateBanners'

describe('rollBannerVisible', () => {
  it('shows switching, trust, adopted and waiting; hides none, nudged, stalled and null', () => {
    const ev = (state: string) => ({ sessionId: 's', state }) as never
    expect(['switching', 'trust', 'adopted', 'waiting'].map((s) => rollBannerVisible(ev(s)))).toEqual([true, true, true, true])
    expect(['none', 'nudged', 'stalled'].map((s) => rollBannerVisible(ev(s)))).toEqual([false, false, false])
    expect(rollBannerVisible(null)).toBe(false)
  })
})

// A limit shown off a usage figure alone (`manual`) resumes nothing by itself — its banner must not say it
// will (2026-10-19). A planned wait keeps its automatic-resume wording.
describe('waitingBannerKey', () => {
  const waiting = (o: Partial<RollStateEvent>): RollStateEvent => ({ sessionId: 's', state: 'waiting', ...o })

  it('words a planned wait as an automatic resume', () => {
    expect(waitingBannerKey(waiting({ scope: 'session' }))).toBe('session.terminal.limitWaiting')
    expect(waitingBannerKey(waiting({ scope: 'weekly' }))).toBe('session.terminal.weeklyLimitWaiting')
  })

  it('words a shown-only limit as a reset that resumes nothing', () => {
    expect(waitingBannerKey(waiting({ scope: 'session', manual: true }))).toBe('session.terminal.limitShown')
    expect(waitingBannerKey(waiting({ scope: 'weekly', manual: true }))).toBe('session.terminal.weeklyLimitShown')
  })
})

describe('stateBannerHeight', () => {
  const roll = (state: string): RollStateEvent => ({ sessionId: 's', state }) as RollStateEvent
  const sched = (state: string): SchedStateEvent => ({ sessionId: 's', state }) as SchedStateEvent

  it('counts one strip row per visible banner, and nothing when neither is shown', () => {
    expect(stateBannerHeight(null, null)).toBe(0)
    expect(stateBannerHeight(roll('none'), sched('off'))).toBe(0)
    expect(stateBannerHeight(roll('switching'), null)).toBe(25)
    expect(stateBannerHeight(null, sched('active'))).toBe(25)
    expect(stateBannerHeight(roll('waiting'), sched('active'))).toBe(50)
  })

  it('agrees with rollBannerVisible about which roll states draw a banner', () => {
    // The two would drift apart if the height had its own copy of the condition, and the drift would
    // show as the thread starting 25px too low or the first message sitting under the strip.
    const states = ['switching', 'trust', 'adopted', 'waiting', 'none', 'nudged', 'stalled']
    expect(states.map((s) => stateBannerHeight(roll(s), null) > 0)).toEqual(states.map((s) => rollBannerVisible(roll(s))))
  })
})
