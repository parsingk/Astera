import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import type { RollJournalEntry } from '../../core/host/protocol'
import { createOfflineRolls } from './offlineRolls'

const swept = { adopted: 1, refused: 0, sessions: ['b'], chats: [] }
const ENTRIES: RollJournalEntry[] = [
  { seq: 4, at: '2026-09-25T01:00:00.000Z', kind: 'state', sessionId: 'a', state: 'waiting', nextRetryAt: '2026-09-25T06:00:00.000Z' },
  { seq: 5, at: '2026-09-25T01:01:00.000Z', kind: 'state', sessionId: 'a', state: 'switching', accountLabel: 'home' },
  { seq: 6, at: '2026-09-25T01:02:00.000Z', kind: 'rolled', sessionId: 'b', oldSessionId: 'a' },
  { seq: 7, at: '2026-09-25T02:00:00.000Z', kind: 'state', sessionId: 'c', state: 'waiting' },
  { seq: 8, at: '2026-09-25T03:00:00.000Z', kind: 'state', sessionId: 'gone', state: 'stalled' }
]

function rig(o: {
  features?: string[]
  connected?: boolean
  journal?: () => Promise<{ status: number; body: unknown }>
  slackFails?: boolean
  desktopThrows?: boolean
} = {}) {
  const trail: string[] = []
  const calls: Record<string, unknown>[] = []
  const logs: string[] = []
  const rolls = createOfflineRolls({
    status: () => ({ connected: o.connected ?? true, features: o.features ?? ['rolling', 'blocks', 'roll-journal'] }),
    call: async (m) => {
      calls.push(m.args)
      if ('ack' in m.args) {
        trail.push(`ack ${String(m.args.ack)}`)
        return { status: 200, body: { entries: [], lastSeq: m.args.ack } }
      }
      trail.push('fetch')
      return o.journal ? o.journal() : { status: 200, body: { entries: ENTRIES, lastSeq: 8 } }
    },
    isLive: (id) => id === 'b' || id === 'c',
    accountLabel: () => 'home',
    lang: () => 'en',
    now: () => Date.parse('2026-09-25T04:00:00.000Z'),
    slack: {
      announceOffline: async (id, text) => {
        if (o.slackFails) throw new Error('post failed')
        trail.push(`slack ${id} ${text}`)
        return id !== 'c' // 'c' has Slack off: nowhere to post
      }
    },
    desktop: {
      announceOffline: (n, id) => {
        if (o.desktopThrows) throw new Error('boom')
        trail.push(`desktop ${n} ${String(id)}`)
      }
    },
    log: (m) => logs.push(m)
  })
  return { rolls, trail, calls, logs }
}

describe('createOfflineRolls (S6 Task 5, D6)', () => {
  it('fetches, sends one Slack line per live chain and one desktop notice, then acks the lastSeq', async () => {
    const h = rig()
    await h.rolls.swept('at startup', swept)
    expect(h.trail[0]).toBe('fetch')
    expect(h.trail.filter((x) => x.startsWith('slack')).map((x) => x.split(' ')[1])).toEqual(['b', 'c'])
    expect(h.trail[1]).toMatch(/^slack b 🕘 While Astera was closed: hit the limit at .* \(resuming .*\), switched to home$/)
    // 'gone' is not live: no Slack, but counted.
    expect(h.trail.slice(-2)).toEqual(['desktop 3 b', 'ack 8'])
    expect(h.calls).toEqual([{}, { ack: 8 }])
  })

  it('asks nothing of a Host that lacks the feature, or is not connected', async () => {
    for (const r of [rig({ features: ['rolling', 'blocks'] }), rig({ connected: false })]) {
      await r.rolls.swept('at startup', swept)
      expect(r.trail).toEqual([])
    }
  })

  it('asks nothing after a sweep that did not answer', async () => {
    const h = rig()
    await h.rolls.swept('at startup', 'unknown')
    await h.rolls.swept('at startup', null)
    expect(h.trail).toEqual([])
  })

  it('does not ack when a Slack send fails, or the desktop notice throws', async () => {
    for (const r of [rig({ slackFails: true }), rig({ desktopThrows: true })]) {
      await r.rolls.swept('at startup', swept)
      expect(r.trail.some((x) => x.startsWith('ack'))).toBe(false)
      expect(r.logs.join('\n')).toMatch(/stays for the next attach/)
    }
  })

  it('does not ack a failed or empty fetch', async () => {
    for (const journal of [
      async () => ({ status: 501, body: null }),
      async () => ({ status: 200, body: { entries: [], lastSeq: 3 } }),
      async () => ({ status: 200, body: { nope: true } }),
      async () => {
        throw new Error('no connection')
      }
    ]) {
      const h = rig({ journal })
      await h.rolls.swept('at startup', swept)
      expect(h.trail).toEqual(['fetch'])
    }
  })

  it('runs one fetch at a time: a sweep during a run queues one more after it', async () => {
    let release: () => void = () => undefined
    let first = true
    const h = rig({
      journal: async () => {
        if (first) {
          first = false
          await new Promise<void>((r) => (release = r))
        }
        return { status: 200, body: { entries: ENTRIES, lastSeq: 8 } }
      }
    })
    const a = h.rolls.swept('at startup', swept)
    const b = h.rolls.swept('after a reconnect', swept)
    const c = h.rolls.swept('after a reconnect', swept)
    await Promise.resolve()
    expect(h.trail).toEqual(['fetch'])
    release()
    await Promise.all([a, b, c])
    expect(h.trail.filter((x) => x === 'fetch').length).toBe(2)
    expect(h.trail.filter((x) => x.startsWith('ack')).length).toBe(2)
  })
})

// registerIpc cannot run without Electron, so its wiring is guarded by its text (as blockSync's is).
describe('ipc.ts wires offlineRolls (S6 Task 5)', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ipc.ts'), 'utf8')
  it('builds it over orchCall, Slack and the desktop sink', () => {
    const at = src.indexOf('const offlineRolls = createOfflineRolls({')
    expect(at).toBeGreaterThan(-1)
    const wiring = src.slice(at, at + 900)
    expect(wiring).toMatch(/call: orchCall/)
    expect(wiring).toMatch(/slack: slack\?\.notifier/)
    expect(wiring).toMatch(/desktop,/)
  })
  it('runs after the startup sweep and after the reconnect sweep', () => {
    expect(src).toMatch(/takeSessionsBack\('at startup'\)\.then\(\(r\) => \{\s*void offlineRolls\.swept\('at startup', r\)/)
    expect(src).toMatch(/takeSessionsBack\('after a reconnect'\)\s*\.then\(\(r\) => offlineRolls\.swept\('after a reconnect', r\)\)/)
  })
})
