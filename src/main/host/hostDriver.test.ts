import { describe, it, expect } from 'vitest'
import type { HostMessage } from '../../core/host/protocol'
import type { HostDriverReport } from '../../core/types'
import { createHostDriverView } from './hostDriver'

const NEW_HOST = { connected: true, unresponsive: false, features: ['spawn', 'dispatch', 'driver'] }
const OLD_HOST = { connected: true, unresponsive: false, features: ['spawn', 'dispatch'] }

function harness(status: { connected: boolean; unresponsive: boolean; features: string[] }) {
  const box = { status }
  const told: Array<HostDriverReport | null> = []
  const view = createHostDriverView({ status: () => box.status, changed: (r) => told.push(r), log: () => {} })
  return { box, told, view }
}

const parked = { t: 'driver', driver: 'parked', gate: 'unreadable' } as HostMessage

describe('createHostDriverView (limits L3)', () => {
  it('keeps what a Host that announced driver says, and tells each change once', () => {
    const h = harness(NEW_HOST)
    expect(h.view.current()).toBeNull()
    h.view.pushed(parked)
    h.view.pushed(parked)
    expect(h.view.current()).toEqual({ driver: 'parked', gate: 'unreadable' })
    expect(h.told).toEqual([{ driver: 'parked', gate: 'unreadable' }])
    h.view.pushed({ t: 'driver', driver: 'host', gate: 'migrated' })
    expect(h.told.at(-1)).toEqual({ driver: 'host', gate: 'migrated' })
  })

  it('reads nothing from a Host that did not announce driver, and ignores other messages', () => {
    const h = harness(OLD_HOST)
    h.view.pushed(parked)
    h.view.pushed({ t: 'pong', seq: 1 })
    expect(h.view.current()).toBeNull()
    expect(h.told).toEqual([])
  })

  it('drops a malformed driver message', () => {
    const h = harness(NEW_HOST)
    h.view.pushed({ t: 'driver', driver: 'sideways', gate: 'unreadable' } as unknown as HostMessage)
    h.view.pushed({ t: 'driver', driver: 'parked', gate: 7 } as unknown as HostMessage)
    expect(h.view.current()).toBeNull()
    h.view.pushed({ t: 'driver', driver: 'parked', gate: null })
    expect(h.view.current()).toEqual({ driver: 'parked', gate: null })
  })

  // What a gone Host said is not true of the next one; a Host that merely stopped answering keeps it,
  // and the sidebar puts not answering first anyway (jobsStall).
  it('forgets the report when the connection goes, and keeps it while the Host is only not answering', () => {
    const h = harness(NEW_HOST)
    h.view.pushed(parked)
    h.view.status({ connected: false, unresponsive: true })
    expect(h.view.current()).toEqual({ driver: 'parked', gate: 'unreadable' })
    h.view.status({ connected: false, unresponsive: false })
    expect(h.view.current()).toBeNull()
    expect(h.told.at(-1)).toBeNull()
  })

  it('never throws out of a subscriber', () => {
    const view = createHostDriverView({
      status: () => NEW_HOST,
      changed: () => {
        throw new Error('boom')
      },
      log: () => {
        throw new Error('boom too')
      }
    })
    expect(() => view.pushed(parked)).not.toThrow()
    expect(() => view.status({ connected: false, unresponsive: false })).not.toThrow()
  })
})
