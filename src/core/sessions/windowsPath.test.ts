import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  REFRESH_MS,
  completeWindowsPath,
  ensureOnWindowsPath,
  mergeWindowsPath,
  parseWindowsPathProbe,
  resetWindowsPathRefresh,
  windowsPathProbe,
  type RunProbe
} from './windowsPath'

/** A probe that answers with `saved` the way windowsPathProbe prints it, and counts its calls. */
function savedPath(saved: string): { run: RunProbe; calls: number } {
  const state = { calls: 0 }
  return {
    run: async () => {
      state.calls++
      return `__ASTERA_PATH__${saved}__END__`
    },
    get calls() {
      return state.calls
    }
  }
}

beforeEach(() => resetWindowsPathRefresh())

describe('mergeWindowsPath: the inherited PATH stays, what it lacks is appended', () => {
  it('keeps the inherited order and appends what the saved Path has that it lacks', () => {
    expect(mergeWindowsPath('C:\\a;C:\\b', 'C:\\b;C:\\c;C:\\a')).toBe('C:\\a;C:\\b;C:\\c')
  })

  it('does not add a folder again in another case or with a trailing separator', () => {
    expect(mergeWindowsPath('C:\\Tools\\', 'c:\\tools;C:\\new')).toBe('C:\\Tools\\;C:\\new')
  })

  it('keeps the inherited PATH as it was when the saved one adds nothing, or cannot be read', () => {
    expect(mergeWindowsPath('C:\\a;;C:\\b;', 'C:\\a;C:\\b')).toBe('C:\\a;;C:\\b;')
    expect(mergeWindowsPath('C:\\a', null)).toBe('C:\\a')
    expect(mergeWindowsPath(undefined, 'C:\\a')).toBe('C:\\a')
  })
})

describe('the probe', () => {
  it('is Windows PowerShell by its absolute path, reading Machine then User', () => {
    const p = windowsPathProbe('C:\\Windows')
    expect(p.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(p.args.join(' ')).toMatch(/Path','Machine'.*Path','User'/)
  })

  it('reads only what sits between its markers', () => {
    expect(parseWindowsPathProbe('noise __ASTERA_PATH__C:\\a;C:\\b__END__ more')).toBe('C:\\a;C:\\b')
    expect(parseWindowsPathProbe('no markers here')).toBeNull()
  })
})

describe('completeWindowsPath', () => {
  it('appends to env.PATH and says so; does nothing off win32', async () => {
    const env = { PATH: 'C:\\a' } as NodeJS.ProcessEnv
    expect(await completeWindowsPath(env, savedPath('C:\\a;C:\\new').run, 'win32')).toBe(true)
    expect(env.PATH).toBe('C:\\a;C:\\new')
    expect(await completeWindowsPath(env, savedPath('C:\\a;C:\\new').run, 'win32')).toBe(false)
    const other = { PATH: '/usr/bin' } as NodeJS.ProcessEnv
    expect(await completeWindowsPath(other, savedPath('C:\\x').run, 'linux')).toBe(false)
    expect(other.PATH).toBe('/usr/bin')
  })
})

describe('ensureOnWindowsPath: read the saved Path again when a CLI is missing, not more than every REFRESH_MS', () => {
  it('reads it once for a missing CLI, and not again inside the window', async () => {
    const probe = savedPath('C:\\nowhere')
    let t = 1_000_000
    const env = { PATH: 'C:\\a' } as NodeJS.ProcessEnv
    await ensureOnWindowsPath(['definitely-not-a-cli-astera'], { env, run: probe.run, platform: 'win32', now: () => t })
    await ensureOnWindowsPath(['definitely-not-a-cli-astera'], { env, run: probe.run, platform: 'win32', now: () => t + 1000 })
    expect(probe.calls).toBe(1)
    t += REFRESH_MS
    await ensureOnWindowsPath(['definitely-not-a-cli-astera'], { env, run: probe.run, platform: 'win32', now: () => t })
    expect(probe.calls).toBe(2)
  })

  // Second pass M2-2: the "is it on PATH" check looked at every PATH folder synchronously before each session start.
  it('does not wait on a PATH folder that does not answer', async () => {
    const probe = savedPath('C:\\a')
    const env = { PATH: 'Z:\\dead;C:\\a', PATHEXT: '.EXE' } as NodeJS.ProcessEnv
    const exists = (p: string): Promise<boolean> => (p.startsWith('Z:') ? new Promise(() => {}) : Promise.resolve(p.toLowerCase() === 'c:\\a\\claude.exe'))
    const t0 = Date.now()
    await ensureOnWindowsPath(['claude'], { env, run: probe.run, platform: 'win32', exists, timeoutMs: 50 })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(probe.calls).toBe(0)
  })

  // Final review I2: a chat spawn never prepares, so its command builder's PATH lookup was cold and synchronous unless
  // something else had warmed it. Every chat spawn awaits this check, so this check's lookup is the one kept.
  it("looks this process's names up through the kept lookup, again after the saved Path was read", async () => {
    const warmed: string[] = []
    const probe = savedPath('C:\\a;C:\\new')
    let n = 0
    await ensureOnWindowsPath(['claude', 'codex'], {
      env: { PATH: 'C:\\a' } as NodeJS.ProcessEnv,
      run: probe.run,
      platform: 'win32',
      now: () => 9_000_000_000,
      warm: async (name) => {
        warmed.push(name)
        return n++ < 2 && name === 'codex' ? null : `C:\\bin\\${name}.exe`
      }
    })
    expect(warmed.slice(0, 2).sort()).toEqual(['claude', 'codex'])
    expect(probe.calls).toBe(1)
    expect(warmed.slice(2).sort()).toEqual(['claude', 'codex'])
  })

  it('does nothing off win32', async () => {
    const probe = savedPath('C:\\x')
    await ensureOnWindowsPath(['claude'], { env: {}, run: probe.run, platform: 'darwin' })
    expect(probe.calls).toBe(0)
  })

  // The case the 1.4.0 update showed: the CLI is installed, its folder is on the saved Path, and this
  // process's copy lacks it. Real files, so this runs where win32 paths are real.
  it.skipIf(process.platform !== 'win32')('finds a CLI whose folder only the saved Path has', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-winpath-'))
    await fs.writeFile(path.join(dir, 'fakecli-astera.exe'), '')
    const env = { PATH: 'C:\\Windows', PATHEXT: '.COM;.EXE;.BAT;.CMD' } as NodeJS.ProcessEnv
    const probe = savedPath(`C:\\Windows;${dir}`)
    await ensureOnWindowsPath(['fakecli-astera'], { env, run: probe.run, platform: 'win32' })
    expect(env.PATH).toBe(`C:\\Windows;${dir}`)
    // Found now, so a second call reads nothing
    await ensureOnWindowsPath(['fakecli-astera'], { env, run: probe.run, platform: 'win32', now: () => Date.now() + REFRESH_MS * 2 })
    expect(probe.calls).toBe(1)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
