// On macOS and Linux a process keeps the PATH it was started with, and the Host outlives the app. Claude
// Code installed from the app after the Host started lands in ~/.local/bin (its installer leaves PATH
// alone: install/cliInstall.ts's unpathedInstallDir), so the Host's sessions could not start it until the
// Host restarted. Windows reads the Path Windows keeps again instead (windowsPath.ts), which the app's
// install writes to. So before a CLI is started, one PATH does not hold is looked for in the folder its
// installer documents, and that folder goes in front of PATH when it holds it: a look at one file, no
// shell started.
import { constants, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unpathedInstallDir, type InstallableCli } from '../install/cliInstall'

const executable = (p: string): Promise<boolean> =>
  fs.stat(p).then(
    (s) => s.isFile() && fs.access(p, constants.X_OK).then(() => true, () => false),
    () => false
  )

export async function ensureInstallDirOnPath(
  names: readonly InstallableCli[],
  o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string; isFile?: (p: string) => Promise<boolean> } = {}
): Promise<void> {
  const platform = o.platform ?? process.platform
  if (platform === 'win32') return
  const env = o.env ?? process.env
  const isFile = o.isFile ?? executable
  const home = o.home ?? os.homedir()
  for (const name of names) {
    const dirs = (env.PATH ?? '').split(':').filter((d) => d !== '')
    if ((await Promise.all(dirs.map((d) => isFile(path.posix.join(d, name))))).some(Boolean)) continue
    const dir = unpathedInstallDir(name, platform, home)
    if (dir === null || !(await isFile(path.posix.join(dir, name)))) continue
    env.PATH = env.PATH ? `${dir}:${env.PATH}` : dir
  }
}
