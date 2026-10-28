// What a sandboxed Codex start does before its spawn (sandbox design §6), for both session managers: the terminal one
// (core/sessions/manager.ts) and the chat one (core/chat/manager.ts). Their spawns are synchronous and cannot read git
// safely (an offline drive would freeze the thread), so the folder's git layout is read here, off the thread, and kept
// for the spawn. A roll prepares a chat chain's respawn through the terminal manager's prepare, as it refreshes the
// capability cache both managers read, so the two managers of a process hold one PreparedLayouts.
import { ensureGitFiles, ensureWorktreeConfigFiles, gitLayoutOf, type GitLayout } from './gitLayout'
import { credentialStoreDenies, hostSocketDenies, sensitiveLocations } from './locations'
import { codexSandboxArgs } from './codexProfile'
import { SANDBOX_UNAVAILABLE, sandboxUnavailable } from './unavailable'
import type { Readiness } from './windowsReadiness'
import { LAUNCH_FORBIDDEN } from '../sessions/commands'
import { fitsWindowsCommandLine } from '../sessions/windowsExecutable'
import { ENFORCE_MIN, atLeast, type CliVersionProbe } from '../sessions/cliVersion'

/** A sandboxed Codex start's command on Windows must fit what Windows carries (final fix pass, minor 4): its profile names
 *  every worktree's git files, and with enough worktrees the line passes cmd.exe's 8191 characters (CreateProcess's 32767
 *  for codex.exe). Refused (`command-too-long`) rather than launched broken. Nothing to check elsewhere. */
export function fitsOnTheLine(platform: NodeJS.Platform, cmd: { file: string; args: string[] | string }): void {
  if (platform !== 'win32' || typeof cmd.args === 'string') return
  if (!fitsWindowsCommandLine(cmd.file, cmd.args)) throw sandboxUnavailable('command-too-long')
}

/** The codex version question a sandboxed Codex start asks (cliVersion.ts's probe, shared with Enforce's check). */
export type CodexVersionProbe = Pick<CliVersionProbe, 'warm'> & ((cli: 'codex') => string | null | undefined)

/** Why a sandboxed Codex cannot start, or null (final review I2): older than the codex its sandbox was measured on
 *  (ENFORCE_MIN.codex, the plan's floor), or a codex whose version is not known or that is not there, either of which
 *  could ignore the permission profile and run under whatever its own config.toml says (E5). The CLI's words for each
 *  are the version check's codes, as a sandboxed Claude start's are (claudeStart.ts claudeSandboxBlocker). */
export function codexSandboxBlocker(version: string | null | undefined): string | null {
  if (version === undefined) return `${SANDBOX_UNAVAILABLE}: cli-missing codex`
  if (version === null) return `${SANDBOX_UNAVAILABLE}: cli-version-unknown codex`
  return atLeast(version, ENFORCE_MIN.codex) ? null : `${SANDBOX_UNAVAILABLE}: cli-too-old codex ${version} ${ENFORCE_MIN.codex}`
}

/** codexSandboxBlocker over a probe; a process with none cannot tell, and refuses as for a version not known. */
export const codexVersionBlocker = (probe: CodexVersionProbe | undefined): string | null => codexSandboxBlocker(probe ? probe('codex') : null)

/** How long a prepared layout is trusted by the spawn after it: a roll prepares before its kill and spawns right after,
 *  so a minute is plenty (the confirmed folder's own bound, core/sessions/manager.ts). */
export const PREPARED_MS = 60_000

/** Whether an account's Codex home has its Windows sandbox set up (windowsReadiness.ts), asked with the environment the
 *  session would start with; `log` says which way Codex could not be asked, when it could not. */
export type CodexWindowsReady = (a: { codexHome: string | null; env: Record<string, string | undefined>; log?: (m: string) => void }) => Promise<Readiness>

/** The layouts sandboxed prepares read, by account and folder: readiness is the account's, so one account's prepare never
 *  lets another account's spawn through in the same folder. */
export class PreparedLayouts {
  private entries = new Map<string, { layout: GitLayout | null; at: number }>()

  keep(accountId: string, cwd: string, layout: GitLayout | null, now: number): void {
    for (const [k, v] of this.entries) if (now - v.at >= PREPARED_MS) this.entries.delete(k)
    this.entries.set(keyOf(accountId, cwd), { layout, at: now })
  }

  /** The layout a prepare kept for this account and folder within PREPARED_MS (null outside a repository), or undefined
   *  when there is none: the spawn then refuses with `not-prepared`. */
  layoutOf(accountId: string, cwd: string, now: number): GitLayout | null | undefined {
    const e = this.entries.get(keyOf(accountId, cwd))
    return e && now - e.at < PREPARED_MS ? e.layout : undefined
  }
}

const keyOf = (accountId: string, cwd: string): string => `${accountId}\u0000${cwd}`

/** A sandboxed Codex session's `-a never` and permission profile: its repository's git directories writable, the E6
 *  list and the OS credential store denied, read from the session's own environment and home, and on macOS and Linux
 *  the folder the Host's socket is in (`hostSocketDir`, hostSocketDenies). On Windows the launch goes through cmd.exe,
 *  which would break on a path holding one of its characters, so such a start is refused instead of launched broken
 *  (Review Focus 2). */
export function sessionSandboxArgs(o: {
  platform: NodeJS.Platform
  homeDir: string
  layout: GitLayout | null
  env: Record<string, string | undefined>
  hostSocketDir?: string | null
}): string[] {
  const { platform, homeDir, layout, env } = o
  const denied = [...sensitiveLocations(platform, env, homeDir), ...credentialStoreDenies(platform, env, homeDir), ...hostSocketDenies(platform, o.hostSocketDir ?? null)]
  if (platform === 'win32') {
    const named = [...(layout ? [layout.top, layout.gitDir, layout.commonDir, ...layout.worktreeConfigs] : []), ...denied]
    if (named.some((p) => LAUNCH_FORBIDDEN.test(p))) throw sandboxUnavailable('path-unsafe')
  }
  return codexSandboxArgs({ platform, layout, denied })
}

/**
 * Reads the folder's git layout for a sandboxed spawn and checks what the spawn would refuse, before anything is written:
 * a codex older than the sandbox's floor or of a version not known (codexSandboxBlocker), a path cmd.exe cannot carry, whatever `check` asks of the arguments (the terminal's codex without `--no-daemon`), and on
 * Windows whether the account's Codex home is set up (`windows-setup codex <account>`, which the app offers to set up, or
 * `windows-check-failed codex <account>` when Codex could not be asked).
 * A roll awaits this before it kills the session it replaces, and the spawn after the kill can only throw. Then, on
 * every OS, the missing git files that decide where git reads its config and hooks from are made (ensureGitFiles: a
 * `commondir` holding `.`, an empty `modules`), since a read entry holds only for a path that exists (final fix pass,
 * C1); and on Windows only, every `config.worktree` git may read is made first: the profile keeps them read-only, but
 * Codex's Windows sandbox creates one that is missing, and git would read a `core.hooksPath` from it (gitLayout.ts); on
 * macOS and Linux a read entry already keeps a missing one from being created. A layout that cannot be read or prepared
 * refuses the start (`git-layout`), since the profile could not name what it must (E5).
 */
export async function prepareCodexSandbox(o: {
  accountId: string
  cwd: string
  platform: NodeJS.Platform
  homeDir: string
  env: Record<string, string | undefined>
  /** Absent, a Windows start is refused: a home nobody asked about would bring up the administrator prompt. */
  ready: CodexWindowsReady | undefined
  /** The folder the Host's socket is in, denied on macOS and Linux (sessionSandboxArgs). */
  hostSocketDir?: string | null
  /** The codex version question (final review I2): asked first, so an old codex is refused before anything is read or
   *  written. Absent, the start is refused as for a version not known. */
  version?: CodexVersionProbe
  check?: (sandboxArgs: string[]) => void
  log: (m: string) => void
}): Promise<GitLayout | null> {
  const fail = (err: unknown): Error => {
    o.log(`sandbox: the git layout of ${o.cwd} could not be read or prepared: ${String(err)}`)
    return sandboxUnavailable('git-layout')
  }
  await o.version?.warm('codex')
  const tooOld = codexVersionBlocker(o.version)
  if (tooOld !== null) {
    o.log(`sandbox: ${tooOld}, so the sandboxed start is refused`)
    throw new Error(tooOld)
  }
  let layout: GitLayout | null
  try {
    layout = await gitLayoutOf(o.cwd)
  } catch (err) {
    throw fail(err)
  }
  const args = sessionSandboxArgs({ platform: o.platform, homeDir: o.homeDir, layout, env: o.env, hostSocketDir: o.hostSocketDir ?? null })
  o.check?.(args)
  if (o.platform === 'win32') {
    const verdict: Readiness = o.ready ? await o.ready({ codexHome: o.env.CODEX_HOME ?? null, env: o.env, log: o.log }) : 'not-set-up'
    // Codex could not be asked: setting the account up would not help, so no setup is offered for it
    if (verdict === 'check-failed') throw sandboxUnavailable(`windows-check-failed codex ${o.accountId}`)
    if (verdict !== 'ready') {
      o.log(`sandbox: the Windows sandbox of account ${o.accountId} is not set up${o.ready ? '' : ' (this process cannot ask)'}`)
      throw sandboxUnavailable(`windows-setup codex ${o.accountId}`)
    }
  }
  if (layout) {
    try {
      await ensureGitFiles(layout)
      if (o.platform === 'win32') await ensureWorktreeConfigFiles(layout)
    } catch (err) {
      throw fail(err)
    }
  }
  return layout
}
