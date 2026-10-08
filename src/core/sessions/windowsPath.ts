// This process's PATH, completed from the Path Windows keeps (Machine, then User), for the app and the
// Host alike.
//
// **A process on Windows can hold an older PATH than the one Windows keeps.** It gets a copy of
// whoever started it: the 1.4.0 update's installer relaunched the app with the old app's environment,
// copied before Codex had put its folder on the user Path, and the app said codex was not installed
// (2026-09-30). The Host is worse off: it outlives the app, and a same-protocol update, with the copy
// it started with, and `astera host start` gives it whatever the shell that ran it had. Since the CLIs
// are started from where this PATH says they are (windowsExecutable.ts), an older copy means a CLI
// that looks missing. So both processes complete their PATH when they start, and again, at most every
// REFRESH_MS, when a CLI they are about to start is not on it — installing one while they run then
// needs no restart.
//
// **Completed, not replaced**: the folders the saved Path has that this one lacks are appended in the
// saved order, and what the inherited PATH already had stays in front where whoever started the
// process put it. Windows PowerShell by its absolute path (a bare name is looked up in the working
// directory first), UTF-8 out so a folder with non-ASCII letters survives.
import { execFile } from 'node:child_process'
import { findOnWindowsPathAsync } from './windowsExecutable'

const START = '__ASTERA_PATH__'
const END = '__END__'

/** How often a CLI that is not on PATH may make this process read the saved Path again. */
export const REFRESH_MS = 30_000

/** The Windows PowerShell call that prints the saved Path, Machine then User, between markers. */
export function windowsPathProbe(systemRoot: string | undefined = process.env.SystemRoot): { file: string; args: string[] } {
  return {
    file: `${systemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write('${START}' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + '${END}')`
    ]
  }
}

/** The saved Path out of what windowsPathProbe printed, or null when the markers are not there. */
export function parseWindowsPathProbe(stdout: string): string | null {
  const start = stdout.indexOf(START)
  if (start === -1) return null
  const end = stdout.indexOf(END, start + START.length)
  if (end === -1) return null
  const value = stdout.slice(start + START.length, end).trim()
  return value === '' ? null : value
}

/** One win32 Path entry as a folder to compare: case folded, trailing separators and quotes off. */
const folderKey = (entry: string): string =>
  entry
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/[\\/]+$/, '')
    .toLowerCase()

/** The inherited PATH with every folder of the saved one it lacks appended, in the saved order. The
 *  inherited string is kept as it is when nothing is new. */
export function mergeWindowsPath(current: string | undefined, saved: string | null): string | undefined {
  if (saved === null) return current
  const have = new Set((current ?? '').split(';').filter((e) => e.trim() !== '').map(folderKey))
  const added: string[] = []
  for (const e of saved.split(';')) {
    if (e.trim() === '') continue
    const key = folderKey(e)
    if (have.has(key)) continue
    have.add(key)
    added.push(e.trim())
  }
  if (added.length === 0) return current
  const kept = (current ?? '').replace(/;+$/, '')
  return kept === '' ? added.join(';') : `${kept};${added.join(';')}`
}

export type RunProbe = (file: string, args: string[]) => Promise<string>

const runProbe: RunProbe = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000, encoding: 'utf8', windowsHide: true }, (err, stdout) =>
      err && !stdout ? reject(err) : resolve(stdout)
    )
  })

/** Reads the saved Path, or null when it could not be read (the inherited PATH then, as before). */
export async function readSavedWindowsPath(run: RunProbe = runProbe): Promise<string | null> {
  const probe = windowsPathProbe()
  try {
    return parseWindowsPathProbe(await run(probe.file, probe.args))
  } catch {
    return null
  }
}

/** Completes `env.PATH` from the saved Path. True when it added something. No-op off win32. */
export async function completeWindowsPath(
  env: NodeJS.ProcessEnv = process.env,
  run: RunProbe = runProbe,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if (platform !== 'win32') return false
  const before = env.PATH
  const merged = mergeWindowsPath(before, await readSavedWindowsPath(run))
  if (merged === undefined || merged === before) return false
  env.PATH = merged
  return true
}

let lastRefresh = -Infinity

/**
 * Before starting one of `names`: when any of them is not on `env.PATH`, reads the saved Path again,
 * at most once every REFRESH_MS, so a CLI installed while this process runs is found without a
 * restart. Never rejects; a no-op off win32 and when every name is found.
 */
export async function ensureOnWindowsPath(
  names: readonly string[],
  o: {
    env?: NodeJS.ProcessEnv
    run?: RunProbe
    platform?: NodeJS.Platform
    now?: () => number
    exists?: (p: string) => Promise<boolean>
    timeoutMs?: number
  } = {}
): Promise<void> {
  const env = o.env ?? process.env
  if ((o.platform ?? process.platform) !== 'win32') return
  // Off the thread and bounded (second pass M2-2): an offline drive on PATH held the app here before every session start.
  const lookup = { ...(o.exists ? { exists: o.exists } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) }
  const found = await Promise.all(names.map((n) => findOnWindowsPathAsync(n, env, lookup)))
  if (found.every((f) => f !== null)) return
  const now = (o.now ?? Date.now)()
  if (now - lastRefresh < REFRESH_MS) return
  lastRefresh = now
  await completeWindowsPath(env, o.run, 'win32').catch(() => false)
}

/** Test seam: forget when the saved Path was last read. */
export function resetWindowsPathRefresh(): void {
  lastRefresh = -Infinity
}
