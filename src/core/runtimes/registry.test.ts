import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openSecretStore } from '../secrets/secretStore'
import { openRuntimeRegistry, type RuntimeProfile } from './registry'

let profile: string
const store = () => openSecretStore({ dir: path.join(profile, 'runtimes'), profileDir: profile })
const p = (id: string): RuntimeProfile => ({
  runtimeId: id,
  name: id,
  address: '10.0.0.2',
  port: 47831,
  fingerprint: 'f',
  permission: 'full-control',
  createdAt: 'T',
  lastSeenAt: null
})
beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-runtimes-'))
})
afterEach(async () => fs.rm(profile, { recursive: true, force: true }))

describe('runtime registry (remote runtime design §4.6, N8)', () => {
  it('adds a profile with its token, lists it, and removes both', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'tok-a')
    expect((await r.list()).map((x) => x.runtimeId)).toEqual(['rt_a'])
    expect(await r.token('rt_a')).toBe('tok-a')
    expect(JSON.stringify(await r.list())).not.toContain('tok-a')
    expect(await r.remove('rt_a')).toBe(true)
    expect(await r.token('rt_a')).toBeNull()
    expect(await r.remove('rt_a')).toBe(false)
  })
  it('a crash between the token and the registry entry leaves a token that the next open deletes', async () => {
    const s = store()
    await s.withLock((tx) => tx.write('rt_lost.token', 'tok'))
    const r = await openRuntimeRegistry(s)
    expect(await r.list()).toEqual([])
    expect(await s.read('rt_lost.token')).toBeNull()
  })
  it('a crash after the entry was removed but before the token was leaves a token the next open deletes', async () => {
    const s = store()
    const r = await openRuntimeRegistry(s)
    await r.add(p('rt_a'), 'tok')
    await s.withLock((tx) => tx.write('runtimes.json', JSON.stringify({ runtimes: [] })))
    await openRuntimeRegistry(s)
    expect(await s.read('rt_a.token')).toBeNull()
  })
  it('refuses a runtime id that is a path (Review Focus 1)', async () => {
    const r = await openRuntimeRegistry(store())
    await expect(r.add(p('../x'), 't')).rejects.toThrow(/runtime id/)
    await expect(r.token('..')).rejects.toThrow(/runtime id/)
    expect(await fs.readdir(profile)).not.toContain('x.token')
    expect(await r.list()).toEqual([])
  })
  it('adding the same runtime again replaces its profile and token', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'one')
    await r.add({ ...p('rt_a'), name: 'renamed' }, 'two')
    expect((await r.list()).map((x) => x.name)).toEqual(['renamed'])
    expect(await r.token('rt_a')).toBe('two')
  })
  // Security audit SEC-4: a Runtime picks the id it says it has, so a hostile one paired here could say another paired
  // Runtime's id and silently take its place: its address, its key, and every command and keystroke meant for it.
  it('refuses another key under an id it already has, unless told to replace it', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'one')
    await expect(r.add({ ...p('rt_a'), fingerprint: 'other', address: '10.6.6.6' }, 'evil')).rejects.toMatchObject({ code: 'RUNTIME_ALREADY_PAIRED' })
    expect(await r.list()).toEqual([p('rt_a')])
    expect(await r.token('rt_a')).toBe('one')
    await r.add({ ...p('rt_a'), fingerprint: 'other' }, 'two', { replace: true })
    expect((await r.list())[0].fingerprint).toBe('other')
  })
})

describe('runtime ids and case (Phase 2 review)', () => {
  it('refuses an id with capitals, which on a case-insensitive disk would share another runtime’s token file', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_ab'), 'mine')
    await expect(r.add(p('RT_AB'), 'theirs')).rejects.toThrow(/runtime id/)
    expect(await r.token('rt_ab')).toBe('mine')
  })

  // Phase 3 minor (design §4.5): the controller keeps when it last reached each Runtime.
  it('touch sets lastSeenAt and keeps the token; an unknown id changes nothing', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'tok-a')
    await r.touch('rt_a', '2026-10-08T00:00:00.000Z')
    expect((await r.list())[0].lastSeenAt).toBe('2026-10-08T00:00:00.000Z')
    expect(await r.token('rt_a')).toBe('tok-a')
    await r.touch('rt_b', 'x')
    expect((await r.list()).map((x) => x.runtimeId)).toEqual(['rt_a'])
  })
})
