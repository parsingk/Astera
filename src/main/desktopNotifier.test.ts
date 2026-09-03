import { describe, it, expect } from 'vitest'
import type { RollStateEvent, SessionInfo } from '../core/types'
import { DESKTOP_NOTIFY_DEFAULTS, type DesktopNotifySettings } from '../core/notify/settings'
import { DesktopNotifier, type DesktopShowRequest } from './desktopNotifier'

const session = (id: string): SessionInfo => ({
  id,
  accountId: 'main',
  cwd: 'D:/work',
  status: 'running',
  title: `session ${id}`
})

interface Harness {
  notifier: DesktopNotifier
  shown: DesktopShowRequest[]
  focused: { value: boolean }
}

function harness(flags: Partial<DesktopNotifySettings> = {}, sessions = ['s1', 's2']): Harness {
  const shown: DesktopShowRequest[] = []
  const focused = { value: false }
  const notifier = new DesktopNotifier({
    settings: { getDesktopNotify: () => ({ ...DESKTOP_NOTIFY_DEFAULTS, ...flags }) },
    isFocused: () => focused.value,
    getSession: (id) => (sessions.includes(id) ? session(id) : null),
    lang: () => 'en',
    show: (req) => shown.push(req)
  })
  return { notifier, shown, focused }
}

const roll = (over: Partial<RollStateEvent> = {}): RollStateEvent => ({
  sessionId: 's1',
  state: 'waiting',
  nextRetryAt: '2026-09-02T13:00:00.000Z',
  scope: 'session',
  ...over
})

describe('DesktopNotifier — the three events', () => {
  it('input needed fires on a Notification hook, and is on by default', () => {
    const h = harness()
    // A payload with no notification_type at all and no idle wording is an unknown kind — it errs
    // toward notifying, the same direction core/hooks/notification takes.
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification' })
    expect(h.shown.map((s) => s.event)).toEqual(['inputNeeded'])
  })

  it('waiting on a limit fires on a waiting roll state, and is on by default', () => {
    const h = harness()
    h.notifier.onRollState(roll())
    expect(h.shown.map((s) => s.event)).toEqual(['limitWaiting'])
  })

  it('account switched is off by default and fires once enabled', () => {
    const off = harness()
    off.notifier.onRollState(roll({ state: 'switching', accountLabel: 'spare' }))
    expect(off.shown).toHaveLength(0)

    const on = harness({ accountSwitched: true })
    on.notifier.onRollState(roll({ state: 'switching', accountLabel: 'spare' }))
    expect(on.shown.map((s) => s.event)).toEqual(['accountSwitched'])
    expect(on.shown[0].body).toContain('spare')
  })

  it('each of the three is silent with its own flag off', () => {
    const h = harness({
      inputNeeded: false,
      limitWaiting: false,
      accountSwitched: false
    })
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification' })
    h.notifier.onRollState(roll())
    h.notifier.onRollState(roll({ state: 'switching', accountLabel: 'spare' }))
    expect(h.shown).toHaveLength(0)
  })

  it('other hook events and other roll states are ignored', () => {
    const h = harness({ accountSwitched: true })
    // Stop is Slack's turn notice, not a desktop event — the desktop sink ignores it entirely.
    h.notifier.onHookEvent('s1', { hook_event_name: 'Stop' })
    h.notifier.onHookEvent('s1', { hook_event_name: 'PreToolUse' })
    h.notifier.onHookEvent('s1', { hook_event_name: 'PostToolUse' })
    h.notifier.onHookEvent('s1', null)
    h.notifier.onHookEvent('s1', 'Stop')
    for (const state of ['trust', 'nudged', 'stalled', 'none'] as const)
      h.notifier.onRollState(roll({ state }))
    expect(h.shown).toHaveLength(0)
  })

  // agent_completed reports that a worker finished, not a screen waiting for an answer — the same
  // classification slack.ts applies via isNonPromptNotification. Without it, a fan-out of subagents
  // pops one false "waiting for your input" toast per worker as each one completes.
  it('a non-prompt notification_type (agent_completed) shows nothing; no type or a prompt type still fires', () => {
    const h = harness()
    h.notifier.onHookEvent('s1', {
      hook_event_name: 'Notification',
      notification_type: 'agent_completed'
    })
    expect(h.shown).toHaveLength(0)

    // A payload with no notification_type at all and no idle wording is an unknown kind — it errs
    // toward notifying, the same direction core/hooks/notification takes.
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification' })
    expect(h.shown.map((s) => s.event)).toEqual(['inputNeeded'])

  })

  // "Claude is waiting for your input" after N idle seconds is not a screen waiting for an answer —
  // nothing is blocked and nothing has to be decided. The desktop notification is for a choice or a
  // permission approval, and those arrive under their own types, so dropping idle costs none of them.
  it('an idle_prompt shows nothing, while a choice or an approval still fires', () => {
    const h = harness()
    h.notifier.onHookEvent('s1', {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt'
    })
    // The pre-type fallback, for a Claude Code old enough to carry no notification_type at all
    h.notifier.onHookEvent('s1', {
      hook_event_name: 'Notification',
      message: 'Claude is waiting for your input'
    })
    expect(h.shown).toHaveLength(0)

    for (const notification_type of [
      'permission_prompt',
      'worker_permission_prompt',
      'agent_needs_input',
      'elicitation_dialog'
    ]) {
      h.notifier.onHookEvent('s1', { hook_event_name: 'Notification', notification_type })
    }
    expect(h.shown.map((s) => s.event)).toEqual([
      'inputNeeded',
      'inputNeeded',
      'inputNeeded',
      'inputNeeded'
    ])
  })

  // reattach is the re-publish that reattaches the banner to the new sessionId after a respawn — the
  // same switch must not be announced twice. slack.ts's onRollState makes the identical exclusion.
  it('a reattach republish of switching does not fire a second time', () => {
    const h = harness({ accountSwitched: true })
    h.notifier.onRollState(roll({ state: 'switching', accountLabel: 'spare' }))
    h.notifier.onRollState(roll({ state: 'switching', accountLabel: 'spare', reattach: true }))
    expect(h.shown).toHaveLength(1)
  })
})

describe('DesktopNotifier — suppression', () => {
  it('is suppressed when the window is focused and this is the active session', () => {
    const h = harness()
    h.focused.value = true
    h.notifier.setActiveSession('s1')
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification' })
    expect(h.shown).toHaveLength(0)
  })

  it('focused but a different session on screen still fires', () => {
    const h = harness()
    h.focused.value = true
    h.notifier.setActiveSession('s2')
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification' })
    expect(h.shown).toHaveLength(1)
  })

  it('the active session but the window unfocused still fires', () => {
    const h = harness()
    h.focused.value = false
    h.notifier.setActiveSession('s1')
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification' })
    expect(h.shown).toHaveLength(1)
  })

  // null covers a file tab being focused, no pane having a session, and the panes being empty.
  it('a null active session suppresses nothing', () => {
    const h = harness()
    h.focused.value = true
    h.notifier.setActiveSession(null)
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification' })
    expect(h.shown).toHaveLength(1)
  })

  it('a non-string active session pushed from the renderer reads as null', () => {
    const h = harness()
    h.focused.value = true
    h.notifier.setActiveSession(42 as unknown as string)
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification' })
    expect(h.shown).toHaveLength(1)
  })
})

describe('DesktopNotifier — what the notification carries', () => {
  it('the title is the session title and the id travels with it for the click', () => {
    const h = harness()
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification' })
    expect(h.shown[0].title).toBe('session s1')
    expect(h.shown[0].sessionId).toBe('s1')
  })

  it('a vanished session falls back to the app name rather than an empty title', () => {
    const h = harness({}, [])
    h.notifier.onHookEvent('gone', { hook_event_name: 'Notification' })
    expect(h.shown[0].title).toBe('Astera')
  })

  // Matches the identical guard in SlackNotifier's own onRollState: with no label there is nothing
  // to name, and firing anyway produces an empty-label sentence (a doubled space and a dangling
  // particle in Korean).
  it('a switching event with no account label fires nothing', () => {
    const h = harness({ accountSwitched: true })
    h.notifier.onRollState(roll({ state: 'switching' }))
    expect(h.shown).toHaveLength(0)
  })
})
