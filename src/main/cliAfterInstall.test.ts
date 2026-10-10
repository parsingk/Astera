// A new PC: the app installed Claude Code, which landed in %USERPROFILE%\.local\bin (~/.local/bin on macOS
// and Linux) with no PATH entry, and the app went on saying it was not installed (2026-10-10).
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PROFILE_PATH_LINE, addUserPathCommand, type InstallCommand } from '../core/install/cliInstall'
import { addToProfile, findAfterInstall, type AfterInstallDeps } from './cliLocate'

const HOME = 'C:\\Users\\kim'
const EXE = 'C:\\Users\\kim\\.local\\bin\\claude.exe'

const rig = (o: { located?: Array<string | null>; files?: readonly string[]; runs?: boolean; platform?: string; home?: string; shell?: string } = {}) => {
  const located = [...(o.located ?? [null, EXE])]
  const ran: InstallCommand[] = []
  const profiles: Array<[string, string]> = []
  const deps: AfterInstallDeps = {
    platform: o.platform ?? 'win32',
    home: o.home ?? HOME,
    shell: o.shell,
    exists: (p: string) => (o.files ?? [EXE]).includes(p),
    locate: async () => located.shift() ?? null,
    run: async (c: InstallCommand) => (ran.push(c), o.runs ?? true),
    addToProfile: async (file, line) => (profiles.push([file, line]), o.runs ?? true)
  }
  return { deps, ran, profiles }
}

describe('findAfterInstall', () => {
  it('puts the documented folder on the user Path when the machine cannot find what was installed there', async () => {
    const r = rig()
    expect(await findAfterInstall('claude', r.deps)).toBe(EXE)
    expect(r.ran).toEqual([addUserPathCommand('C:\\Users\\kim\\.local\\bin')])
    expect(r.profiles).toEqual([])
  })

  it('changes nothing when the machine already finds it', async () => {
    const r = rig({ located: ['C:\\tools\\claude.exe'] })
    expect(await findAfterInstall('claude', r.deps)).toBe('C:\\tools\\claude.exe')
    expect(r.ran).toEqual([])
  })

  it('changes nothing when the documented folder does not hold it, or the CLI or platform has no such folder', async () => {
    for (const [cli, o] of [
      ['claude', { files: [] }],
      ['codex', {}],
      ['claude', { platform: 'freebsd' }]
    ] as const) {
      const r = rig(o)
      expect(await findAfterInstall(cli, r.deps)).toBeNull()
      expect(r.ran).toEqual([])
      expect(r.profiles).toEqual([])
    }
  })

  it('answers null when the Path could not be written', async () => {
    const r = rig({ runs: false })
    expect(await findAfterInstall('claude', r.deps)).toBeNull()
  })

  it('answers the installed file when the Path was written but the machine still does not name it', async () => {
    const r = rig({ located: [null, null] })
    expect(await findAfterInstall('claude', r.deps)).toBe(EXE)
  })

  it("on macOS and Linux, adds the note's PATH line to the shell's own file", async () => {
    const r = rig({ platform: 'darwin', home: '/Users/kim', shell: '/bin/zsh', files: ['/Users/kim/.local/bin/claude'], located: [null, '/Users/kim/.local/bin/claude'] })
    expect(await findAfterInstall('claude', r.deps)).toBe('/Users/kim/.local/bin/claude')
    expect(r.profiles).toEqual([['/Users/kim/.zshrc', PROFILE_PATH_LINE]])
    expect(r.ran).toEqual([])
  })

  it('on macOS and Linux, answers null for a shell with no file it knows', async () => {
    const r = rig({ platform: 'linux', home: '/home/kim', shell: '/usr/bin/fish', files: ['/home/kim/.local/bin/claude'] })
    expect(await findAfterInstall('claude', r.deps)).toBeNull()
    expect(r.profiles).toEqual([])
  })
})

describe('addToProfile', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  it('appends the line once, on its own line, keeping what the file had', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-profile-'))
    const file = path.join(dir, '.zshrc')
    await fs.writeFile(file, 'alias ll="ls -l"', 'utf8')
    expect(await addToProfile(file, PROFILE_PATH_LINE)).toBe(true)
    expect(await addToProfile(file, PROFILE_PATH_LINE)).toBe(true)
    expect(await fs.readFile(file, 'utf8')).toBe(`alias ll="ls -l"\n${PROFILE_PATH_LINE}\n`)
  })

  it('makes a file that is not there, and answers false when it cannot be written', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-profile-'))
    const file = path.join(dir, '.bash_profile')
    expect(await addToProfile(file, PROFILE_PATH_LINE)).toBe(true)
    expect(await fs.readFile(file, 'utf8')).toBe(`${PROFILE_PATH_LINE}\n`)
    expect(await addToProfile(path.join(dir, 'no such folder', '.zshrc'), PROFILE_PATH_LINE)).toBe(false)
  })
})
