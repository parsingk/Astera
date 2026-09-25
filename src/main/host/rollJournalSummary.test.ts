import { describe, it, expect } from 'vitest'
import type { RollJournalEntry } from '../../core/host/protocol'
import { foldRollChains, summarizeRollJournal, chainText } from './rollJournalSummary'

let seq = 0
const at = (hm: string): string => new Date(2026, 8, 25, Number(hm.slice(0, 2)), Number(hm.slice(3, 5))).toISOString()
const st = (sessionId: string, state: RollJournalEntry['state'], time: string, over: Partial<RollJournalEntry> = {}): RollJournalEntry => ({
  seq: ++seq,
  at: at(time),
  kind: 'state',
  sessionId,
  state,
  ...over
})
const rolled = (oldSessionId: string, sessionId: string, time: string): RollJournalEntry => ({
  seq: ++seq,
  at: at(time),
  kind: 'rolled',
  sessionId,
  oldSessionId
})
const NOW = new Date(2026, 8, 25, 23, 0).getTime()

describe('foldRollChains (S6 Task 5, D6)', () => {
  it('folds a chain rolled twice onto its newest id, in seq order', () => {
    const entries = [
      st('a', 'waiting', '10:00', { nextRetryAt: at('15:00') }),
      st('a', 'switching', '10:01', { accountLabel: 'work' }),
      rolled('a', 'b', '10:02'),
      st('b', 'waiting', '12:00', { nextRetryAt: at('17:00') }),
      st('b', 'switching', '12:01', { accountLabel: 'home' }),
      rolled('b', 'c', '12:02'),
      st('x', 'stalled', '11:00')
    ]
    // Shuffled: the fold orders by seq, not by arrival.
    const chains = foldRollChains([...entries].reverse())
    expect(chains.map((c) => c.sessionId).sort()).toEqual(['c', 'x'])
    const c = chains.find((x) => x.sessionId === 'c')!
    expect(c.entries.map((e) => e.seq)).toEqual(entries.slice(0, 6).map((e) => e.seq))
  })

  it('survives a cycle of roll links without looping', () => {
    const chains = foldRollChains([rolled('a', 'b', '10:00'), rolled('b', 'a', '10:01'), st('a', 'stalled', '10:02')])
    expect(chains.reduce((n, c) => n + c.entries.length, 0)).toBe(3)
  })
})

describe('chainText (S6 Task 5, D6)', () => {
  it('says the limit, each switch and the resume, in order', () => {
    const text = chainText(
      [
        st('a', 'waiting', '10:00', { nextRetryAt: at('15:00') }),
        st('a', 'waiting', '10:05', { nextRetryAt: at('15:30') }),
        st('a', 'switching', '10:06', { accountLabel: 'work' }),
        rolled('a', 'b', '10:07'),
        st('b', 'nudged', '15:31')
      ],
      { lang: 'en', now: NOW, liveLabel: 'work' }
    )
    // Two waits in a row are one limit, with the later reset time.
    expect(text).toBe('🕘 While Astera was away from the Host: hit the limit at 10:00 (resuming 15:30), switched to work, resumed at 15:31')
  })

  it('names a switch with no label by the live account when it is the last one', () => {
    const text = chainText(
      [st('a', 'switching', '10:00'), rolled('a', 'b', '10:01'), st('b', 'switching', '11:00'), rolled('b', 'c', '11:01')],
      { lang: 'en', now: NOW, liveLabel: 'home' }
    )
    expect(text).toBe('🕘 While Astera was away from the Host: switched account, switched to home')
  })

  it('says stalled, and a day that is not today', () => {
    const text = chainText([st('a', 'stalled', '10:00')], { lang: 'ko', now: NOW + 86_400_000 })
    expect(text).toBe('🕘 Astera 가 Host 와 끊겨 있던 사이: 9/25 10:00 멈춤, 확인 필요')
  })

  it('has nothing to say for a chain of roll links alone', () => {
    expect(chainText([rolled('a', 'b', '10:00')], { lang: 'en', now: NOW })).toBeNull()
  })
})

describe('summarizeRollJournal (S6 Task 5, D6)', () => {
  const entries = (): RollJournalEntry[] => [
    st('a', 'waiting', '10:00', { nextRetryAt: at('15:00') }),
    rolled('a', 'b', '10:02'),
    st('gone', 'stalled', '11:00'),
    rolled('q', 'r', '11:30'),
    st('s', 'switching', '12:00', { accountLabel: 'home' })
  ]
  it('keeps a chain whose newest id is live for Slack, and counts only chains that met a limit for the desktop', () => {
    const e = entries()
    const s = summarizeRollJournal(e, {
      isLive: (id) => id === 'b',
      accountLabel: () => 'work',
      lang: 'en',
      now: NOW
    })
    expect(s.sessions).toEqual([{ sessionId: 'b', text: '🕘 While Astera was away from the Host: hit the limit at 10:00 (resuming 15:00)', seq: e[1].seq }])
    // 'gone' only stalled: not a limit, and not live, so nowhere. 'r' only rolled, with no switching: a
    // same-account respawn, silent on the desktop as in Slack (final review M3). 's' switched: a limit.
    expect(s.limited).toEqual([
      { sessionId: 'b', seq: e[1].seq },
      { sessionId: 's', seq: e[4].seq }
    ])
  })

  it('an empty journal is nothing', () => {
    expect(summarizeRollJournal([], { isLive: () => true, accountLabel: () => undefined, lang: 'en', now: NOW })).toEqual({
      sessions: [],
      limited: []
    })
  })
})
