import { describe, it, expect } from 'vitest'
import { writeRollSnapshotTo } from './rollSnapshotSink'

describe('writeRollSnapshotTo (chat takeover spec §3.3)', () => {
  it('writes a chat chain snapshot into the chat proc note, and a pty chain into the pty note', () => {
    const calls: string[] = []
    const d = { isChat: (id: string) => id === 'c1', rememberChat: (id: string) => calls.push(`chat ${id}`), rememberPty: (id: string) => calls.push(`pty ${id}`) }
    writeRollSnapshotTo('c1', { v: 1 } as never, d)
    writeRollSnapshotTo('s1', { v: 1 } as never, d)
    expect(calls).toEqual(['chat c1', 'pty s1'])
  })
})
