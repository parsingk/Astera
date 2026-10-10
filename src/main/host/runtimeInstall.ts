// Putting the Host's runtime in place without holding the main thread, and telling the window while
// it happens (stage 3 task 2).
//
// **Why this exists.** The install ran from `startHostClient` with `cpSync`, `rmSync` and friends, on
// Electron's main thread. A first install after an update copies an 87 MB `node.exe`, which an
// antivirus then scans, and for all of that time the window froze with nothing on screen to say why.
// Slow is acceptable; frozen, or looking frozen, is not. So:
//
// - every filesystem call on this path is `fs.promises` — `installHostRuntime` takes that object
//   injected, which is also how the tests prove no `*Sync` call is left on it;
// - one install is in flight at a time, and everyone who needs the runtime awaits that one
//   (`createRuntimeInstaller`), so nothing spawns a Host from a runtime still being written;
// - the window hears `preparing` the moment something is actually written, `slow` after a second,
//   and `failed` with the reason if it did not work.
//
// The runtime's content and layout are `runtime.ts`'s business and unchanged: the same staging
// directories, the same renames, the same sweep.
import { win32 as w } from 'node:path'
import { hostRuntimePaths, type HostRuntimePaths } from '../../core/host/runtime'
import type { HostRuntimeInstallState } from '../../core/types'
import { prepareHostRuntime, sweepHostRuntime, type RuntimeFiles, type RuntimeFs } from './runtime'

/** The part of `fs.promises` this path uses. Node's own `fs.promises` satisfies it; the tests hand in
 *  one that throws from every `*Sync` twin. */
export interface AsyncFs {
  access(p: string): Promise<void>
  readdir(p: string): Promise<string[]>
  cp(from: string, to: string, o: { recursive: true }): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(p: string, o: { recursive: true; force: true }): Promise<void>
  readFile(p: string, enc: 'utf8'): Promise<string>
}

/** `RuntimeFs` over `fs.promises`. The same answers the sync version gave: `readdir` of a directory
 *  that is not there is `[]`, `rm` of one is nothing, and `exists` is whether `access` succeeds. */
export function asyncRuntimeFs(fsp: AsyncFs): RuntimeFs {
  return {
    exists: async (p) => {
      try {
        await fsp.access(p)
        return true
      } catch {
        return false
      }
    },
    readdir: async (p) => {
      try {
        return await fsp.readdir(p)
      } catch {
        return []
      }
    },
    copy: (from, to) => fsp.cp(from, to, { recursive: true }),
    rename: (from, to) => fsp.rename(from, to),
    rm: (p) => fsp.rm(p, { recursive: true, force: true })
  }
}

/** The Node version a shipped `runtime.json` names, or '' when it names none. */
function manifestNodeVersion(manifest: unknown): string {
  const node = manifest && typeof manifest === 'object' ? (manifest as { node?: unknown }).node : undefined
  return typeof node === 'string' ? node.trim() : ''
}

/**
 * Where the shipped runtime's executable is installed, whether or not the install has run yet; null
 * when this build ships none or its manifest cannot be read.
 *
 * Claude Code's capture scripts run under it on win32 (core.ts), so a PC without Node.js still gets
 * its hooks. It is asked before the install lands, so a session opened while the window still says
 * "Preparing the Astera Host" gets the command it will have once it has; `installHostRuntime`'s answer
 * corrects it afterwards (ipc.ts, `runtimeInstaller`).
 */
export async function shippedHostExe(a: {
  base: string
  /** `<resources>\host-runtime`. */
  shippedRoot: string
  appVersion: string
  readFile: AsyncFs['readFile']
}): Promise<string | null> {
  try {
    const nodeVersion = manifestNodeVersion(JSON.parse(await a.readFile(w.join(a.shippedRoot, 'runtime.json'), 'utf8')))
    return nodeVersion ? hostRuntimePaths({ base: a.base, nodeVersion, appVersion: a.appVersion }).exePath : null
  } catch {
    return null
  }
}

export interface InstalledRuntime {
  paths: HostRuntimePaths
  incomplete: boolean
}

/**
 * Reads the shipped manifest, puts the runtime in place, and sweeps what an update left behind — the
 * body `prepareHostRuntimeFor` in ipc.ts used to run synchronously, now with the filesystem injected.
 *
 * `runtime` null means "spawn from the app executable", exactly as before; `failure` says whether that
 * is because something went wrong (shown to the person) or simply because nothing was shipped (not a
 * fault, not shown).
 */
export async function installHostRuntime(a: {
  base: string
  /** `<resources>\host-runtime`. */
  shippedRoot: string
  appVersion: string
  stamp: string
  fs: AsyncFs
  onInstall?: () => void
  log(m: string): void
}): Promise<{ runtime: InstalledRuntime | null; failure: string | null }> {
  // Which Node is actually in that directory is read from the directory, not from a constant: the two
  // can then never disagree about what was shipped. Empty file lists are not an error —
  // `prepareHostRuntime` treats them as "do not check", which is the right answer for an older shipped
  // runtime and for a manifest this build could not parse.
  let nodeVersion = ''
  let files: RuntimeFiles = { node: [], build: [] }
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  try {
    const manifest: unknown = JSON.parse(await a.fs.readFile(w.join(a.shippedRoot, 'runtime.json'), 'utf8'))
    nodeVersion = manifestNodeVersion(manifest)
    const listed = (manifest as { files?: { node?: unknown; build?: unknown } } | null)?.files
    if (listed) files = { node: strings(listed.node), build: strings(listed.build) }
  } catch {
    /* nothing shipped, or unreadable — said just below */
  }
  if (!nodeVersion) {
    a.log('no host runtime shipped with this build — the Host runs from the app executable')
    return { runtime: null, failure: null }
  }
  const paths = hostRuntimePaths({ base: a.base, nodeVersion, appVersion: a.appVersion })
  // The shipped tree carries the same `node-<version>` directory the install uses, so putting it in
  // place is one copy. scripts/host-runtime.mjs says why it is nested rather than flat.
  const shipped = w.join(a.shippedRoot, w.basename(paths.nodeDir))
  const fs = asyncRuntimeFs(a.fs)
  const installed = await prepareHostRuntime({
    paths,
    shipped,
    appVersion: a.appVersion,
    stamp: a.stamp,
    files,
    fs,
    onInstall: a.onInstall,
    log: a.log
  })
  if (!installed.ready) return { runtime: null, failure: installed.failure }
  if (installed.did !== 'nothing') a.log(`host runtime installed (${installed.did}): ${paths.exePath}`)
  await sweepHostRuntime({ paths, nodeVersion, appVersion: a.appVersion, fs, log: a.log })
  return { runtime: { paths, incomplete: installed.incomplete }, failure: null }
}

/** How long an install may run before the window says it is still working. */
export const INSTALL_SLOW_MS = 1_000

/**
 * How long anyone waits for one install before falling back to the app executable (review of stage 3
 * task 2). Two minutes is far past a first install on a slow disk with an antivirus scanning
 * `node.exe`, and far short of "forever" — which is what a hung `fs.promises.cp` used to mean: the
 * connect cycle, the fallback, `hostSessionsTakenBack` and with it `bootOrch` all waited on it.
 */
export const INSTALL_TIMEOUT_MS = 120_000

export interface RuntimeInstaller<T> {
  /** The runtime, installing or checking it first. Concurrent callers share the one in flight; a call
   *  after that one settled starts another, which is the check-and-repair before every spawn (design
   *  F6). Never rejects: a failure is `null` — spawn from the app executable — and the state says why.
   *
   *  **Bounded by INSTALL_TIMEOUT_MS.** Past it every caller gets `null` and the state is `failed`
   *  with reason `timeout`, while the install itself is left to finish or fail on its own. It stays
   *  the one in flight until it does, so no second install is started beside it to fight over the
   *  same staging directory; when it lands, the state says what it actually came to, and the next
   *  `ensure()` checks the runtime from scratch. A late completion corrupts nothing: it either renamed
   *  a whole directory into place or did not. */
  ensure(): Promise<T | null>
  /** Resolves once no install is in flight, or once the one in flight has run past its deadline. Does
   *  not start one. */
  whenSettled(): Promise<void>
  state(): HostRuntimeInstallState
}

/**
 * One install at a time, and the state the window shows for it.
 *
 * `run` is handed `installing()`, to call the moment it starts writing (`onInstall` above). Only then
 * does the state leave `idle`: a runtime that is already whole is checked in a few milliseconds, and
 * flashing "Preparing" for that on every launch would teach people to ignore it.
 */
export function createRuntimeInstaller<T>(o: {
  run(hooks: { installing(): void }): Promise<{ value: T | null; failure: string | null }>
  onState(s: HostRuntimeInstallState): void
  log(m: string): void
  slowAfterMs?: number
  timeoutMs?: number
  now?: () => number
}): RuntimeInstaller<T> {
  const slowAfterMs = o.slowAfterMs ?? INSTALL_SLOW_MS
  const timeoutMs = o.timeoutMs ?? INSTALL_TIMEOUT_MS
  const now = o.now ?? Date.now
  let state: HostRuntimeInstallState = { phase: 'idle' }
  /** The install in flight, and the promise that resolves null at its deadline. */
  let running: { done: Promise<T | null>; deadline: Promise<null> } | null = null
  let slowTimer: ReturnType<typeof setTimeout> | null = null

  const set = (s: HostRuntimeInstallState): void => {
    state = s
    try {
      o.onState(s)
    } catch (err) {
      o.log(`the host runtime's install state could not be shown: ${String(err)}`)
    }
  }
  const clearSlow = (): void => {
    if (slowTimer) clearTimeout(slowTimer)
    slowTimer = null
  }

  const once = async (): Promise<T | null> => {
    // Set by this attempt only. A `failed` left from an earlier attempt is not cleared by a check that
    // wrote nothing unless that check succeeded, which is what the settle below does.
    let announced = false
    const installing = (): void => {
      if (announced) return
      announced = true
      const startedAt = now()
      set({ phase: 'preparing', slow: false, startedAt })
      slowTimer = setTimeout(() => {
        slowTimer = null
        if (state.phase === 'preparing') set({ phase: 'preparing', slow: true, startedAt })
      }, slowAfterMs)
      slowTimer.unref?.()
    }
    try {
      const r = await o.run({ installing })
      clearSlow()
      if (r.failure) set({ phase: 'failed', reason: 'copy', detail: r.failure })
      else if (state.phase !== 'idle') set({ phase: 'idle' })
      return r.failure ? null : r.value
    } catch (err) {
      clearSlow()
      const detail = `the host runtime could not be prepared: ${String(err)}`
      o.log(`${detail} — the Host runs from the app executable, and the next start tries again`)
      set({ phase: 'failed', reason: 'unknown', detail })
      return null
    }
  }

  const start = (): { done: Promise<T | null>; deadline: Promise<null> } => {
    const done = once()
    let timer: ReturnType<typeof setTimeout> | null = null
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        timer = null
        clearSlow()
        const detail = `the host runtime was still being prepared after ${Math.round(timeoutMs / 1000)}s`
        o.log(`${detail} — the Host runs from the app executable; the install is left to finish on its own`)
        set({ phase: 'failed', reason: 'timeout', detail })
        resolve(null)
      }, timeoutMs)
      ;(timer as { unref?: () => void }).unref?.()
    })
    const r = { done, deadline }
    // `once()` never rejects, so neither does this.
    void done.then(() => {
      if (timer) clearTimeout(timer)
      if (running === r) running = null
    })
    return r
  }

  return {
    ensure: () => {
      if (!running) running = start()
      return Promise.race([running.done, running.deadline])
    },
    whenSettled: async () => {
      if (running) await Promise.race([running.done, running.deadline])
    },
    state: () => state
  }
}

/** A `spawnHost` that waits for the install before spawning: nothing is started from a runtime that
 *  is still being written. `spawn` gets null when the runtime is not usable, and then spawns from the
 *  app executable, as before.
 *
 *  **And nothing is spawned that is no longer wanted** (review of stage 3 task 2): the client may have
 *  been stopped — the updater's stop, or the app quitting — or restarted into another cycle while the
 *  install ran, and a spawn then would put a detached Host behind an update. */
export function spawnWhenInstalled<T>(
  installer: RuntimeInstaller<T>,
  spawn: (runtime: T | null) => void
): (ctx: { wanted(): boolean }) => Promise<void> {
  return async (ctx) => {
    const runtime = await installer.ensure()
    if (!ctx.wanted()) return
    spawn(runtime)
  }
}
