// The tokens a Claude session spent, one API response at a time, off the lines Claude itself writes: a terminal
// session's transcript (and its sub-agents' files) and a chat session's stream. Every fixture is written for the test,
// in the shape measured from Claude Code 2.1.306 to 2.1.309.
import { describe, it, expect } from 'vitest'
import { claudeTokenReader } from './claudeTokens'

const T0 = Date.parse('2026-10-23T03:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

const usage = (input: number, cacheCreation: number, cacheRead: number, output: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: cacheCreation,
  cache_read_input_tokens: cacheRead,
  output_tokens: output,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard'
})

/** One transcript line of an assistant message: Claude writes one per content block, each with the message's usage. */
const line = (at: number, id: string, u: ReturnType<typeof usage>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    type: 'assistant',
    timestamp: iso(at),
    message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }], usage: u },
    requestId: `req_${id}`,
    sessionId: 's1',
    ...extra
  })

describe('claudeTokenReader', () => {
  it('counts each response once, though its content blocks are lines of their own, with its cache in the input', () => {
    const read = claudeTokenReader(T0)
    const u = usage(2, 1565, 188_930, 1613)
    expect(read([line(T0 + 10, 'msg_1', u), line(T0 + 10, 'msg_1', u), line(T0 + 20, 'msg_2', usage(5, 0, 1000, 40))])).toEqual([
      { at: iso(T0 + 10), input: 2 + 1565 + 188_930, output: 1613 },
      { at: iso(T0 + 20), input: 1005, output: 40 }
    ])
    // A later read that meets the same message again adds nothing
    expect(read([line(T0 + 10, 'msg_1', u)])).toEqual([])
  })

  // A resumed or copied transcript holds the turns of the sessions before this one: they were theirs
  it('passes what was written before the session started, and lines that are no response', () => {
    const read = claudeTokenReader(T0)
    expect(
      read([
        line(T0 - 1, 'msg_old', usage(1, 0, 0, 1)),
        JSON.stringify({ type: 'user', timestamp: iso(T0 + 1), message: { role: 'user', content: 'hi' } }),
        'not json',
        '{"type":"assistant","timestamp":"' + iso(T0 + 2) + '","message":{"id":"msg_cut"',
        // An aborted turn, or a message Claude made up for an error, used nothing
        line(T0 + 3, 'msg_zero', usage(0, 0, 0, 0)),
        // History replayed rather than a live message
        line(T0 + 4, 'msg_replayed', usage(9, 0, 0, 9), { historical: true }),
        line(T0 + 5, 'msg_new', usage(3, 0, 0, 4))
      ])
    ).toEqual([{ at: iso(T0 + 5), input: 3, output: 4 }])
  })

  it('adds only what a response grew by when it is met again with a larger figure', () => {
    const read = claudeTokenReader(T0)
    expect(read([line(T0 + 1, 'msg_1', usage(10, 0, 0, 1))])).toEqual([{ at: iso(T0 + 1), input: 10, output: 1 }])
    expect(read([line(T0 + 2, 'msg_1', usage(10, 0, 0, 30))])).toEqual([{ at: iso(T0 + 2), input: 0, output: 29 }])
  })

  // A chat's stream carries a sub-agent's responses too (parent_tool_use_id); an older CLI's frames carry no time
  it('counts a chat stream’s frames, a sub-agent’s among them, and one with no time as now', () => {
    const read = claudeTokenReader(T0)
    const frame = (id: string, parent: string | null, at?: number) =>
      JSON.stringify({
        type: 'assistant',
        message: { id, type: 'message', role: 'assistant', content: [], usage: usage(1, 2, 3, 4) },
        parent_tool_use_id: parent,
        session_id: 'c1',
        uuid: `u_${id}`,
        ...(at !== undefined ? { timestamp: iso(at) } : {})
      })
    expect(read([frame('msg_a', null, T0 + 1), frame('msg_b', 'toolu_1', T0 + 2), frame('msg_c', null)])).toEqual([
      { at: iso(T0 + 1), input: 6, output: 4 },
      { at: iso(T0 + 2), input: 6, output: 4 },
      { at: null, input: 6, output: 4 }
    ])
  })
})
