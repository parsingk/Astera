// On macOS and Linux the Host keeps the PATH it was started with. Claude Code installed from the app after
// that lands in ~/.local/bin, which that PATH lacks, so its sessions could not start it until the Host
// restarted (Windows reads the Path Windows keeps again instead: windowsPath.ts).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ensureInstallDirOnPath } from './installDirPath'

const run = async (env: NodeJS.ProcessEnv, files: string[], platform: NodeJS.Platform = 'darwin') => {
  await ensureInstallDirOnPath(['claude'], { env, platform, home: '/Users/kim', isFile: async (p) => files.includes(p) })
  return env
}

describe('ensureInstallDirOnPath', () => {
  it('puts the folder the installer documents in front of PATH when it holds a CLI PATH does not', async () => {
    const env = await run({ PATH: '/usr/bin:/bin' }, ['/Users/kim/.local/bin/claude'])
    expect(env.PATH).toBe('/Users/kim/.local/bin:/usr/bin:/bin')
  })

  it('leaves PATH alone when a folder on it already holds the CLI, or the folder does not', async () => {
    expect((await run({ PATH: '/opt/bin:/usr/bin' }, ['/opt/bin/claude', '/Users/kim/.local/bin/claude'])).PATH).toBe('/opt/bin:/usr/bin')
    expect((await run({ PATH: '/usr/bin' }, [])).PATH).toBe('/usr/bin')
  })

  it('does nothing on Windows, which reads the Path Windows keeps', async () => {
    expect((await run({ PATH: 'C:\\Windows' }, ['/Users/kim/.local/bin/claude'], 'win32')).PATH).toBe('C:\\Windows')
  })

  // Every place that completes PATH before a CLI starts (the Host's two spawns and its session create, the
  // app's own two) looks in the install folder there too.
  it('runs wherever the Windows Path is completed before a CLI starts', () => {
    for (const file of ['src/host/spawner.ts', 'src/host/sessionCreate.ts', 'src/main/ipc.ts']) {
      const text = readFileSync(path.join(process.cwd(), file), 'utf8')
      const windows = text.match(/await ensureOnWindowsPath\(\[[^\]]*\]\)/g) ?? []
      const posix = text.match(/await ensureInstallDirOnPath\(\[[^\]]*\]\)/g) ?? []
      expect(windows.length, file).toBeGreaterThan(0)
      expect(posix.map((c) => c.replace('ensureInstallDirOnPath', 'ensureOnWindowsPath')), file).toEqual(windows)
    }
  })
})
