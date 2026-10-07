import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveRuntime, runRuntimesCommand, controllerRegistry, type RuntimesDeps } from './runtimes'
import { RemoteError, type RuntimeLink } from '../core/remote/client'
import { formatPairing } from '../core/remote/pairing'
import type { RuntimeProfile } from '../core/runtimes/registry'

const FP = 'A'.repeat(43)
const NOW = '2026-10-08T00:00:00.000Z'
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-runtimes-'))
})
afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

const profile = (over: Partial<RuntimeProfile> = {}): RuntimeProfile => ({
  runtimeId: 'rt_a', name: 'Office', address: '10.0.0.2', port: 47831, fingerprint: FP, permission: 'full-control', createdAt: NOW, lastSeenAt: null, ...over
})

/** A Runtime that pairs with code `GOODCODE01` and pins FP. */
function deps(over: Partial<RuntimesDeps> = {}) {
  const seen: Array<{ host: string; port: number; pin: string }> = []
  const redeemed: Array<{ code: string; name: string }> = []
  const d: RuntimesDeps = {
    registry: () => controllerRegistry(dir),
    connect: async (o) => {
      seen.push(o)
      if (o.pin !== FP) throw Object.assign(new Error('the Runtime presented a different identity'), { code: 'RUNTIME_IDENTITY_CHANGED' })
      const link: RuntimeLink = {
        redeem: async (code, name) => {
          redeemed.push({ code, name })
          if (code !== 'GOODCODE01') throw new RemoteError('RUNTIME_AUTH_FAILED', 'that pairing code is not valid')
          return { clientId: 'cl_1', token: 'tok-secret-value' }
        },
        auth: async (token) => {
          if (token !== 'tok-secret-value') throw new RemoteError('RUNTIME_AUTH_FAILED', 'unknown token')
          return { t: 'hello', runtimeId: 'rt_office', displayName: 'Office PC', asteraVersion: '1.4.8', hostProtocol: 4, gatewayProtocol: 1, bootId: 'b', platform: 'win32', pathStyle: 'windows', permission: 'full-control', capabilities: [] }
        },
        call: async () => ({ status: 200, body: {} }),
        close: () => {},
        closed: new Promise(() => {})
      }
      return link
    },
    hostname: () => 'laptop',
    now: () => NOW,
    version: '1.4.8',
    ...over
  }
  return { d, seen, redeemed }
}

describe('resolveRuntime', () => {
  const list = [profile(), profile({ runtimeId: 'rt_b', name: 'Build' }), profile({ runtimeId: 'rt_c', name: 'build' })]
  it('takes the id first, then a name ignoring case', () => {
    expect(resolveRuntime(list, 'rt_b')).toMatchObject({ runtimeId: 'rt_b' })
    expect(resolveRuntime(list, 'office')).toMatchObject({ runtimeId: 'rt_a' })
  })
  it('refuses a name two Runtimes share, naming both ids, and an unknown one', () => {
    const two = resolveRuntime(list, 'BUILD')
    expect(two).toMatchObject({ code: 'RUNTIME_NOT_FOUND' })
    expect((two as { message: string }).message).toMatch(/rt_b.*rt_c/)
    expect(resolveRuntime(list, 'nope')).toMatchObject({ code: 'RUNTIME_NOT_FOUND' })
  })
})

describe('astera runtimes (remote runtime design §4.4, §4.5)', () => {
  it('add with a pairing string pins, redeems, reads the hello, and stores the profile and token; prints no token', async () => {
    const h = deps()
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: FP })
    const r = await runRuntimesCommand('runtimes-add', { pair }, h.d)
    expect(r).toMatchObject({ ok: true, body: { runtimeId: 'rt_office', name: 'Office PC', address: '10.0.0.2', port: 47831, permission: 'full-control' } })
    expect(JSON.stringify(r)).not.toContain('tok-secret-value')
    expect(h.redeemed).toEqual([{ code: 'GOODCODE01', name: 'laptop' }])
    const reg = await controllerRegistry(dir)
    expect(await reg.list()).toEqual([expect.objectContaining({ runtimeId: 'rt_office', fingerprint: FP })])
    expect(await reg.token('rt_office')).toBe('tok-secret-value')
  })
  it('add takes --address over the hint, and --name', async () => {
    const h = deps()
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: FP })
    const r = await runRuntimesCommand('runtimes-add', { pair, address: 'office.tail.net', name: 'Desk' }, h.d)
    expect(h.seen[0]).toMatchObject({ host: 'office.tail.net', port: 47831 })
    expect(r).toMatchObject({ ok: true, body: { name: 'Desk', address: 'office.tail.net' } })
  })
  it('the decomposed form needs the fingerprint', async () => {
    const r = await runRuntimesCommand('runtimes-add', { address: '10.0.0.2', code: 'GOODCODE01' }, deps().d)
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'pairing needs the fingerprint the Runtime printed' } })
  })
  it('a different key refuses before the code is sent, and stores nothing', async () => {
    const h = deps()
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: 'B'.repeat(43) })
    expect(await runRuntimesCommand('runtimes-add', { pair }, h.d)).toMatchObject({ ok: false, error: { code: 'RUNTIME_IDENTITY_CHANGED' } })
    expect(h.redeemed).toEqual([])
    expect(await (await controllerRegistry(dir)).list()).toEqual([])
  })
  it('a wrong code says so and stores nothing', async () => {
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'WRONGCODE1', fingerprint: FP })
    expect(await runRuntimesCommand('runtimes-add', { pair }, deps().d)).toMatchObject({ ok: false, error: { code: 'RUNTIME_AUTH_FAILED' } })
    expect(await (await controllerRegistry(dir)).list()).toEqual([])
  })
  it('an unreachable Runtime is RUNTIME_OFFLINE', async () => {
    const h = deps({ connect: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) } })
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: FP })
    expect(await runRuntimesCommand('runtimes-add', { pair }, h.d)).toMatchObject({ ok: false, error: { code: 'RUNTIME_OFFLINE' } })
  })
  it('list shows the profiles and no token; remove deletes one and says it did not revoke', async () => {
    const reg = await controllerRegistry(dir)
    await reg.add(profile(), 'tok-a')
    const listed = await runRuntimesCommand('runtimes-list', {}, deps().d)
    expect(listed).toMatchObject({ ok: true, body: [expect.objectContaining({ runtimeId: 'rt_a' })] })
    expect(JSON.stringify(listed)).not.toContain('tok-a')
    const removed = await runRuntimesCommand('runtimes-remove', { id: 'Office' }, deps().d)
    expect(removed).toMatchObject({ ok: true, body: { removed: 'rt_a', revoked: false } })
    expect(await reg.list()).toEqual([])
    expect(await runRuntimesCommand('runtimes-remove', { id: 'rt_a' }, deps().d)).toMatchObject({ ok: false, error: { code: 'RUNTIME_NOT_FOUND' } })
  })
})
