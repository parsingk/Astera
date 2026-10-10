// A new PC: the app installed Claude Code, which landed in %USERPROFILE%\.local\bin with no PATH entry,
// and the app went on saying it was not installed (2026-10-10).
import { describe, it, expect } from 'vitest'
import { addUserPathCommand, type InstallCommand } from '../core/install/cliInstall'
import { findAfterInstall } from './cliLocate'

const HOME = 'C:\\Users\\kim'
const EXE = 'C:\\Users\\kim\\.local\\bin\\claude.exe'

const rig = (o: { located?: Array<string | null>; files?: readonly string[]; runs?: boolean; platform?: string } = {}) => {
  const located = [...(o.located ?? [null, EXE])]
  const ran: InstallCommand[] = []
  const deps = {
    platform: o.platform ?? 'win32',
    home: HOME,
    exists: (p: string) => (o.files ?? [EXE]).includes(p),
    locate: async () => located.shift() ?? null,
    run: async (c: InstallCommand) => (ran.push(c), o.runs ?? true)
  }
  return { deps, ran }
}

describe('findAfterInstall', () => {
  it('puts the documented folder on the user Path when the machine cannot find what was installed there', async () => {
    const r = rig()
    expect(await findAfterInstall('claude', r.deps)).toBe(EXE)
    expect(r.ran).toEqual([addUserPathCommand('C:\\Users\\kim\\.local\\bin')])
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
      ['claude', { platform: 'darwin' }]
    ] as const) {
      const r = rig(o)
      expect(await findAfterInstall(cli, r.deps)).toBeNull()
      expect(r.ran).toEqual([])
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
})
