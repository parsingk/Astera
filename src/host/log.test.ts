import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHostLog } from './log'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-host-log-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('openHostLog', () => {
  it('creates the file and its directory, and stamps every line', () => {
    const p = path.join(dir, 'nested', 'host.log')
    const log = openHostLog({ path: p })
    log.write('started')
    log.close()
    const text = readFileSync(p, 'utf8')
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z started\n$/)
  })

  it('appends across opens rather than starting over', () => {
    const p = path.join(dir, 'host.log')
    const a = openHostLog({ path: p })
    a.write('first')
    a.close()
    const b = openHostLog({ path: p })
    b.write('second')
    b.close()
    expect(readFileSync(p, 'utf8').split('\n').filter(Boolean)).toHaveLength(2)
  })

  // A Host that runs for weeks must not fill the disk with its own diary.
  it('starts the file over once it passes the cap', () => {
    const p = path.join(dir, 'host.log')
    const log = openHostLog({ path: p, maxBytes: 200 })
    for (let i = 0; i < 20; i++) log.write(`line ${i} ${'x'.repeat(20)}`)
    log.close()
    const text = readFileSync(p, 'utf8')
    expect(text.length).toBeLessThan(600)
    expect(text).toContain('line 19')
  })

  // The Host must not die because its log could not be written. A regular file where a directory has
  // to go is a failure mkdir cannot work around; a path whose parents merely do not exist is not,
  // because `recursive: true` would create them and nothing would fail.
  it('swallows a write when the log path cannot be opened', () => {
    const blocker = path.join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const log = openHostLog({ path: path.join(blocker, 'nested', 'host.log') })
    expect(() => log.write('still fine')).not.toThrow()
    expect(() => log.close()).not.toThrow()
  })
})
