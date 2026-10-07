import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearUpdateHold, readValidHold, writeUpdateHold } from './updateHold'

let profile: string
beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hold-'))
})
afterEach(async () => fs.rm(profile, { recursive: true, force: true }))

describe('the update hold (remote runtime design §2.9)', () => {
  it('is valid while its holder lives and its time has not passed', () => {
    writeUpdateHold(profile, { pid: 42, until: 2_000 })
    expect(readValidHold(profile, 1_000, () => true)).toEqual({ pid: 42, until: 2_000 })
  })
  it('is not valid once it expired, or once its holder is gone', () => {
    writeUpdateHold(profile, { pid: 42, until: 2_000 })
    expect(readValidHold(profile, 2_001, () => true)).toBeNull()
    expect(readValidHold(profile, 1_000, () => false)).toBeNull()
  })
  it('is none when there is no file, an unreadable one, or after it is cleared', async () => {
    expect(readValidHold(profile, 0, () => true)).toBeNull()
    await fs.mkdir(path.join(profile, 'host'), { recursive: true })
    await fs.writeFile(path.join(profile, 'host', 'update-hold'), '{not json')
    expect(readValidHold(profile, 0, () => true)).toBeNull()
    writeUpdateHold(profile, { pid: 1, until: 9 })
    clearUpdateHold(profile)
    expect(readValidHold(profile, 0, () => true)).toBeNull()
  })
})
