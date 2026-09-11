import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { reduceTranscript, type ConvPart, type ConvTurn } from './conversation'

const line = (obj: unknown): string => JSON.stringify(obj)

const shapesFixture = (): string[] =>
  readFileSync(join(__dirname, 'fixtures/conversation-shapes.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)

const turnFixture = (): string[] =>
  readFileSync(join(__dirname, 'fixtures/conversation-turn.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)

const toolParts = (turn: ConvTurn): Extract<ConvPart, { kind: 'tool' }>[] =>
  turn.parts.filter((p): p is Extract<ConvPart, { kind: 'tool' }> => p.kind === 'tool')

describe('reduceTranscript — a real turn (conversation-turn.jsonl)', () => {
  it('groups into user / assistant / user', () => {
    const turns = reduceTranscript(turnFixture())
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('the middle assistant turn is ten tool parts plus one trailing text part — no thinking or fallback slips through', () => {
    const [, assistantTurn] = reduceTranscript(turnFixture())
    // Measured: ten Bash tool_use entries, interleaved with thinking blocks that contribute
    // nothing, then one final text block that ends the response.
    expect(assistantTurn.parts).toHaveLength(11)
    expect(assistantTurn.parts.slice(0, -1).every((p) => p.kind === 'tool')).toBe(true)
    expect(assistantTurn.parts[assistantTurn.parts.length - 1].kind).toBe('text')
  })

  it('a turn\'s id and timestamp come from the entry that produced its first part, not the run\'s first entry', () => {
    const turns = reduceTranscript(turnFixture())
    expect(turns[0]).toMatchObject({
      id: '39d0c83a-9d9a-43d8-b6db-26fdff6d09c9',
      timestamp: '2026-09-03T06:14:55.601Z'
    })
    // The assistant run's first entry is a thinking-only line (uuid da126648-…) that contributes no
    // part. The turn is anchored to the next entry instead — the first one with a real tool_use.
    expect(turns[1]).toMatchObject({
      id: 'eb31b40f-7d00-466b-a4b6-0bb649a0c74d',
      timestamp: '2026-09-03T06:15:10.954Z'
    })
    expect(turns[2]).toMatchObject({
      id: 'c8682da0-3f92-4c0c-8c1e-1c695eda4031',
      timestamp: '2026-09-03T06:50:46.666Z'
    })
  })
})

describe('reduceTranscript — a dropped user record does not end an assistant run', () => {
  it('a real isMeta coordinator record sitting between two tool_use entries does not split the run (real data, appended to conversation-shapes.jsonl)', () => {
    // The isMeta record and the two Bash calls either side of it are real, redacted entries from a
    // live transcript on this machine (a subagent run that was interrupted, then resumed by a
    // coordinator message injected as an isMeta user record — exactly the shape that splits a run).
    const turns = reduceTranscript(shapesFixture())
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
    const ids = toolParts(turns[1]).map((p) => p.id)
    expect(ids).toContain('toolu_018J7mWrzzYF37f9a1RCHQDn') // the Bash call before the isMeta record
    expect(ids).toContain('toolu_019C5P4P4K6TCYk9tnL4EQ8y') // the Bash call after it — same turn
  })

  it('a <task-notification> record does not end an in-progress run either', () => {
    const turns = reduceTranscript([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }
      }),
      line({
        type: 'user',
        uuid: 'u1',
        message: { content: '<task-notification>task-42 finished</task-notification>' }
      }),
      line({
        type: 'assistant',
        uuid: 'a2',
        message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pwd' } }] }
      })
    ])
    expect(turns).toHaveLength(1)
    expect(toolParts(turns[0]).map((p) => p.id)).toEqual(['t1', 't2'])
  })
})

describe('reduceTranscript — tool outcomes (conversation-shapes.jsonl)', () => {
  it('Read (text) — file.numLines becomes "N lines"', () => {
    const parts = reduceTranscript(shapesFixture()).flatMap(toolParts)
    const read = parts.find((p) => p.name === 'Read' && p.target.endsWith('.md'))
    expect(read?.outcome).toEqual({ ok: true, detail: '27 lines' })
  })

  it('Read (image) — no count, detail is empty, still ok', () => {
    const parts = reduceTranscript(shapesFixture()).flatMap(toolParts)
    const read = parts.find((p) => p.name === 'Read' && p.target.endsWith('.png'))
    expect(read?.outcome).toEqual({ ok: true, detail: '' })
  })

  it('Grep — this sample is mode "content", so numLines becomes "N matches"', () => {
    const parts = reduceTranscript(shapesFixture()).flatMap(toolParts)
    const grep = parts.find((p) => p.name === 'Grep')
    expect(grep?.outcome).toEqual({ ok: true, detail: '30 matches' })
  })

  it('Edit — sums structuredPatch +/- lines per hunk, and direction is not interchangeable', () => {
    const parts = reduceTranscript(shapesFixture()).flatMap(toolParts)
    const edits = parts.filter((p) => p.name === 'Edit')
    const designEdit = edits.find((p) => p.target.includes('specs'))
    const planEdit = edits.find((p) => p.target.includes('plans'))
    // Exact values, not a /^\+\d+ -\d+$/ pattern — a regex still passes if + and - are swapped.
    expect(designEdit?.outcome).toEqual({ ok: true, detail: '+6 -2' })
    expect(planEdit?.outcome).toEqual({ ok: true, detail: '+2 -15' })
  })

  it('Write is always "new file" — structuredPatch is empty and content length is not shown', () => {
    const parts = reduceTranscript(shapesFixture()).flatMap(toolParts)
    const write = parts.find((p) => p.name === 'Write')
    expect(write?.outcome).toEqual({ ok: true, detail: 'new file' })
  })

  it('Bash success — "N lines" counted from stdout', () => {
    const parts = reduceTranscript(shapesFixture()).flatMap(toolParts)
    const bash = parts.find((p) => p.name === 'Bash' && p.outcome?.ok === true)
    expect(bash?.outcome).toEqual({ ok: true, detail: '5 lines' })
  })

  it('a failed call is not ok, and a string toolUseResult does not throw', () => {
    let turns: ConvTurn[] = []
    expect(() => {
      turns = reduceTranscript(shapesFixture())
    }).not.toThrow()
    const failed = turns.flatMap(toolParts).find((p) => p.name === 'Bash' && p.outcome?.ok === false)
    expect(failed?.outcome).toEqual({ ok: false, detail: '' })
  })

  it('an unknown tool name passes through — target is the first string value in input, detail is empty', () => {
    const turns = reduceTranscript([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'WebFetch', input: { url: 'https://example.com', timeout: 30 } }]
        }
      }),
      line({
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        toolUseResult: { someField: 1 }
      })
    ])
    const tool = toolParts(turns[0])[0]
    expect(tool.name).toBe('WebFetch')
    expect(tool.target).toBe('https://example.com')
    expect(tool.outcome).toEqual({ ok: true, detail: '' })
  })
})

describe('reduceTranscript — outcome edge cases the fixtures do not exercise', () => {
  it('a failed Write does not announce "new file" — the string toolUseResult guard applies to every tool', () => {
    const turns = reduceTranscript([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/x.ts', content: 'hi' } }]
        }
      }),
      line({
        type: 'user',
        uuid: 'u1',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'EACCES: permission denied' }]
        },
        toolUseResult: "Error: EACCES: permission denied, open '/x.ts'"
      })
    ])
    const tool = toolParts(turns[0])[0]
    expect(tool.outcome).toEqual({ ok: false, detail: '' })
  })

  it('Bash stdout that is only a trailing newline renders no detail, not "0 lines"', () => {
    const turns = reduceTranscript([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'true' } }] }
      }),
      line({
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '' }] },
        toolUseResult: { stdout: '\n', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
      })
    ])
    const tool = toolParts(turns[0])[0]
    expect(tool.outcome).toEqual({ ok: true, detail: '' })
  })

  it('a fallback block (a model-switch record) produces nothing — no empty-parts turn either', () => {
    const turns = reduceTranscript([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'fallback', from: { model: 'x' }, to: { model: 'y' } }] }
      })
    ])
    expect(turns).toEqual([])
  })
})

describe('reduceTranscript — synthetic cases', () => {
  it('batched calls pair by tool_use_id, not position (results arrive in reverse order)', () => {
    const turns = reduceTranscript([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } }] }
      }),
      line({
        type: 'assistant',
        uuid: 'a2',
        message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/b.ts' } }] }
      }),
      // The results come back t2, then t1 — the reverse of the call order (t1, then t2).
      line({
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
        toolUseResult: {
          type: 'create',
          filePath: '/b.ts',
          content: 'x',
          structuredPatch: [],
          originalFile: null,
          userModified: false
        }
      }),
      line({
        type: 'user',
        uuid: 'u2',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        toolUseResult: {
          type: 'text',
          file: { filePath: '/a.ts', content: 'x', numLines: 5, startLine: 1, totalLines: 5 }
        }
      })
    ])
    expect(turns).toHaveLength(1) // two consecutive assistant entries merge into one turn
    const parts = toolParts(turns[0])
    const read = parts.find((p) => p.id === 't1')
    const write = parts.find((p) => p.id === 't2')
    expect(read?.outcome).toEqual({ ok: true, detail: '5 lines' })
    expect(write?.outcome).toEqual({ ok: true, detail: 'new file' })
  })

  it('a call with no result yet leaves outcome null', () => {
    const turns = reduceTranscript([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }
      })
    ])
    const tool = turns[0].parts[0]
    expect(tool.kind).toBe('tool')
    expect((tool as Extract<ConvPart, { kind: 'tool' }>).outcome).toBeNull()
  })

  it('a tool_result with no matching call in the window produces no turn and no part', () => {
    const turns = reduceTranscript([
      line({
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'x' }] }
      })
    ])
    expect(turns).toEqual([])
  })

  it('meta records and machine-prefixed records produce no turn; a real message does', () => {
    const turns = reduceTranscript([
      line({ type: 'user', uuid: 'u0', isMeta: true, message: { content: 'a whole skill body landed here' } }),
      line({ type: 'user', uuid: 'u1', message: { content: '<command-name>/clear</command-name>' } }),
      line({ type: 'user', uuid: 'u2', message: { content: 'why is store.load closing them' } })
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].parts).toEqual([{ kind: 'text', text: 'why is store.load closing them' }])
  })

  it('a malformed line is skipped, and the lines around it survive', () => {
    const turns = reduceTranscript([
      line({ type: 'user', uuid: 'u1', message: { content: 'one' } }),
      '{ this is not json',
      line({ type: 'user', uuid: 'u2', message: { content: 'two' } })
    ])
    expect(turns.map((t) => t.id)).toEqual(['u1', 'u2'])
  })

  it('defensive: text and tool_use interleaved in one message keep source order (not seen in real data)', () => {
    const turns = reduceTranscript([
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/a.ts' } },
            { type: 'text', text: 'second' }
          ]
        }
      })
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].parts.map((p) => p.kind)).toEqual(['text', 'tool', 'text'])
  })
})
