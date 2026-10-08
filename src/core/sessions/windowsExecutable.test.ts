import { describe, it, expect } from 'vitest'
import { findOnWindowsPath, findOnWindowsPathAsync, makeWindowsResolver, windowsSpawn } from './windowsExecutable'

const fsOf = (...present: string[]) => {
  const set = new Set(present.map((p) => p.toLowerCase()))
  return (p: string): boolean => set.has(p.toLowerCase())
}

describe('findOnWindowsPath', () => {
  const env = { Path: 'C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Program Files\\Git\\cmd', PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS' }

  it('finds an npm shim on PATH, with cmd.exe’s extension order', () => {
    const exists = fsOf('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')
    expect(findOnWindowsPath('claude', env, exists)).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')
  })

  it('prefers .exe over .cmd in the same folder, as cmd.exe does', () => {
    const exists = fsOf('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe')
    expect(findOnWindowsPath('claude', env, exists)).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe')
  })

  it('reads the PATH key however it is capitalised, and strips quotes around an entry', () => {
    const exists = fsOf('C:\\tools\\git.exe')
    expect(findOnWindowsPath('git', { PATH: '"C:\\tools"' }, exists)).toBe('C:\\tools\\git.exe')
  })

  // The whole point: a repository's folder never takes part. Neither the working directory nor a
  // relative PATH entry (`.`, `bin`) is looked at, so a `claude.cmd` shipped in a clone is never it.
  it('never looks in a relative PATH entry or the working directory', () => {
    const exists = fsOf('claude.cmd', '.\\claude.cmd', 'bin\\claude.cmd', 'C:\\repo\\claude.cmd')
    expect(findOnWindowsPath('claude', { Path: '.;bin;;' }, exists)).toBeNull()
  })

  it('answers null when PATH does not know the name', () => {
    expect(findOnWindowsPath('claude', env, fsOf())).toBeNull()
  })

  it('takes a name that already has an executable extension as it is', () => {
    const exists = fsOf('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(findOnWindowsPath('git.exe', env, exists)).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(findOnWindowsPath('git.cmd', env, exists)).toBeNull()
  })

  it('does not look up a name that carries a path', () => {
    const exists = fsOf('C:\\x\\claude.exe')
    expect(findOnWindowsPath('C:\\x\\claude.exe', env, exists)).toBe('C:\\x\\claude.exe')
    expect(findOnWindowsPath('.\\claude.exe', env, exists)).toBeNull()
  })

  it('falls back to the default extensions when PATHEXT is unset or useless', () => {
    const exists = fsOf('C:\\tools\\codex.cmd')
    expect(findOnWindowsPath('codex', { PATH: 'C:\\tools' }, exists)).toBe('C:\\tools\\codex.cmd')
    expect(findOnWindowsPath('codex', { PATH: 'C:\\tools', PATHEXT: '.VBS;.JS' }, exists)).toBe('C:\\tools\\codex.cmd')
  })
})

// Second pass M2-2: every session start looked the CLI up with a synchronous check of each PATH folder on the app's (or
// the Host's) one thread; an offline mapped drive on PATH held the whole app for its network timeout.
describe('findOnWindowsPathAsync', () => {
  const env = { Path: 'Z:\\dead;C:\\Users\\me\\AppData\\Roaming\\npm', PATHEXT: '.EXE;.CMD' }

  it('finds the same file the sync lookup does, in the same order', async () => {
    const present = new Set(['c:\\users\\me\\appdata\\roaming\\npm\\claude.cmd'])
    const exists = async (p: string): Promise<boolean> => present.has(p.toLowerCase())
    expect(await findOnWindowsPathAsync('claude', env, { exists })).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')
  })

  it('gives up on a folder that does not answer in time and takes the next one that has it', async () => {
    const exists = (p: string): Promise<boolean> =>
      p.startsWith('Z:') ? new Promise(() => {}) : Promise.resolve(p.toLowerCase().endsWith('npm\\claude.cmd'))
    const t0 = Date.now()
    expect(await findOnWindowsPathAsync('claude', env, { exists, timeoutMs: 50 })).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})

describe('makeWindowsResolver', () => {
  const env = { Path: 'C:\\npm', PATHEXT: '.CMD' }
  const rig = () => {
    let syncChecks = 0
    let t = 0
    const r = makeWindowsResolver({
      env: () => env,
      exists: (p) => (syncChecks++, p === 'C:\\npm\\claude.cmd'),
      existsAsync: async (p) => p === 'C:\\npm\\claude.cmd',
      now: () => t
    })
    return { r, syncChecks: () => syncChecks, advance: (ms: number) => (t += ms) }
  }

  it('answers a lookup a warm made without checking a folder', async () => {
    const h = rig()
    expect(await h.r.warm('claude')).toBe('C:\\npm\\claude.cmd')
    expect(h.r.resolve('claude')).toBe('C:\\npm\\claude.cmd')
    expect(h.syncChecks()).toBe(0)
  })

  it('looks again once its answer is a minute old, so a CLI installed meanwhile is found', () => {
    const h = rig()
    h.r.resolve('claude')
    h.r.resolve('claude')
    expect(h.syncChecks()).toBe(1)
    h.advance(61_000)
    h.r.resolve('claude')
    expect(h.syncChecks()).toBe(2)
  })
})

describe('windowsSpawn', () => {
  it('spawns an .exe directly, with no shell in between', () => {
    expect(windowsSpawn('claude', ['--version'], () => 'C:\\Users\\me\\.local\\bin\\claude.exe')).toEqual({
      file: 'C:\\Users\\me\\.local\\bin\\claude.exe',
      args: ['--version']
    })
  })

  it('runs a .cmd shim through cmd.exe by its absolute path, with call and without AutoRun', () => {
    expect(windowsSpawn('claude', ['--', 'hi'], () => 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd')).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/c', 'call', 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd', '--', 'hi']
    })
  })

  // A name PATH does not know is not handed to cmd.exe, whose lookup would then reach the working
  // directory. Spawned bare it either resolves from the parent's own folders or fails outright.
  it('spawns a name PATH does not know bare, never through cmd.exe', () => {
    expect(windowsSpawn('claude', ['--version'], () => null)).toEqual({ file: 'claude', args: ['--version'] })
  })
})
