// Where the Host's own executable would live, on win32
// (docs/superpowers/specs/2026-09-14-host-runtime-design.md).
//
// **Split out of `src/main/host/runtime.ts`.** That file's other half — `prepareHostRuntime`, the
// 87MB of copying that puts a runtime in place — stays in main; the app is the only thing that ever
// lays one down. This half is pure path arithmetic, arguments in and a path out with no filesystem
// access, which is exactly what `astera host start` (src/cli/host.ts) needs: it has to find a
// prepared runtime, never to create one.
//
// Paths are built with `path.win32` rather than `path`, for the reason `address.ts` gives for the
// same choice: these tests run on windows, macos and ubuntu, and on win32 `path.win32` *is* `path`,
// so the tests read the same everywhere.
import { win32 as w } from 'node:path'

/** The directory name that carries the Node version, so a runtime built for one Node is never handed
 *  to another. Everything under one of these was copied together and belongs together.
 *
 *  Exported so `../../main/host/runtime.ts`'s `staleNodeDirs` filters by the same prefix — one
 *  literal, not two that could drift apart. */
export const NODE_PREFIX = 'node-'

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
