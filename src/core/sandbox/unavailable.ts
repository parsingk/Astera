// The error a session start throws when the CLI's own sandbox cannot be used. Callers match the prefix, so a session never
// starts quietly without the protection the profile asked for.
import type { Message } from '../i18n'

export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

export function sandboxUnavailable(code: string): Error {
  return new Error(`${SANDBOX_UNAVAILABLE}: ${code}`)
}

// The codes a start refuses with, wherever the error text was carried (the app's IPC wraps it, the Host's answer quotes
// it): `windows-setup codex <account>` (that account's Windows sandbox is not set up, windowsReadiness.ts),
// `codex-daemon codex`, `path-unsafe`, `git-layout`, `not-prepared`, and the version floor's `cli-too-old <cli> <found>
// <min>` (the Enforce check's shape, core/sessions/cliVersion.ts).
const REFUSAL =
  /SANDBOX_UNAVAILABLE:\s*(windows-setup|codex-daemon|path-unsafe|git-layout|not-prepared|cli-too-old)(?:\s+(claude|codex))?(?:\s+(\S+)(?:\s+(\S+))?)?/
const CLI_NAMES = { claude: 'Claude Code', codex: 'Codex' } as const

/** The account a `windows-setup` refusal names, for the setup the app offers; null for every other error. */
export function sandboxSetupAccountOf(raw: string): string | null {
  const m = REFUSAL.exec(raw)
  return m && m[1] === 'windows-setup' && m[3] ? m[3] : null
}

/** What a sandbox refusal says, in the catalog's words; null when `raw` is not one this build knows. Read by the app's
 *  toast (renderer/src/lib/spawnErrors.ts) and by a roll that is refused (core/rolling/codexCoordinator.ts). */
export function sandboxRefusalMessage(raw: string): Message | null {
  const m = REFUSAL.exec(raw)
  if (!m) return null
  switch (m[1]) {
    case 'windows-setup':
      return { key: 'session.spawn.sandbox.windowsSetup', params: { accountId: m[3] ?? '' } }
    case 'codex-daemon':
      return { key: 'session.spawn.sandbox.codexDaemon' }
    case 'path-unsafe':
      return { key: 'session.spawn.sandbox.pathUnsafe' }
    case 'git-layout':
      return { key: 'session.spawn.sandbox.gitLayout' }
    case 'not-prepared':
      return { key: 'session.spawn.sandbox.notPrepared' }
    default:
      return {
        key: 'session.spawn.sandbox.cliTooOld',
        params: { cli: CLI_NAMES[(m[2] ?? 'claude') as keyof typeof CLI_NAMES], found: m[3] ?? '', min: m[4] ?? '' }
      }
  }
}
