// A remote session as the renderer holds it (remote runtime design Phase 9b): its ref from a Runtime's row, the roll it
// follows, when its facts call for a notification, the pages of its conversation, and its input batched for the link.
import { describe, it, expect, vi } from 'vitest'
import { refOf, followRolls, factsTransition, mergeTurns, InputCoalescer, createSessionArgs, goneOutcome, factsStatus, createFactsReader, pruneBaseline, followAction, remoteChatState, createRemoteAnswer, canStartSession, pollEvery, sameOrNext, type RemoteFacts } from './remoteSessions'
import { SESSION_INPUT_MAX } from '../../../core/remote/sessions'

const row = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  kind: 'terminal' as const,
  title: 'fix',
  accountId: 'acc',
  cwd: '/srv/repo',
  alive: true,
  state: 'unknown',
  ptyId: 'pty-1',
  provider: 'claude' as const,
  ...over
})

describe('refOf', () => {
  it('keys a Runtime row by runtime and session', () => {
    expect(refOf('rt_1', row())).toMatchObject({ runtimeId: 'rt_1', sessionId: 's1', key: 'rt_1:s1', kind: 'terminal', ptyId: 'pty-1', provider: 'claude', alive: true })
  })
})

describe('followRolls', () => {
  it('a row rolled from an open session replaces it; a chain is followed to its end', () => {
    const open = [refOf('rt_1', row({ id: 'a' }))]
    const rows = [row({ id: 'a', alive: false }), row({ id: 'b', rolledFrom: 'a', ptyId: 'pty-b' }), row({ id: 'c', rolledFrom: 'b', ptyId: 'pty-c' })]
    expect(followRolls(open, rows).map((r) => [r.from, r.to.key, r.to.ptyId])).toEqual([['rt_1:a', 'rt_1:c', 'pty-c']])
  })
  it('a roll whose new session is already open is not followed again', () => {
    const open = [refOf('rt_1', row({ id: 'a' })), refOf('rt_1', row({ id: 'b' }))]
    expect(followRolls(open, [row({ id: 'b', rolledFrom: 'a' })])).toEqual([])
  })
})

const facts = (over: Partial<RemoteFacts> = {}): RemoteFacts => ({ id: 's1', alive: true, status: 'working', prompt: null, usage: null, model: null, ...over })

describe('factsTransition', () => {
  it('a session that starts waiting, or asks something new, calls for a notification', () => {
    expect(factsTransition(facts(), facts({ status: 'waiting', prompt: 'permission' }))).toBe('waiting')
    expect(factsTransition(null, facts({ status: 'waiting' }))).toBe(null)
    expect(factsTransition(facts({ status: 'waiting', requests: [{ id: 'r1' }] }), facts({ status: 'waiting', requests: [{ id: 'r1' }, { id: 'r2' }] }))).toBe('waiting')
  })
  it('unknown never notifies, and neither does staying put', () => {
    expect(factsTransition(facts(), facts({ status: 'unknown' }))).toBe(null)
    expect(factsTransition(facts({ status: 'unknown' }), facts({ status: 'unknown', prompt: 'unknown' }))).toBe(null)
    expect(factsTransition(facts({ status: 'waiting' }), facts({ status: 'waiting' }))).toBe(null)
  })
})

describe('mergeTurns', () => {
  it('an older page goes before, a newer read replaces the turns it repeats', () => {
    const t = (id: string, text = id) => ({ id, role: 'user' as const, parts: [{ kind: 'text' as const, text }] })
    expect(mergeTurns([t('b'), t('c')], [t('a')], 'older').map((x) => x.id)).toEqual(['a', 'b', 'c'])
    const merged = mergeTurns([t('a'), t('b'), t('c', 'old')], [t('c', 'new'), t('d')], 'newer')
    expect(merged.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd'])
    expect((merged[2].parts[0] as { text: string }).text).toBe('new')
  })
})

describe('InputCoalescer', () => {
  it('joins keys typed together into one send, in order, one send at a time', async () => {
    const sent: string[] = []
    let release: () => void = () => {}
    const c = new InputCoalescer(
      (d) => {
        sent.push(d)
        return new Promise<void>((r) => (release = r))
      },
      { delayMs: 0 }
    )
    c.push('a')
    c.push('b')
    await new Promise((r) => setTimeout(r, 5))
    expect(sent).toEqual(['ab'])
    c.push('c')
    c.push('d')
    await new Promise((r) => setTimeout(r, 5))
    expect(sent).toEqual(['ab'])
    release()
    await new Promise((r) => setTimeout(r, 5))
    expect(sent).toEqual(['ab', 'cd'])
    release()
  })
  it('splits a paste larger than one input carries', async () => {
    const sent: string[] = []
    const c = new InputCoalescer(async (d) => void sent.push(d), { delayMs: 0 })
    c.push('x'.repeat(SESSION_INPUT_MAX + 10))
    await new Promise((r) => setTimeout(r, 10))
    expect(sent.map((s) => s.length)).toEqual([SESSION_INPUT_MAX, 10])
  })
  it('a failed send drops nothing after it', async () => {
    const sent: string[] = []
    let fail = true
    const c = new InputCoalescer(
      async (d) => {
        if (fail) {
          fail = false
          throw new Error('offline')
        }
        sent.push(d)
      },
      { delayMs: 0 }
    )
    c.push('a')
    await new Promise((r) => setTimeout(r, 5))
    c.push('b')
    await new Promise((r) => setTimeout(r, 5))
    expect(sent).toEqual(['b'])
  })
})

describe('createSessionArgs', () => {
  it('names the account as the Host reads it and drops an empty title or prompt', () => {
    expect(createSessionArgs({ kind: 'chat', accountId: 'a1', cwd: '/srv/repo', title: '  ', prompt: '' })).toEqual({
      kind: 'chat',
      account: 'a1',
      cwd: '/srv/repo'
    })
  })
  it('keeps a title and prompt, trimmed', () => {
    expect(createSessionArgs({ kind: 'terminal', accountId: 'a1', cwd: '/r', title: ' fix ', prompt: ' go ' })).toEqual({
      kind: 'terminal',
      account: 'a1',
      cwd: '/r',
      title: 'fix',
      prompt: 'go'
    })
  })
})

// Phase 9b review I1: input the Runtime did not take is reported, not dropped in silence.
describe('InputCoalescer delivery', () => {
  it('reports each send as delivered or not: a refusal, a lost Runtime and a throw are not', async () => {
    const replies = [{ status: 200 }, { status: 503 }, { status: 403 }]
    const seen: boolean[] = []
    const c = new InputCoalescer(
      async () => {
        const r = replies.shift()
        if (!r) throw new Error('offline')
        return r
      },
      { delayMs: 0, onDelivery: (ok) => seen.push(ok) }
    )
    for (const d of ['a', 'b', 'c', 'd']) {
      c.push(d)
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(seen).toEqual([true, false, false, false])
  })
})

// Phase 9b review M1: what a tab does when its stream is given up.
describe('goneOutcome', () => {
  it('an ended session stays ended', () => {
    expect(goneOutcome('RUNTIME_PTY_NOT_FOUND', { ended: true })).toBe('ended')
  })
  it('a Runtime that was removed, or one that cannot stream, is final', () => {
    expect(goneOutcome('RUNTIME_NOT_FOUND', { ended: false })).toBe('final')
    expect(goneOutcome('RUNTIME_AUTH_FAILED', { ended: false })).toBe('final')
    expect(goneOutcome('RUNTIME_CAPABILITY_MISSING', { ended: false })).toBe('final')
  })
  it('anything else is tried again', () => {
    expect(goneOutcome('RUNTIME_PTY_NOT_FOUND', { ended: false })).toBe('retry')
    expect(goneOutcome('RUNTIME_OFFLINE', { ended: false })).toBe('retry')
  })
})

// Phase 9b review I1: a tab whose facts cannot be read stops showing the last status as current.
describe('factsStatus', () => {
  it('is the facts status on an answer and unknown on anything else', () => {
    expect(factsStatus({ status: 200, body: { status: 'working' } })).toBe('working')
    expect(factsStatus({ status: 503, body: { error: 'offline' } })).toBe('unknown')
    expect(factsStatus({ status: 200, body: null })).toBe('unknown')
  })
})

// Phase 9b review M5: a visible remote chat and the tab watch read one session's facts once between them.
describe('createFactsReader', () => {
  it('shares a read in flight and a fresh answer, and asks again once it is old', async () => {
    let now = 0
    const asked: string[] = []
    const read = createFactsReader(async (runtimeId, cmd, args) => {
      asked.push(`${runtimeId}/${cmd}/${(args as { id: string }).id}`)
      return { status: 200, body: { status: 'idle' } }
    }, { now: () => now, freshMs: 1000 })
    const [a, b] = await Promise.all([read('rt', 's1'), read('rt', 's1')])
    expect(a).toBe(b)
    now = 500
    await read('rt', 's1')
    await read('rt', 's2')
    expect(asked).toEqual(['rt/sessions-facts/s1', 'rt/sessions-facts/s2'])
    now = 1600
    await read('rt', 's1')
    expect(asked.length).toBe(3)
  })
})

// Phase 9b review M3: a closed tab's baseline is forgotten, so reopening a waiting session does not notify at once.
describe('pruneBaseline', () => {
  it('drops the keys of tabs that are no longer open', () => {
    const last = new Map<string, RemoteFacts>([
      ['rt:a', { id: 'a', alive: true, status: 'idle', prompt: null, usage: null, model: null }],
      ['rt:b', { id: 'b', alive: true, status: 'idle', prompt: null, usage: null, model: null }]
    ])
    pruneBaseline(last, ['rt:b'])
    expect([...last.keys()]).toEqual(['rt:b'])
  })
})

// Phase 9b review M4: a roll whose new session the person already opened in its own tab closes the old tab instead of
// putting a second tab of the same session in the tree.
describe('followAction', () => {
  it('replaces the old tab, or drops it when the new session is already open', () => {
    expect(followAction(['rt:a'], 'rt:a', 'rt:b')).toBe('replace')
    expect(followAction(['rt:a', 'rt:b'], 'rt:a', 'rt:b')).toBe('drop')
  })
})

// Phase 9b review M7: what a remote chat tab lets the person do, from its facts and pairing.
describe('remoteChatState', () => {
  const facts = (over: Partial<RemoteFacts> = {}): RemoteFacts => ({ id: 'c1', alive: true, status: 'idle', prompt: null, usage: null, model: null, ...over })
  const card = { id: 'r1', kind: 'approval' }
  it('a live chat with full control: the composer is open, it can be stopped, no card', () => {
    expect(remoteChatState({ facts: facts(), sessionAlive: true, readOnly: false })).toEqual({
      alive: true, request: null, composerDisabled: false, card: null, canStop: true, status: 'idle'
    })
  })
  it('an open card is answered from the tab and shuts the composer meanwhile', () => {
    const s = remoteChatState({ facts: facts({ status: 'waiting', requests: [card] }), sessionAlive: true, readOnly: false })
    expect(s).toMatchObject({ request: card, composerDisabled: true, card: 'answer', status: 'waiting' })
  })
  it('a read-only pairing sees the card as a note, and cannot send or stop', () => {
    const s = remoteChatState({ facts: facts({ requests: [card] }), sessionAlive: true, readOnly: true })
    expect(s).toMatchObject({ composerDisabled: true, card: 'note', canStop: false })
  })
  it('an ended chat shuts everything; before its facts arrive the row decides', () => {
    expect(remoteChatState({ facts: facts({ alive: false }), sessionAlive: true, readOnly: false })).toMatchObject({ alive: false, composerDisabled: true, canStop: false })
    expect(remoteChatState({ facts: null, sessionAlive: false, readOnly: false })).toMatchObject({ alive: false, status: 'unknown' })
  })
})

describe('createRemoteAnswer', () => {
  it('sends the card’s answer to the Runtime and throws its refusal for the card to show', async () => {
    const asked: unknown[] = []
    let status = 200
    const answer = createRemoteAnswer(async (runtimeId, cmd, args) => {
      asked.push([runtimeId, cmd, args])
      return { status, body: status === 200 ? {} : { error: 'no such request' } }
    }, 'rt', 'c1')
    await answer('r1', { kind: 'approval', decision: 'accept' } as never)
    expect(asked).toEqual([['rt', 'sessions-answer', { id: 'c1', request: 'r1', answer: { kind: 'approval', decision: 'accept' } }]])
    status = 404
    await expect(answer('r1', { kind: 'approval', decision: 'accept' } as never)).rejects.toThrow('no such request')
  })
})

// A controller with no agent CLI of its own still starts sessions on its paired Runtimes: the + button and the empty
// pane's start must not go dead for it (found checking the remote chat tab, 2026-10-08).
describe('canStartSession', () => {
  it('a CLI here, or a paired Runtime, is enough', () => {
    expect(canStartSession({ cliInstalled: true, pairedRuntimes: 0 })).toBe(true)
    expect(canStartSession({ cliInstalled: false, pairedRuntimes: 1 })).toBe(true)
    expect(canStartSession({ cliInstalled: false, pairedRuntimes: 0 })).toBe(false)
  })
})

// Performance audit R3: an open remote chat read its conversation every 2 s and always made a new list from the answer,
// so the whole thread re-drew every 2 s with nothing new; and a read that threw stopped the polling for good.
describe('remote chat polling', () => {
  const turn = (id: string, text: string) => ({ id, role: 'assistant' as const, parts: [{ kind: 'text' as const, text }] })

  it('keeps the held list when a newer page brings nothing new', () => {
    const held = [turn('a', 'x'), turn('b', 'y')]
    expect(mergeTurns(held, [turn('a', 'x'), turn('b', 'y')], 'newer')).toBe(held)
  })

  it('keeps each unchanged turn object when one changes or one is added', () => {
    const held = [turn('a', 'x'), turn('b', 'y')]
    const next = mergeTurns(held, [turn('b', 'y2'), turn('c', 'z')], 'newer')
    expect(next[0]).toBe(held[0])
    expect(next[1]).toEqual(turn('b', 'y2'))
    expect(next.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    const same = mergeTurns(held, [turn('a', 'x')], 'newer')
    expect(same).toBe(held)
  })

  it('keeps the held facts when the new ones say the same', () => {
    const held = { status: 'idle', request: null } as unknown as RemoteFacts
    expect(sameOrNext(held, JSON.parse(JSON.stringify(held)) as RemoteFacts)).toBe(held)
    const moved = { status: 'busy', request: null } as unknown as RemoteFacts
    expect(sameOrNext(held, moved)).toBe(moved)
    expect(sameOrNext(null, moved)).toBe(moved)
  })

  // Final review M7: an open remote chat in a hidden window read its conversation every 2 s; the tab watch, not this,
  // is what notifies then.
  it('asks nothing while paused, and again once it is not', async () => {
    vi.useFakeTimers()
    try {
      let n = 0
      let hidden = false
      const stop = pollEvery(async () => void n++, 2_000, { paused: () => hidden })
      await vi.advanceTimersByTimeAsync(0)
      expect(n).toBe(1)
      hidden = true
      await vi.advanceTimersByTimeAsync(20_000)
      expect(n).toBe(1)
      hidden = false
      await vi.advanceTimersByTimeAsync(2_000)
      expect(n).toBe(2)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('goes on polling after a read that throws, and stops when told', async () => {
    vi.useFakeTimers()
    try {
      let n = 0
      const stop = pollEvery(async () => {
        n++
        if (n === 1) throw new Error('ipc gone')
      }, 2_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(n).toBe(1)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(n).toBe(2)
      stop()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(n).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
