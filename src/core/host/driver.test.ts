import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { driverOf, readDispatchGate, type DispatchGate } from './driver'

describe('driverOf (design §4.3, §4.6)', () => {
  const gates: DispatchGate[] = ['no-settings', 'migrated', 'not-migrated', 'unreadable']
  it.each(gates)('an attached app that keeps dispatch drives, whatever the settings say (%s)', (gate) => {
    expect(driverOf({ appKeepsDispatch: true, gate })).toBe('app')
  })
  it('the Host drives a migrated profile, and one that has no settings file at all (F64)', () => {
    expect(driverOf({ appKeepsDispatch: false, gate: 'migrated' })).toBe('host')
    expect(driverOf({ appKeepsDispatch: false, gate: 'no-settings' })).toBe('host')
  })
  it('an unmigrated profile parks the Host (F62), and so does a settings file it cannot read (R2)', () => {
    expect(driverOf({ appKeepsDispatch: false, gate: 'not-migrated' })).toBe('parked')
    expect(driverOf({ appKeepsDispatch: false, gate: 'unreadable' })).toBe('parked')
  })
})

describe('readDispatchGate', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-driver-'))
    file = path.join(dir, 'app-settings.json')
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  it('no file is no-settings', async () => {
    expect(await readDispatchGate(file)).toBe('no-settings')
  })
  it('the F62 marker is migrated', async () => {
    await fs.writeFile(file, JSON.stringify({ orchAlwaysOnMigrated: true }))
    expect(await readDispatchGate(file)).toBe('migrated')
  })
  it('a file without the marker is not-migrated, even one that says orchestration was on', async () => {
    await fs.writeFile(file, JSON.stringify({ orchestrationEnabled: true, lang: 'ko' }))
    expect(await readDispatchGate(file)).toBe('not-migrated')
  })
  it('a marker that is not literally true does not count', async () => {
    await fs.writeFile(file, JSON.stringify({ orchAlwaysOnMigrated: 'yes' }))
    expect(await readDispatchGate(file)).toBe('not-migrated')
  })
  it('a damaged file is unreadable, never migrated', async () => {
    await fs.writeFile(file, '{ not json')
    expect(await readDispatchGate(file)).toBe('unreadable')
    await fs.writeFile(file, '[1, 2]')
    expect(await readDispatchGate(file)).toBe('unreadable')
  })
  it('rides out a busy read during the app’s rename instead of parking (C12)', async () => {
    await fs.writeFile(file, JSON.stringify({ orchAlwaysOnMigrated: true }))
    const real = fs.readFile
    let busy = 1
    const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof real>) => {
      if (busy-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return real(...args)
    }) as typeof real)
    try {
      expect(await readDispatchGate(file)).toBe('migrated')
    } finally {
      spy.mockRestore()
    }
  })
})
