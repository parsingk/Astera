import { describe, expect, it, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { findInstalledHostExe } from './installedRuntime'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})

describe('findInstalledHostExe', () => {
  it('finds the newest Host runtime an Astera installed, by its Node version', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-rt-'))
    dirs.push(base)
    const exe = async (dir: string, name = 'astera-host.exe'): Promise<void> => {
      await fs.mkdir(path.join(base, dir), { recursive: true })
      await fs.writeFile(path.join(base, dir, name), '')
    }
    await exe('node-22.1.0-astera-host')
    await exe('node-24.15.0-astera-host')
    await exe('node-9.0.0-astera-host')
    // Before the rename, a node.exe: not this name, so not taken
    await exe('node-30.0.0', 'node.exe')
    // A newer one still being laid down, its executable not there yet
    await fs.mkdir(path.join(base, 'node-31.0.0-astera-host'), { recursive: true })
    expect(await findInstalledHostExe(base)).toBe(path.join(base, 'node-24.15.0-astera-host', 'astera-host.exe'))
  })

  it('finds none where there is no runtime', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-rt-'))
    dirs.push(base)
    expect(await findInstalledHostExe(base)).toBeNull()
    expect(await findInstalledHostExe(path.join(base, 'missing'))).toBeNull()
    expect(await findInstalledHostExe(null)).toBeNull()
  })
})
