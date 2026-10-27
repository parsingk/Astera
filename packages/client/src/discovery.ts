// How a tool outside the app finds this machine's Astera Host (public CLI design §4): the `astera` CLI's rule, and
// now @astera-app/client's. One profile folder gives both the Host's address and its files.
//
// **Pure**: the platform and the environment arrive as arguments. The answer has to be right on three operating
// systems and a test runs on one, which is why address.ts has the same shape.
import { hostAddress } from './address.js'
import { HOST_PROTOCOL } from './protocol.js'

/**
 * One separator, the platform's own.
 *
 * **Mixed ones work** (Windows takes both). The reason is people: these paths go into settings screens and error
 * messages as they are, and a path with mixed separators looks broken, more so when it is meant to be copied.
 */
export const nativePath = (p: string, platform: NodeJS.Platform): string =>
  platform === 'win32' ? p.replace(/\//g, '\\') : p

/** The app's profile folder (Electron's userData): `astera`, or `astera-dev` for a dev build (src/main/index.ts). */
export function userDataDir(a: {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  home: string
  dev?: boolean
}): string {
  const name = a.dev === true ? 'astera-dev' : 'astera'
  if (a.platform === 'win32') {
    const appData = a.env.APPDATA ?? `${a.home}/AppData/Roaming`
    return nativePath(`${appData.replace(/[\\/]+$/, '')}/${name}`, 'win32')
  }
  if (a.platform === 'darwin') return `${a.home}/Library/Application Support/${name}`
  const xdg = a.env.XDG_CONFIG_HOME
  return `${(xdg && xdg.length > 0 ? xdg : `${a.home}/.config`).replace(/[\\/]+$/, '')}/${name}`
}

/**
 * A profile folder spelled the way the Host spells its own: the platform's separators and no trailing one.
 *
 * The Host's address is the sha256 of this string (address.ts), so `C:\astera-dev\` and `C:\astera-dev`, the same
 * folder, would be two Hosts. What senders put here is already native and has no trailing separator, so this
 * changes no address that exists today; it rescues only what a person typed.
 *
 * **A root keeps its separator**: `C:\` made `C:` means the drive's current folder on win32, and `/` made `` is
 * nothing. **What a separator is depends on the platform**: on posix a backslash is an ordinary file name
 * character, so `/home/me/dir\` and `/home/me/dir` are two folders. **Nothing stripped, nothing added**: a bare
 * `C:` stays `C:`, not `C::`. **Case is left alone**: win32 paths ignore it, but folding it would change every
 * address that exists today, which is exactly what the two rules above are safe from.
 */
export function profilePath(given: string, platform: NodeJS.Platform): string {
  const p = nativePath(given, platform)
  const stripped = p.replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '')
  if (stripped === p) return p
  if (stripped === '') return p.slice(0, 1)
  if (/^[A-Za-z]:$/.test(stripped)) return stripped + p.slice(stripped.length, stripped.length + 1)
  return stripped
}

/**
 * The Host this run talks to: its address and the profile folder it uses.
 *
 * **The profile comes first.** A session the app started carries the app's profile folder (`ASTERA_PROFILE_DIR`);
 * without it (a person's own shell, an application using the SDK) it is the installed app's, or the dev app's
 * with `ASTERA_PROFILE=dev`. A folder rather than an address, because the files that go with a Host live in the
 * folder and an address does not say which folder.
 *
 * **`ASTERA_HOST` wins the address only**: it points at one particular Host by hand, and still says nothing about
 * which profile that Host uses. An empty variable counts as unset.
 *
 * **`ASTERA_SANDBOX_HOST` comes next**: Astera sets it in a sandboxed Claude Code session on macOS, whose sandbox lets it
 * reach that one socket while giving it a `$TMPDIR` the derived address would not match. Astera clears it from every
 * session and Host it starts, so it never outlives the session it was set for, and a person's `ASTERA_HOST` still wins.
 */
export function hostTarget(a: {
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  home: string
  tmpDir: string
}): { address: string; profileDir: string } {
  const given = a.env.ASTERA_PROFILE_DIR
  const profileDir =
    given !== undefined && given.length > 0
      ? profilePath(given, a.platform)
      : userDataDir({ platform: a.platform, env: a.env, home: a.home, dev: a.env.ASTERA_PROFILE === 'dev' })
  const explicit = a.env.ASTERA_HOST
  if (explicit !== undefined && explicit.length > 0) return { address: explicit, profileDir }
  const sandboxed = a.env.ASTERA_SANDBOX_HOST
  if (sandboxed !== undefined && sandboxed.length > 0) return { address: sandboxed, profileDir }
  return { address: hostAddress({ profileDir, platform: a.platform, tmpDir: a.tmpDir, protocol: HOST_PROTOCOL }).address, profileDir }
}
