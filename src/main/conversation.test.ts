import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { transcriptPathFor, createConversationSessions } from './conversation'
import { ConversationFollow } from '../core/history/conversationRead'
import type { ConvPart, ConvTurn } from '../core/history/conversation'

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

/** An assistant entry carrying only a text part, the start of a run a following toolUseLine (below)
 *  continues — the real shape ("Let me run the build." then Bash), not a synthetic one-part turn. */
function textLine(turnId: string, text: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      uuid: turnId,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { content: [{ type: 'text', text }] }
    }) + '\n'
  )
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
      sourceFor: async () => null,
      emit: vi.fn()
    })
    await expect(sessions.open('s1')).resolves.toBeNull()
    expect(setIntervalSpy).not.toHaveBeenCalled()
  })

  it('open returns the first window and, when the file grows, the next tick emits only the new turns', async () => {
    const p = path.join(dir, 't.jsonl')
    await writeFile(p, userLine(1))
    const emit = vi.fn()
    const sessions = createConversationSessions({ sourceFor: async () => ({ path: p, format: 'claude' }), emit })

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

    const sessions = createConversationSessions({ sourceFor: async () => ({ path: p, format: 'claude' }), emit: vi.fn() })
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
      sourceFor: async (id: string) => ({ path: id === 'a' ? pA : pB, format: 'claude' as const }),
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
      sourceFor: async (id: string) => ({ path: id === 'a' ? pA : pB, format: 'claude' as const }),
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
    const sessions = createConversationSessions({ sourceFor: async () => ({ path: p, format: 'claude' }), emit })
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
    const sessions = createConversationSessions({ sourceFor: async () => ({ path: p, format: 'claude' }), emit })
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
    const sessions = createConversationSessions({ sourceFor: async () => ({ path: p, format: 'claude' }), emit })
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
    const sessions = createConversationSessions({ sourceFor: async () => ({ path: p, format: 'claude' }), emit })
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
  // lands minutes later, in a separate read as a matter of course — not an edge case. The turn has
  // two parts (text, then the call), not one: a one-part fixture cannot tell "the whole turn was
  // re-emitted" apart from "only the changed part was" — under the latter, a renderer told to replace
  // by id would drop the assistant's own text the moment the call resolved.
  it('a tool result that lands in a later read re-emits the whole turn, not only the resolved part', async () => {
    const p = path.join(dir, 't.jsonl')
    await writeFile(p, textLine('a1', 'Let me run the build.') + toolUseLine('a1', 'tool1'))
    const emit = vi.fn()
    const sessions = createConversationSessions({ sourceFor: async () => ({ path: p, format: 'claude' }), emit })

    const opened = await sessions.open('s1')
    const turn = opened?.turns.find((t) => t.id === 'a1')
    expect(turn?.parts).toEqual([
      { kind: 'text', text: 'Let me run the build.' },
      { kind: 'tool', id: 'tool1', name: 'Bash', target: 'echo hi', outcome: null }
    ])

    await appendFile(p, toolResultLine('tool1', 'hi\n'))
    await advance(POLL_MS)

    expect(emit).toHaveBeenCalledTimes(1)
    const [sessionId, turns, restarted] = emit.mock.calls[0]
    expect(sessionId).toBe('s1')
    expect(restarted).toBe(false)
    const updated = turns.find((t: { id: string }) => t.id === 'a1')
    expect(updated).toBeDefined()
    // Both parts, not only the one that changed — the text part unchanged, the tool part now resolved.
    expect(updated.parts).toEqual([
      { kind: 'text', text: 'Let me run the build.' },
      { kind: 'tool', id: 'tool1', name: 'Bash', target: 'echo hi', outcome: { ok: true, detail: '1 lines' } }
    ])
    sessions.closeAll()
  })

  // accountUsage.ts's own poller — the shape this one's guard was copied from — wires its tick as
  // `void tick().catch(() => {})` because an unhandled rejection can terminate the process; a rejecting
  // read must not escape that way here either. Caught directly via Node's own `unhandledRejection`
  // event, not inferred from a side effect, since a missing `.catch` leaves no other trace within one
  // test run.
  it('a rejecting read does not escape as an unhandled rejection', async () => {
    const p = path.join(dir, 't.jsonl')
    await writeFile(p, userLine(1))
    const sessions = createConversationSessions({ sourceFor: async () => ({ path: p, format: 'claude' }), emit: vi.fn() })
    await sessions.open('s1')

    vi.spyOn(ConversationFollow.prototype, 'read').mockRejectedValue(new Error('boom'))
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)
    try {
      await advance(POLL_MS)
      await new Promise((r) => realSetTimeout(r, 10)) // give a genuinely unhandled rejection time to surface
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(onUnhandled).not.toHaveBeenCalled()
    sessions.closeAll()
  })

  // A wedged fs read (a network path, OneDrive, an AV filter driver — none of it has a timeout of its
  // own, unlike accountUsage.ts's HTTP fetch) must stall only the session it belongs to. Reproduced by
  // making the very first ConversationFollow.read() call in the test hang forever and letting every
  // later call through to the real implementation — the first call is always session 'a' (opened
  // first, ticked first), so 'a' wedges on tick one and never advances, while 'b' keeps going.
  it('a wedged read stalls only its own session; every other open conversation keeps emitting', async () => {
    const pA = path.join(dir, 'a.jsonl')
    const pB = path.join(dir, 'b.jsonl')
    await writeFile(pA, userLine(1))
    await writeFile(pB, userLine(1))
    const emit = vi.fn()
    const sessions = createConversationSessions({
      sourceFor: async (id: string) => ({ path: id === 'a' ? pA : pB, format: 'claude' as const }),
      emit
    })
    await sessions.open('a')
    await sessions.open('b')

    const originalRead = ConversationFollow.prototype.read
    let calls = 0
    vi.spyOn(ConversationFollow.prototype, 'read').mockImplementation(function (
      this: ConversationFollow,
      ...args: Parameters<typeof originalRead>
    ) {
      calls += 1
      if (calls === 1) return new Promise(() => {}) // 'a's first read — never settles
      return originalRead.apply(this, args)
    })

    for (let i = 2; i <= 11; i++) {
      await appendFile(pB, userLine(i))
      await advance(POLL_MS)
    }

    expect(emit.mock.calls.length).toBeGreaterThan(0)
    expect(emit.mock.calls.every((c) => c[0] === 'b')).toBe(true) // 'a' never once got through
    sessions.closeAll()
  })

  // A retention leak has no other observable trace (the emitted turns look the same either way), so
  // this asserts the count directly via retainedCount, added to the interface for exactly this.
  it('retention shrinks back to zero once every unresolved call resolves', async () => {
    const p = path.join(dir, 't.jsonl')
    await writeFile(p, toolUseLine('a1', 'tool1') + toolUseLine('a1', 'tool2'))
    const emit = vi.fn()
    const sessions = createConversationSessions({ sourceFor: async () => ({ path: p, format: 'claude' }), emit })
    await sessions.open('s1')
    expect(sessions.retainedCount('s1')).toBe(2) // one entry per outstanding call, tool1 and tool2

    // The counts alone would pass even if the wrong call were resolved: two outstanding calls
    // resolved in either order shrink 2 to 1 to 0 just the same. So each step also asserts WHICH
    // call carries an outcome now, which is the thing an id-matching bug would get wrong.
    const outcomes = (): Array<string | null> => {
      const last = emit.mock.calls[emit.mock.calls.length - 1]
      const turn = (last[1] as ConvTurn[])[0]
      return turn.parts
        .filter((part): part is Extract<ConvPart, { kind: 'tool' }> => part.kind === 'tool')
        .map((part) => part.outcome?.detail ?? null)
    }

    // tool2 is answered FIRST, on purpose. Resolving in insertion order would land on tool1 and
    // still shrink the count to 1, so a pairing bug that goes by order only shows up out of order.
    await appendFile(p, toolResultLine('tool2', 'bye\n'))
    await advance(POLL_MS)
    expect(sessions.retainedCount('s1')).toBe(1) // tool1 is still outstanding, on the same turn
    expect(outcomes()).toEqual([null, '1 lines']) // tool2 answered, tool1 not

    await appendFile(p, toolResultLine('tool1', 'hi\n'))
    await advance(POLL_MS)
    expect(sessions.retainedCount('s1')).toBe(0) // nothing left unresolved — nothing left retained
    expect(outcomes()).toEqual(['1 lines', '1 lines'])
    sessions.closeAll()
  })

  // The post-await guard compares the entry, not just the id. Membership alone would let a read
  // started before a close finish afterwards and hand its turns to the conversation that reopened
  // in the meantime — a different conversation that happens to share a session id.
  it('a read still in flight from a closed conversation does not emit into the reopened one', async () => {
    const p = path.join(dir, 't.jsonl')
    await writeFile(p, userLine(1))
    const emit = vi.fn()
    const sessions = createConversationSessions({ sourceFor: async () => ({ path: p, format: 'claude' }), emit })
    await sessions.open('s1')

    // Hold the first tick's read open, so the close and the reopen both land while it is unsettled.
    let release: ((v: { turns: ConvTurn[]; restarted: boolean } | null) => void) | null = null
    const originalRead = ConversationFollow.prototype.read
    let calls = 0
    vi.spyOn(ConversationFollow.prototype, 'read').mockImplementation(function (
      this: ConversationFollow,
      ...args: Parameters<typeof originalRead>
    ) {
      calls += 1
      if (calls === 1) return new Promise((resolve) => (release = resolve))
      return originalRead.apply(this, args)
    })

    await appendFile(p, userLine(2))
    await advance(POLL_MS)
    expect(release).not.toBeNull() // the first read really is held

    sessions.close('s1')
    await sessions.open('s1')
    emit.mockClear()

    // Now let the read from the closed conversation finish, carrying a turn.
    release!({ turns: [{ id: 'stale', role: 'user', parts: [{ kind: 'text', text: 'stale' }] }], restarted: false })
    await settleIo()
    expect(emit).not.toHaveBeenCalled()
    sessions.closeAll()
  })

  // Each session's `pending` Map is its own (created fresh in `open`), never a Map shared across
  // sessions — this pins that: two sessions with calls under the *same* tool_use_id, and only one of
  // them resolved. A shared Map would resolve both from the one tool_result.
  it('one session\'s tool result cannot resolve a different session\'s call, even with the same id', async () => {
    const pA = path.join(dir, 'a.jsonl')
    const pB = path.join(dir, 'b.jsonl')
    await writeFile(pA, toolUseLine('a1', 'tool1'))
    await writeFile(pB, toolUseLine('b1', 'tool1'))
    const emit = vi.fn()
    const sessions = createConversationSessions({
      sourceFor: async (id: string) => ({ path: id === 'a' ? pA : pB, format: 'claude' as const }),
      emit
    })
    await sessions.open('a')
    await sessions.open('b')
    expect(sessions.retainedCount('a')).toBe(1)
    expect(sessions.retainedCount('b')).toBe(1)

    await appendFile(pA, toolResultLine('tool1', 'hi\n')) // resolves only a's own call
    await advance(POLL_MS)

    // Checked on the actual emitted content, not just retainedCount's map sizes: a Map shared between
    // sessions would still shrink each session's own retainedCount back to the right-looking number,
    // because it is a's own `open` that first claimed the shared 'tool1' key and b's `open` overwrote
    // it — the outcome that lands is decided by *whose ToolPart the shared map points at*, not by
    // which session's file the tool_result actually came from, and retainedCount cannot see that.
    const aCall = emit.mock.calls.find((c) => c[0] === 'a')
    expect(aCall).toBeDefined()
    const aTurn = (aCall![1] as { id: string; parts: { outcome: unknown }[] }[]).find((t) => t.id === 'a1')
    expect(aTurn?.parts[0].outcome).toEqual({ ok: true, detail: '1 lines' }) // a's own call actually resolved

    expect(sessions.retainedCount('a')).toBe(0)
    expect(sessions.retainedCount('b')).toBe(1) // b's own call, same id, is untouched
    sessions.closeAll()
  })
})
