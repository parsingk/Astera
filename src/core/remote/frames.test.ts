import { describe, it, expect } from 'vitest'
import { parseControllerFrame, parseLinkFrame } from './frames'

describe('parseControllerFrame (remote runtime design §3.1, §3.2, §3.3)', () => {
  it('reads auth, redeem, call, ping and pong', () => {
    expect(parseControllerFrame({ t: 'auth', token: 'x', client: { name: 'laptop', surface: 'cli' } })).toEqual({ t: 'auth', token: 'x', client: { name: 'laptop', surface: 'cli' } })
    expect(parseControllerFrame({ t: 'redeem', code: 'ABC', name: 'laptop', client: {} })).toMatchObject({ t: 'redeem', code: 'ABC', name: 'laptop' })
    expect(parseControllerFrame({ t: 'call', id: '1', cmd: 'jobs-list', args: { status: 'running' }, request: 'r-1', retry: true })).toEqual({
      t: 'call',
      id: '1',
      cmd: 'jobs-list',
      args: { status: 'running' },
      request: 'r-1',
      retry: true
    })
    expect(parseControllerFrame({ t: 'ping' })).toEqual({ t: 'ping' })
    expect(parseControllerFrame({ t: 'pong' })).toEqual({ t: 'pong' })
  })
  it('never carries an authority field a controller put on the frame (Review Focus 1)', () => {
    const f = parseControllerFrame({ t: 'call', id: '1', cmd: 'runs-stop', args: {}, role: 'app', permission: 'full-control', session: 's', principal: { clientId: 'x' } })
    expect(f).toEqual({ t: 'call', id: '1', cmd: 'runs-stop', args: {} })
  })
  it('refuses an unknown type, a bad command name, args that are not an object, and an over-long string', () => {
    expect(parseControllerFrame({ t: 'state-put' })).toHaveProperty('error')
    expect(parseControllerFrame({ t: 'call', id: '1', cmd: 'Runs Stop', args: {} })).toHaveProperty('error')
    expect(parseControllerFrame({ t: 'call', id: '1', cmd: 'runs-stop', args: [] })).toHaveProperty('error')
    expect(parseControllerFrame({ t: 'auth', token: 'x'.repeat(65 * 1024), client: {} })).toHaveProperty('error')
    expect(parseControllerFrame({ t: 'call', id: 'x'.repeat(200), cmd: 'jobs-list', args: {} })).toHaveProperty('error')
    expect(parseControllerFrame(null)).toHaveProperty('error')
  })
})

describe('parseLinkFrame', () => {
  it('reads what the Gateway sends the Host, with its connection id', () => {
    expect(parseLinkFrame({ t: 'auth', conn: 'c1', tokenHash: 'h' }, 'gateway')).toEqual({ t: 'auth', conn: 'c1', tokenHash: 'h' })
    expect(parseLinkFrame({ t: 'call', conn: 'c1', id: '1', cmd: 'jobs-list', args: {}, role: 'app' }, 'gateway')).toEqual({ t: 'call', conn: 'c1', id: '1', cmd: 'jobs-list', args: {} })
    expect(parseLinkFrame({ t: 'conn-closed', conn: 'c1' }, 'gateway')).toEqual({ t: 'conn-closed', conn: 'c1' })
    expect(parseLinkFrame({ t: 'gateway-ready', port: 1, address: '127.0.0.1', fingerprint: 'f' }, 'gateway')).toMatchObject({ t: 'gateway-ready' })
  })
  it('reads what the Host sends the Gateway, and refuses one side’s frames on the other', () => {
    expect(parseLinkFrame({ t: 'close-conn', conn: 'c1', code: 'RUNTIME_AUTH_FAILED' }, 'host')).toMatchObject({ t: 'close-conn' })
    expect(parseLinkFrame({ t: 'result', conn: 'c1', id: '1', status: 200, body: { a: 1 } }, 'host')).toMatchObject({ t: 'result', status: 200 })
    expect(parseLinkFrame({ t: 'close-conn', conn: 'c1', code: 'x' }, 'gateway')).toHaveProperty('error')
    expect(parseLinkFrame({ t: 'auth', conn: 'c1', tokenHash: 'h' }, 'host')).toHaveProperty('error')
  })
})

// Remote runtime design §3.7 (Phase 8): pty subscriptions on both hops.
describe('subscription frames', () => {
  it('a controller subscribes with an id, a pty and optionally where it left off, and unsubscribes by id', () => {
    expect(parseControllerFrame({ t: 'subscribe', sub: 's1', pty: 'p1' })).toEqual({ t: 'subscribe', sub: 's1', pty: 'p1' })
    expect(parseControllerFrame({ t: 'subscribe', sub: 's1', pty: 'p1', fromSeq: 42, bootId: 'b' })).toEqual({ t: 'subscribe', sub: 's1', pty: 'p1', fromSeq: 42, bootId: 'b' })
    expect(parseControllerFrame({ t: 'unsubscribe', sub: 's1' })).toEqual({ t: 'unsubscribe', sub: 's1' })
  })
  it('refuses a subscription without a pty, a seq that is not a whole number from 1, or an over-long id', () => {
    expect(parseControllerFrame({ t: 'subscribe', sub: 's1' })).toHaveProperty('error')
    expect(parseControllerFrame({ t: 'subscribe', sub: 's1', pty: 'p1', fromSeq: 0 })).toHaveProperty('error')
    expect(parseControllerFrame({ t: 'subscribe', sub: 's1', pty: 'p1', fromSeq: 1.5 })).toHaveProperty('error')
    expect(parseControllerFrame({ t: 'subscribe', sub: 'x'.repeat(200), pty: 'p1' })).toHaveProperty('error')
    expect(parseControllerFrame({ t: 'unsubscribe' })).toHaveProperty('error')
  })
  it('a controller has no frame to pause or resume a pty (N2)', () => {
    expect(parseControllerFrame({ t: 'pty-pause', id: 'p1' })).toHaveProperty('error')
    expect(parseControllerFrame({ t: 'pty-resume', id: 'p1' })).toHaveProperty('error')
  })
  it('the Gateway forwards a subscription to the Host with its connection', () => {
    expect(parseLinkFrame({ t: 'subscribe', conn: 'c1', sub: 's1', pty: 'p1', fromSeq: 3, bootId: 'b' }, 'gateway')).toEqual({ t: 'subscribe', conn: 'c1', sub: 's1', pty: 'p1', fromSeq: 3, bootId: 'b' })
    expect(parseLinkFrame({ t: 'unsubscribe', conn: 'c1', sub: 's1' }, 'gateway')).toEqual({ t: 'unsubscribe', conn: 'c1', sub: 's1' })
    expect(parseLinkFrame({ t: 'subscribe', sub: 's1', pty: 'p1' }, 'gateway')).toHaveProperty('error')
  })
  it('the Host answers with subscribed, output, a checkpoint, a gap or an error, each for a connection', () => {
    const cp = { watermark: 4, cols: 80, rows: 24, state: 'x', pending: '' }
    expect(parseLinkFrame({ t: 'subscribed', conn: 'c1', sub: 's1', pty: 'p1', bootId: 'b' }, 'host')).toEqual({ t: 'subscribed', conn: 'c1', sub: 's1', pty: 'p1', bootId: 'b' })
    expect(parseLinkFrame({ t: 'pty-out', conn: 'c1', sub: 's1', events: [{ seq: 5, kind: 'data', data: 'hi' }, { seq: 6, kind: 'resize', cols: 9, rows: 3 }, { seq: 7, kind: 'exit', code: null }] }, 'host')).toMatchObject({ t: 'pty-out', events: [{ seq: 5 }, { seq: 6 }, { seq: 7 }] })
    expect(parseLinkFrame({ t: 'checkpoint', conn: 'c1', sub: 's1', checkpoint: cp, gap: { firstSeq: 1, lastSeq: 4 } }, 'host')).toEqual({ t: 'checkpoint', conn: 'c1', sub: 's1', checkpoint: cp, gap: { firstSeq: 1, lastSeq: 4 } })
    expect(parseLinkFrame({ t: 'output-gap', conn: 'c1', sub: 's1', firstSeq: 5, lastSeq: 9 }, 'host')).toEqual({ t: 'output-gap', conn: 'c1', sub: 's1', firstSeq: 5, lastSeq: 9, code: 'OUTPUT_GAP' })
    expect(parseLinkFrame({ t: 'sub-error', conn: 'c1', sub: 's1', code: 'RUNTIME_NOT_FOUND', message: 'no such pty' }, 'host')).toMatchObject({ t: 'sub-error' })
  })
  it('refuses output whose events are not events', () => {
    expect(parseLinkFrame({ t: 'pty-out', conn: 'c1', sub: 's1', events: [{ seq: 'x', kind: 'data', data: 'hi' }] }, 'host')).toHaveProperty('error')
    expect(parseLinkFrame({ t: 'pty-out', conn: 'c1', sub: 's1', events: [{ seq: 1, kind: 'nope' }] }, 'host')).toHaveProperty('error')
    expect(parseLinkFrame({ t: 'checkpoint', conn: 'c1', sub: 's1', checkpoint: { watermark: 'x' } }, 'host')).toHaveProperty('error')
  })
})
