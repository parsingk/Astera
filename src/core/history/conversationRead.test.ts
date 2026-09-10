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

/** One line that reduces to exactly one turn (a real, non-meta user message) — keeps the byte-offset
 *  arithmetic in these tests simple: counting turns tells you exactly which lines survived a window,
 *  and every line built this way is the same length, which makes picking a `tailBytes` that lands a
 *  window mid-line straightforward. */
function userLine(n: number): string {
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

  it('a file smaller than the window: all turns, from 0, more false', async () => {
    const p = path.join(dir, 'small.jsonl')
    const content = userLine(1) + userLine(2) + userLine(3)
    await writeFile(p, content)
    const result = await readConversationWindow(p, { tailBytes: content.length + 100 })
    expect(result?.from).toBe(0)
    expect(result?.more).toBe(false)
    expect(result?.turns.map((t) => t.id)).toEqual(['u1', 'u2', 'u3'])
  })

  it('a window that starts mid-file discards the partial first line', async () => {
    const p = path.join(dir, 'mid.jsonl')
    const l1 = userLine(1)
    const l2 = userLine(2)
    const l3 = userLine(3)
    await writeFile(p, l1 + l2 + l3)
    // Big enough for all of l3 plus roughly half of l2, so the window starts mid l2, not on a line
    // boundary — the case this behaviour exists for.
    const tailBytes = l3.length + Math.floor(l2.length / 2)
    const result = await readConversationWindow(p, { tailBytes })
    expect(result?.more).toBe(true)
    expect(result?.from).toBeGreaterThan(0)
    // The partial l2 fragment is dropped; only the complete line after it (l3) is reduced.
    expect(result?.turns.map((t) => t.id)).toEqual(['u3'])
    // `from` lands exactly at the start of l3 — right after l2's newline, not somewhere inside l2.
    expect(result?.from).toBe(l1.length + l2.length)
  })

  it('endAt walks backwards: the window before `from` has the earlier entries, none repeated', async () => {
    const p = path.join(dir, 'walk.jsonl')
    const l1 = userLine(1)
    const l2 = userLine(2)
    const l3 = userLine(3)
    await writeFile(p, l1 + l2 + l3)
    const tailBytes = l3.length + Math.floor(l2.length / 2)
    const first = await readConversationWindow(p, { tailBytes })
    expect(first?.turns.map((t) => t.id)).toEqual(['u3'])

    const second = await readConversationWindow(p, { tailBytes: 10_000, endAt: first!.from })
    expect(second?.turns.map((t) => t.id)).toEqual(['u1', 'u2']) // the entries before `from`, not u3 again
    expect(second?.from).toBe(0)
    expect(second?.more).toBe(false)
  })

  it('follow equals the end of the window that was read', async () => {
    const p = path.join(dir, 'follow.jsonl')
    const content = userLine(1) + userLine(2)
    await writeFile(p, content)
    const result = await readConversationWindow(p)
    expect(result?.follow).toBe(content.length)

    // Same for a windowed (endAt) read — follow is that window's end, not the file's current end.
    const partial = await readConversationWindow(p, { tailBytes: 10_000, endAt: userLine(1).length })
    expect(partial?.follow).toBe(userLine(1).length)
  })

  it('CONVERSATION_TAIL_BYTES is the default window when tailBytes is omitted', async () => {
    const p = path.join(dir, 'default.jsonl')
    const content = userLine(1)
    await writeFile(p, content)
    const result = await readConversationWindow(p)
    // The whole (tiny) file fits well within the default window, so nothing is trimmed off the front.
    expect(CONVERSATION_TAIL_BYTES).toBeGreaterThan(content.length)
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

  it('widening stops at the cap: a file that is one single line bigger than it returns zero turns and terminates', async () => {
    const p = path.join(dir, 'onegiant.jsonl')
    const content = bigToolResultLine(CONVERSATION_TAIL_BYTES_MAX + 100_000) // one line, bigger than the cap
    await writeFile(p, content)
    // Completing at all — resolving rather than reading without bound — is itself under test.
    const result = await readConversationWindow(p)
    expect(result).not.toBeNull()
    expect(result!.turns).toEqual([])
    // The file is bigger than the cap, so the cap — not reaching the start of the file — is what
    // stopped the widening: the only newline in the whole file is this one line's own trailing
    // newline, mistaken for a partial fragment at the front and dropped (the "same simplification"
    // note on readConversationWindow), so `from` sits at the file's own end, and `more` is true because
    // there genuinely is more file before that point. Pinned to concrete values, not to the tautology
    // `more === from > 0`, which would hold even if the cap silently stopped applying.
    expect(result!.from).toBe(content.length)
    expect(result!.more).toBe(true)
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
    expect(first!.follow).toBe(content.length) // follow tracks `end`, unaffected by widening

    // A ConversationFollow resumed at `first.follow` sees nothing new yet — the widened window already
    // reached the file's current end.
    const follow = new ConversationFollow(p, first!.follow)
    expect((await follow.read())?.turns).toEqual([])

    // Walk backwards from `first.from`. This must not repeat anything `first` already returned, and
    // together the two calls must cover every ordinary turn exactly once — whatever the widened
    // window's own boundary happened to drop (see readConversationWindow's "same simplification" note)
    // falls inside this next older window instead, since that window ends exactly at `first.from`.
    const second = await readConversationWindow(p, { tailBytes: content.length, endAt: first!.from })
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
    const follow = new ConversationFollow(p, userLine(1).length)

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
    const follow = new ConversationFollow(p, original.length)

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
    const follow = new ConversationFollow(p, userLine(1).length)

    const withoutNewline = JSON.stringify({ type: 'user', uuid: 'u2', message: { content: 'message 2' } })
    await appendFile(p, withoutNewline) // no trailing newline — still being written
    const beforeNewline = await follow.read()
    expect(beforeNewline?.turns).toEqual([]) // carried, not reduced yet

    await appendFile(p, '\n')
    const afterNewline = await follow.read()
    expect(afterNewline?.turns.map((t) => t.id)).toEqual(['u2'])
  })
})
