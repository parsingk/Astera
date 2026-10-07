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
