// Where the Host's own executable lives, and how it gets there
// (docs/superpowers/specs/2026-09-14-host-runtime-design.md).
//
// **win32 only.** The Host is spawned from `process.execPath` — the app's own `Astera.exe` run with
// ELECTRON_RUN_AS_NODE — and Windows locks the image of a running process, so a Host that outlives
// the app pins the install directory and no installer can write over it. macOS and Linux replace a
// running binary without complaint, so their Hosts already survive an update and `hostRuntimeBase`
// returns null there: nothing is copied, nothing is swept, the spawn is unchanged.
//
// Pure, with the platform and the filesystem arriving as arguments, for the reason `address.ts` gives
// for the same choice: these tests run on windows, macos and ubuntu, and a module that asks the host
// which platform it is on can only be tested on one of them. Paths are built with `path.win32`
// rather than `path` for the same reason — this code only ever produces Windows paths, and on win32
// `path.win32` *is* `path`, so the tests read the same everywhere.
import { win32 as w } from 'node:path'

/** The directory name that carries the Node version, so a runtime built for one Node is never handed
 *  to another. Everything under one of these was copied together and belongs together. */
const NODE_PREFIX = 'node-'

export interface HostRuntimePaths {
  /** `%LOCALAPPDATA%\<app>\host-runtime` — the parent of every `node-*`. */
  base: string
  /** `<base>\node-<nodeVersion>` — the unit that is copied, and the unit that is swept. */
  nodeDir: string
  /** What the Host is spawned with, in place of `process.execPath`. */
  exePath: string
  /** `<nodeDir>\builds` — one directory per app version. */
  buildsDir: string
  buildDir: string
  /** The `host.js` to hand the executable. */
  entryPath: string
}

/**
 * Where this machine's runtimes live, or null when this platform does not use one.
 *
 * `%LOCALAPPDATA%`, **not** `app.getPath('userData')`: userData is `%APPDATA%\<app>`, the *roaming*
 * profile, and ninety megabytes of platform-specific binaries must not follow a user between
 * machines. userData is the fallback only for the case where `LOCALAPPDATA` is unset, which on a
 * supported Windows it is not.
 */
export function hostRuntimeBase(a: {
  platform: NodeJS.Platform
  localAppData: string | undefined
  userData: string
  appName: string
}): string | null {
  if (a.platform !== 'win32') return null
  const local = a.localAppData?.trim()
  if (local) return w.join(local, a.appName, 'host-runtime')
  return w.join(a.userData, 'host-runtime')
}

/**
 * **`builds` sits inside the Node directory, not beside it.** `out/main/host.js` requires `node-pty`
 * as a bare specifier (electron-vite externalizes it), so Node's ordinary resolution has to be able
 * to find it: walking up from `<nodeDir>\builds\<appVersion>` reaches `<nodeDir>\node_modules` on its
 * own. Beside it, this would need NODE_PATH or a rewritten import.
 *
 * It is also the truthful nesting. A build was made against one Node, and the two are copied,
 * swept and discarded together.
 */
export function hostRuntimePaths(a: { base: string; nodeVersion: string; appVersion: string }): HostRuntimePaths {
  const nodeDir = w.join(a.base, `${NODE_PREFIX}${a.nodeVersion}`)
  const buildsDir = w.join(nodeDir, 'builds')
  const buildDir = w.join(buildsDir, a.appVersion)
  return {
    base: a.base,
    nodeDir,
    exePath: w.join(nodeDir, 'node.exe'),
    buildsDir,
    buildDir,
    entryPath: w.join(buildDir, 'host.js')
  }
}

/** Which `node-*` directories are no longer the current one. **The prefix check is the guard, not
 *  decoration**: this list is deleted, and `base` is a directory a person could have put something
 *  else in. A name that does not look like ours is never a candidate. */
export function staleNodeDirs(names: readonly string[], keepNodeVersion: string): string[] {
  const keep = `${NODE_PREFIX}${keepNodeVersion}`
  return names.filter((n) => n.startsWith(NODE_PREFIX) && n !== keep)
}

/** Which build directories under the current Node are no longer the current app version.
 *
 *  Deleting the previous version's build while its Host is still running is deliberate and safe:
 *  `host.js` and its chunks are CommonJS, read at startup and closed, so a running Host holds no
 *  handle on them and never reads them again. `node.exe` is the opposite — a locked running image —
 *  which is why a whole `node-*` directory can only go once its Host has, and why the sweep has to
 *  tolerate failing (see `sweepHostRuntime`). */
export function staleBuildDirs(names: readonly string[], keepAppVersion: string): string[] {
  return names.filter((n) => n !== keepAppVersion)
}

/** The filesystem this module needs, injected so the sequencing below is testable. Every one of
 *  these is allowed to throw; the callers here say what that means in each place. */
export interface RuntimeFs {
  exists(p: string): boolean
  /** The entries of a directory, or `[]` when it is not there — "nothing to sweep" and "no such
   *  directory" are the same answer to the only question asked of it. */
  readdir(p: string): string[]
  /** Recursive copy, creating the destination's parents. */
  copy(from: string, to: string): void
  rename(from: string, to: string): void
  /** Recursive delete that does not mind a path which is not there. */
  rm(p: string): void
}

export interface PrepareResult {
  /** Whether the runtime is complete and can be spawned. False means the caller falls back to
   *  `process.execPath`, which is what every version before this one did. */
  ready: boolean
  /** What was actually written, for the log — an ordinary update does `build` alone. */
  did: 'nothing' | 'build' | 'node'
  /** The runtime is missing files and could not be repaired, because a Host is still running out of
   *  it and Windows will not delete a locked `node.exe`. The Host on the other end of that is one
   *  spawn away from stalling, so the app carries this in its status and replaces it the first moment
   *  it holds nothing (docs/2026-09-22-host-unresponsive-recovery-design.md F6). */
  incomplete: boolean
}

/**
 * Which files a whole runtime has, as the build wrote them into `runtime.json`.
 *
 * **Two lists, because a file being absent means opposite things in the two halves.** Nothing under
 * `builds\<version>` exists yet on the machine that is taking this app's first update — that is an
 * ordinary install, not damage. Everything under the node directory was laid down together by one
 * rename, so one of them missing means somebody or something took it, and what is left cannot spawn.
 */
export interface RuntimeFiles {
  /** Paths relative to `nodeDir`, excluding `builds`. */
  node: string[]
  /** Paths relative to `buildDir` — this app version's own build. */
  build: string[]
}

/**
 * Puts the shipped runtime where the Host can be spawned from it, doing as little as possible.
 *
 * The expensive half — `node.exe`, 87 MB — is copied **once per Node version**, because the
 * directory is keyed by that and nothing else. An ordinary app update finds it already there and
 * writes only the build directory, a few tens of kilobytes.
 *
 * **Both copies land through a staging directory and a rename.** An interrupted copy that left a
 * half-written `node.exe` behind would be believed by every later launch — `exists` was once the only
 * question asked of it — and the Host would never start again. A rename is the one step that either
 * happened or did not.
 *
 * **And `exists(node.exe)` is no longer the only question.** On 2026-09-22 a recursive delete of
 * `%LOCALAPPDATA%\astera` took everything in the runtime except the two files the running Host had
 * open, `node.exe` among them. This function looked at that and saw a runtime already in place; the
 * restart wrote the build directory and nothing else, and the Host went on being unable to spawn
 * anything at all. So every file the build recorded is checked, and a node directory that is missing
 * one is not patched but replaced (design D5, F6).
 */
export function prepareHostRuntime(a: {
  paths: HostRuntimePaths
  /** `<resources>\host-runtime`, as shipped in the installer. */
  shipped: string
  /** The app version, which is also the name of the build directory inside `shipped`. */
  appVersion: string
  /** Distinguishes this attempt's staging directory from a concurrent one. */
  stamp: string
  /** What a whole runtime has, from the shipped `runtime.json`. Empty lists mean the check is skipped
   *  — see where that is decided. */
  files: RuntimeFiles
  fs: RuntimeFs
  log(m: string): void
}): PrepareResult {
  const { paths, fs, shipped } = a
  if (!fs.exists(w.join(shipped, 'node.exe'))) {
    a.log('no host runtime shipped with this build — the Host runs from the app executable')
    return { ready: false, did: 'nothing', incomplete: false }
  }

  /** The first of `names` that is not under `dir`, or null. Swallows a filesystem that refuses to
   *  answer: **a check that cannot be made is not a failure**, and reading it as one would replace a
   *  working runtime, or worse refuse to start a Host, on no evidence at all. The same rule
   *  `host/nodePtyCheck.ts` follows on the other side of this. */
  const firstMissing = (dir: string, names: string[]): string | null => {
    try {
      return names.find((n) => !fs.exists(w.join(dir, n))) ?? null
    } catch {
      return null
    }
  }
  if (a.files.node.length === 0 && a.files.build.length === 0) {
    a.log('the shipped runtime lists no files — installed without checking what is already there')
  }

  let incomplete = false
  // Only for a runtime that is already installed. A machine that has none is the ordinary first
  // install, and the copy below is what puts every one of these files there.
  if (fs.exists(paths.exePath)) {
    const missing = firstMissing(paths.nodeDir, a.files.node)
    if (missing) {
      a.log(`the host runtime is missing ${missing} — replacing it`)
      try {
        // The whole directory, not the one file: what took that file took whatever else was not
        // locked at the time, and the list is only as complete as this build's own manifest.
        fs.rm(paths.nodeDir)
      } catch (err) {
        // The expected failure, and the one worth reporting: a Host is still running out of this
        // directory and holds its `node.exe`. Nothing can be repaired until that Host is gone, so the
        // caller is told, and the Host gets replaced the first moment it holds nothing.
        incomplete = true
        a.log(`the host runtime could not be repaired while a Host is running from it: ${String(err)}`)
      }
    }
  }

  let did: PrepareResult['did'] = 'nothing'
  if (!fs.exists(paths.exePath)) {
    const stage = `${paths.nodeDir}.staging-${a.stamp}`
    try {
      fs.rm(stage)
      fs.copy(shipped, stage)
      fs.rename(stage, paths.nodeDir)
      did = 'node'
    } catch (err) {
      // A second instance that got there first is the expected loser here, and it has already
      // produced exactly what this one was going to. Anything else leaves `ready` false below.
      fs.rm(stage)
      if (!fs.exists(paths.exePath)) {
        a.log(`the host runtime could not be installed: ${String(err)}`)
        return { ready: false, did: 'nothing', incomplete }
      }
    }
  }

  // The entry alone is not the question either: `host.js` requires the chunks beside it, and a build
  // directory with the entry and none of them is a Host that dies on its first line.
  const buildMissing = firstMissing(paths.buildDir, a.files.build)
  if (buildMissing && fs.exists(paths.entryPath)) a.log(`this build's host runtime is missing ${buildMissing} — rewriting it`)
  if (!fs.exists(paths.entryPath) || buildMissing) {
    const from = w.join(shipped, 'builds', a.appVersion)
    const stage = `${paths.buildDir}.staging-${a.stamp}`
    try {
      fs.rm(stage)
      fs.copy(from, stage)
      fs.rm(paths.buildDir)
      fs.rename(stage, paths.buildDir)
      if (did === 'nothing') did = 'build'
    } catch (err) {
      fs.rm(stage)
      if (!fs.exists(paths.entryPath)) {
        a.log(`the host runtime's entry could not be installed: ${String(err)}`)
        return { ready: false, did: 'nothing', incomplete }
      }
    }
  }

  return { ready: fs.exists(paths.exePath) && fs.exists(paths.entryPath), did, incomplete }
}

/**
 * Removes what this version will never use again: every other Node's directory, and every other app
 * version's build under this one.
 *
 * **A failure here is expected, not exceptional.** The directory most worth removing is an old
 * Node's, and that is precisely the one an old Host may still be running out of — Windows refuses to
 * delete a locked image. So each removal stands alone and a refusal is swallowed: the sweep is
 * self-healing, and the next launch after that Host exits finishes the job.
 */
export function sweepHostRuntime(a: {
  paths: HostRuntimePaths
  nodeVersion: string
  appVersion: string
  fs: RuntimeFs
  log(m: string): void
}): number {
  let removed = 0
  const drop = (p: string): void => {
    try {
      a.fs.rm(p)
      removed += 1
    } catch {
      /* still in use, or gone already — either way the next launch tries again */
    }
  }
  // Staging directories too: a copy killed between `copy` and `rename` leaves one behind, and
  // nothing else will ever look at it.
  for (const name of a.fs.readdir(a.paths.base)) {
    if (name.includes('.staging-')) drop(w.join(a.paths.base, name))
  }
  for (const name of staleNodeDirs(a.fs.readdir(a.paths.base), a.nodeVersion)) {
    drop(w.join(a.paths.base, name))
  }
  for (const name of staleBuildDirs(a.fs.readdir(a.paths.buildsDir), a.appVersion)) {
    drop(w.join(a.paths.buildsDir, name))
  }
  if (removed > 0) a.log(`swept ${removed} unused host runtime director${removed === 1 ? 'y' : 'ies'}`)
  return removed
}
