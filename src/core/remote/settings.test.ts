import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REMOTE_DEFAULTS, readRemoteSettings, writeRemoteSettings } from './settings'

let profile: string
beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-remote-settings-'))
})
afterEach(async () => fs.rm(profile, { recursive: true, force: true }))

describe('remote-runtime.json (remote runtime design §2.9, §4.6)', () => {
  it('reads the defaults when there is no file: Remote off, loopback, port 47831', async () => {
    expect(await readRemoteSettings(profile)).toEqual({ enabled: false, listen: '127.0.0.1', port: 47831 })
    expect(REMOTE_DEFAULTS.port).toBe(47831)
  })
  it('writes a patch over what is there and reads it back', async () => {
    await writeRemoteSettings(profile, { enabled: true, listen: '100.64.0.5' })
    expect(await writeRemoteSettings(profile, { port: 50000 })).toEqual({ enabled: true, listen: '100.64.0.5', port: 50000 })
    expect(await readRemoteSettings(profile)).toEqual({ enabled: true, listen: '100.64.0.5', port: 50000 })
    expect((await fs.readdir(profile)).sort()).toEqual(['remote-runtime.json'])
  })
  it('refuses a broken file by name rather than reading it as off', async () => {
    await fs.writeFile(path.join(profile, 'remote-runtime.json'), '{not json')
    await expect(readRemoteSettings(profile)).rejects.toMatchObject({ code: 'REMOTE_SETTINGS_UNREADABLE' })
    await fs.writeFile(path.join(profile, 'remote-runtime.json'), JSON.stringify({ enabled: 'yes' }))
    await expect(readRemoteSettings(profile)).rejects.toMatchObject({ code: 'REMOTE_SETTINGS_UNREADABLE' })
  })
  it('refuses a port outside 1 to 65535 and an empty listen address', async () => {
    await expect(writeRemoteSettings(profile, { port: 0 })).rejects.toThrow(/port/)
    await expect(writeRemoteSettings(profile, { port: 70000 })).rejects.toThrow(/port/)
    await expect(writeRemoteSettings(profile, { listen: '' })).rejects.toThrow(/listen/)
  })
})
