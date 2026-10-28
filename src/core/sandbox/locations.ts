// The places a sandboxed session may not read (sandbox design §6): the sensitive locations of the credentials design's E6
// list, plus the OS credential stores a CLI's own sandbox does not close by itself. All paths come out absolute with forward
// slashes, the one form both CLIs' settings and the Codex profile take on every OS.
const slashed = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** The E6 list. Windows keeps the GitHub CLI and gcloud under `APPDATA`; the other systems keep them under `~/.config`. */
export function sensitiveLocations(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string[] {
  const h = slashed(home)
  const roaming = slashed(env.APPDATA ?? '') || `${h}/AppData/Roaming`
  const gh = platform === 'win32' ? `${roaming}/GitHub CLI` : `${h}/.config/gh`
  const gcloud = platform === 'win32' ? `${roaming}/gcloud` : `${h}/.config/gcloud`
  return [`${h}/.ssh`, `${h}/.aws`, gh, gcloud, `${h}/.docker`, `${h}/.npmrc`, `${h}/.git-credentials`, `${h}/.kube`]
}

/** The session bus socket a Linux desktop's secret service listens on, or null when the environment names none. Only a
 *  filesystem socket can be denied; an abstract one (`unix:abstract=`) is not a path. */
export function busSocketOf(env: Record<string, string | undefined>): string | null {
  const address = env.DBUS_SESSION_BUS_ADDRESS
  if (address) {
    const m = /(?:^|;)unix:(?:[^;]*,)?path=([^,;]+)/.exec(address)
    return m ? m[1] : null
  }
  const runtime = env.XDG_RUNTIME_DIR
  return runtime ? `${slashed(runtime)}/bus` : null
}

/** The folder the Host's socket is in (`hostAddress`'s `dirToPrepare`, macOS and Linux), which a sandboxed Codex session
 *  may not open, so it reaches the Host only through the loopback with its workload token (final fix pass, C2). The
 *  whole folder, not the socket file: the Host key the loopback's proof needs is kept in the profile folder
 *  (`<profile>/host/host.key`), not here, and the folder holds nothing else a session needs. macOS keeps `/var` and `/tmp`
 *  as links into `/private`, so a folder under either is named in both spellings. None on Windows, where the Host
 *  listens on a named pipe, or when `dir` is not known. */
export function hostSocketDenies(platform: NodeJS.Platform, dir: string | null): string[] {
  if (platform === 'win32' || !dir) return []
  const d = slashed(dir)
  return platform === 'darwin' && /^\/(?:var|tmp)\//.test(d) ? [d, `/private${d}`] : [d]
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
