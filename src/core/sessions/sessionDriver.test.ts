import { afterEach, describe, it, expect, vi } from 'vitest'
import { ptyDriver, chatDriver, routedDriver, ENTER_DELAY_MS, ENTER_QUIET_MS, ENTER_MAX_WAIT_MS } from './sessionDriver'

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

  // Found on the dev app: Codex takes a fast run of keys as a paste and turns an Enter within 120 ms of its last key
  // into a newline, and a long text reaches it later than it was written, so Enter at 150 ms left it unsent
  describe('with the time of the session’s last output', () => {
    afterEach(() => vi.useRealTimers())
    const rig = () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      const written: Array<[number, string]> = []
      let last: number | null = -1000
      const d = ptyDriver({ write: (_id, data) => written.push([Date.now(), data]), lastOutputAt: () => last })
      return { written, d, output: (at: number) => (last = at), enterAt: () => written.find(([, w]) => w === '\r')?.[0] }
    }

    it('sends Enter once the session has shown the text and gone quiet, not at a fixed delay', async () => {
      const r = rig()
      const p = r.d.deliver('s1', 'a long instruction')
      for (const at of [50, 180, 300]) {
        await vi.advanceTimersByTimeAsync(at - Date.now())
        r.output(at)
      }
      await vi.advanceTimersByTimeAsync(ENTER_QUIET_MS - 1)
      expect(r.enterAt()).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(r.enterAt()).toBe(300 + ENTER_QUIET_MS)
      vi.useRealTimers()
    })

    it('waits for output after the text was written: a screen quiet from before does not count', async () => {
      const r = rig()
      const p = r.d.deliver('s1', 'a long instruction')
      await vi.advanceTimersByTimeAsync(400)
      expect(r.enterAt()).toBeUndefined()
      r.output(400)
      await vi.advanceTimersByTimeAsync(ENTER_QUIET_MS)
      await p
      expect(r.enterAt()).toBe(400 + ENTER_QUIET_MS)
      vi.useRealTimers()
    })

    it('sends Enter after ENTER_MAX_WAIT_MS when the screen never settles (a spinner)', async () => {
      const r = rig()
      const p = r.d.deliver('s1', 'a long instruction')
      for (let at = 50; at < ENTER_MAX_WAIT_MS + 1000 && r.enterAt() === undefined; at += 50) {
        await vi.advanceTimersByTimeAsync(at - Date.now())
        r.output(at)
      }
      await p
      expect(r.enterAt()).toBe(ENTER_MAX_WAIT_MS)
      vi.useRealTimers()
    })
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

  it('a send that knows nothing of the id rejects — the "or the session is gone" half of the contract', async () => {
    // The chat manager's own `send` resolves for an id it does not know, which would read as "delivered"
    // to everything downstream: the scheduler would zero its refusal count, and 4b's Slack path and 4c's
    // rolling prompt both treat a resolve as sent. So index.ts composes this driver with a core.chat.has
    // guard in front of the manager, and what it hands in is a send shaped like the one below. This pins
    // the driver's end of that contract — a live id resolves, a gone one rejects, and the reason travels
    // out of deliver unchanged.
    const live = new Set(['c1'])
    const d = chatDriver({
      send: (id) => (live.has(id) ? Promise.resolve() : Promise.reject(new Error(`no chat session: ${id}`)))
    })
    await expect(d.deliver('c1', 'x')).resolves.toBeUndefined()
    live.delete('c1') // the session exits between one round and the next
    await expect(d.deliver('c1', 'x')).rejects.toThrow('no chat session: c1')
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

// Observe deferred fix round 2, Important a: a delivery made for a person (a Slack reply) carries the mark down to the
// write, through either driver, so the Host can tell the prompt was a person's; any other delivery carries none
describe('a delivery made for a person', () => {
  it('passes the mark to the pty’s writes and to the chat’s send, and none for any other delivery', async () => {
    vi.useFakeTimers()
    const writes: Array<[string, unknown]> = []
    const sends: Array<[string, unknown]> = []
    const d = routedDriver(
      (id) => id === 'c1',
      ptyDriver({ write: (_id, data, by) => void writes.push([data, by]) }),
      chatDriver({ send: async (_id, text, by) => void sends.push([text, by]) })
    )
    const typed = d.deliver('s1', 'hi', { person: true })
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS)
    await typed
    await d.deliver('c1', 'hello', { person: true })
    await d.deliver('c1', 'scheduled')
    vi.useRealTimers()
    expect(writes).toEqual([
      ['hi', { person: true }],
      ['\r', { person: true }]
    ])
    expect(sends).toEqual([
      ['hello', { person: true }],
      ['scheduled', undefined]
    ])
  })
})
