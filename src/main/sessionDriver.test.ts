import { describe, it, expect, vi } from 'vitest'
import { ptyDriver, chatDriver, routedDriver, ENTER_DELAY_MS } from './sessionDriver'

describe('ptyDriver', () => {
  it('writes the text, then Enter after ENTER_DELAY_MS, and resolves after the Enter', async () => {
    vi.useFakeTimers()
    const written: string[] = []
    const d = ptyDriver({ write: (_id, data) => written.push(data) })
    const p = d.deliver('s1', 'status')
    expect(written).toEqual(['status'])
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS - 1)
    expect(written).toEqual(['status'])
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(written).toEqual(['status', '\r'])
    vi.useRealTimers()
  })

  it('a throwing write rejects and sends no Enter', async () => {
    vi.useFakeTimers()
    const d = ptyDriver({ write: () => { throw new Error('pty gone') } })
    await expect(d.deliver('s1', 'x')).rejects.toThrow('pty gone')
    vi.useRealTimers()
  })
})

describe('chatDriver', () => {
  it('sends the text once, with no Enter, and resolves with the send', async () => {
    const sent: Array<{ id: string; text: string }> = []
    const d = chatDriver({ send: async (id, text) => { sent.push({ id, text }) } })
    await d.deliver('c1', 'status')
    expect(sent).toEqual([{ id: 'c1', text: 'status' }])
  })

  it('a refused send rejects with the CLI reason', async () => {
    const d = chatDriver({ send: async () => { throw new Error('turn in progress') } })
    await expect(d.deliver('c1', 'x')).rejects.toThrow('turn in progress')
  })
})

describe('routedDriver', () => {
  it('asks the kind on every call and routes to the matching driver', async () => {
    const calls: string[] = []
    const pty = { deliver: async (id: string) => { calls.push(`pty:${id}`) } }
    const chat = { deliver: async (id: string) => { calls.push(`chat:${id}`) } }
    const kinds = new Set(['c1'])
    const d = routedDriver((id) => kinds.has(id), pty, chat)
    await d.deliver('c1', 'a')
    await d.deliver('s1', 'b')
    kinds.delete('c1')
    await d.deliver('c1', 'c')
    expect(calls).toEqual(['chat:c1', 'pty:s1', 'pty:c1'])
  })
})
