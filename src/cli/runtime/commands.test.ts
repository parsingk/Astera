import { describe, it, expect } from 'vitest'
import { runRuntimeCommand, type RuntimeCommandDeps } from './commands'
import type { RemoteSettings } from '../../core/remote/settings'

const FP = 'F'.repeat(43)

/** A fake machine: settings in memory, an identity once made, and a Host that answers what the test says. */
const machine = (o: { hostUp?: boolean; gateway?: Array<Record<string, unknown>>; noPrivate?: boolean } = {}) => {
  let settings: RemoteSettings = { enabled: false, listen: '127.0.0.1', port: 47831 }
  let identity: { runtimeId: string; spkiSha256: string; displayName: string } | null = null
  let hostUp = o.hostUp ?? false
  const order: string[] = []
  const gateway = [...(o.gateway ?? [{ state: 'ready', listen: '127.0.0.1', port: 47831, fingerprint: FP }])]
  const deps: RuntimeCommandDeps = {
    readSettings: async () => settings,
    writeSettings: async (p) => {
      order.push(`write:${JSON.stringify(p)}`)
      settings = { ...settings, ...p }
      return settings
    },
    ensureIdentity: async (san) => {
      order.push(`identity:${san}`)
      identity ??= { runtimeId: 'rt_1', spkiSha256: FP, displayName: 'desk' }
      return identity
    },
    loadIdentity: async () => identity,
    hostCall: async (cmd, args, co) => {
      order.push(`call:${cmd}${co.start ? ':start' : ''}`)
      if (!hostUp && co.start) hostUp = true
      if (!hostUp) return { down: true }
      if (cmd === 'runtime-reload' || cmd === 'runtime-status') return { status: 200, body: { gateway: gateway.length > 1 ? gateway.shift() : gateway[0], clients: [] } }
      if (cmd === 'pair-create') return { status: 200, body: { code: 'ABCDE23456', expiresAt: 'T', permission: args.permission } }
      if (cmd === 'clients-list') return { status: 200, body: { clients: [{ clientId: 'cli_1' }] } }
      if (cmd === 'clients-revoke') return args.id === 'cli_1' ? { status: 200, body: { revoked: true } } : { status: 404, body: { error: 'unknown client' } }
      return { status: 404, body: { error: 'no' } }
    },
    sleep: async () => {},
    privateAddress: () => o.noPrivate ? null : '192.168.0.7',
    hostname: () => 'desk.local'
  }
  return { deps, order, settings: () => settings, hostUp: () => hostUp }
}

describe('astera runtime (remote runtime design §2.9)', () => {
  it('start writes the setting, makes the identity, starts a Host, reloads, and answers ready', async () => {
    const m = machine()
    const r = await runRuntimeCommand('runtime-start', { listen: '100.64.0.5', port: '50000' }, m.deps)
    // The identity first (Phase 3 minor): a start that cannot make one leaves Remote off.
    expect(m.order.slice(0, 3)).toEqual(['identity:100.64.0.5', 'write:{"enabled":true,"listen":"100.64.0.5","port":50000}', 'call:runtime-reload:start'])
    expect(r).toMatchObject({ ok: true, body: { enabled: true, gateway: { state: 'ready' }, fingerprint: FP } })
  })
  it('start waits through starting, and is a failure naming the Gateway’s code when it fails', async () => {
    const m = machine({ gateway: [{ state: 'starting' }, { state: 'failed', code: 'BIND_IN_USE', message: 'in use' }] })
    const r = await runRuntimeCommand('runtime-start', {}, m.deps)
    expect(r).toMatchObject({ ok: false, error: { code: 'FAILED', details: { gateway: 'BIND_IN_USE' } } })
    expect(r.ok ? '' : r.error.message).toMatch(/BIND_IN_USE/)
  })
  it('start refuses a port that is not a number before it writes anything', async () => {
    const m = machine()
    expect(await runRuntimeCommand('runtime-start', { port: 'x' }, m.deps)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } })
    expect(m.order).toEqual([])
  })
  it('stop writes the setting off and starts no Host', async () => {
    const m = machine()
    const r = await runRuntimeCommand('runtime-stop', {}, m.deps)
    expect(m.settings().enabled).toBe(false)
    expect(m.hostUp()).toBe(false)
    expect(r).toMatchObject({ ok: true, body: { enabled: false, host: 'not running' } })
  })
  it('status answers without a Host, from the setting and the identity', async () => {
    const m = machine()
    await m.deps.ensureIdentity('127.0.0.1')
    expect(await runRuntimeCommand('runtime-status', {}, m.deps)).toMatchObject({ ok: true, body: { enabled: false, host: 'not running', fingerprint: FP } })
  })
  it('pair needs a running Host, and prints the pairing string with a private address when listening on all', async () => {
    const down = machine()
    await down.deps.writeSettings({ enabled: true })
    await down.deps.ensureIdentity('127.0.0.1')
    expect(await runRuntimeCommand('runtime-pair', {}, down.deps)).toMatchObject({ ok: false, error: { code: 'HOST_NOT_RUNNING' } })
    const m = machine({ hostUp: true })
    await m.deps.writeSettings({ enabled: true, listen: '0.0.0.0' })
    await m.deps.ensureIdentity('0.0.0.0')
    const r = await runRuntimeCommand('runtime-pair', { readOnly: true, name: 'laptop' }, m.deps)
    expect(r).toMatchObject({
      ok: true,
      body: { pairing: `astera-pair:v1:192.168.0.7:47831:ABCDE23456:${FP}`, address: '192.168.0.7', port: 47831, code: 'ABCDE23456', fingerprint: FP, permission: 'read-only' }
    })
  })
  // Phase 3 minor: no code is made while Remote is off, since nobody could redeem it.
  it('pair refuses while Remote is off, and makes no code', async () => {
    const m = machine({ hostUp: true })
    await m.deps.ensureIdentity('127.0.0.1')
    const r = await runRuntimeCommand('runtime-pair', {}, m.deps)
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: expect.stringMatching(/runtime start/) } })
    expect(m.order).not.toContain('call:pair-create')
  })
  // Phase 3 minor: listening on every interface with no private address found, the hint is this machine's name, never 0.0.0.0.
  it('pair names this machine when it listens everywhere and has no private address', async () => {
    const m = machine({ hostUp: true, noPrivate: true })
    await m.deps.writeSettings({ enabled: true, listen: '0.0.0.0' })
    await m.deps.ensureIdentity('0.0.0.0')
    const r = await runRuntimeCommand('runtime-pair', {}, m.deps)
    expect(r).toMatchObject({ ok: true, body: { address: 'desk.local' } })
  })
  it('clients and revoke ask the Host; revoke needs --id and answers 4 for an unknown one', async () => {
    const m = machine({ hostUp: true })
    expect(await runRuntimeCommand('runtime-clients', {}, m.deps)).toMatchObject({ ok: true, body: { clients: [{ clientId: 'cli_1' }] } })
    expect(await runRuntimeCommand('runtime-revoke', {}, m.deps)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } })
    expect(await runRuntimeCommand('runtime-revoke', { id: 'cli_9' }, m.deps)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await runRuntimeCommand('runtime-revoke', { id: 'cli_1' }, m.deps)).toMatchObject({ ok: true, body: { revoked: true } })
  })
})
