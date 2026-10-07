import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { PassThrough } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { runRuntimeGateway } from './gateway'
import { loadOrCreateIdentity } from '../../core/remote/identity'
import { openSecretStore } from '../../core/secrets/secretStore'

let profile: string
beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-gwcmd-'))
})
afterEach(async () => fs.rm(profile, { recursive: true, force: true }))

describe('runRuntimeGateway (the hidden `astera runtime gateway`)', () => {
  it('reports a missing identity as gateway-failed IDENTITY_UNREADABLE and exits 1, binding nothing', async () => {
    const stdout = new PassThrough()
    const lines: string[] = []
    stdout.on('data', (d: Buffer) => lines.push(d.toString()))
    const code = await runRuntimeGateway({ argv: ['--listen', '127.0.0.1', '--port', '0'], profileDir: profile, stdin: new PassThrough(), stdout })
    expect(code).toBe(1)
    expect(JSON.parse(lines.join(''))).toMatchObject({ t: 'gateway-failed', code: 'IDENTITY_UNREADABLE' })
  })
  it('refuses arguments it cannot use with exit 2', async () => {
    const stdout = new PassThrough()
    expect(await runRuntimeGateway({ argv: ['--port', 'x'], profileDir: profile, stdin: new PassThrough(), stdout })).toBe(2)
  })
})

describe('runRuntimeGateway leaves with its Host (Phase 3 review)', () => {
  it('exits 0 even when its stdin had already ended by the time it was listening', async () => {
    await loadOrCreateIdentity(openSecretStore({ dir: path.join(profile, 'remote'), profileDir: profile }), { displayName: 't' })
    const stdin = new PassThrough()
    stdin.end()
    const code = await Promise.race([
      runRuntimeGateway({ argv: ['--listen', '127.0.0.1', '--port', '0'], profileDir: profile, stdin, stdout: new PassThrough() }),
      new Promise<string>((r) => setTimeout(() => r('still running'), 3000))
    ])
    expect(code).toBe(0)
  })
})

// Phase 3 minor: a Host that is gone closes the pipe, and the Gateway's next write fails with EPIPE. That ends it with
// 1 rather than crashing on an unhandled 'error'.
describe('runRuntimeGateway and a broken link', () => {
  it('exits 1 when writing to its Host fails', async () => {
    await loadOrCreateIdentity(openSecretStore({ dir: path.join(profile, 'remote'), profileDir: profile }), { displayName: 't' })
    const { Writable } = await import('node:stream')
    const stdout = new Writable({
      write: (_c, _e, cb) => cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    })
    const stdin = new PassThrough()
    const code = await Promise.race([
      runRuntimeGateway({ argv: ['--listen', '127.0.0.1', '--port', '0'], profileDir: profile, stdin, stdout }),
      new Promise<string>((r) => setTimeout(() => r('still running'), 3000))
    ])
    expect(code).toBe(1)
  })
})
