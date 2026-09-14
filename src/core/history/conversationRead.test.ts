import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  readConversationWindow,
  ConversationFollow,
  CONVERSATION_TAIL_BYTES,
  CONVERSATION_TAIL_BYTES_MAX
} from './conversationRead'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'conv-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** The actual UTF-8 byte length of a string. A JS string's own `.length` counts UTF-16 units, which is
 *  NOT the same number for anything outside ASCII — every offset built or asserted in these tests has
 *  to be a byte count, since that is what the file on disk, and `readConversationWindow`, actually work
 *  in. Using `.length` here is exactly the bug this fix round found. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** One line that reduces to exactly one turn (a real, non-meta user message), in Korean — Astera's
 *  transcripts are largely Korean, so this is the ordinary case for these tests, not a special one.
 *  Every caller that needs an offset must go through `byteLen(...)`: a Hangul syllable below is 3 UTF-8
 *  bytes but 1 UTF-16 unit, so `.length` undercounts it. */
function userLine(n: number): string {
  return JSON.stringify({ type: 'user', uuid: `u${n}`, message: { content: `메시지 ${n}` } }) + '\n'
}

/** The deliberately ASCII case — kept once so the (byte length === UTF-16 length) case is still
 *  exercised, not just the Korean one that is now the default above. */
function asciiUserLine(n: number): string {
  return JSON.stringify({ type: 'user', uuid: `u${n}`, message: { content: `message ${n}` } }) + '\n'
}

/** A user entry carrying only a tool_result, sized to `size` bytes of filler — mimics a real oversized
 *  line: an image Read result, whose toolUseResult.file.base64 is what actually makes a JSONL line run
 *  past a megabyte in practice. It never becomes a turn on its own — reduceTranscript only uses a
 *  tool_result to patch a pending tool call's outcome, and none of these tests have that call pending
 *  — so any turn a widened read returns around one of these lines can only have come from the ordinary
 *  lines beside it, not from this one. */
function bigToolResultLine(size: number): string {
  return (
    JSON.stringify({
      type: 'user',
      uuid: 'big',
      message: { content: [{ type: 'tool_result', tool_use_id: 'not-pending-in-this-window', content: 'x'.repeat(size) }] }
    }) + '\n'
  )
}

describe('readConversationWindow', () => {
  it('a missing file gives null', async () => {
    const result = await readConversationWindow(path.join(dir, 'missing.jsonl'))
    expect(result).toBeNull()
  })

  it('an empty file gives zero turns and does not throw', async () => {
    const p = path.join(dir, 'empty.jsonl')
    await writeFile(p, '')
    const result = await readConversationWindow(p)
    expect(result).toEqual({ turns: [], from: 0, more: false, follow: 0 })
  })

  it('a file smaller than the window: all turns, from 0, more false (the deliberately ASCII case)', async () => {
    const p = path.join(dir, 'small.jsonl')
    const content = asciiUserLine(1) + asciiUserLine(2) + asciiUserLine(3)
    await writeFile(p, content)
    const result = await readConversationWindow(p, { tailBytes: byteLen(content) + 100 })
    expect(result?.from).toBe(0)
    expect(result?.more).toBe(false)
    expect(result?.turns.map((t) => t.id)).toEqual(['u1', 'u2', 'u3'])
  })

  // Measured 2026-09-12: a session with one "안녕" and its answer had already written 296KB, because
  // Claude writes attachments and file-history snapshots beside the turns. The last 256KB of it held
  // the answer alone, and the view drew an answer to a question that was not on screen.
  it('widens past a window holding only an answer, until what was said is in it', async () => {
    const said = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: '안녕' }
    })
    const bulk = JSON.stringify({ type: 'file-history-snapshot', blob: 'x'.repeat(4_000) })
    const answered = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      message: { role: 'assistant', content: [{ type: 'text', text: '안녕하세요' }] }
    })
    const p = path.join(dir, 'padded.jsonl')
    await writeFile(p, [said, bulk, answered].join('\n') + '\n')

    const narrow = await readConversationWindow(p, { tailBytes: 2_000, anyTurnWillDo: true })
    expect(narrow?.turns.map((t) => t.role)).toEqual(['assistant'])

    const result = await readConversationWindow(p, { tailBytes: 2_000 })
    expect(result?.turns.map((t) => t.role)).toEqual(['user', 'assistant'])
  })

  it('a window that starts mid-file discards the partial first line', async () => {
    const p = path.join(dir, 'mid.jsonl')
    const l1 = userLine(1)
    const l2 = userLine(2)
    const l3 = userLine(3)
    await writeFile(p, l1 + l2 + l3)
    // Big enough for all of l3 plus roughly half of l2, so the window starts mid l2, not on a line
    // boundary — the case this behaviour exists for.
    const tailBytes = byteLen(l3) + Math.floor(byteLen(l2) / 2)
    // anyTurnWillDo: this one is about what a window does with a half-line at its front, and the
    // default — widen until something a person said is in view — would widen past the window it is
    // testing.
    const result = await readConversationWindow(p, { tailBytes, anyTurnWillDo: true })
    expect(result?.more).toBe(true)
    expect(result?.from).toBeGreaterThan(0)
    // The partial l2 fragment is dropped; only the complete line after it (l3) is reduced.
    expect(result?.turns.map((t) => t.id)).toEqual(['u3'])
    // `from` lands exactly at the start of l3 — right after l2's newline, not somewhere inside l2.
    expect(result?.from).toBe(byteLen(l1) + byteLen(l2))
  })

  it('endAt walks backwards: the window before `from` has the earlier entries, none repeated', async () => {
    const p = path.join(dir, 'walk.jsonl')
    const l1 = userLine(1)
    const l2 = userLine(2)
    const l3 = userLine(3)
    await writeFile(p, l1 + l2 + l3)
    const tailBytes = byteLen(l3) + Math.floor(byteLen(l2) / 2)
    const first = await readConversationWindow(p, { tailBytes })
    expect(first?.turns.map((t) => t.id)).toEqual(['u3'])

    const second = await readConversationWindow(p, { anyTurnWillDo: true, tailBytes: 10_000, endAt: first!.from })
    expect(second?.turns.map((t) => t.id)).toEqual(['u1', 'u2']) // the entries before `from`, not u3 again
    expect(second?.from).toBe(0)
    expect(second?.more).toBe(false)
  })

  it('endAt combined with a small tailBytes actually clamps against endAt, not the file\'s full size', async () => {
    // Regression test for a mutation that survived the previous round: "start uses `size` instead of
    // `end`". Both prior endAt tests pass a tailBytes bigger than the whole file, so `start` clamps to
    // 0 either way and never actually exercises which variable it was computed from. This is the
    // production "load earlier" path: a small tailBytes and an endAt in the middle of a longer file.
    const p = path.join(dir, 'endattail.jsonl')
    const l1 = userLine(1)
    const l2 = userLine(2)
    const l3 = userLine(3)
    const l4 = userLine(4)
    await writeFile(p, l1 + l2 + l3 + l4)

    const endAt = byteLen(l1) + byteLen(l2) // stop right after l2 — l3/l4 are past this point
    const tailBytes = byteLen(l2) + 3 // enough to reach a few bytes into l1, nowhere near l3/l4
    const result = await readConversationWindow(p, { tailBytes, endAt })
    expect(result).not.toBeNull()
    // If `start` were computed from the file's full size instead of `endAt`, it would land near the
    // true end of the file (inside l3/l4, past `end`), making `length <= 0` and the result empty —
    // this assertion is what catches that, not the loop below (which is vacuously true on an empty
    // array).
    expect(result!.turns.length).toBeGreaterThan(0)
    // And every turn that does come back must be from before `endAt` — never u3 or u4, which only
    // exist past it.
    for (const t of result!.turns) expect(['u1', 'u2']).toContain(t.id)
    expect(result!.follow).toBe(endAt) // follow reflects the requested endAt, not the file's true end
  })

  it('endAt past EOF is clamped: follow never exceeds the real file size, and a resumed follow sees no spurious restart', async () => {
    const p = path.join(dir, 'pasteof.jsonl')
    const content = userLine(1) + userLine(2)
    await writeFile(p, content)
    const size = byteLen(content)

    const result = await readConversationWindow(p, { tailBytes: 10_000, endAt: size + 1000 })
    expect(result).not.toBeNull()
    // No corrupted extra entries from Buffer.alloc's zero-filled padding leaking into the decoded text.
    expect(result!.turns.map((t) => t.id)).toEqual(['u1', 'u2'])
    expect(result!.follow).toBe(size) // clamped to the real end, not the requested (past-EOF) endAt

    // A `follow` value past the real file size is what makes JsonlTail see `size < offset` and treat
    // the file as recreated — replaying (and duplicating) everything. Confirms that does not happen.
    const follow = new ConversationFollow(p, result!.follow)
    const read = await follow.read()
    expect(read?.restarted).toBe(false)
  })

  it('endAt astronomically far past EOF still finds the real file, not a nonsensical offset', async () => {
    // A modest overshoot (the test above, `size + 1000`) is already caught by the bytesRead fix alone:
    // `start` still computes to 0 there (tailBytes covers the whole inflated window), so the read still
    // lands on real content and only `bytesRead` ends up short. This case is different — `endAt` is so
    // far past the real size that `start = end - tailBytes` is ALSO nonsensical (nowhere near the real
    // file), so without clamping `end` first, every read in the widening loop lands past true EOF,
    // returns zero bytes every time, and the call gives up at the cap having never seen the real content
    // at all — not a crash, just silently wrong.
    const p = path.join(dir, 'hugeend.jsonl')
    const content = userLine(1)
    await writeFile(p, content)
    const result = await readConversationWindow(p, { endAt: Number.MAX_SAFE_INTEGER })
    expect(result).not.toBeNull()
    expect(result!.turns.map((t) => t.id)).toEqual(['u1'])
    expect(result!.from).toBeLessThanOrEqual(byteLen(content))
    expect(result!.follow).toBeLessThanOrEqual(byteLen(content))
  })

  it('follow equals the end of the window when the window ends on a complete line', async () => {
    const p = path.join(dir, 'follow.jsonl')
    const content = userLine(1) + userLine(2)
    await writeFile(p, content)
    const result = await readConversationWindow(p)
    expect(result?.follow).toBe(byteLen(content))

    // Same for a windowed (endAt) read that itself lands exactly at a line boundary — follow is that
    // window's end, not the file's current end.
    const l1 = userLine(1)
    const partial = await readConversationWindow(p, { tailBytes: 10_000, endAt: byteLen(l1) })
    expect(partial?.follow).toBe(byteLen(l1))
  })

  it('follow stops before a half-written trailing line, so a resumed follow does not lose it', async () => {
    // The live-session case this module exists for: the file's last line is still being written at the
    // moment the window is read. `follow` used to be `end` unconditionally, which put a resumed
    // ConversationFollow's empty carry right in the middle of that record — the writer would finish the
    // line and append another, and only the later one would ever render. The half-written record was
    // lost for good.
    const p = path.join(dir, 'halfwritten.jsonl')
    const complete = userLine(1)
    const nextLineFull = JSON.stringify({ type: 'user', uuid: 'u2', message: { content: '메시지 2' } })
    const half = nextLineFull.slice(0, Math.floor(nextLineFull.length / 2)) // no trailing newline yet
    await writeFile(p, complete + half)

    const result = await readConversationWindow(p)
    expect(result).not.toBeNull()
    expect(result!.turns.map((t) => t.id)).toEqual(['u1']) // the half-written u2 cannot reduce yet
    expect(result!.follow).toBe(byteLen(complete)) // stops right after the last COMPLETE line, not at `end`

    const follow = new ConversationFollow(p, result!.follow)
    await appendFile(p, nextLineFull.slice(half.length) + '\n') // the writer finishes the line…
    await appendFile(p, userLine(3)) // …and appends another
    const followed = await follow.read()
    expect(followed?.turns.map((t) => t.id)).toEqual(['u2', 'u3']) // u2 is not lost
  })

  it('CONVERSATION_TAIL_BYTES is the default window when tailBytes is omitted', async () => {
    const p = path.join(dir, 'default.jsonl')
    const content = userLine(1)
    await writeFile(p, content)
    const result = await readConversationWindow(p)
    // The whole (tiny) file fits well within the default window, so nothing is trimmed off the front.
    expect(CONVERSATION_TAIL_BYTES).toBeGreaterThan(byteLen(content))
    expect(result?.from).toBe(0)
  })
})

describe('readConversationWindow — widening past an oversized line', () => {
  it('a last line bigger than the initial tailBytes still returns the ordinary turns before it', async () => {
    const p = path.join(dir, 'oversized.jsonl')
    const ordinary = [userLine(1), userLine(2), userLine(3), userLine(4), userLine(5)].join('')
    const big = bigToolResultLine(5000) // comfortably bigger than the tiny tailBytes requested below
    await writeFile(p, ordinary + big)

    const result = await readConversationWindow(p, { tailBytes: 20 }) // far smaller than `big` alone
    expect(result).not.toBeNull()
    expect(result!.turns.length).toBeGreaterThan(0) // not the empty result the bug produced
    // Every returned turn must be one of the ordinary lines — `big` never becomes a turn itself — so a
    // non-empty result here can only have come from widening past it.
    const ordinaryIds = new Set(['u1', 'u2', 'u3', 'u4', 'u5'])
    for (const t of result!.turns) expect(ordinaryIds.has(t.id)).toBe(true)
  })

  it('widening stops at the cap: paging keeps advancing rather than getting stuck', async () => {
    const p = path.join(dir, 'onegiant.jsonl')
    const ordinary = [userLine(1), userLine(2), userLine(3)].join('')
    const big = bigToolResultLine(CONVERSATION_TAIL_BYTES_MAX + 100_000) // one line, bigger than the cap
    const content = ordinary + big
    await writeFile(p, content)

    // Completing at all — resolving rather than reading without bound — is itself under test.
    const first = await readConversationWindow(p)
    expect(first).not.toBeNull()
    expect(first!.turns).toEqual([]) // the cap is reached before the window ever reaches the ordinary lines
    expect(first!.more).toBe(true)
    // `from` must be strictly before `endAt` (the file's end, since no endAt was given) — not stuck at
    // it. Before this fix, `from` landed on `end` here (the only newline found was `big`'s own trailing
    // one), so a caller retrying with `endAt: from` would repeat the identical read forever.
    expect(first!.from).toBeLessThan(byteLen(content))
    expect(first!.from).toBeGreaterThan(0)

    // Paging backward with that `from` must actually reach the earlier, ordinary turns — not return the
    // same stuck empty window again.
    const second = await readConversationWindow(p, { endAt: first!.from })
    expect(second).not.toBeNull()
    expect(second!.turns.map((t) => t.id)).toEqual(['u1', 'u2', 'u3'])
  })

  it('from and follow after widening point at the window actually used — no repeats, nothing lost', async () => {
    const p = path.join(dir, 'oversized2.jsonl')
    const n = 20
    const ordinary = Array.from({ length: n }, (_, i) => userLine(i + 1)).join('')
    const big = bigToolResultLine(500) // bigger than the tiny tailBytes requested below
    const content = ordinary + big
    await writeFile(p, content)

    const first = await readConversationWindow(p, { tailBytes: 20 })
    expect(first).not.toBeNull()
    expect(first!.turns.length).toBeGreaterThan(0) // widening actually found something
    expect(first!.follow).toBe(byteLen(content)) // follow tracks the last complete line, which is `end` here

    // A ConversationFollow resumed at `first.follow` sees nothing new yet — the widened window already
    // reached the file's current end.
    const follow = new ConversationFollow(p, first!.follow)
    expect((await follow.read())?.turns).toEqual([])

    // Walk backwards from `first.from`. This must not repeat anything `first` already returned, and
    // together the two calls must cover every ordinary turn exactly once — whatever the widened
    // window's own boundary happened to drop (see readConversationWindow's "same simplification" note)
    // falls inside this next older window instead, since that window ends exactly at `first.from`.
    const second = await readConversationWindow(p, { tailBytes: byteLen(content), endAt: first!.from })
    const firstIds = first!.turns.map((t) => t.id)
    const secondIds = second!.turns.map((t) => t.id)
    for (const id of firstIds) expect(secondIds).not.toContain(id)
    const allIds = new Set([...firstIds, ...secondIds])
    expect(allIds).toEqual(new Set(Array.from({ length: n }, (_, i) => `u${i + 1}`)))
  })
})

describe('ConversationFollow', () => {
  it('a missing file gives null', async () => {
    const follow = new ConversationFollow(path.join(dir, 'missing.jsonl'), 0)
    expect(await follow.read()).toBeNull()
  })

  it('nothing appended gives no turns; after an append, only the appended turns come back', async () => {
    const p = path.join(dir, 'live.jsonl')
    await writeFile(p, userLine(1))
    const follow = new ConversationFollow(p, byteLen(userLine(1)))

    const first = await follow.read()
    expect(first?.turns).toEqual([])
    expect(first?.restarted).toBe(false)

    await appendFile(p, userLine(2))
    const second = await follow.read()
    expect(second?.turns.map((t) => t.id)).toEqual(['u2']) // not u1 again
  })

  it('a file recreated shorter reports restarted: true and returns the new content', async () => {
    const p = path.join(dir, 'recreate.jsonl')
    const original = userLine(1) + userLine(2) + userLine(3)
    await writeFile(p, original)
    const follow = new ConversationFollow(p, byteLen(original))

    await writeFile(p, userLine(9)) // recreated, shorter than the offset the follow started at
    const result = await follow.read()
    expect(result?.restarted).toBe(true)
    expect(result?.turns.map((t) => t.id)).toEqual(['u9'])
  })

  it('a last line with no trailing newline is not reduced until the newline arrives', async () => {
    // This is the carry behaviour JsonlTail exists for — it is why ConversationFollow wraps JsonlTail
    // instead of doing its own byte read.
    const p = path.join(dir, 'partial.jsonl')
    await writeFile(p, userLine(1))
    const follow = new ConversationFollow(p, byteLen(userLine(1)))

    const withoutNewline = JSON.stringify({ type: 'user', uuid: 'u2', message: { content: '메시지 2' } })
    await appendFile(p, withoutNewline) // no trailing newline — still being written
    const beforeNewline = await follow.read()
    expect(beforeNewline?.turns).toEqual([]) // carried, not reduced yet

    await appendFile(p, '\n')
    const afterNewline = await follow.read()
    expect(afterNewline?.turns.map((t) => t.id)).toEqual(['u2'])
  })
})
