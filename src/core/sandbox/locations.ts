// The places a sandboxed session may not read (sandbox design §6): the sensitive locations of the credentials design's E6
// list, plus the OS credential stores a CLI's own sandbox does not close by itself. All paths come out absolute with forward
// slashes, the one form both CLIs' settings and the Codex profile take on every OS.
import { realpathSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'

const slashed = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** The E6 list. Windows keeps the GitHub CLI and gcloud under `APPDATA`; the other systems keep them under `~/.config`. */
export function sensitiveLocations(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string[] {
  const h = slashed(home)
  const roaming = slashed(env.APPDATA ?? '') || `${h}/AppData/Roaming`
  const gh = platform === 'win32' ? `${roaming}/GitHub CLI` : `${h}/.config/gh`
  const gcloud = platform === 'win32' ? `${roaming}/gcloud` : `${h}/.config/gcloud`
  return [`${h}/.ssh`, `${h}/.aws`, gh, gcloud, `${h}/.docker`, `${h}/.npmrc`, `${h}/.git-credentials`, `${h}/.kube`]
}

/** The app's key (`<profile>/host/app.key`, core/host/hostKey.ts appKeyPath): what lets a process be the app to the
 *  Host, which spawns any program for it and counts it as the person (sandbox follow-ups, item 1). The one file of the
 *  profile a sandboxed session may not read, on every OS. The Host key beside it is not named: the `astera` inside the
 *  session checks the loopback's proof with it. None when the file is not known. */
export function appKeyDenies(appKeyFile: string | null): string[] {
  return appKeyFile ? [slashed(appKeyFile)] : []
}

/** Astera's profile folder (`profileDir`: the app's userData, the Host's ASTERA_HOST_PROFILE_DIR), read-only in every
 *  sandboxed session, for both CLIs on every OS (Task E, 2026-10-28): what the app and the Host run outside any sandbox
 *  is kept there (the Host's scripts under `host`, the capture and Enforce hooks, the sessions' `.cmd` files,
 *  `audit-policy.json`, the settings files), so a session that wrote it could have its code run outside the sandbox. It
 *  matters where the session's folder holds the profile (a session started in the home folder or above it); anywhere
 *  else the profile is already outside what the sandbox lets a session write. Reads are not touched: the Host key in it
 *  stays readable, and the app key stays denied (appKeyDenies). The one list for every start and the S2 measurement
 *  (scripts/measure/s2.mjs). None when the folder is not known. */
export function profileReadOnly(profileDir: string | null): string[] {
  return profileDir ? [slashed(profileDir)] : []
}

/** electron-updater's download cache base (its `getAppCacheDir`, `dist/AppAdapter.js` at 6.8.9):
 *  `%LOCALAPPDATA%` on Windows, `~/Library/Caches` on macOS, `$XDG_CACHE_HOME` or `~/.cache` on Linux. */
function appCacheBase(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string {
  const h = slashed(home)
  if (platform === 'win32') return slashed(env.LOCALAPPDATA ?? '') || `${h}/AppData/Local`
  if (platform === 'darwin') return `${h}/Library/Caches`
  return slashed(env.XDG_CACHE_HOME ?? '') || `${h}/.cache`
}

/** electron-updater's download cache folder (Task E fix round 1): `<appCacheBase>/astera-updater`. The name is the
 *  app's sanitized name lowercased plus `-updater` (app-builder-lib `appInfo.ts` `updaterCacheDirName`), `astera` here.
 *  The installer run on update is its `pending` subfolder, and Astera unpacks a manual copy into `manual/<version>`
 *  (src/main/manualInstall.ts), so the whole folder is what a sandboxed session must not write. */
export const UPDATER_CACHE_DIR = 'astera-updater'
export function updaterCacheDir(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string {
  return `${appCacheBase(platform, env, home)}/${UPDATER_CACHE_DIR}`
}

/** The installed app's own folder, from its executable (`process.execPath`, the Host's `ASTERA_HOST_CLI_EXEC`): on
 *  Windows the executable's folder (a per-user install under `%LOCALAPPDATA%\Programs`; a machine-wide one is not the
 *  session's to write anyway), on macOS the enclosing `.app` bundle. On Linux the AppImage's own folder is the person's
 *  download folder, and the update is staged in the updater cache, not there, so none. None without an executable. */
export function installRootOf(appExe: string | null | undefined, platform: NodeJS.Platform): string | null {
  if (!appExe) return null
  const p = slashed(appExe)
  if (platform === 'win32') return p.replace(/\/[^/]*$/, '')
  if (platform === 'darwin') {
    const bundle = /^(.*\.app)(\/|$)/.exec(p)
    return bundle ? bundle[1] : p.replace(/\/[^/]*$/, '')
  }
  return null
}

/** Astera's own folder under `%LOCALAPPDATA%` on Windows (Task E fix round 2): `%LOCALAPPDATA%\astera`, literal
 *  `astera` (cliInstall.ts `binDirFor`). It holds the public CLI's `bin`, the `app` junction the session `.cmd` goes
 *  through (exec/shuttle.ts `cmdLinkPath`) and the installed app's `host-runtime` (core/host/runtime.ts), and nothing a
 *  sandboxed session writes, so it is read-only whole rather than child by child. None off Windows. */
export function localAsteraDir(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string | null {
  if (platform !== 'win32') return null
  const local = slashed(env.LOCALAPPDATA ?? '') || `${slashed(home)}/AppData/Local`
  return `${local}/astera`
}

/** The public CLI's own files on macOS and Linux (Task E fix round 2): the folder (`binDir`, cliInstall.ts `binDirFor`,
 *  `~/.local/bin`) is the person's PATH folder and keeps their own programs, so only the files Astera writes into it
 *  (`names`, exec/shuttle.ts `shuttleNames`) are named, and only those that `exists` says are there: a read-only path
 *  that is missing would have bubblewrap put a placeholder file at it, which an interrupted sandbox could leave on the
 *  person's PATH. None on Windows, where localAsteraDir names the whole folder. A look that throws counts as missing. */
export function publicShuttleFiles(o: { platform: NodeJS.Platform; binDir: string; names: readonly string[]; exists: (p: string) => boolean }): string[] {
  if (o.platform === 'win32') return []
  const dir = slashed(o.binDir)
  return o.names
    .map((n) => `${dir}/${n}`)
    .filter((p) => {
      try {
        return o.exists(p)
      } catch {
        return false
      }
    })
}

/** The whole list of paths a sandboxed session keeps read-only (Task E and its fix rounds 1 to 3): Astera's profile
 *  folder and every place Astera itself writes executable code or an installer to and later runs outside any sandbox —
 *  the Windows Host runtime (core/host/runtime.ts hostRuntimeBase), electron-updater's download cache, the installed
 *  app's own folder, Astera's own `%LOCALAPPDATA%\astera` on Windows (the public CLI and the session-`.cmd` junction),
 *  and on macOS and Linux the public CLI's own files. The one function every start path and the measurement build from,
 *  as for the profile; each caller passes what it knows (nulls dropped). Forward slashes, each once.
 *
 *  `resolve` (realPathOrNull at both wirings; fix round 3, re-review Minor 5) names each path where it really is, and
 *  drops one that is not there or cannot be looked at, on every OS. A missing read-only path is not harmless: while a
 *  sandboxed command runs, Codex and srt put an empty read-only file at it on the host to block its creation, so a
 *  missing `~/.cache/astera-updater` would make an update download fail then, and an interrupted sandbox could leave the
 *  file behind. A path through a linked folder (a dotfile manager's `~/.cache` or `~/.local`) is named at its target:
 *  Codex on Linux refuses every command when a read-only path crosses a writable symlink (linux-sandbox `bwrap.rs`
 *  at rust-v0.160.0), and Claude Code's deny rules match "either the requested path or the file it resolves to"
 *  (code.claude.com/docs/en/permissions, Symlinks), so the target keeps both. Without it (the measurement, whose
 *  profile is there), each path is named as given. */
export function sandboxReadOnly(o: {
  profileDir?: string | null
  hostRuntimeBase?: string | null
  updaterCache?: string | null
  installRoot?: string | null
  localAstera?: string | null
  publicShuttle?: readonly string[]
  resolve?: (p: string) => string | null
}): string[] {
  const named = [o.profileDir, o.hostRuntimeBase, o.updaterCache, o.installRoot, o.localAstera, ...(o.publicShuttle ?? [])]
    .filter((p): p is string => Boolean(p))
    .map(slashed)
  const resolve = o.resolve
  const all = resolve
    ? named
        .map((p) => {
          try {
            const real = resolve(p)
            return real ? slashed(real) : null
          } catch {
            return null
          }
        })
        .filter((p): p is string => p !== null)
    : named
  return [...new Set(all)]
}

/** A path's real location (every link on it followed, `realpathSync.native`), forward slashes; null when it is not there
 *  or cannot be looked at. What both wirings hand sandboxReadOnly, once, when the app or the Host starts. */
export function realPathOrNull(p: string): string | null {
  try {
    return slashed(realpathSync.native(p))
  } catch {
    return null
  }
}

/** A D-Bus address value with its `%xx` escapes decoded (the D-Bus specification, "Server Addresses": any byte may be
 *  escaped so, and a path holding a space or a non-ASCII letter is), so the path denied is the file's own (final fix pass,
 *  minor 8). Bytes, decoded as UTF-8. */
function dbusUnescape(value: string): string {
  if (!value.includes('%')) return value
  const bytes: number[] = []
  for (let i = 0; i < value.length; i++) {
    const hex = value[i] === '%' ? /^[0-9A-Fa-f]{2}$/.exec(value.slice(i + 1, i + 3)) : null
    if (hex) {
      bytes.push(parseInt(hex[0], 16))
      i += 2
    } else bytes.push(...Buffer.from(value[i], 'utf8'))
  }
  return Buffer.from(bytes).toString('utf8')
}

/** The session bus socket a Linux desktop's secret service listens on, or null when the environment names none. Only a
 *  filesystem socket can be denied; an abstract one (`unix:abstract=`) is not a path. */
export function busSocketOf(env: Record<string, string | undefined>): string | null {
  const address = env.DBUS_SESSION_BUS_ADDRESS
  if (address) {
    const m = /(?:^|;)unix:(?:[^;]*,)?path=([^,;]+)/.exec(address)
    return m ? dbusUnescape(m[1]) : null
  }
  const runtime = env.XDG_RUNTIME_DIR
  return runtime ? `${slashed(runtime)}/bus` : null
}

/** The folder the Host's socket is in (`hostAddress`'s `dirToPrepare`, macOS and Linux), which a sandboxed Codex session
 *  may not open, so it reaches the Host only through the loopback with its workload token (final fix pass, C2), and
 *  every other Host's folder found beside it (`others`, otherHostFolders: another profile's Host, such as the dev app's;
 *  final fix pass, part 2, B). Whole folders, not the socket files: the Host key the loopback's proof needs is kept in
 *  the profile folder (`<profile>/host/host.key`), not here, and the folder holds nothing else a session needs. macOS
 *  keeps `/var` and `/tmp` as links into `/private`, so a folder under either is named in both spellings. Each once.
 *  None on Windows, where the Host listens on a named pipe, or when `dir` is not known. */
export function hostSocketDenies(platform: NodeJS.Platform, dir: string | null, others: readonly string[] = []): string[] {
  if (platform === 'win32' || !dir) return []
  const spellings = (folder: string): string[] => {
    const d = slashed(folder)
    return platform === 'darwin' && /^\/(?:var|tmp)\//.test(d) ? [d, `/private${d}`] : [d]
  }
  return [...new Set([dir, ...others].flatMap(spellings))]
}

/** How every Host's socket folder is named (packages/client/src/address.ts hostAddress): `astera-host-<key>`, with
 *  `-v<protocol>` after it from protocol 2 on. */
const HOST_FOLDER = /^astera-host-/

/** Every other Host's socket folder in the folder this profile's (`dir`) is in that this user owns: each `astera-host-*`
 *  folder there but `dir` itself, such as the dev app's Host beside the installed app's, or an older protocol's (final
 *  fix pass, part 2, B). Only this user's (`lstat` uid equal to `uid`, part 3): Linux's `/tmp` is every user's, and
 *  another user's Host folder (mode 0700) is closed to this user anyway, so it is neither named nor lets anyone lengthen
 *  the command line; a folder that cannot be looked at (gone since the listing) is left out. With no uid to compare
 *  (a process without `getuid`), every Host folder is kept. A sandboxed Codex start reads this once, at its prepare, and
 *  its spawn denies what was there then (hostSocketDenies), so a Host started after that is not denied to the session.
 *  Absolute, forward slashes, sorted. None on Windows (named pipes), without `dir`, or when the folder cannot be listed.
 *  `uid` and `lstat` are test seams. */
export async function otherHostFolders(
  platform: NodeJS.Platform,
  dir: string | null,
  o: { uid?: number; lstat?: (p: string) => Promise<{ uid: number }> } = {}
): Promise<string[]> {
  if (platform === 'win32' || !dir) return []
  const own = slashed(dir)
  const cut = own.lastIndexOf('/')
  if (cut < 0) return []
  const parent = own.slice(0, cut)
  const name = own.slice(cut + 1)
  let folders: string[]
  try {
    const entries = await readdir(parent === '' ? '/' : parent, { withFileTypes: true })
    folders = entries
      .filter((e) => e.isDirectory() && HOST_FOLDER.test(e.name) && e.name !== name)
      .map((e) => `${parent}/${e.name}`)
      .sort()
  } catch {
    return []
  }
  const uid = 'uid' in o ? o.uid : process.getuid?.()
  if (uid === undefined) return folders
  const look = o.lstat ?? lstat
  const owners = await Promise.all(folders.map((f) => look(f).then((st) => st.uid, () => null)))
  return folders.filter((_, i) => owners[i] === uid)
}

/** What a sandbox cannot be trusted to keep closed: the macOS keychain folder and the Linux session bus socket (a process
 *  that reaches it can ask the secret service for any stored login). Windows has no file to name. */
export function credentialStoreDenies(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string[] {
  if (platform === 'darwin') return [`${slashed(home)}/Library/Keychains`]
  if (platform === 'linux') {
    const bus = busSocketOf(env)
    return bus ? [bus] : []
  }
  return []
}
