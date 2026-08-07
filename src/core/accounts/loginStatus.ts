// Login-status probes for accounts.
//
// The evidence differs per provider (claude = .credentials.json or macOS Keychain, codex = auth.json),
// and claude further splits by platform. This pulls that branching out of ProviderDescriptor and
// collects it here.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { claudeKeychainServices, type KeychainHas } from './keychain'

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

/** Decides by the presence of a marker file inside configDir (codex, and claude on win32). */
export function fileMarkerProbe(marker: string): LoginProbe {
  return (configDir) => exists(path.join(configDir, marker))
}

/**
 * The claude probe.
 *
 * Order matters — **file first, Keychain second**. If the file exists, that settles it and the
 * keychain isn't even asked. Two reasons: (1) environments that write the file, via older claude
 * versions or CLAUDE_CODE-related settings, still exist, and (2) the keychain service-name
 * convention isn't a documented contract, just what was observed on one version, and will eventually
 * drift. If it does drift, the file path still being alive keeps the probe from failing outright.
 */
export function claudeLoginProbe(opts: {
  platform: NodeJS.Platform
  homeDir: string
  account: string
  keychainHas: KeychainHas
}): LoginProbe {
  const fileProbe = fileMarkerProbe('.credentials.json')
  return async (configDir) => {
    if (await fileProbe(configDir)) return true
    if (opts.platform !== 'darwin') return false
    // A session running against the default home directory (~/.claude) doesn't set CLAUDE_CONFIG_DIR
    // (the isAmbientDir rule in sessions/manager.ts:154). So the keychain entry has no suffix either.
    const ambient = path.resolve(configDir) === path.resolve(path.join(opts.homeDir, '.claude'))
    const services = claudeKeychainServices(ambient ? null : configDir)
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
