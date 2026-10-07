import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { PassThrough } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { runRuntimeGateway } from './gateway'

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
