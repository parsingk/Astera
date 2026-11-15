// The login probes' healing (sandbox design §6): Codex's Windows sandbox makes a missing deny-read path a FOLDER before it
// denies it (windows-sandbox-rs deny_read_acl.rs apply_deny_read_acls, "Missing paths are materialized as directories"),
// so a session that started while an account was logged in leaves an empty folder named `auth.json` or
// `.credentials.json` after a logout, and the CLI's next login cannot write its file there. On Windows the probes drop
// such an empty folder first. Real folders in a temp dir, no real login file.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeFixture } from '../testFixtures'
import { claudeLoginProbe, fileMarkerProbe } from './loginStatus'

describe('login probes heal an empty folder at the login file path', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-login-heal-'))
  })
  afterEach(() => removeFixture(dir))

  const claude = (platform: NodeJS.Platform) => claudeLoginProbe({ platform, homeDir: dir, account: 'u', keychainHas: async () => false })
  const isFolder = (p: string) => fs.stat(p).then((s) => s.isDirectory(), () => false)
  const probes = [
    { name: 'codex (fileMarkerProbe)', file: 'auth.json', make: (platform: NodeJS.Platform) => fileMarkerProbe('auth.json', platform) },
    { name: 'claude (claudeLoginProbe)', file: '.credentials.json', make: claude }
  ]

  for (const { name, file, make } of probes) {
    it(`${name}: on Windows removes an empty folder and reports logged out`, async () => {
      const at = path.join(dir, file)
      await fs.mkdir(at)
      expect(await make('win32')(dir)).toBe(false)
      expect(await fs.stat(at).then(() => true, () => false)).toBe(false)
      // The CLI's next login can now write its file there
      await fs.writeFile(at, '{}')
      expect(await make('win32')(dir)).toBe(true)
    })

    it(`${name}: on Windows leaves a folder that holds something alone`, async () => {
      const at = path.join(dir, file)
      await fs.mkdir(at)
      await fs.writeFile(path.join(at, 'keep.txt'), 'x')
      await make('win32')(dir)
      expect(await isFolder(at)).toBe(true)
      expect(await fs.readFile(path.join(at, 'keep.txt'), 'utf8')).toBe('x')
    })

    it(`${name}: does nothing off Windows`, async () => {
      const at = path.join(dir, file)
      await fs.mkdir(at)
      await make('linux')(dir)
      expect(await isFolder(at)).toBe(true)
    })

    it(`${name}: on Windows leaves a login file alone`, async () => {
      const at = path.join(dir, file)
      await fs.writeFile(at, '{}')
      expect(await make('win32')(dir)).toBe(true)
      expect(await fs.readFile(at, 'utf8')).toBe('{}')
    })
  }
})
