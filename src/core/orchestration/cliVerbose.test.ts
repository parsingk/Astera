import { describe, it, expect } from 'vitest'
import { helloLine, verboseLog } from './cliVerbose'
import { HOST_PROTOCOL } from '../host/protocol'

describe('verboseLog — diagnostics for --verbose, on stderr only', () => {
  it('writes nothing when --verbose was not given', async () => {
    const lines: string[] = []
    const v = verboseLog({ enabled: false, write: (l) => lines.push(l) })
    v.say('the Host address is x')
    expect(await v.timed('jobs-list', async () => 42, (r) => `answered ${r}`)).toBe(42)
    expect(lines).toEqual([])
  })

  it('says each line with a verbose mark, so a reader can tell it from the keepalive', () => {
    const lines: string[] = []
    const v = verboseLog({ enabled: true, write: (l) => lines.push(l) })
    v.say('Host address \\.\pipe\astera-host')
    expect(lines).toEqual(['verbose: Host address \\.\pipe\astera-host'])
  })

  it('times one call and says how it ended', async () => {
    const lines: string[] = []
    let t = 1000
    const v = verboseLog({ enabled: true, write: (l) => lines.push(l), now: () => t })
    const r = await v.timed('call jobs-list', async () => {
      t += 37
      return { status: 200 }
    }, (x) => `status ${x.status}`)
    expect(r).toEqual({ status: 200 })
    expect(lines).toEqual(['verbose: call jobs-list took 37ms: status 200'])
  })

  it('a call that throws is timed too, and the throw goes on', async () => {
    const lines: string[] = []
    let t = 0
    const v = verboseLog({ enabled: true, write: (l) => lines.push(l), now: () => t })
    await expect(
      v.timed('connect', async () => {
        t += 5
        throw new Error('boom')
      }, () => 'never')
    ).rejects.toThrow('boom')
    expect(lines).toEqual(['verbose: connect failed after 5ms: Error: boom'])
  })
})

describe('helloLine — what the handshake said', () => {
  it('names the version, protocol, pid, start and features', () => {
    const line = helloLine(
      { host: '1.4.0', pid: 4242, startedAt: '2026-09-26T01:02:03.000Z', features: ['orch', 'ping'] },
      12
    )
    expect(line).toBe(
      `handshake in 12ms: Host 1.4.0, protocol ${HOST_PROTOCOL}, pid 4242, started 2026-09-26T01:02:03.000Z, features orch, ping`
    )
  })

  it('an older Host that announces no features says none', () => {
    expect(helloLine({ host: '1.3.0', pid: 1, startedAt: 's', features: [] }, 1)).toContain('features none')
  })
})
