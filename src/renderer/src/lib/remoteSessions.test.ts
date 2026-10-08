// A remote session as the renderer holds it (remote runtime design Phase 9b): its ref from a Runtime's row, the roll it
// follows, when its facts call for a notification, the pages of its conversation, and its input batched for the link.
import { describe, it, expect } from 'vitest'
import { refOf, followRolls, factsTransition, mergeTurns, InputCoalescer, type RemoteFacts } from './remoteSessions'
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
