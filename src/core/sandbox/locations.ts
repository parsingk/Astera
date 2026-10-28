// The places a sandboxed session may not read (sandbox design §6): the sensitive locations of the credentials design's E6
// list, plus the OS credential stores a CLI's own sandbox does not close by itself. All paths come out absolute with forward
// slashes, the one form both CLIs' settings and the Codex profile take on every OS.
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
