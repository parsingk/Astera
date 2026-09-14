import { describe, it, expect } from 'vitest'
import type { RollStateEvent, SessionInfo } from '../core/types'
import { DESKTOP_NOTIFY_DEFAULTS, type DesktopNotifySettings } from '../core/notify/settings'
import { DesktopNotifier, type DesktopShowRequest } from './desktopNotifier'
import { createAttentionState } from './attention'

const session = (id: string): SessionInfo => ({
  id,
  accountId: 'main',
  cwd: 'D:/work',
  status: 'running',
  title: `session ${id}`
})

/** What every existing test in this file drives — the same surface `DesktopNotifier` itself exposes,
 *  so no test body has to change to route through the feed below. */
interface HarnessNotifier {
  onHookEvent: (sessionId: string, payload: unknown) => void
  onRollState: (ev: RollStateEvent) => void
  setActiveSession: (sessionId: string | null) => void
}

interface Harness {
  notifier: HarnessNotifier
  shown: DesktopShowRequest[]
  focused: { value: boolean }
}

function harness(flags: Partial<DesktopNotifySettings> = {}, sessions = ['s1', 's2']): Harness {
  const shown: DesktopShowRequest[] = []
  const focused = { value: false }
  // The real state (main/attention.ts), not a stub. `DesktopNotifier` subscribes to it in its own
  // constructor and fires on the TRANSITION into `waiting` (see that constructor's comment) — a stub
  // that just returned canned values would not exercise the thing several tests below need to prove:
  // that a specific sequence of hook events produces the right number of transitions, not the right
  // number of Notification payloads.
  const attention = createAttentionState()
  const real = new DesktopNotifier({
    settings: { getDesktopNotify: () => ({ ...DESKTOP_NOTIFY_DEFAULTS, ...flags }) },
    isFocused: () => focused.value,
    getSession: (id) => (sessions.includes(id) ? session(id) : null),
    lang: () => 'en',
    show: (req) => shown.push(req),
    attention
  })
  const notifier: HarnessNotifier = {
    // Feeds the shared state the same way index.ts's dedicated tap does. `real` already subscribed to
    // this same `attention` instance in its constructor, so this alone is enough to drive a
    // notification — there is no separate `real.onHookEvent` to call any more (see desktopNotifier.ts:
    // the whole method went away with the per-event read it existed for).
    onHookEvent: (sessionId, payload) => attention.onHookEvent(sessionId, payload),
    onRollState: (ev) => real.onRollState(ev),
    setActiveSession: (sessionId) => real.setActiveSession(sessionId)
  }
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
  //
  // Fix round 2 moved the expectation on the loop below from four fires to one. This sink now fires on
  // the transition into `waiting`, not on every Notification read while a session is already `waiting`
  // (desktopNotifier.ts's constructor comment has the full reasoning, and the "DesktopNotifier — waiting
  // fires once per transition" describe block below has the measured spam sequences this was fixed
  // for). Four different prompt types back to back on the same session, with nothing resolving the
  // first before the next arrives, is the artificial version of that same spam: `s1` transitions into
  // `waiting` once, on the first prompt, and stays there through the rest, so exactly one toast fires —
  // not one per type. That each of these four types individually reaches `waiting` is attention.ts's
  // own coverage (attention.test.ts's `%s is a waiting screen` cases), not this file's job to re-prove.
  it('an idle_prompt shows nothing, while a choice or an approval fires once, not once per type', () => {
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
    expect(h.shown.map((s) => s.event)).toEqual(['inputNeeded'])
  })

  // The one behaviour change Task 5 made: attention.ts treats an idle notice as `waiting` when a
  // PreToolUse call is still outstanding (its own Notification branch), and this sink now inherits
  // that exception because it subscribes to the shared verdict instead of dropping idle unconditionally
  // as it did before. Before Task 5 the sequence below showed nothing at all.
  it('an idle_prompt with a call outstanding fires, where before it fired nothing', () => {
    const h = harness()
    h.notifier.onHookEvent('s1', { hook_event_name: 'PreToolUse', tool_use_id: 'call-1' })
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    expect(h.shown.map((s) => s.event)).toEqual(['inputNeeded'])
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

// Fix round 2. Reading `attention.get(sessionId)` per Notification event (fix round 1's design) fires
// once per Notification that happens to arrive while the verdict is already `waiting`, not once per
// genuine prompt — `Attention` is level state, and a level read re-fires for every event underneath an
// unresolved one. These three sequences are the reviewer's own measurements of that spam; each now
// fires exactly one toast, matching what the original per-payload classification this sink carried
// before Task 5 would have fired for the same three sequences.
describe('DesktopNotifier — waiting fires once per transition, not once per Notification', () => {
  // permission_prompt asks; auth_success and agent_completed each report something already finished —
  // neither changes the verdict, so neither should re-announce a prompt that is still the same prompt.
  it('permission_prompt, then auth_success, then agent_completed — fires once', () => {
    const h = harness()
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification', notification_type: 'permission_prompt' })
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification', notification_type: 'auth_success' })
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification', notification_type: 'agent_completed' })
    expect(h.shown.map((s) => s.event)).toEqual(['inputNeeded'])
  })

  // The PreToolUse never itself fires (a session becoming `working` is not `waiting`). The prompt fires
  // once, on the transition. agent_completed reports a different, unrelated finish and leaves the
  // outstanding call's verdict exactly where it was — still `waiting` — so it must not fire again.
  it('PreToolUse, then worker_permission_prompt, then agent_completed — fires once', () => {
    const h = harness()
    h.notifier.onHookEvent('s1', { hook_event_name: 'PreToolUse', tool_use_id: 'call-1' })
    h.notifier.onHookEvent('s1', {
      hook_event_name: 'Notification',
      notification_type: 'worker_permission_prompt'
    })
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification', notification_type: 'agent_completed' })
    expect(h.shown.map((s) => s.event)).toEqual(['inputNeeded'])
  })

  // The concrete case: five subagents dispatched, one asks permission (fires once), the person has not
  // answered yet, and each of the other four finishing sends its own idle notice underneath the still-
  // outstanding call. Idle alone never fires (no call outstanding, or here, no *new* transition) — the
  // verdict is already `waiting` and idle does not change it, so the second and third idle notice must
  // not pop a second and third toast for a prompt the person has already seen once.
  it('permission_prompt, then idle_prompt, then idle_prompt — fires once', () => {
    const h = harness()
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification', notification_type: 'permission_prompt' })
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    h.notifier.onHookEvent('s1', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    expect(h.shown.map((s) => s.event)).toEqual(['inputNeeded'])
  })

  // Leaving `waiting` is a transition too, and it must not fire. Without this, an edit that fires on
  // any change rather than on the arrival at `waiting` passes every other test here: nothing else
  // resolves a session out of `waiting` and then counts. Answering the prompt lets the call finish,
  // and a toast at that moment would announce input needed for a session that is no longer blocked.
  it('resolving the prompt does not fire a second time', () => {
    const h = harness()
    h.notifier.onHookEvent('s1', { hook_event_name: 'PreToolUse', tool_use_id: 'call-1' })
    h.notifier.onHookEvent('s1', {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt'
    })
    h.notifier.onHookEvent('s1', { hook_event_name: 'PostToolUse', tool_use_id: 'call-1' })
    expect(h.shown.map((s) => s.event)).toEqual(['inputNeeded'])
  })

  // The same on the other exit from `waiting`: the turn ends rather than the call finishing.
  it('Stop while waiting does not fire', () => {
    const h = harness()
    h.notifier.onHookEvent('s1', {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt'
    })
    h.notifier.onHookEvent('s1', { hook_event_name: 'Stop' })
    expect(h.shown.map((s) => s.event)).toEqual(['inputNeeded'])
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
