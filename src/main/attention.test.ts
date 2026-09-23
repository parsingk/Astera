import { describe, it, expect } from 'vitest'
import { createAttentionState, type Attention } from './attention'

const pre = (toolUseId: string): unknown => ({ hook_event_name: 'PreToolUse', tool_use_id: toolUseId })
const post = (toolUseId: string): unknown => ({ hook_event_name: 'PostToolUse', tool_use_id: toolUseId })
const notify = (notification_type: string): unknown => ({
  hook_event_name: 'Notification',
  notification_type
})
const stop = (): unknown => ({ hook_event_name: 'Stop' })

describe('createAttentionState — reading', () => {
  it('a fresh state reads idle for any session id', () => {
    const state = createAttentionState()
    expect(state.get('never-seen')).toBe('idle')
  })

  it('two sessions do not see each other’s state', () => {
    const state = createAttentionState()
    state.onHookEvent('s1', pre('call-1'))
    expect(state.get('s1')).toBe('working')
    expect(state.get('s2')).toBe('idle')
  })
})

describe('createAttentionState — PreToolUse / PostToolUse', () => {
  it('PreToolUse moves a session to working; the matching PostToolUse returns it to idle', () => {
    const state = createAttentionState()
    state.onHookEvent('s1', pre('call-1'))
    expect(state.get('s1')).toBe('working')
    state.onHookEvent('s1', post('call-1'))
    expect(state.get('s1')).toBe('idle')
  })

  // This is the case a boolean gets wrong: calls are issued in batches, so a second PreToolUse can
  // land before either call's PostToolUse. The session must stay working until both are done.
  it('two outstanding calls stay working until both finish', () => {
    const state = createAttentionState()
    state.onHookEvent('s1', pre('call-1'))
    state.onHookEvent('s1', pre('call-2'))
    state.onHookEvent('s1', post('call-1'))
    expect(state.get('s1')).toBe('working')
    state.onHookEvent('s1', post('call-2'))
    expect(state.get('s1')).toBe('idle')
  })
})

describe('createAttentionState — Notification', () => {
  it.each(['permission_prompt', 'worker_permission_prompt', 'agent_needs_input', 'elicitation_dialog'])(
    '%s is a waiting screen',
    (notification_type) => {
      const state = createAttentionState()
      state.onHookEvent('s1', notify(notification_type))
      expect(state.get('s1')).toBe('waiting')
    }
  )

  it.each(['agent_completed', 'auth_success', 'computer_use_exit', 'push_notification'])(
    '%s reports something already finished, not a waiting screen',
    (notification_type) => {
      const state = createAttentionState()
      state.onHookEvent('s1', notify(notification_type))
      expect(state.get('s1')).not.toBe('waiting')
    }
  )

  it('idle_prompt alone is not a waiting screen', () => {
    const state = createAttentionState()
    state.onHookEvent('s1', notify('idle_prompt'))
    expect(state.get('s1')).toBe('idle')
  })

  // A type absent from notification.ts's measured list is deliberately treated as waiting, the same
  // direction notification.ts takes for the notifier: a missed waiting screen strands a session with
  // nobody knowing, while a surplus one only costs a glance.
  it('an unrecognised notification_type is treated as waiting', () => {
    const state = createAttentionState()
    state.onHookEvent('s1', notify('some_future_prompt'))
    expect(state.get('s1')).toBe('waiting')
  })

  // slack.ts keeps an exception desktopNotifier does not: an idle notice arriving while a
  // PreToolUse call is still outstanding is the CLI reporting "waiting for your input" with a call
  // unanswered underneath it — a prompt on screen, not a genuinely idle box. This state tracks
  // outstanding calls by id already, so it follows Slack's rule.
  it('idle_prompt with a call outstanding is a waiting screen', () => {
    const state = createAttentionState()
    state.onHookEvent('s1', pre('call-1'))
    state.onHookEvent('s1', notify('idle_prompt'))
    expect(state.get('s1')).toBe('waiting')
  })

  it('idle_prompt with no call outstanding still leaves the value as it is', () => {
    const state = createAttentionState()
    state.onHookEvent('s1', notify('idle_prompt'))
    expect(state.get('s1')).toBe('idle')
  })

  it('idle_prompt with a call outstanding goes to waiting, then back to idle once the call finishes', () => {
    const state = createAttentionState()
    state.onHookEvent('s1', pre('call-1'))
    state.onHookEvent('s1', notify('idle_prompt'))
    expect(state.get('s1')).toBe('waiting')
    state.onHookEvent('s1', post('call-1'))
    expect(state.get('s1')).toBe('idle')
  })
})

describe('createAttentionState — leaving waiting', () => {
  it('a waiting session returns to idle once its only outstanding call finishes', () => {
    const state = createAttentionState()
    state.onHookEvent('s1', pre('call-1'))
    state.onHookEvent('s1', notify('permission_prompt'))
    expect(state.get('s1')).toBe('waiting')
    state.onHookEvent('s1', post('call-1'))
    expect(state.get('s1')).toBe('idle')
  })

  it('a waiting session returns to working when another call is still outstanding', () => {
    const state = createAttentionState()
    state.onHookEvent('s1', pre('call-1'))
    state.onHookEvent('s1', pre('call-2'))
    state.onHookEvent('s1', notify('agent_needs_input'))
    expect(state.get('s1')).toBe('waiting')
    state.onHookEvent('s1', post('call-1'))
    expect(state.get('s1')).toBe('working')
    state.onHookEvent('s1', post('call-2'))
    expect(state.get('s1')).toBe('idle')
  })
})

describe('createAttentionState — Stop', () => {
  it('Stop clears every outstanding call, not just the value', () => {
    const state = createAttentionState()
    state.onHookEvent('s1', pre('call-1'))
    state.onHookEvent('s1', pre('call-2'))
    state.onHookEvent('s1', stop())
    expect(state.get('s1')).toBe('idle')
    // If Stop had only flipped the value without clearing the outstanding set, this stray
    // PostToolUse would still find call-2 in it and report working again.
    state.onHookEvent('s1', post('call-1'))
    expect(state.get('s1')).toBe('idle')
  })
})

describe('createAttentionState — subscribe', () => {
  it('fires once for two identical transitions, and the returned unsubscribe stops it', () => {
    const state = createAttentionState()
    const seen: Array<[string, Attention]> = []
    const unsubscribe = state.subscribe((sessionId, value) => seen.push([sessionId, value]))
    state.onHookEvent('s1', pre('call-1'))
    state.onHookEvent('s1', pre('call-2')) // still working — one notification, not two
    expect(seen).toEqual([['s1', 'working']])
    unsubscribe()
    state.onHookEvent('s1', post('call-1'))
    state.onHookEvent('s1', post('call-2'))
    expect(seen).toEqual([['s1', 'working']]) // nothing added once unsubscribed
  })
})

describe('createAttentionState — forget', () => {
  it('drops the session, which then reads idle', () => {
    const state = createAttentionState()
    state.onHookEvent('s1', pre('call-1'))
    expect(state.get('s1')).toBe('working')
    state.forget('s1')
    expect(state.get('s1')).toBe('idle')
  })
})

describe('createAttentionState — set', () => {
  it('set writes a value outright and notifies only on change', () => {
    const s = createAttentionState()
    const seen: Array<[string, string]> = []
    s.subscribe((id, v) => seen.push([id, v]))
    s.set('c1', 'working')
    s.set('c1', 'working')
    s.set('c1', 'waiting')
    expect(s.get('c1')).toBe('waiting')
    expect(seen).toEqual([
      ['c1', 'working'],
      ['c1', 'waiting']
    ])
  })
})

/** What Claude Code 2.1.280 sends when an API error ends the turn, field for field (its builder
 *  `sAe`): the session fields every hook carries, `error` (rate_limit, overloaded,
 *  authentication_failed, server_error, …), `error_details` when there are any, and the error
 *  message's own text as `last_assistant_message`. It fires *instead of* Stop. */
const stopFailure = (error = 'rate_limit'): unknown => ({
  session_id: 'cc-1',
  transcript_path: 'D:/t.jsonl',
  cwd: 'D:/work',
  hook_event_name: 'StopFailure',
  error,
  last_assistant_message: 'API Error: Repeated 529 Overloaded errors'
})

// StopFailure is the other way a turn ends, so it ends a turn here exactly as Stop does. Before, a
// turn that errored left whatever the value was standing: `waiting` stayed up with nobody waiting,
// and the next real prompt was no transition, so the desktop notifier never fired for it.
describe('createAttentionState — StopFailure', () => {
  it('StopFailure ends the turn the way Stop does: idle, every outstanding call cleared', () => {
    const state = createAttentionState()
    const seen: Array<[string, Attention]> = []
    state.subscribe((id, value) => seen.push([id, value]))
    state.onHookEvent('w', pre('call-1'))
    state.onHookEvent('w', pre('call-2'))
    state.onHookEvent('q', pre('call-3'))
    state.onHookEvent('q', notify('permission_prompt'))
    seen.length = 0
    state.onHookEvent('w', stopFailure('overloaded'))
    state.onHookEvent('q', stopFailure('authentication_failed'))
    expect(state.get('w')).toBe('idle')
    expect(state.get('q')).toBe('idle')
    expect(seen).toEqual([
      ['w', 'idle'],
      ['q', 'idle']
    ])
    // cleared, not only flipped: a stray PostToolUse of one of them does not bring working back
    state.onHookEvent('w', post('call-1'))
    expect(state.get('w')).toBe('idle')
  })

  it('a StopFailure for a session never seen creates nothing, as Stop does not', () => {
    const state = createAttentionState()
    const seen: Array<[string, Attention]> = []
    state.subscribe((id, value) => seen.push([id, value]))
    state.onHookEvent('fresh', stopFailure())
    expect(state.get('fresh')).toBe('idle')
    expect(seen).toEqual([])
  })

  // StopFailure and UserPromptSubmit are captured async, so a prompt submitted right after a failed
  // turn can have its UserPromptSubmit land first, and the old StopFailure after the new turn's first
  // tool call. The capture stamps when it started (`astera_at`); a turn end that happened before the
  // latest prompt belongs to the turn before it.
  it.each(['StopFailure', 'Stop'])('a %s older than the latest prompt does not end the new turn', (name) => {
    const state = createAttentionState()
    state.onHookEvent('w', { hook_event_name: 'UserPromptSubmit', prompt: 'again', astera_at: 1_020 })
    state.onHookEvent('w', { hook_event_name: 'PreToolUse', tool_use_id: 'call-1', astera_at: 1_500 })
    state.onHookEvent('w', { ...(stopFailure() as object), hook_event_name: name, astera_at: 1_000 })
    expect(state.get('w')).toBe('working')
    // and the call it left outstanding is still the one that ends the value
    state.onHookEvent('w', { hook_event_name: 'PostToolUse', tool_use_id: 'call-1', astera_at: 1_600 })
    expect(state.get('w')).toBe('idle')
  })

  // An instant API error whose StopFailure lands before its own prompt: the prompt is older, so the
  // turn end stands.
  it('a StopFailure that landed before its own older prompt still ends the turn', () => {
    const state = createAttentionState()
    state.onHookEvent('w', { hook_event_name: 'PreToolUse', tool_use_id: 'call-1', astera_at: 900 })
    state.onHookEvent('w', { ...(stopFailure() as object), astera_at: 1_005 })
    state.onHookEvent('w', { hook_event_name: 'UserPromptSubmit', prompt: 'go', astera_at: 1_000 })
    expect(state.get('w')).toBe('idle')
    state.onHookEvent('w', { hook_event_name: 'PreToolUse', tool_use_id: 'call-2', astera_at: 2_000 })
    state.onHookEvent('w', { ...(stopFailure() as object), astera_at: 2_500 })
    expect(state.get('w')).toBe('idle')
  })

  // A wall clock set back 30 s during a turn stamps its Stop well before the prompt. That is far past
  // any reordering, so the stamps are not trusted and the Stop ends the turn as it lands.
  it('a Stop stamped 20 s before its prompt, after a clock step back, still ends the turn', () => {
    const state = createAttentionState()
    state.onHookEvent('w', { hook_event_name: 'UserPromptSubmit', prompt: 'go', astera_at: 1_000_000 })
    state.onHookEvent('w', { hook_event_name: 'PreToolUse', tool_use_id: 'call-1', astera_at: 1_000_000 - 25_000 })
    state.onHookEvent('w', { hook_event_name: 'Stop', astera_at: 1_000_000 - 20_000 })
    expect(state.get('w')).toBe('idle')
  })

  // Lines from a capture that predates the stamp keep the append-order rule, and so does a tie.
  it.each([
    ['no stamp', {}, {}],
    ['the same millisecond', { astera_at: 1_000 }, { astera_at: 1_000 }]
  ])('with %s the turn end ends the turn, as it always did', (_label, promptAt, endAt) => {
    const state = createAttentionState()
    state.onHookEvent('w', { hook_event_name: 'UserPromptSubmit', prompt: 'go', ...promptAt })
    state.onHookEvent('w', pre('call-1'))
    state.onHookEvent('w', { ...(stopFailure() as object), ...endAt })
    expect(state.get('w')).toBe('idle')
  })
})

// The capture also records UserPromptSubmit, for `astera sessions list` (core/hooks/sessionState.ts).
// It is not this state's business: a turn starting is no reason to raise a banner.
describe('createAttentionState — the events it does not read', () => {
  it('UserPromptSubmit changes no value and notifies nobody', () => {
    const state = createAttentionState()
    const seen: Array<[string, Attention]> = []
    state.subscribe((id, value) => seen.push([id, value]))
    state.onHookEvent('w', pre('call-1'))
    state.onHookEvent('q', pre('call-2'))
    state.onHookEvent('q', notify('permission_prompt'))
    seen.length = 0
    for (const id of ['w', 'q', 'fresh']) state.onHookEvent(id, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    expect(state.get('w')).toBe('working')
    expect(state.get('q')).toBe('waiting')
    expect(state.get('fresh')).toBe('idle')
    expect(seen).toEqual([])
  })
})

describe('createAttentionState — malformed input', () => {
  it('a non-object payload and an unrecognised hook_event_name are ignored rather than throwing', () => {
    const state = createAttentionState()
    expect(() => state.onHookEvent('s1', null)).not.toThrow()
    expect(() => state.onHookEvent('s1', 'PreToolUse')).not.toThrow()
    expect(() => state.onHookEvent('s1', { hook_event_name: 'SessionStart' })).not.toThrow()
    expect(state.get('s1')).toBe('idle')
  })
})
