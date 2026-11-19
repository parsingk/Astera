/** The real dependencies of the kube service: the file system, git layout and kubectl as spawned for this app. */
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KUBE_HEAD_BYTES } from '../../core/kube/detect'
import { kubectlBin, runKubectl } from '../../core/kube/kubectl'
import { gitLayoutOf } from '../../core/sandbox/gitLayout'
import type { AppSettingsStore } from '../appSettingsStore'
import type { KubeServiceDeps } from './service'
import type { KubeTargetStore } from './targetStore'

/** The environment kubectl runs in. With added kubeconfig files, KUBECONFIG is the default list (the parent's
 *  KUBECONFIG, else ~/.kube/config) followed by the added ones, so kubectl merges them as it does for a person. */
export function kubeEnv(extraFiles: string[], parent: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  if (extraFiles.length === 0) return parent
  const own = parent.KUBECONFIG
  const defaults = own ? own.split(path.delimiter).filter((f) => f !== '') : [path.join(home, '.kube', 'config')]
  return { ...parent, KUBECONFIG: [...new Set([...defaults, ...extraFiles])].join(path.delimiter) }
}

/** The kubectl a run would use, for display: the override, else where PATH finds it, else the bare name. */
export function kubectlDisplayPath(override: string | null, env: NodeJS.ProcessEnv, exists: (p: string) => boolean = existsSync): string {
  const bin = kubectlBin(override)
  if (path.isAbsolute(bin) || /[\\/]/.test(bin)) return bin
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue
    const candidate = path.join(dir, bin)
    if (exists(candidate)) return candidate
  }
  return bin
}

export function createRealKubeDeps(settings: AppSettingsStore, store: KubeTargetStore): KubeServiceDeps {
  return {
    // Bin and env are read per call so a settings change applies without a restart.
    run: (args, opts) =>
      runKubectl(args, {
        bin: kubectlBin(settings.getKubectlPath()),
        env: kubeEnv(settings.getKubeconfigFiles(), process.env, os.homedir()),
        ...opts
      }),
    readHead: async (file) => {
      const handle = await fs.open(file, 'r')
      try {
        const buf = Buffer.alloc(KUBE_HEAD_BYTES)
        const { bytesRead } = await handle.read(buf, 0, KUBE_HEAD_BYTES, 0)
        return buf.subarray(0, bytesRead).toString('utf8')
      } finally {
        await handle.close()
      }
    },
    readText: (file) => fs.readFile(file, 'utf8'),
    stat: async (file) => {
      try {
        const s = await fs.stat(file)
        return { mtimeMs: s.mtimeMs, isDir: s.isDirectory() }
      } catch {
        return null
      }
    },
    listDir: async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    },
    layoutOf: async (dir) => {
      const l = await gitLayoutOf(dir).catch(() => null)
      return l ? { top: l.top, commonDir: l.commonDir } : null
    },
    store
  }
}
