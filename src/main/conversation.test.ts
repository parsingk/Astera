import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { transcriptPathFor, createConversationSessions } from './conversation'

const POLL_MS = 1_000 // matches conversation.ts's own poll tick

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'astera-conv-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** One line that reduces to exactly one real user turn, ids increasing with `n` — same shape
 *  conversationRead.test.ts uses for the same reason (a plain string message, not meta, not a
 *  tool_result). */
function userLine(n: number): string {
  return JSON.stringify({ type: 'user', uuid: `u${n}`, message: { content: `message ${n}` } }) + '\n'
}

// The follow reads real files, so advancing only the fake timer runs the poll before the real fs I/O
// it starts has settled — the same problem, and the same fix, as codexRolloutWatcher.test.ts: advance
// the fake timer, then hand the event loop a few real ticks so the I/O (and anything it schedules
// next) finishes, before advancing again.
const realSetTimeout = setTimeout
const settleIo = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => realSetTimeout(r, 5))
}
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
  await settleIo()
  await vi.advanceTimersByTimeAsync(0)
  await settleIo()
}

describe('transcriptPathFor', () => {
  it('returns the path the payload carries', async () => {
    const p = await transcriptPathFor('s1', {
      readStatusPayload: async () => ({ session_id: 's1', transcript_path: '/a/b.jsonl' })
    })
    expect(p).toBe('/a/b.jsonl')
  })

  it('answers null when the payload has no path', async () => {
    const p = await transcriptPathFor('s1', { readStatusPayload: async () => ({ session_id: 's1' }) })
    expect(p).toBeNull()
  })

  it('answers null when there is no payload at all', async () => {
    const p = await transcriptPathFor('s1', { readStatusPayload: async () => null })
    expect(p).toBeNull()
  })

  it('answers null, not a throw, when the payload is malformed', async () => {
    await expect(
      transcriptPathFor('s1', { readStatusPayload: async () => 'not an object' })
    ).resolves.toBeNull()
  })

  it('answers null, not a throw, when the read itself rejects', async () => {
    await expect(
      transcriptPathFor('s1', {
        readStatusPayload: async () => {
          throw new Error('boom')
        }
      })
    ).resolves.toBeNull()
  })
})

describe('createConversationSessions', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('open on a session with no transcript path answers null and starts no timer', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const sessions = createConversationSessions({
      transcriptPathFor: async () => null,
      emit: vi.fn()
    })
    await expect(sessions.open('s1')).resolves.toBeNull()
    expect(setIntervalSpy).not.toHaveBeenCalled()
  })

  it('open returns the first window and, when the file grows, the next tick emits only the new turns', async () => {
    const p = path.join(dir, 't.jsonl')
    await writeFile(p, userLine(1))
    const emit = vi.fn()
    const sessions = createConversationSessions({ transcriptPathFor: async () => p, emit })

    const opened = await sessions.open('s1')
    expect(opened?.turns.map((t) => t.id)).toEqual(['u1'])

    await appendFile(p, userLine(2))
    await advance(POLL_MS)

    expect(emit).toHaveBeenCalledTimes(1)
    const [sessionId, turns, restarted] = emit.mock.calls[0]
    expect(sessionId).toBe('s1')
    expect(turns.map((t: { id: string }) => t.id)).toEqual(['u2']) // only the new turn, not u1 again
    expect(restarted).toBe(false)
    sessions.closeAll()
  })

  it('more walks backwards and does not repeat what open already returned', async () => {
    const p = path.join(dir, 't.jsonl')
    // Enough lines to exceed readConversationWindow's default tail (256KB), so open() only captures
    // the newest ones and more:true — otherwise the whole file fits in one window and there would be
    // nothing to walk back to.
    let content = ''
    let n = 0
    while (Buffer.byteLength(content, 'utf8') < 300 * 1024) {
      n += 1
      content += userLine(n)
    }
    await writeFile(p, content)

    const sessions = createConversationSessions({ transcriptPathFor: async () => p, emit: vi.fn() })
    const opened = await sessions.open('s1')
    expect(opened).not.toBeNull()
    expect(opened?.more).toBe(true)
    const openedIds = (opened?.turns ?? []).map((t) => Number(t.id.slice(1)))
    const minOpenedId = Math.min(...openedIds)

    const more = await sessions.more('s1', opened!.from)
    expect(more).not.toBeNull()
    expect(more?.turns.length).toBeGreaterThan(0)
    const moreIds = (more?.turns ?? []).map((t) => Number(t.id.slice(1)))
    const maxMoreId = Math.max(...moreIds)

    // Strictly older than everything open() already returned — a repeat of open()'s own window would
    // make this the same (or a larger) id, never smaller.
    expect(maxMoreId).toBeLessThan(minOpenedId)
    sessions.closeAll()
  })

  it('close stops emitting for that session; other open sessions keep emitting', async () => {
    const pA = path.join(dir, 'a.jsonl')
    const pB = path.join(dir, 'b.jsonl')
    await writeFile(pA, userLine(1))
    await writeFile(pB, userLine(1))
    const emit = vi.fn()
    const sessions = createConversationSessions({
      transcriptPathFor: async (id) => (id === 'a' ? pA : pB),
      emit
    })
    await sessions.open('a')
    await sessions.open('b')
    sessions.close('a')

    await appendFile(pA, userLine(2))
    await appendFile(pB, userLine(2))
    await advance(POLL_MS)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toBe('b')
    sessions.closeAll()
  })

  it('the timer starts on the first open and stops on the last close', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const pA = path.join(dir, 'a.jsonl')
    const pB = path.join(dir, 'b.jsonl')
    await writeFile(pA, userLine(1))
    await writeFile(pB, userLine(1))
    const sessions = createConversationSessions({
      transcriptPathFor: async (id) => (id === 'a' ? pA : pB),
      emit: vi.fn()
    })

    await sessions.open('a')
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    await sessions.open('b')
    expect(setIntervalSpy).toHaveBeenCalledTimes(1) // still just the one timer, for both sessions

    sessions.close('a')
    expect(clearIntervalSpy).not.toHaveBeenCalled() // b is still open

    sessions.close('b')
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)

    // Reopening after the timer stopped must arm it again, not find it already running.
    await sessions.open('a')
    expect(setIntervalSpy).toHaveBeenCalledTimes(2)
    sessions.closeAll()
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2)
  })

  it('a file that disappears while open emits nothing and does not throw', async () => {
    const p = path.join(dir, 't.jsonl')
    await writeFile(p, userLine(1))
    const emit = vi.fn()
    const sessions = createConversationSessions({ transcriptPathFor: async () => p, emit })
    await sessions.open('s1')
    await rm(p)

    await expect(advance(POLL_MS)).resolves.not.toThrow()
    expect(emit).not.toHaveBeenCalled()
    sessions.closeAll()
  })

  it('restarted from the follow reaches the emit', async () => {
    const p = path.join(dir, 't.jsonl')
    await writeFile(p, userLine(1) + userLine(2) + userLine(3) + userLine(4) + userLine(5))
    const emit = vi.fn()
    const sessions = createConversationSessions({ transcriptPathFor: async () => p, emit })
    await sessions.open('s1')

    // A much shorter file at the same path — JsonlTail reads this as the file having been recreated
    // (size < the offset the follow was sitting at), not as more content appended.
    await writeFile(p, userLine(1))
    await advance(POLL_MS)

    expect(emit).toHaveBeenCalled()
    const call = emit.mock.calls.find((c) => c[2] === true)
    expect(call).toBeDefined()
    sessions.closeAll()
  })
})
