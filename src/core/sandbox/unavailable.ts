// The error a session start throws when the CLI's own sandbox cannot be used. Callers match the prefix, so a session never
// starts quietly without the protection the profile asked for.
import type { Message } from '../i18n'

export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

export function sandboxUnavailable(code: string): Error {
  return new Error(`${SANDBOX_UNAVAILABLE}: ${code}`)
}

// The codes a start refuses with, wherever the error text was carried (the app's IPC wraps it, the Host's answer quotes
// it, JSON may close it): `windows-setup codex <account>` (that account's Windows sandbox is not set up,
// windowsReadiness.ts), `windows-check-failed codex <account>` (Codex could not be asked about it), `codex-daemon codex`,
// `path-unsafe`, `git-layout`, `not-prepared`, and the version floor's `cli-too-old <cli> <found> <min>` (the Enforce
// check's shape, core/sessions/cliVersion.ts). Versions take dots; an account id is `[\w-]+` only, so a quote, a brace or
// a full stop after it is not read as part of it.
const REFUSAL =
  /SANDBOX_UNAVAILABLE:\s*(windows-setup|windows-check-failed|codex-daemon|path-unsafe|git-layout|not-prepared|cli-too-old)(?:\s+(claude|codex))?(?:\s+([\w.-]+)(?:\s+([\w.-]+))?)?/
const CLI_NAMES = { claude: 'Claude Code', codex: 'Codex' } as const
const accountIdIn = (s: string | undefined): string | null => (s ? (/^[\w-]+/.exec(s)?.[0] ?? null) : null)

/** The account a `windows-setup` refusal names, for the setup the app offers and the roll's line; null for every other
 *  error, `windows-check-failed` included (setting up would not help there). */
export function sandboxSetupAccountOf(raw: string): string | null {
  const m = REFUSAL.exec(raw)
  return m && m[1] === 'windows-setup' ? accountIdIn(m[3]) : null
}

/** What a sandbox refusal says at a start, in the catalog's words; null when `raw` is not one this build knows. Read by
 *  the app's toast (renderer/src/lib/spawnErrors.ts) and by a refused roll for every code but `windows-setup`, which a
 *  roll words itself (rollRefusalMessage). */
export function sandboxRefusalMessage(raw: string): Message | null {
  const m = REFUSAL.exec(raw)
  if (!m) return null
  switch (m[1]) {
    case 'windows-setup':
      return { key: 'session.spawn.sandbox.windowsSetup', params: { accountId: accountIdIn(m[3]) ?? '' } }
    case 'windows-check-failed':
      return { key: 'session.spawn.sandbox.windowsCheckFailed' }
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

/** What a refused roll says in the session's tab (Task 6 fix round 1): for an account whose Windows sandbox is not set
 *  up, which account it is, by `nameOf` its display name (the refusal carries its id), and where to set it up; for any
 *  other sandbox refusal, the start's own sentence. Null when `raw` is not a sandbox refusal. */
export function rollRefusalMessage(raw: string, nameOf: (accountId: string) => string | null): Message | null {
  const accountId = sandboxSetupAccountOf(raw)
  if (accountId !== null) return { key: 'session.roll.sandbox.windowsSetup', params: { account: nameOf(accountId) ?? accountId } }
  return sandboxRefusalMessage(raw)
}
