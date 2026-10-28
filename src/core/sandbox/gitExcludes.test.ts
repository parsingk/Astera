import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GIT_EXCLUDES_ARGS, codexExcludesFileOf, codexExcludesWriter, globalExcludesPath, type RunGit } from './gitExcludes'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'astera-excludes-'))
  dirs.push(d)
  return d
}

describe('the person’s global git excludes', () => {
  it('are found where git reads them', () => {
    expect(globalExcludesPath('~/my-ignore', {}, '/home/t')).toBe('/home/t/my-ignore')
    expect(globalExcludesPath('/etc/ignore', { XDG_CONFIG_HOME: '/x' }, '/home/t')).toBe('/etc/ignore')
    expect(globalExcludesPath(null, { XDG_CONFIG_HOME: '/x/' }, '/home/t')).toBe('/x/git/ignore')
    expect(globalExcludesPath(null, {}, '/home/t')).toBe('/home/t/.config/git/ignore')
    expect(globalExcludesPath(null, {}, 'C:\\Users\\t\\')).toBe('C:/Users/t/.config/git/ignore')
  })
})

// The elevated Windows sandbox runs a Codex session as an account of its own, which cannot read the person's home: its
// git warns at every call and leaves their global ignore rules out. The copy is in TEMP, which the sandbox reads and
// writes (the npm cache is there, codexProfile.ts npmCacheOf), one per profile, named as the Host's address is
describe('the copy a sandboxed Codex session on Windows reads', () => {
  it('is in TEMP, one per profile', () => {
    const own = codexExcludesFileOf('C:\\t\\', 'C:\\Users\\p\\AppData\\Roaming\\astera')
    expect(own).toMatch(/^C:\/t\/astera-git-excludes-[0-9a-f]{12}$/)
    expect(codexExcludesFileOf('C:/t', 'C:\\Users\\p\\AppData\\Roaming\\astera')).toBe(own)
    expect(codexExcludesFileOf('C:/t', 'C:\\Users\\p\\AppData\\Roaming\\astera-dev')).not.toBe(own)
  })

  const rig = (o: { configured?: string | null; env?: Record<string, string | undefined>; tmpDir?: string } = {}) => {
    const root = temp()
    const home = path.join(root, 'home')
    const tmpDir = o.tmpDir ?? path.join(root, 'tmp')
    mkdirSync(home, { recursive: true })
    if (o.tmpDir === undefined) mkdirSync(tmpDir, { recursive: true })
    const profileDir = path.join(root, 'profile')
    const env = o.env ?? { HOME: home }
    const asked: Array<{ args: string[]; cwd: string; env: Record<string, string | undefined> }> = []
    const runGit: RunGit = async (args, opts) => (asked.push({ args, ...opts }), o.configured ?? null)
    const logged: string[] = []
    const write = codexExcludesWriter({ profileDir, tmpDir, homeDir: home, env, runGit, log: (m) => logged.push(m) })
    const ignore = (text: string, at = path.join(home, '.config', 'git', 'ignore')): void => {
      mkdirSync(path.dirname(at), { recursive: true })
      writeFileSync(at, text)
    }
    return { root, home, tmpDir, profileDir, env, asked, logged, write, ignore, file: codexExcludesFileOf(tmpDir, profileDir) }
  }

  it('holds the person’s excludes as git reads them, and is answered', async () => {
    const r = rig()
    r.ignore('*.secret\nbuild/\n')
    expect(await r.write()).toBe(r.file)
    expect(readFileSync(r.file, 'utf8')).toBe('*.secret\nbuild/\n')
    // git's effective core.excludesFile, asked with no scope, outside any repository, with the environment Astera runs with
    expect(r.asked).toEqual([{ args: GIT_EXCLUDES_ARGS, cwd: r.tmpDir, env: r.env }])
    // A change to them is in the next copy
    r.ignore('*.secret\n')
    expect(await r.write()).toBe(r.file)
    expect(readFileSync(r.file, 'utf8')).toBe('*.secret\n')
  })

  it('copies the file core.excludesFile names, and the one under XDG_CONFIG_HOME', async () => {
    const root = temp()
    const mine = path.join(root, 'mine')
    writeFileSync(mine, 'node_modules/\n')
    const configured = rig({ configured: mine.replace(/\\/g, '/') })
    expect(readFileSync((await configured.write())!, 'utf8')).toBe('node_modules/\n')
    const xdg = path.join(root, 'xdg')
    const x = rig({ env: { XDG_CONFIG_HOME: xdg } })
    x.ignore('dist/\n', path.join(xdg, 'git', 'ignore'))
    expect(readFileSync((await x.write())!, 'utf8')).toBe('dist/\n')
  })

  // Nothing to copy: the session's git is not pointed anywhere new
  it('is not written when the person has no excludes', async () => {
    const none = rig()
    expect(await none.write()).toBeNull()
    expect(existsSync(none.file)).toBe(false)
    const blank = rig()
    blank.ignore('\n  \n')
    expect(await blank.write()).toBeNull()
    expect(existsSync(blank.file)).toBe(false)
  })

  it('answers null, and says so, when it cannot be written', async () => {
    const root = temp()
    const notADir = path.join(root, 'file')
    writeFileSync(notADir, '')
    const r = rig({ tmpDir: notADir })
    r.ignore('*.secret\n')
    expect(await r.write()).toBeNull()
    expect(r.logged.join('\n')).toContain(r.file)
  })
})
