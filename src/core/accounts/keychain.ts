// Looks up Claude Code credentials held in the macOS Keychain.
//
// **Why this is needed:** on macOS, Claude Code doesn't put its OAuth credentials in configDir's
// .credentials.json — it puts them in the login keychain. A probe that only checks for the file
// always reads "logged out" on macOS, and then defaultAccountIdOf (accounts/defaultAccount.ts) and
// resumeAccountOptions (resume.ts) can't pick a candidate, which kills rolling and resume outright.
//
// **Service-name convention (measured):** the form read off an installed claude 2.1.224 binary is
//   `Claude Code${OAUTH_FILE_SUFFIX}-credentials${suffix}`
// - OAUTH_FILE_SUFFIX is an empty string on the official release (confirmed the actual keychain
//   entry is exactly "Claude Code-credentials").
// - suffix is '' when CLAUDE_CONFIG_DIR is unset, otherwise `-${sha256(configDir.normalize('NFC')).hex[0..8]}`.
// - There is also an override env var, CLAUDE_SECURESTORAGE_CONFIG_DIR, but this app never sets it,
//   so it isn't handled here.
// - account is $USER (falling back to os.userInfo().username), or 'claude-code-user' if that fails
//   to match /^[a-zA-Z0-9._-]+$/.
//
// This is not a documented contract — it's a convention observed on one version. If the value
// changes, the probe silently drifts to "logged out" — which is why claudeLoginProbe checks the
// file marker **first** and only asks the keychain after.
import { createHash } from 'node:crypto'
import path from 'node:path'

const SERVICE_BASE = 'Claude Code-credentials'

/** The username convention claude puts in the account field */
const VALID_ACCOUNT = /^[a-zA-Z0-9._-]+$/

export function keychainAccount(env: { USER?: string }, fallbackUser: string): string {
  const name = env.USER || fallbackUser
  return VALID_ACCOUNT.test(name) ? name : 'claude-code-user'
}

const digest = (dir: string): string =>
  createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)

/**
 * Candidate Keychain service names for this configDir.
 *
 * configDir === null means "the default account, which doesn't set CLAUDE_CONFIG_DIR", and yields
 * exactly one unsuffixed name.
 *
 * **Why isolated accounts get more than one candidate:** it isn't settled whether the hash input is
 * the raw env var value or the resolved absolute path. Trying both costs one extra `security` call;
 * getting it wrong costs a login that looks like it's not there at all — a much worse trade.
 */
export function claudeKeychainServices(configDir: string | null): string[] {
  if (configDir === null) return [SERVICE_BASE]
  const seen = new Set<string>()
  for (const variant of [configDir, path.resolve(configDir)]) {
    seen.add(`${SERVICE_BASE}-${digest(variant)}`)
  }
  return [...seen]
}

export type KeychainHas = (service: string, account: string) => Promise<boolean>

/**
 * Confirms only that the entry exists, via security(1).
 *
 * **Not passing -w is the whole point.** -w reads the password body, which pops a keychain-access
 * approval dialog for this app. This existence-only form doesn't touch the ACL, so it finishes quietly.
 */
export function makeSecurityKeychainHas(
  run: (file: string, args: string[]) => Promise<number>
): KeychainHas {
  return async (service, account) => {
    try {
      return (await run('security', ['find-generic-password', '-a', account, '-s', service])) === 0
    } catch {
      return false
    }
  }
}
