import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { transcriptPathFor, createConversationSessions } from './conversation'
import { ConversationFollow } from '../core/history/conversationRead'
import type { ConvTurn } from '../core/history/conversation'

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

/** An assistant entry with one unresolved Bash call — `outcome: null` until a matching tool_result
 *  line (below) arrives. */
function toolUseLine(turnId: string, toolId: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      uuid: turnId,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'echo hi' } }] }
    }) + '\n'
  )
}

/** The answer to one `toolUseLine`'s call — a `tool_result`-only user entry, so it patches that
 *  call's outcome rather than becoming a turn of its own (reduceTranscript's own isToolResultOnly
 *  branch, core/history/conversation.ts). */
function toolResultLine(toolId: string, stdout: string): string {
  return (
    JSON.stringify({
      type: 'user',
      uuid: `${toolId}-result`,
      message: { content: [{ type: 'tool_result', tool_use_id: toolId, is_error: false }] },
      toolUseResult: { stdout }
    }) + '\n'
  )
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
  // Restores every spy/mock regardless of whether the test's own assertions threw first — a test that
  // mocks ConversationFollow.prototype.read and then fails before its own cleanup line must not leave
  // that mock's behavior (not just its call log) bleeding into every test that runs after it.
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

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

  // JsonlTail.read() is not re-entrant: it reads its own offset, awaits three fs calls, and only then
  // writes the new offset back — so two overlapping reads both start from the same offset and both
  // return the same lines. Two ticks firing before the first one's fs work has settled is routine, not
  // exotic (several open conversations sharing one tick; a transcript behind a slow disk or an AV
  // scanner) — this reproduces it directly: the fake interval is advanced twice back to back, with no
  // real event-loop turn in between for the first tick's read to finish.
  it('an interval firing again before the previous tick has settled does not emit the same turn twice', async () => {
    const p = path.join(dir, 't.jsonl')
    await writeFile(p, userLine(1))
    const emit = vi.fn()
    const sessions = createConversationSessions({ transcriptPathFor: async () => p, emit })
    await sessions.open('s1')
    await appendFile(p, userLine(2))

    await vi.advanceTimersByTimeAsync(POLL_MS) // starts a read that will not settle before the next line
    await vi.advanceTimersByTimeAsync(POLL_MS) // fires again while that read is still in flight
    await settleIo()
    await vi.advanceTimersByTimeAsync(0)
    await settleIo()

    expect(emit).toHaveBeenCalledTimes(1)
    const [, turns] = emit.mock.calls[0]
    expect(turns.map((t: { id: string }) => t.id)).toEqual(['u2'])
    sessions.closeAll()
  })

  // The real mid-tick close is closeConversationOnExit firing on session:exit from inside main, not a
  // synchronous re-entry from `emit` (that goes through win.webContents.send, which is asynchronous) —
  // so this reproduces it directly: close() the session that is itself still awaiting its own read.
  it('a session closed while its own read is still in flight does not receive that read\'s append', async () => {
    const p = path.join(dir, 't.jsonl')
    await writeFile(p, userLine(1))
    const emit = vi.fn()
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const sessions = createConversationSessions({ transcriptPathFor: async () => p, emit })
    await sessions.open('s1')

    const tickFn = setIntervalSpy.mock.calls[0][0] as () => void
    let resolveRead!: (v: { turns: ConvTurn[]; restarted: boolean } | null) => void
    const readSpy = vi
      .spyOn(ConversationFollow.prototype, 'read')
      .mockImplementation(() => new Promise((resolve) => (resolveRead = resolve)))

    tickFn() // begins this tick's read for s1, which the mock leaves pending
    expect(readSpy).toHaveBeenCalledTimes(1)

    sessions.close('s1') // the pty exited (or the tab closed) while this read was still in flight
    resolveRead({ turns: [{ id: 'u2', role: 'user', parts: [{ kind: 'text', text: 'message 2' }] }], restarted: false })
    await Promise.resolve()
    await Promise.resolve()

    expect(emit).not.toHaveBeenCalled()
    readSpy.mockRestore()
    sessions.closeAll()
  })

  // A build, a test run, a long Bash: the tool_use line is written immediately and the tool_result
  // lands minutes later, in a separate read as a matter of course — not an edge case.
  it('a tool result that lands in a later read updates the turn that is still waiting on it', async () => {
    const p = path.join(dir, 't.jsonl')
    await writeFile(p, toolUseLine('a1', 'tool1'))
    const emit = vi.fn()
    const sessions = createConversationSessions({ transcriptPathFor: async () => p, emit })

    const opened = await sessions.open('s1')
    const turn = opened?.turns.find((t) => t.id === 'a1')
    expect(turn?.parts[0]).toMatchObject({ kind: 'tool', id: 'tool1', outcome: null })

    await appendFile(p, toolResultLine('tool1', 'hi\n'))
    await advance(POLL_MS)

    expect(emit).toHaveBeenCalledTimes(1)
    const [sessionId, turns, restarted] = emit.mock.calls[0]
    expect(sessionId).toBe('s1')
    expect(restarted).toBe(false)
    const updated = turns.find((t: { id: string }) => t.id === 'a1')
    expect(updated).toBeDefined()
    expect(updated.parts[0]).toEqual({
      kind: 'tool',
      id: 'tool1',
      name: 'Bash',
      target: 'echo hi',
      outcome: { ok: true, detail: '1 lines' }
    })
    sessions.closeAll()
  })
})
