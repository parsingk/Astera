import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readConversationWindow, ConversationFollow, CONVERSATION_TAIL_BYTES } from './conversationRead'

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
