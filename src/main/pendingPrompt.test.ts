import { describe, it, expect } from 'vitest'
import { createPendingPromptState } from './pendingPrompt'

const pre = (id: string, tool = 'AskUserQuestion', input: unknown = { questions: [] }): unknown => ({
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_input: input,
  tool_use_id: id
})
const post = (id: string): unknown => ({ hook_event_name: 'PostToolUse', tool_use_id: id })
const stop = (): unknown => ({ hook_event_name: 'Stop' })

describe('createPendingPromptState', () => {
  it('a fresh state has nothing for any session', () => {
    expect(createPendingPromptState().get('s1')).toBeNull()
  })

  it('PreToolUse remembers the call, with its input untouched and a timestamp', () => {
    const state = createPendingPromptState(() => 1234)
    const input = { questions: [{ question: 'Q?' }] }
    state.onHookEvent('s1', pre('call-1', 'AskUserQuestion', input))
    expect(state.get('s1')).toEqual({ toolUseId: 'call-1', tool: 'AskUserQuestion', input, at: 1234 })
    expect(state.get('s2')).toBeNull()
  })

  it('the matching PostToolUse clears it; a different id leaves it alone', () => {
    const state = createPendingPromptState()
    state.onHookEvent('s1', pre('call-1'))
    state.onHookEvent('s1', post('call-other'))
    expect(state.get('s1')?.toolUseId).toBe('call-1')
    state.onHookEvent('s1', post('call-1'))
    expect(state.get('s1')).toBeNull()
  })

  it('Stop clears it, and so does forget', () => {
    const state = createPendingPromptState()
    state.onHookEvent('s1', pre('call-1'))
    state.onHookEvent('s1', stop())
    expect(state.get('s1')).toBeNull()
    state.onHookEvent('s1', pre('call-2'))
    state.forget('s1')
    expect(state.get('s1')).toBeNull()
  })

  // The capture also records UserPromptSubmit (for `astera sessions list`); it neither clears nor
  // replaces a waiting question here.
  it('UserPromptSubmit leaves the capture alone', () => {
    const state = createPendingPromptState()
    const changes: unknown[] = []
    state.onHookEvent('s1', pre('call-1'))
    state.subscribe((_id, p) => changes.push(p))
    state.onHookEvent('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    expect(state.get('s1')?.toolUseId).toBe('call-1')
    expect(changes).toEqual([])
  })

  // StopFailure fires instead of Stop when an API error ends the turn (Claude Code 2.1.280's payload:
  // `error`, `error_details`, the error text as `last_assistant_message`). The turn is over either way,
  // so no question from it is still on screen, and the form must not stay drawn.
  it('StopFailure clears it, as Stop does', () => {
    const state = createPendingPromptState()
    const changes: unknown[] = []
    state.onHookEvent('s1', pre('call-1'))
    state.subscribe((_id, p) => changes.push(p))
    state.onHookEvent('s1', {
      session_id: 'cc-1',
      transcript_path: 'D:/t.jsonl',
      cwd: 'D:/work',
      hook_event_name: 'StopFailure',
      error: 'server_error',
      last_assistant_message: 'API Error: 500 Internal server error'
    })
    expect(state.get('s1')).toBeNull()
    expect(changes).toEqual([null])
  })

  // StopFailure is captured async (so is UserPromptSubmit): a prompt sent right after a failed turn
  // can land its UserPromptSubmit first and the old StopFailure after the new turn's question. The
  // capture stamps when it started (`astera_at`); a turn end older than the latest prompt belongs to
  // the turn before, and the question on screen now stays drawn.
  it.each(['StopFailure', 'Stop'])('a %s older than the latest prompt leaves the new question up', (name) => {
    const state = createPendingPromptState()
    state.onHookEvent('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'again', astera_at: 1_020 })
    state.onHookEvent('s1', { ...(pre('call-2') as object), astera_at: 1_500 })
    state.onHookEvent('s1', { hook_event_name: name, error: 'rate_limit', astera_at: 1_000 })
    expect(state.get('s1')?.toolUseId).toBe('call-2')
  })

  // Lines with no stamp (an older capture), a tie, and a gap far past any reordering (a wall clock set
  // back 30 s) keep the append-order rule.
  it.each([
    ['no stamp', {}, {}],
    ['a clock stepped back 30 s', { astera_at: 1_000_000 }, { astera_at: 1_000_000 - 20_000 }],
    ['the same millisecond', { astera_at: 1_000 }, { astera_at: 1_000 }],
    ['a turn end newer than the prompt', { astera_at: 1_000 }, { astera_at: 1_005 }]
  ])('with %s the turn end clears it', (_label, promptAt, endAt) => {
    const state = createPendingPromptState()
    state.onHookEvent('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'go', ...promptAt })
    state.onHookEvent('s1', pre('call-1'))
    state.onHookEvent('s1', { hook_event_name: 'StopFailure', error: 'server_error', ...endAt })
    expect(state.get('s1')).toBeNull()
  })

  it('forget drops the prompt time with the capture', () => {
    const state = createPendingPromptState()
    state.onHookEvent('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'go', astera_at: 2_000 })
    state.forget('s1')
    state.onHookEvent('s1', pre('call-1'))
    state.onHookEvent('s1', { hook_event_name: 'StopFailure', error: 'server_error', astera_at: 1_000 })
    expect(state.get('s1')).toBeNull()
  })

  it('the latest PreToolUse wins', () => {
    const state = createPendingPromptState()
    state.onHookEvent('s1', pre('call-1', 'Bash', { command: 'ls' }))
    state.onHookEvent('s1', pre('call-2'))
    expect(state.get('s1')?.toolUseId).toBe('call-2')
  })

  // Never half-stored: a payload missing any of the three fields is not a capture (spec §7).
  it('ignores a PreToolUse missing the name, the input or the id, and non-object payloads', () => {
    const state = createPendingPromptState()
    state.onHookEvent('s1', { hook_event_name: 'PreToolUse', tool_input: {}, tool_use_id: 'x' })
    state.onHookEvent('s1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'x' })
    state.onHookEvent('s1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })
    state.onHookEvent('s1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: 'not an object', tool_use_id: 'x' })
    state.onHookEvent('s1', null)
    state.onHookEvent('s1', 'nonsense')
    expect(state.get('s1')).toBeNull()
  })

  it('subscribe fires on change only, with the new value, and unsubscribes', () => {
    const state = createPendingPromptState(() => 1)
    const seen: Array<[string, string | null]> = []
    const off = state.subscribe((sid, prompt) => seen.push([sid, prompt?.toolUseId ?? null]))
    state.onHookEvent('s1', post('nothing-pending')) // nothing to clear: no event
    state.onHookEvent('s1', stop()) // still nothing: no event
    state.onHookEvent('s1', pre('call-1'))
    state.onHookEvent('s1', pre('call-1')) // the same call again: no event
    state.onHookEvent('s1', post('call-1'))
    state.forget('s1') // already empty: no event
    off()
    state.onHookEvent('s1', pre('call-2'))
    expect(seen).toEqual([
      ['s1', 'call-1'],
      ['s1', null]
    ])
  })
})
