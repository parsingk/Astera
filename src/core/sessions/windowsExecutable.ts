// Where a command actually is on Windows, looked up on PATH and nowhere else (security review
// 2026-09-28, CWE-427).
//
// The CLIs were spawned as `cmd.exe /c claude …` with the project folder as the working directory,
// and cmd.exe looks a bare name up in its current directory before it looks at PATH. A repository
// shipping a `claude.cmd` therefore ran it the moment its folder was picked in the New Session
// dialog (`system.checkCli` runs `claude --version` there) and again in place of the real CLI when a
// session started, before Claude Code's own trust prompt. git and gh were spawned by name too, and
// libuv's lookup has the same order. sh never searches the working directory, so this is win32 only.
//
// `findOnWindowsPath` walks the absolute entries of PATH with the executable extensions cmd.exe
// itself would try, and `windowsSpawn` turns a bare name into something the working directory cannot
// redirect: an .exe or .com is spawned directly, a .cmd or .bat goes through `cmd.exe /d /c call
// "<absolute path>"` (the path carries a separator, so cmd.exe does not search for it; `call` keeps a
// quoted path with spaces from tripping cmd.exe's /c quote stripping; `/d` skips AutoRun), and a
// name PATH does not know is spawned bare with no shell at all, which CreateProcess resolves from the
// parent's own folders rather than the child's cwd — and which simply fails when it is not there.
import { existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import type { SpawnCommand } from './commands'

/** The extensions cmd.exe tries for a bare name, in PATHEXT's default order. PATHEXT is honoured
 *  for the order, but only these four are executables a CLI ships as. */
const EXECUTABLE_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd']

/** The files cmd.exe would try for `name`, in its order; null for a name that already carries a path. */
function candidatesOnWindowsPath(name: string, env: NodeJS.ProcessEnv): string[] | null {
  if (/[\\/]/.test(name)) return null
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  const entries = (pathKey ? env[pathKey] ?? '' : '')
    .split(';')
    .map((e) => e.trim().replace(/^"(.*)"$/, '$1'))
    // A relative entry (`.` and the like) is the working directory in disguise: skipped.
    .filter((e) => e !== '' && path.win32.isAbsolute(e))
  const pathext = (env['PATHEXT'] ?? env['Pathext'] ?? '')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => EXECUTABLE_EXTENSIONS.includes(e))
  const exts = pathext.length > 0 ? pathext : EXECUTABLE_EXTENSIONS
  const hasExt = EXECUTABLE_EXTENSIONS.includes(path.win32.extname(name).toLowerCase())
  const out: string[] = []
  for (const dir of entries) {
    if (hasExt) out.push(path.win32.join(dir, name))
    else for (const ext of exts) out.push(path.win32.join(dir, name + ext))
  }
  return out
}

export function findOnWindowsPath(
  name: string,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean = existsSync
): string | null {
  const candidates = candidatesOnWindowsPath(name, env)
  // A name that already carries a path is not looked up: that is a path, and it is the caller's.
  if (candidates === null) return path.win32.isAbsolute(name) && exists(name) ? name : null
  for (const p of candidates) if (exists(p)) return p
  return null
}

/** How long the asynchronous lookup waits for the PATH folders to answer. A folder that has not (an offline mapped
 *  drive) counts as not having the file. */
export const PATH_LOOKUP_TIMEOUT_MS = 3_000

const existsAsyncDefault = (p: string): Promise<boolean> =>
  fsp.access(p).then(
    () => true,
    () => false
  )

/** `findOnWindowsPath` off the calling thread (second pass M2-2): every candidate is asked at once, and the first in
 *  cmd.exe's order that answered yes within `timeoutMs` wins. */
export async function findOnWindowsPathAsync(
  name: string,
  env: NodeJS.ProcessEnv,
  o: { exists?: (p: string) => Promise<boolean>; timeoutMs?: number } = {}
): Promise<string | null> {
  const exists = o.exists ?? existsAsyncDefault
  const timeoutMs = o.timeoutMs ?? PATH_LOOKUP_TIMEOUT_MS
  const candidates = candidatesOnWindowsPath(name, env)
  const list = candidates ?? (path.win32.isAbsolute(name) ? [name] : [])
  if (list.length === 0) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((r) => {
    timer = setTimeout(() => r('late'), timeoutMs)
  })
  try {
    const answers = list.map((p) => Promise.race([exists(p).catch(() => false), late]))
    for (let i = 0; i < list.length; i++) if ((await answers[i]) === true) return list[i]
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** How long a lookup's answer is used without looking again: enough for a prepare and the spawn after it, short enough
 *  that a CLI installed into a folder already on PATH is found. */
export const RESOLVED_FOR_MS = 60_000

export interface WindowsResolver {
  /** The file PATH names for `name`: the answer of the last minute, else a synchronous lookup. */
  resolve(name: string): string | null
  /** The same lookup off the calling thread, its answer kept for `resolve`. Never rejects. */
  warm(name: string): Promise<string | null>
}

export function makeWindowsResolver(o: {
  env: () => NodeJS.ProcessEnv
  exists?: (p: string) => boolean
  existsAsync?: (p: string) => Promise<boolean>
  now?: () => number
  timeoutMs?: number
}): WindowsResolver {
  const now = o.now ?? Date.now
  const kept = new Map<string, { file: string | null; at: number }>()
  const keyOf = (name: string, env: NodeJS.ProcessEnv): string => {
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
    return `${name}\u0000${pathKey ? env[pathKey] ?? '' : ''}\u0000${env['PATHEXT'] ?? env['Pathext'] ?? ''}`
  }
  const keep = (key: string, file: string | null): string | null => {
    const t = now()
    for (const [k, v] of kept) if (t - v.at >= RESOLVED_FOR_MS) kept.delete(k)
    kept.set(key, { file, at: t })
    return file
  }
  return {
    resolve: (name) => {
      const env = o.env()
      const key = keyOf(name, env)
      const hit = kept.get(key)
      if (hit && now() - hit.at < RESOLVED_FOR_MS) return hit.file
      return keep(key, findOnWindowsPath(name, env, o.exists))
    },
    warm: async (name) => {
      const env = o.env()
      const file = await findOnWindowsPathAsync(name, env, { ...(o.existsAsync ? { exists: o.existsAsync } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) }).catch(() => null)
      return keep(keyOf(name, env), file)
    }
  }
}

const processResolver = makeWindowsResolver({ env: () => process.env })

/** PATH lookup against this process's environment, on win32; null everywhere else (a posix spawn
 *  by name is PATH-only already). The answer of the last minute, so a spawn after its prepare's `warm` checks nothing. */
export function resolveWindowsExecutable(name: string): string | null {
  return process.platform === 'win32' ? processResolver.resolve(name) : null
}

/** `resolveWindowsExecutable` looked up off the calling thread and kept for it; null off win32. */
export function warmWindowsExecutable(name: string): Promise<string | null> {
  return process.platform === 'win32' ? processResolver.warm(name) : Promise.resolve(null)
}

/** The file to hand child_process for a tool spawned by name with a repository as its cwd: on win32
 *  the absolute path PATH names (or the bare name when PATH does not know it — CreateProcess then
 *  resolves it from the parent's folders and fails otherwise), elsewhere the name itself. Cached per
 *  PATH value, so a PATH the app extends after an install is looked at again. */
export function windowsExecutable(name: string): string {
  if (process.platform !== 'win32') return name
  const pathNow = process.env.PATH ?? process.env.Path ?? ''
  const hit = executableCache.get(name)
  if (hit && hit.path === pathNow) return hit.file
  const file = findOnWindowsPath(name, process.env) ?? name
  executableCache.set(name, { path: pathNow, file })
  return file
}
const executableCache = new Map<string, { path: string; file: string }>()

/** How to spawn `name args…` on win32 without the working directory taking part in the lookup. */
export function windowsSpawn(
  name: string,
  args: string[],
  resolve: (name: string) => string | null = resolveWindowsExecutable
): SpawnCommand {
  const found = resolve(name)
  if (found === null) return { file: name, args }
  const ext = path.win32.extname(found).toLowerCase()
  if (ext === '.exe' || ext === '.com') return { file: found, args }
  return { file: 'cmd.exe', args: ['/d', '/c', 'call', found, ...args] }
}
