// The error a session start throws when the CLI's own sandbox cannot be used. Callers match the prefix, so a session never
// starts quietly without the protection the profile asked for.
import type { Message } from '../i18n'
import { sandboxKindOf } from './coverage'

export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

export function sandboxUnavailable(code: string): Error {
  return new Error(`${SANDBOX_UNAVAILABLE}: ${code}`)
}

/** A session a sandboxed session starts, its Job's coordinator, a worker of its work, must run in its CLI's sandbox (final
 *  fix pass, C3): where that CLI has none, Claude Code on Windows with deny rules only, it is refused rather than started
 *  without one (`no-sandbox <cli>`). Null where the sandbox runs. */
export function forcedSandboxBlocker(provider: 'claude' | 'codex', platform: string): Error | null {
  return sandboxKindOf(provider, platform) === 'deny-only' ? sandboxUnavailable(`no-sandbox ${provider}`) : null
}

// The codes a start refuses with, wherever the error text was carried (the app's IPC wraps it, the Host's answer quotes
// it, JSON may close it): `windows-setup codex <account>` (that account's Windows sandbox is not set up,
// windowsReadiness.ts), `windows-check-failed codex <account>` (Codex could not be asked about it), `codex-daemon codex`,
// `path-unsafe` (the work folder's repository), `named-path-unsafe` (another path the sandbox names: Astera's own
// folders, a login folder; Task E fix round 3), `linked-path` (a named path through a link the session could change,
// where nothing else refuses it; fix round 5), `git-layout`, `not-prepared`, `settings-write-failed` (Claude's sandbox
// settings, claudeStart.ts), `no-sandbox <cli>` (forcedSandboxBlocker), `command-too-long` (a Windows command line the
// profile overflows,
// prepared.ts fitsOnTheLine), `profile-not-active codex` (a sandboxed chat's thread that does not run
// under the Astera profile, codexAdapter.ts), `outside-sandbox <session|job|task|command> <id>` (a sandboxed session handing work
// to something outside its sandbox, the command layer's, final fix pass part 2), and the
// version floor's `cli-too-old <cli> <found> <min>`, `cli-version-unknown <cli>` and `cli-missing <cli>` (the Enforce
// check's shape, core/sessions/cliVersion.ts), and for a sandboxed Task's check under Claude's sandbox (Task K)
// `runtime-missing claude` (srt cannot run a command here) and `userns-restricted claude` (Ubuntu's AppArmor profile
// confines bubblewrap, so every command would fail), and `no-check-runner` (a process without the runner a sandboxed check
// runs through, fix round 2). Versions take dots; an account id is `[\w-]+` only, so a quote, a brace or a full stop after
// it is not read as part of it.
const REFUSAL =
  /SANDBOX_UNAVAILABLE:\s*(windows-setup|windows-check-failed|codex-daemon|path-unsafe|named-path-unsafe|linked-path|git-layout|not-prepared|settings-write-failed|no-sandbox|profile-not-active|command-too-long|outside-sandbox|cli-too-old|cli-version-unknown|cli-missing|runtime-missing|userns-restricted|no-check-runner)(?:\s+(claude|codex))?(?:\s+([\w.-]+)(?:\s+([\w.-]+))?)?/
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
    case 'named-path-unsafe':
      return { key: 'session.spawn.sandbox.namedPathUnsafe' }
    case 'linked-path':
      return { key: 'session.spawn.sandbox.linkedPath' }
    case 'git-layout':
      return { key: 'session.spawn.sandbox.gitLayout' }
    case 'not-prepared':
      return { key: 'session.spawn.sandbox.notPrepared' }
    case 'settings-write-failed':
      return { key: 'session.spawn.sandbox.settingsWriteFailed' }
    case 'cli-version-unknown':
      return { key: 'session.spawn.sandbox.cliVersionUnknown', params: { cli: CLI_NAMES[(m[2] ?? 'claude') as keyof typeof CLI_NAMES] } }
    case 'cli-missing':
      return { key: 'session.spawn.sandbox.cliMissing', params: { cli: CLI_NAMES[(m[2] ?? 'claude') as keyof typeof CLI_NAMES] } }
    case 'command-too-long':
      return { key: 'session.spawn.sandbox.commandTooLong' }
    case 'profile-not-active':
      return { key: 'session.spawn.sandbox.profileNotActive' }
    case 'no-sandbox':
      return { key: 'session.spawn.sandbox.noSandbox', params: { cli: CLI_NAMES[(m[2] ?? 'claude') as keyof typeof CLI_NAMES] } }
    case 'runtime-missing':
      return { key: 'session.spawn.sandbox.runtimeMissing', params: { cli: CLI_NAMES[(m[2] ?? 'claude') as keyof typeof CLI_NAMES] } }
    case 'userns-restricted':
      return { key: 'session.spawn.sandbox.usernsRestricted', params: { cli: CLI_NAMES[(m[2] ?? 'claude') as keyof typeof CLI_NAMES] } }
    // Only a check meets it: its words are the check's (checkRefusalMessage)
    case 'no-check-runner':
      return { key: 'jobs.checks.sandbox.cannot' }
    // `outside-sandbox <session|job|task> <id>`: the words name it by its id
    case 'outside-sandbox':
      return { key: 'session.spawn.sandbox.outsideSandbox', params: { id: accountIdIn(m[4]) ?? '' } }
    default:
      return {
        key: 'session.spawn.sandbox.cliTooOld',
        params: { cli: CLI_NAMES[(m[2] ?? 'claude') as keyof typeof CLI_NAMES], found: m[3] ?? '', min: m[4] ?? '' }
      }
  }
}

/**
 * What a refusal says on a Task check's question (Task K fix round 2): the check-unavailable question, whose answers are
 * run the checks again, go on without this check, or mark the Task failed. A start's words name a Set up button and a
 * session that question does not have, so each refusal a check can meet (SessionManager.checkLaunch and the prepares it
 * runs) is said in a check's words, with what the person can do and where: the Set up beside the account under a
 * sandboxed profile in Settings › Agent profiles, an update, an install, or that running again will not help. `nameOf`
 * gives an account's display name (the refusal carries its id; the id when none). A refusal no check meets keeps a
 * start's words; null when `raw` is not a refusal.
 */
export function checkRefusalMessage(raw: string, nameOf: (accountId: string) => string | null): Message | null {
  const m = REFUSAL.exec(raw)
  if (!m) return null
  const cli = CLI_NAMES[(m[2] ?? 'claude') as keyof typeof CLI_NAMES]
  const account = (): string => {
    const id = accountIdIn(m[3]) ?? ''
    return nameOf(id) ?? id
  }
  switch (m[1]) {
    case 'windows-setup':
      return { key: 'jobs.checks.sandbox.windowsSetup', params: { account: account() } }
    case 'windows-check-failed':
      return { key: 'jobs.checks.sandbox.windowsCheckFailed', params: { account: account() } }
    case 'cli-too-old':
      return { key: 'jobs.checks.sandbox.cliTooOld', params: { cli, found: m[3] ?? '', min: m[4] ?? '' } }
    case 'cli-version-unknown':
      return { key: 'jobs.checks.sandbox.cliVersionUnknown', params: { cli } }
    case 'cli-missing':
      return { key: 'jobs.checks.sandbox.cliMissing', params: { cli } }
    case 'path-unsafe':
      return { key: 'jobs.checks.sandbox.pathUnsafe' }
    case 'named-path-unsafe':
      return { key: 'jobs.checks.sandbox.namedPathUnsafe' }
    case 'linked-path':
      return { key: 'jobs.checks.sandbox.linkedPath' }
    case 'git-layout':
      return { key: 'jobs.checks.sandbox.gitLayout' }
    case 'not-prepared':
      return { key: 'jobs.checks.sandbox.notPrepared' }
    case 'command-too-long':
      return { key: 'jobs.checks.sandbox.commandTooLong' }
    case 'settings-write-failed':
      return { key: 'jobs.checks.sandbox.settingsWriteFailed' }
    case 'no-sandbox':
      return { key: 'jobs.checks.sandbox.noSandbox', params: { cli } }
    case 'runtime-missing':
      return { key: 'jobs.checks.sandbox.runtimeMissing', params: { cli } }
    case 'userns-restricted':
      return { key: 'jobs.checks.sandbox.usernsRestricted', params: { cli } }
    case 'no-check-runner':
      return { key: 'jobs.checks.sandbox.cannot' }
    default:
      return sandboxRefusalMessage(raw)
  }
}

/** What a refused roll says in the session's tab (Task 6 fix round 1): for an account whose Windows sandbox is not set
 *  up, which account it is, by `nameOf` its display name (the refusal carries its id), and where to set it up; for one
 *  Codex could not be asked about, which account it is; for any other sandbox refusal, the start's own sentence. Null
 *  when `raw` is not a sandbox refusal. */
export function rollRefusalMessage(raw: string, nameOf: (accountId: string) => string | null): Message | null {
  const accountId = sandboxSetupAccountOf(raw)
  if (accountId !== null) return { key: 'session.roll.sandbox.windowsSetup', params: { account: nameOf(accountId) ?? accountId } }
  // An account Codex could not be asked about is named too, as above, since "this account" is ambiguous in a roll's tab
  // (final fix pass, minor 14); no setup is offered for it
  const m = REFUSAL.exec(raw)
  const unasked = m && m[1] === 'windows-check-failed' ? accountIdIn(m[3]) : null
  if (unasked !== null) return { key: 'session.roll.sandbox.windowsCheckFailed', params: { account: nameOf(unasked) ?? unasked } }
  return sandboxRefusalMessage(raw)
}
