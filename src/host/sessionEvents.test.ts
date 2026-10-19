// Plugin Phase 3 (events and notifications design N2, N3): the session events the Host records. Hook events, the
// Host's own chats and chains, and what an app forwards become `session.*` drafts, by the rules the desktop
// notifications follow. The registries and chats are small fakes: only their callbacks are read.
import { describe, it, expect } from 'vitest'
import { createHostSessionEvents, SESSION_EVENTS_TRACKED_MAX } from './sessionEvents'
import type { EventDraft } from '../core/orchestration/publicEvents'
import type { HostSession } from '../core/orchestration/command'
import type { ChatEvent } from '../core/chat/types'

const row = (id: string, over: Partial<HostSession> = {}): HostSession => ({
  id,
  kind: 'terminal',
  title: 'Fix the build',
  accountId: 'a1',
  cwd: 'D:\\proj',
  alive: true,
  state: 'waiting',
  provider: 'claude',
  sources: { status: 'hooks', prompt: 'hooks', usage: 'statusline', conversation: 'transcript' },
  ...over
})

function rig(
  o: { rows?: Record<string, HostSession>; heldChats?: string[]; heldChains?: string[]; lookup?: (id: string) => Promise<HostSession | null>; record?: (d: EventDraft[]) => void } = {}
) {
  const drafts: EventDraft[] = []
  const logged: string[] = []
  const exits = new Set<(id: string, code: number) => void>()
  const procExits = new Set<(id: string, code: number) => void>()
  const chatListeners = new Set<(id: string, e: ChatEvent) => void>()
  const metas = new Map<string, { kind: 'session'; id: string; restore: Record<string, unknown> }>()
  const procs: Array<{ id: string; alive: boolean; meta?: { kind: 'chat'; id: string; restore: Record<string, unknown> } }> = []
  /** A session's live pty, as `sessionPty` answers it: a respawn that keeps the id opens its new pty first. */
  const livePty = new Map<string, string>()
  const events = createHostSessionEvents({
    record: o.record ?? ((d) => drafts.push(...d)),
    sessionById: o.lookup ?? (async (id) => o.rows?.[id] ?? null),
    registry: {
      onExit: (cb) => (exits.add(cb), () => exits.delete(cb)),
      metaOf: (id) => metas.get(id) ?? null,
      sessionPty: (id) => livePty.get(id) ?? null
    },
    procs: { onExit: (cb) => (procExits.add(cb), () => procExits.delete(cb)), list: () => procs as never },
    chats: { subscribe: (fn) => (chatListeners.add(fn), () => chatListeners.delete(fn)), has: (id) => (o.heldChats ?? []).includes(id) },
    rolling: { has: (id) => (o.heldChains ?? []).includes(id) },
    log: (m) => logged.push(m)
  })
  return {
    events,
    drafts,
    logged,
    listening: () => exits.size + procExits.size + chatListeners.size,
    chat: (id: string, e: ChatEvent) => chatListeners.forEach((l) => l(id, e)),
    ptyExit: (ptyId: string, sessionId: string, respawnedAs?: string) => {
      metas.set(ptyId, { kind: 'session', id: sessionId, restore: {} })
      if (respawnedAs) livePty.set(sessionId, respawnedAs)
      exits.forEach((cb) => cb(ptyId, 0))
    },
    procExit: (procId: string, sessionId: string, liveSibling?: string) => {
      if (liveSibling) procs.push({ id: liveSibling, alive: true, meta: { kind: 'chat', id: sessionId, restore: {} } })
      procs.push({ id: procId, alive: false, meta: { kind: 'chat', id: sessionId, restore: {} } })
      procExits.forEach((cb) => cb(procId, 0))
    }
  }
}

const hook = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ hook_event_name: name, ...extra })
const permissionPrompt = hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
const session = { id: 's1', kind: 'terminal', title: 'Fix the build', provider: 'claude', cwd: 'D:\\proj' }
const approval: ChatEvent = { type: 'request', request: { id: 'r1', kind: 'approval', about: {} as never, decisions: [] } }
const asking: ChatEvent = { type: 'request', request: { id: 'r2', kind: 'question', form: {} as never } }

describe('the Host session events', () => {
  it('records input needed when a terminal session turns to a permission prompt', async () => {
    const r = rig({ rows: { s1: row('s1') } })
    r.events.onHookEvent('s1', hook('PreToolUse', { tool_use_id: 't1', tool_name: 'Bash' }))
    r.events.onHookEvent('s1', permissionPrompt)
    await r.events.settled()
    expect(r.drafts).toEqual([{ type: 'session.input_needed', sessionId: 's1', payload: { session, prompt: 'permission' } }])
  })

  it('says question for an AskUserQuestion that waits', async () => {
    const r = rig({ rows: { s1: row('s1') } })
    r.events.onHookEvent('s1', hook('PreToolUse', { tool_use_id: 't1', tool_name: 'AskUserQuestion', tool_input: {} }))
    r.events.onHookEvent('s1', permissionPrompt)
    await r.events.settled()
    expect(r.drafts.map((d) => (d.payload as { prompt: unknown }).prompt)).toEqual(['question'])
  })

  // Final review m2: the waiting call follows pendingPrompt's rules (src/core/sessions/pendingPrompt.ts): the latest
  // PreToolUse wins, and a turn end from before the latest prompt is the previous turn's
  it('says permission once a declined question is followed by another call', async () => {
    const r = rig({ rows: { s1: row('s1') } })
    r.events.onHookEvent('s1', hook('PreToolUse', { tool_use_id: 'q', tool_name: 'AskUserQuestion', tool_input: {} }))
    // declined: no PostToolUse for it, and the turn goes on to a Bash call that needs permission
    r.events.onHookEvent('s1', hook('PreToolUse', { tool_use_id: 'b', tool_name: 'Bash', tool_input: { command: 'ls' } }))
    r.events.onHookEvent('s1', permissionPrompt)
    await r.events.settled()
    expect(r.drafts.map((d) => (d.payload as { prompt: unknown }).prompt)).toEqual(['permission'])
  })

  it('keeps a question up when the previous turn’s StopFailure lands late', async () => {
    const r = rig({ rows: { s1: row('s1') } })
    r.events.onHookEvent('s1', hook('UserPromptSubmit', { astera_at: 2000 }))
    r.events.onHookEvent('s1', hook('PreToolUse', { tool_use_id: 'q', tool_name: 'AskUserQuestion', tool_input: {}, astera_at: 2100 }))
    r.events.onHookEvent('s1', hook('StopFailure', { astera_at: 1900 }))
    r.events.onHookEvent('s1', hook('Notification', { notification_type: 'permission_prompt', message: 'm', astera_at: 2200 }))
    await r.events.settled()
    expect(r.drafts.map((d) => (d.payload as { prompt: unknown }).prompt)).toEqual(['question'])
  })

  it('says null for a waiting it cannot name', async () => {
    const r = rig({ rows: { s1: row('s1') } })
    r.events.onHookEvent('s1', hook('PreToolUse', { tool_use_id: 't1', tool_name: 'Bash' }))
    r.events.onHookEvent('s1', hook('Notification', { notification_type: 'something_new', message: 'm' }))
    await r.events.settled()
    expect(r.drafts.map((d) => (d.payload as { prompt: unknown }).prompt)).toEqual([null])
  })

  // Review Focus 1: attention's transition rule (src/core/sessions/attention.ts), not one notice per event
  it('records input needed once per turn into waiting', async () => {
    const r = rig({ rows: { s1: row('s1') } })
    r.events.onHookEvent('s1', hook('PreToolUse', { tool_use_id: 'task', tool_name: 'Task' }))
    r.events.onHookEvent('s1', permissionPrompt)
    // subagents finishing underneath the open prompt: more notifications while the session is already waiting
    for (let i = 0; i < 4; i++) r.events.onHookEvent('s1', hook('Notification', { notification_type: 'permission_prompt', message: `again ${i}` }))
    await r.events.settled()
    expect(r.drafts).toHaveLength(1)
    // answered, then a new prompt: a second turn into waiting is a second event
    r.events.onHookEvent('s1', hook('PostToolUse', { tool_use_id: 'task' }))
    r.events.onHookEvent('s1', hook('PreToolUse', { tool_use_id: 't2', tool_name: 'Bash' }))
    r.events.onHookEvent('s1', permissionPrompt)
    await r.events.settled()
    expect(r.drafts).toHaveLength(2)
  })

  it('records a chat the Host holds turning to waiting, with what its open request asks', async () => {
    const r = rig({ rows: { c1: row('c1', { kind: 'chat', provider: 'codex', title: null }) } })
    r.chat('c1', approval)
    r.chat('c1', { type: 'status', status: 'waiting' })
    r.chat('c1', { type: 'status', status: 'working' })
    r.chat('c1', asking)
    r.chat('c1', { type: 'status', status: 'waiting' })
    r.chat('c1', { type: 'request', request: null })
    r.chat('c1', { type: 'status', status: 'idle' })
    r.chat('c1', { type: 'status', status: 'waiting' })
    await r.events.settled()
    const chat = { id: 'c1', kind: 'chat', provider: 'codex', cwd: 'D:\\proj' }
    expect(r.drafts).toEqual([
      { type: 'session.input_needed', sessionId: 'c1', payload: { session: chat, prompt: 'permission' } },
      { type: 'session.input_needed', sessionId: 'c1', payload: { session: chat, prompt: 'question' } },
      { type: 'session.input_needed', sessionId: 'c1', payload: { session: chat, prompt: null } }
    ])
  })

  it('records a limit wait and an account switch, and not their re-publishes or the other states', async () => {
    const r = rig({ rows: { s1: row('s1') } })
    r.events.onRollState({ sessionId: 's1', state: 'waiting', scope: 'weekly', nextRetryAt: '2026-10-15T03:00:00.000Z' })
    r.events.onRollState({ sessionId: 's1', state: 'waiting', reattach: true })
    r.events.onRollState({ sessionId: 's1', state: 'switching', accountLabel: 'work' })
    r.events.onRollState({ sessionId: 's1', state: 'switching', accountLabel: 'work', reattach: true })
    r.events.onRollState({ sessionId: 's1', state: 'switching' })
    for (const state of ['trust', 'nudged', 'stalled', 'adopted', 'none'] as const) r.events.onRollState({ sessionId: 's1', state })
    await r.events.settled()
    expect(r.drafts).toEqual([
      { type: 'session.limit_waiting', sessionId: 's1', payload: { session, scope: 'weekly', nextRetryAt: '2026-10-15T03:00:00.000Z' } },
      { type: 'session.account_switched', sessionId: 's1', payload: { session, accountLabel: 'work' } }
    ])
  })

  // A limit judged from usage alone (manual) resumes nothing, so the public event carries no retry time —
  // a plugin then says the session stopped at a limit, not that it tries again at a time (2026-10-19).
  it('records a waiting judged from usage alone without a retry time', async () => {
    const r = rig({ rows: { s1: row('s1') } })
    r.events.onRollState({ sessionId: 's1', state: 'waiting', scope: 'session', nextRetryAt: '2026-10-15T03:00:00.000Z', manual: true })
    await r.events.settled()
    expect(r.drafts).toEqual([{ type: 'session.limit_waiting', sessionId: 's1', payload: { session, scope: 'session' } }])
  })

  it('records what an app forwards for the sessions the Host does not source', async () => {
    const r = rig()
    const appChat = { id: 'c9', kind: 'chat', title: 'App chat', provider: 'claude', cwd: 'D:\\a' }
    r.events.forwarded({ kind: 'chat', session: appChat, event: { type: 'request', request: 'question' } })
    r.events.forwarded({ kind: 'chat', session: appChat, event: { type: 'status', status: 'waiting' } })
    r.events.forwarded({ kind: 'roll-state', session: { id: 's9', kind: 'terminal', title: 'App term' }, event: { sessionId: 's9', state: 'waiting' } })
    await r.events.settled()
    expect(r.drafts).toEqual([
      { type: 'session.input_needed', sessionId: 'c9', payload: { session: appChat, prompt: 'question' } },
      { type: 'session.limit_waiting', sessionId: 's9', payload: { session: { id: 's9', kind: 'terminal', title: 'App term' } } }
    ])
  })

  it('names a forwarded chat whose first signal is already its waiting', async () => {
    const r = rig()
    r.events.forwarded({ kind: 'chat', session: { id: 'c9', kind: 'chat', title: 'App chat' }, event: { type: 'status', status: 'waiting' } })
    await r.events.settled()
    expect(r.drafts).toEqual([{ type: 'session.input_needed', sessionId: 'c9', payload: { session: { id: 'c9', kind: 'chat', title: 'App chat' }, prompt: null } }])
  })

  it('reads the session the Host has a row for over what the app forwarded', async () => {
    const r = rig({ rows: { s9: row('s9', { title: 'Host title' }) } })
    r.events.forwarded({ kind: 'roll-state', session: { id: 's9', kind: 'terminal', title: 'App title' }, event: { sessionId: 's9', state: 'switching', accountLabel: 'b' } })
    await r.events.settled()
    expect((r.drafts[0].payload as { session: { title: string } }).session.title).toBe('Host title')
  })

  it('drops a forward for a chat or chain the Host holds itself, and a malformed one', async () => {
    const r = rig({ heldChats: ['c1'], heldChains: ['s1'] })
    r.events.forwarded({ kind: 'chat', session: { id: 'c1', kind: 'chat' }, event: { type: 'status', status: 'waiting' } })
    r.events.forwarded({ kind: 'roll-state', session: { id: 's1', kind: 'terminal' }, event: { sessionId: 's1', state: 'waiting' } })
    r.events.forwarded({ kind: 'roll-state', session: { id: 's1', kind: 'terminal' }, event: { sessionId: 's2', state: 'waiting' } })
    await r.events.settled()
    expect(r.drafts).toEqual([])
    expect(r.logged.filter((m) => m.includes('malformed'))).toHaveLength(1)
  })

  // Review Focus 5
  it('keeps order and falls back when the session cannot be read', async () => {
    let release!: () => void
    const slow = new Promise<void>((res) => (release = res))
    const r = rig({
      lookup: async (id) => {
        if (id === 's1') {
          await slow
          return null
        }
        throw new Error('registry gone')
      }
    })
    r.events.onRollState({ sessionId: 's1', state: 'waiting' })
    r.events.onRollState({ sessionId: 's1', state: 'switching', accountLabel: 'b' })
    r.events.onRollState({ sessionId: 's2', state: 'waiting' })
    release()
    await r.events.settled()
    expect(r.drafts.map((d) => [d.type, d.sessionId, (d.payload as { session: unknown }).session])).toEqual([
      ['session.limit_waiting', 's1', { id: 's1', kind: 'terminal' }],
      ['session.account_switched', 's1', { id: 's1', kind: 'terminal' }],
      ['session.limit_waiting', 's2', { id: 's2', kind: 'terminal' }]
    ])
    expect(r.logged.some((m) => m.includes('registry gone'))).toBe(true)
  })

  it('forgets a session that ended, so its next turn into waiting is told', async () => {
    const r = rig({ rows: { s1: row('s1') } })
    r.events.onHookEvent('s1', hook('PreToolUse', { tool_use_id: 't1', tool_name: 'Bash' }))
    r.events.onHookEvent('s1', permissionPrompt)
    r.ptyExit('pty1', 's1')
    r.events.onHookEvent('s1', permissionPrompt)
    await r.events.settled()
    expect(r.drafts).toHaveLength(2)
  })

  it('forgets a chat whose proc ended', async () => {
    const r = rig({ rows: { c1: row('c1', { kind: 'chat' }) } })
    r.chat('c1', { type: 'status', status: 'waiting' })
    r.procExit('p1', 'c1')
    r.chat('c1', { type: 'status', status: 'waiting' })
    await r.events.settled()
    expect(r.drafts).toHaveLength(2)
  })

  // Final review m4: an exit that is not the session's end keeps what the session is waiting on, so a prompt still up
  // is not told again
  it('does not end a session whose respawn kept its id', async () => {
    const r = rig({ rows: { s1: row('s1') } })
    r.events.onHookEvent('s1', hook('PreToolUse', { tool_use_id: 't1', tool_name: 'Bash' }))
    r.events.onHookEvent('s1', permissionPrompt)
    r.ptyExit('pty1', 's1', 'pty2')
    r.events.onHookEvent('s1', permissionPrompt)
    await r.events.settled()
    expect(r.drafts).toHaveLength(1)
  })

  it('does not end a chat while another of its procs is alive', async () => {
    const r = rig({ rows: { c1: row('c1', { kind: 'chat' }) } })
    r.chat('c1', { type: 'status', status: 'waiting' })
    r.procExit('p1', 'c1', 'p2')
    r.chat('c1', { type: 'status', status: 'waiting' })
    await r.events.settled()
    expect(r.drafts).toHaveLength(1)
  })

  // Final review m1: what the recorder keeps per session is bounded for the Host's life. A session that never ends in
  // this Host's registries (an app's own pty, a chat whose status lands after its exit) is forgotten oldest first.
  it('keeps at most a bounded number of sessions, forgetting the oldest', async () => {
    const r = rig()
    for (let i = 0; i < SESSION_EVENTS_TRACKED_MAX + 5; i++) r.events.onHookEvent(`s${i}`, hook('PreToolUse', { tool_use_id: 't', tool_name: 'Bash' }))
    expect(r.events.tracked()).toBe(SESSION_EVENTS_TRACKED_MAX)
    // the oldest was forgotten, so its prompt is a fresh turn into waiting; the newest still knows its call
    r.events.onHookEvent('s0', permissionPrompt)
    r.events.onHookEvent(`s${SESSION_EVENTS_TRACKED_MAX + 4}`, permissionPrompt)
    await r.events.settled()
    expect(r.drafts.map((d) => d.sessionId)).toEqual(['s0', `s${SESSION_EVENTS_TRACKED_MAX + 4}`])
    expect(r.events.tracked()).toBe(SESSION_EVENTS_TRACKED_MAX)
  })

  it('keeps nothing for a forwarded roll state, a final one after the session ended included', async () => {
    const r = rig()
    r.events.forwarded({ kind: 'roll-state', session: { id: 's9', kind: 'terminal', title: 'App term' }, event: { sessionId: 's9', state: 'none' } })
    r.events.forwarded({ kind: 'roll-state', session: { id: 's9', kind: 'terminal', title: 'App term' }, event: { sessionId: 's9', state: 'waiting' } })
    await r.events.settled()
    expect(r.drafts).toEqual([{ type: 'session.limit_waiting', sessionId: 's9', payload: { session: { id: 's9', kind: 'terminal', title: 'App term' } } }])
    expect(r.events.tracked()).toBe(0)
  })

  it('never throws: a record that throws is logged', async () => {
    const r = rig({
      rows: { s1: row('s1') },
      record: () => {
        throw new Error('disk')
      }
    })
    expect(() => r.events.onRollState({ sessionId: 's1', state: 'waiting' })).not.toThrow()
    expect(() => r.events.onHookEvent('s1', null)).not.toThrow()
    expect(() => r.events.forwarded(undefined)).not.toThrow()
    await r.events.settled()
    expect(r.logged.some((m) => m.includes('disk'))).toBe(true)
  })

  it('stops hearing its sources once disposed', async () => {
    const r = rig({ rows: { s1: row('s1') } })
    expect(r.listening()).toBe(3)
    r.events.dispose()
    expect(r.listening()).toBe(0)
    r.events.onRollState({ sessionId: 's1', state: 'waiting' })
    r.events.forwarded({ kind: 'chat', session: { id: 'c1', kind: 'chat' }, event: { type: 'status', status: 'waiting' } })
    await r.events.settled()
    expect(r.drafts).toEqual([])
  })
})
