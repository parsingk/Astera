import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BlockRegistry } from '../../core/rolling/blockRegistry'
import type { BlockRecord } from '../../core/rolling/retry'
import type { ClientMessage, HostMessage } from '../../core/host/protocol'
import { createBlockSync } from './blockSync'

const rec = (at: number | null, since = 0, weekly = false): BlockRecord => ({ at, weekly, since })
const NEW_HOST = { connected: true, features: ['spawn', 'rolling', 'blocks'] }
const OLD_HOST = { connected: true, features: ['spawn', 'rolling'] }

function harness(status: { connected: boolean; unresponsive?: boolean; features: string[] }) {
  const blocks = new BlockRegistry()
  const sent: ClientMessage[] = []
  const logs: string[] = []
  const box = { status, now: 100, sendThrows: false }
  const sync = createBlockSync({
    blocks,
    status: () => box.status,
    send: (m) => {
      if (box.sendThrows) throw new Error('socket boom')
      sent.push(m)
      return true
    },
    now: () => box.now,
    log: (m) => logs.push(m)
  })
  return { blocks, sent, logs, box, sync }
}

describe('createBlockSync (S6 Task 3)', () => {
  it('sends nothing to a Host that lacks the feature: no change, no whole registry', () => {
    const h = harness(OLD_HOST)
    h.blocks.record('a', rec(5_000, 10), 10)
    h.blocks.clear('b', 20)
    h.sync.connected()
    expect(h.sent).toEqual([])
  })

  it('sends a local record and a local clear to a Host that speaks blocks', () => {
    const h = harness(NEW_HOST)
    h.blocks.record('a', rec(5_000, 10), 10)
    h.blocks.clear('b', 20)
    expect(h.sent).toEqual([
      { t: 'blocks', records: { a: rec(5_000, 10) }, cleared: [] },
      { t: 'blocks', records: {}, cleared: [{ accountId: 'b', at: 20 }] }
    ])
  })

  it('sends the whole registry after a handshake with a Host that speaks blocks', () => {
    const h = harness(OLD_HOST)
    h.blocks.record('a', rec(5_000, 10), 10)
    h.blocks.clear('b', 20)
    h.box.status = NEW_HOST
    h.sync.connected()
    expect(h.sent).toEqual([{ t: 'blocks', records: { a: rec(5_000, 10) }, cleared: [{ accountId: 'b', at: 20 }] }])
  })

  it('absorbs a pushed record and clear, and sends nothing back (no echo)', () => {
    const h = harness(NEW_HOST)
    h.blocks.record('b', rec(9_000, 10), 10)
    h.sent.length = 0
    h.sync.pushed({ t: 'blocks', records: { a: rec(5_000, 30) }, cleared: [{ accountId: 'b', at: 40 }] } as HostMessage)
    expect(h.blocks.get('a', 100)).toEqual(rec(5_000, 30))
    expect(h.blocks.get('b', 100)).toBeNull()
    expect(h.sent).toEqual([])
  })

  it('ignores every other push, and a malformed blocks push, without throwing', () => {
    const h = harness(NEW_HOST)
    expect(() => h.sync.pushed({ t: 'roll-state', event: {} } as unknown as HostMessage)).not.toThrow()
    expect(() => h.sync.pushed({ t: 'blocks', records: { a: { at: 'x', weekly: 1, since: null } }, cleared: 3 } as unknown as HostMessage)).not.toThrow()
    expect(() => h.sync.pushed(null as unknown as HostMessage)).not.toThrow()
    expect(h.blocks.size).toBe(0)
  })

  it('a send that throws is logged, and costs the registry nothing', () => {
    const h = harness(NEW_HOST)
    h.box.sendThrows = true
    expect(() => h.blocks.record('a', rec(5_000, 10), 10)).not.toThrow()
    expect(() => h.sync.connected()).not.toThrow()
    expect(h.blocks.get('a', 10)).toEqual(rec(5_000, 10))
    expect(h.logs.some((m) => m.includes('socket boom'))).toBe(true)
  })

  it('dispose stops sending local changes', () => {
    const h = harness(NEW_HOST)
    h.sync.dispose()
    h.blocks.record('a', rec(5_000, 10), 10)
    expect(h.sent).toEqual([])
  })
})

// Fix round 1, 2: registerIpc cannot run without Electron, so its wiring is guarded by its text.
describe('ipc.ts wires blockSync (S6 Task 3)', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ipc.ts'), 'utf8')
  const at = src.indexOf('const blockSync = createBlockSync({')
  const wiring = src.slice(at, at + 600)
  it('builds it over the index.ts registry', () => {
    expect(at).toBeGreaterThan(-1)
    expect(wiring).toMatch(/blocks: hostWiring\.blocks/)
  })
  it('hands every Host push to pushed', () => {
    expect(wiring).toMatch(/client\.onMessage\(\(m\) => blockSync\.pushed\(m\)\)/)
  })
  it('sends the whole registry on every handshake', () => {
    expect(wiring).toMatch(/client\.onConnect\(\(\) => blockSync\.connected\(\)\)/)
  })
  it('index.ts passes its shared registry into the Host wiring', () => {
    const index = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8')
    const hostWiring = index.slice(index.indexOf('log: hostLog,'), index.indexOf('onHostClientReady'))
    expect(hostWiring).toMatch(/^\s*blocks,\s*$/m)
  })
})
