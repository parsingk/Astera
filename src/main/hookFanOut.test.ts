import { describe, it, expect } from 'vitest'
import { fanOutHookEvent, type HookFanOutTap } from './hookFanOut'

const recorder = (calls: string[], name: string, throwing = false): HookFanOutTap => ({
  onHookEvent: (sessionId, payload) => {
    calls.push(name)
    if (throwing) throw new Error(`${name} boom`)
  }
})

describe('fanOutHookEvent — every tap sees the event', () => {
  it('calls attention, slack and rolling once each, with the same sessionId and payload', () => {
    const seen: Array<{ name: string; sessionId: string; payload: unknown }> = []
    const tap = (name: string): HookFanOutTap => ({
      onHookEvent: (sessionId, payload) => seen.push({ name, sessionId, payload })
    })
    fanOutHookEvent(
      { attention: tap('attention'), slack: tap('slack'), rolling: tap('rolling') },
      's1',
      { hook_event_name: 'Notification' }
    )
    expect(seen).toEqual([
      { name: 'attention', sessionId: 's1', payload: { hook_event_name: 'Notification' } },
      { name: 'slack', sessionId: 's1', payload: { hook_event_name: 'Notification' } },
      { name: 'rolling', sessionId: 's1', payload: { hook_event_name: 'Notification' } }
    ])
  })

  // rollingRef is null until the rolling coordinator is constructed later in index.ts's boot sequence
  // (the same reason that variable starts null there) — a missing rolling tap must not be an error.
  it('a missing rolling tap does not throw', () => {
    const calls: string[] = []
    expect(() =>
      fanOutHookEvent(
        { attention: recorder(calls, 'attention'), slack: recorder(calls, 'slack'), rolling: null },
        's1',
        {}
      )
    ).not.toThrow()
    expect(calls).toEqual(['attention', 'slack'])
  })
})

describe('fanOutHookEvent — attention runs first', () => {
  // This is the property Task 5's review found nothing pinned: attention has to see and process an
  // event before anything that reads its result would. Recording the call order is the direct way to
  // pin it, rather than trusting the source order never drifts.
  it('records attention before slack and rolling', () => {
    const calls: string[] = []
    fanOutHookEvent(
      {
        attention: recorder(calls, 'attention'),
        slack: recorder(calls, 'slack'),
        rolling: recorder(calls, 'rolling')
      },
      's1',
      { hook_event_name: 'PreToolUse', tool_use_id: 'call-1' }
    )
    expect(calls).toEqual(['attention', 'slack', 'rolling'])
  })
})

describe('fanOutHookEvent — one tap throwing does not stop the others', () => {
  // The property the attention tap's own try exists for, and the reason it matters more now that
  // attention runs first: without it, a throw there would cost slack and rolling their turn too, not
  // just itself.
  it('attention throwing still lets slack and rolling run', () => {
    const calls: string[] = []
    expect(() =>
      fanOutHookEvent(
        {
          attention: recorder(calls, 'attention', true),
          slack: recorder(calls, 'slack'),
          rolling: recorder(calls, 'rolling')
        },
        's1',
        {}
      )
    ).not.toThrow()
    expect(calls).toEqual(['attention', 'slack', 'rolling'])
  })

  // rolling is last, so this mainly pins that its own try does not let the exception escape the whole
  // function — a caller (index.ts's HookEventWatcher callback) must not see it either.
  it('rolling throwing does not escape the function', () => {
    const calls: string[] = []
    expect(() =>
      fanOutHookEvent(
        {
          attention: recorder(calls, 'attention'),
          slack: recorder(calls, 'slack'),
          rolling: recorder(calls, 'rolling', true)
        },
        's1',
        {}
      )
    ).not.toThrow()
    expect(calls).toEqual(['attention', 'slack', 'rolling'])
  })

  // slack itself is intentionally left unguarded (matching its behaviour before this task), so a throw
  // there is expected to escape — this pins that fact rather than leaving it an unstated assumption.
  it('slack throwing does escape — it has no try of its own, unlike attention and rolling', () => {
    const calls: string[] = []
    expect(() =>
      fanOutHookEvent(
        {
          attention: recorder(calls, 'attention'),
          slack: recorder(calls, 'slack', true),
          rolling: recorder(calls, 'rolling')
        },
        's1',
        {}
      )
    ).toThrow('slack boom')
    // attention still ran before the throw; rolling never got its turn.
    expect(calls).toEqual(['attention', 'slack'])
  })
})
