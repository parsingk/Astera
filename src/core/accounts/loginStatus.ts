// Login-status probes for accounts.
//
// The evidence differs per provider (claude = .credentials.json or macOS Keychain, codex = auth.json),
// and claude further splits by platform. This pulls that branching out of ProviderDescriptor and
// collects it here.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { claudeKeychainServicesFor, type KeychainHas } from './keychain'

/** Takes a configDir and answers whether it's logged in. Never throws. */
export type LoginProbe = (configDir: string) => Promise<boolean>

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** On Windows, removes an EMPTY folder at a login file's path before the probe looks (sandbox design §6). Codex's Windows
 *  sandbox makes a missing deny-read path a folder before it denies it (windows-sandbox-rs deny_read_acl.rs
 *  `apply_deny_read_acls`: "Missing paths are materialized as directories"; the same at rust-v0.160.0 and rust-v0.169.0).
 *  A session that started while the account was logged in keeps naming its login file, so after a logout its next
 *  command leaves an empty folder named `auth.json` or `.credentials.json`, which the probe would read as a login and
 *  which the CLI's next login could not write its file over. Only a real directory is removed (`lstat` first: a junction or
 *  symlink is not one Codex made, and `rmdir` on a link removes the link itself whatever its target holds), and `rmdir`
 *  removes only an empty one: a file, a link, a folder that holds something, or a path that is not there is left as it
 *  is, and it is never recursive. Never throws. Nothing happens off Windows. */
async function dropEmptyFolder(p: string, platform: NodeJS.Platform): Promise<void> {
  if (platform !== 'win32') return
  try {
    const st = await fs.lstat(p)
    if (st.isDirectory() && !st.isSymbolicLink()) await fs.rmdir(p)
  } catch {
    /* a file, a link, a folder with something in it, or nothing there: nothing to heal */
  }
}

/** Decides by the presence of a marker file inside configDir (codex, and claude on win32). On Windows an empty folder at
 *  the marker's path is removed first (dropEmptyFolder), so a logged-out account reads as logged out. */
export function fileMarkerProbe(marker: string, platform: NodeJS.Platform): LoginProbe {
  return async (configDir) => {
    const file = path.join(configDir, marker)
    await dropEmptyFolder(file, platform)
    return exists(file)
  }
}

/**
 * The claude probe.
 *
 * Order matters — **file first, Keychain second**. If the file exists it settles the login — with one
 * exception: a refresh token whose recorded expiry has passed. On darwin an expired file is not the
 * end (the Keychain may hold a live credential, so the probe falls through to it); off darwin an
 * expired file is logged out. A present, unexpired file settles it and the keychain isn't even asked.
 * Two reasons for file-first: (1) environments that write the file, via older claude versions or
 * CLAUDE_CODE-related settings, still exist, and (2) the keychain service-name convention isn't a
 * documented contract, just what was observed on one version, and will eventually drift. If it does
 * drift, the file path still being alive keeps the probe from failing outright.
 */
export function claudeLoginProbe(opts: {
  platform: NodeJS.Platform
  homeDir: string
  account: string
  keychainHas: KeychainHas
  now?: () => number
}): LoginProbe {
  return async (configDir) => {
    const credPath = path.join(configDir, '.credentials.json')
    await dropEmptyFolder(credPath, opts.platform)
    if (await exists(credPath)) {
      // The file's presence still settles a login, with one exception: a refresh token whose recorded
      // expiry has passed. The CLI writes `claudeAiOauth.refreshTokenExpiresAt` in ms; once it is behind
      // us the account cannot authenticate until `claude login`, yet the file it left is still on disk —
      // so `loginStatus`, the resume dialog's candidate list and a roll chain's targets would all keep
      // treating a dead account as live. Only a numeric, past value turns the answer over; a missing or
      // malformed field, or an unreadable file, keeps the presence-means-logged-in rule, because the one
      // fact we are acting on is the field itself and its absence is not evidence of expiry.
      const now = (opts.now ?? Date.now)()
      let expired = false
      try {
        const parsed = JSON.parse(await fs.readFile(credPath, 'utf8')) as {
          claudeAiOauth?: { refreshTokenExpiresAt?: unknown }
        }
        const exp = parsed.claudeAiOauth?.refreshTokenExpiresAt
        if (typeof exp === 'number' && exp <= now) expired = true
      } catch {
        /* unreadable or unparsable — fall through to "present means logged in" */
      }
      if (!expired) return true
      if (opts.platform !== 'darwin') return false
      // darwin: a dead file does not end it — the Keychain may hold a live credential (below)
    }
    if (opts.platform !== 'darwin') return false
    // The ambient-directory special case (no CLAUDE_CONFIG_DIR → no suffix in the keychain item) lives
    // in claudeKeychainServicesFor now — see its docstring in keychain.ts. rateLimitFetcher.ts's readAccessToken
    // needs the identical rule, so it was pulled out here rather than kept inline.
    const services = claudeKeychainServicesFor(configDir, opts.homeDir)
    for (const service of services) {
      try {
        if (await opts.keychainHas(service, opts.account)) return true
      } catch {
        return false // security itself is missing or dead — treat it as logged out
      }
    }
    return false
  }
}
