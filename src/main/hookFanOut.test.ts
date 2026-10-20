import { describe, it, expect } from 'vitest'
import { fanOutHookEvent, type HookFanOutTap } from './hookFanOut'

const recorder = (calls: string[], name: string, throwing = false): HookFanOutTap => ({
  onHookEvent: (sessionId, payload) => {
    calls.push(name)
    if (throwing) throw new Error(`${name} boom`)
  }
})

describe('fanOutHookEvent — every tap sees the event', () => {
  it('calls attention, pendingPrompt and slack once each, with the same sessionId and payload', () => {
    const seen: Array<{ name: string; sessionId: string; payload: unknown }> = []
    const tap = (name: string): HookFanOutTap => ({
      onHookEvent: (sessionId, payload) => seen.push({ name, sessionId, payload })
    })
    fanOutHookEvent(
      {
        attention: tap('attention'),
        pendingPrompt: tap('pendingPrompt'),
        slack: tap('slack')
      },
      's1',
      { hook_event_name: 'Notification' }
    )
    expect(seen).toEqual([
      { name: 'attention', sessionId: 's1', payload: { hook_event_name: 'Notification' } },
      { name: 'pendingPrompt', sessionId: 's1', payload: { hook_event_name: 'Notification' } },
      { name: 'slack', sessionId: 's1', payload: { hook_event_name: 'Notification' } }
    ])
  })
})

describe('fanOutHookEvent — attention runs first', () => {
  // This is the property Task 5's review found nothing pinned: attention has to see and process an
  // event before anything that reads its result would. Recording the call order is the direct way to
  // pin it, rather than trusting the source order never drifts.
  it('records attention before pendingPrompt and slack', () => {
    const calls: string[] = []
    fanOutHookEvent(
      {
        attention: recorder(calls, 'attention'),
        pendingPrompt: recorder(calls, 'pendingPrompt'),
        slack: recorder(calls, 'slack')
      },
      's1',
      { hook_event_name: 'PreToolUse', tool_use_id: 'call-1' }
    )
    expect(calls).toEqual(['attention', 'pendingPrompt', 'slack'])
  })
})

describe('fanOutHookEvent — one tap throwing does not stop the others', () => {
  // The property the attention tap's own try exists for, and the reason it matters more now that
  // attention runs first: without it, a throw there would cost pendingPrompt and slack their turn too,
  // not just itself.
  it('attention throwing still lets pendingPrompt and slack run', () => {
    const calls: string[] = []
    expect(() =>
      fanOutHookEvent(
        {
          attention: recorder(calls, 'attention', true),
          pendingPrompt: recorder(calls, 'pendingPrompt'),
          slack: recorder(calls, 'slack')
        },
        's1',
        {}
      )
    ).not.toThrow()
    expect(calls).toEqual(['attention', 'pendingPrompt', 'slack'])
  })

  it('pendingPrompt throwing still lets slack run', () => {
    const calls: string[] = []
    expect(() =>
      fanOutHookEvent(
        {
          attention: recorder(calls, 'attention'),
          pendingPrompt: recorder(calls, 'pendingPrompt', true),
          slack: recorder(calls, 'slack')
        },
        's1',
        {}
      )
    ).not.toThrow()
    expect(calls).toEqual(['attention', 'pendingPrompt', 'slack'])
  })

  // slack itself is intentionally left unguarded (matching its behaviour before this task), so a throw
  // there is expected to escape — this pins that fact rather than leaving it an unstated assumption.
  it('slack throwing does escape — it has no try of its own, unlike attention and pendingPrompt', () => {
    const calls: string[] = []
    expect(() =>
      fanOutHookEvent(
        {
          attention: recorder(calls, 'attention'),
          pendingPrompt: recorder(calls, 'pendingPrompt'),
          slack: recorder(calls, 'slack', true)
        },
        's1',
        {}
      )
    ).toThrow('slack boom')
    // attention and pendingPrompt still ran before the throw.
    expect(calls).toEqual(['attention', 'pendingPrompt', 'slack'])
  })
})
