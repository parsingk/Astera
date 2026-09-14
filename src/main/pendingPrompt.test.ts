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
