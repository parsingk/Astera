// What a sandboxed start warns about (Task E fix rounds 2 and 3; the person's decision, 2026-10-29): the session starts
// as it does today, and its tab says why the sandbox will not keep out what the person may expect it to, or why its shell
// will not work. Nothing here refuses a start. The managers decide before they build the session's info, where the
// warnings travel (SessionInfo.sandboxWarnings, in the note too); the tab shows them above the terminal or the chat, a
// chat's notice says them at the start, and the wiring logs them. Main and the Host only: the check reads files.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { comparablePath, isPathWithin } from '../files/tree'
import type { SandboxStartWarning } from '../types'

export type { SandboxStartWarning } from '../types'
export { sandboxWarningMessage } from './warningKeys'

/** Where a session manager tells a sandboxed start's warnings (SessionManager.sandboxWarn, ChatSessionManager's twin):
 *  the app and the Host each give one, which logs them and, for a chat, raises its notice. `claudeUsernsRestricted` is
 *  the Ubuntu check, run once per process by whoever gives the sink. */
export interface SandboxWarnSink {
  claudeUsernsRestricted(): boolean
  warn(sessionId: string, warnings: readonly SandboxStartWarning[]): void
}

/** The warnings of one sandboxed start, asked before the session's info is built: the sink's Ubuntu check is asked only
 *  for a Claude session on Linux, and a check that throws counts as no (a hint, not a gate). */
export function startWarningsFor(
  sink: SandboxWarnSink | undefined,
  o: { provider: 'claude' | 'codex'; platform: NodeJS.Platform; cwd: string; homeDir: string; linkInWorkFolder?: boolean; elevatedDefault?: boolean }
): SandboxStartWarning[] {
  let restricted = false
  if (sink && o.provider === 'claude' && o.platform === 'linux') {
    try {
      restricted = sink.claudeUsernsRestricted()
    } catch {
      restricted = false
    }
  }
  return sandboxStartWarnings({ ...o, claudeUsernsRestricted: restricted, linkInWorkFolder: o.linkInWorkFolder === true, elevatedDefault: o.elevatedDefault === true })
}

/** What a manager does once the session is tracked: tells the sink its warnings, if any. Never throws: a sink that fails
 *  costs the log line or the chat's notice, not the session. */
export function tellSandboxStart(sink: SandboxWarnSink | undefined, sessionId: string, ws: readonly SandboxStartWarning[], log: (m: string) => void): void {
  if (!sink || ws.length === 0) return
  try {
    sink.warn(sessionId, ws)
  } catch (err) {
    log(`sandbox: the start warnings of session=${sessionId} could not be told: ${String(err)}`)
  }
}

/** Whether `cwd` holds `homeDir`: isPathWithin (core/files/tree.ts: case folded on Windows and macOS only), and a
 *  filesystem or drive root, which isPathWithin misses because a resolved root already ends in a separator (re-review
 *  Minor 1): `/` holds every home, `C:\` the one on drive C and not another drive's. isPathWithin itself is left as it
 *  is: the files IPC guard relies on it. */
function holdsHome(cwd: string, homeDir: string, platform: NodeJS.Platform): boolean {
  const base = comparablePath(cwd, platform)
  if (path.parse(base).root === base) return comparablePath(homeDir, platform).startsWith(base)
  return isPathWithin(cwd, homeDir, platform)
}

/**
 * The warnings for one sandboxed start, in a fixed order:
 * - `claudeUserns`: a Claude session on Linux where Ubuntu's AppArmor profile confines bubblewrap
 *   (`claudeUsernsRestricted`, ubuntuBwrapRestricted below), so srt's apply-seccomp cannot run there and every shell
 *   command fails. Codex is not affected (its own sandbox ran normally on Ubuntu 26, run 40761549024).
 * - `linkInWorkFolder` (fix round 5): a Codex session on Linux one of whose named paths goes through a link inside its
 *   writable folders (`linkInWorkFolder`, core/sandbox/prepared.ts codexSessionLinks), so Codex refuses every command
 *   there by design. Elsewhere such a start is refused instead, so nothing else is told this.
 * - `elevatedDefault` (Task P, the person's decision 2026-10-29): a Codex session on Windows whose home's config.toml
 *   still makes the elevated sandbox its default (`elevatedDefault`, the prepare read it: codexDefaultSandbox.ts),
 *   through the `windows.sandbox` line or Codex's older feature key, set up before Astera took that line back out or by
 *   the person. The session is sandboxed as always; the account's ordinary Codex sessions run in that sandbox too and
 *   cannot read the login folders, which Settings › Agent profiles can undo.
 * - `homeInWorkFolder`: the work folder is the home folder, holds it, or is the root of the filesystem or drive the home
 *   folder is on, so the sandbox lets the session write anything in the home folder. Both CLIs on every OS but Claude Code on Windows, whose shell has no
 *   sandbox at all (deny rules for its file tools only, coverage.ts), so "start it in a project folder" would be untrue.
 */
export function sandboxStartWarnings(o: {
  provider: 'claude' | 'codex'
  platform: NodeJS.Platform
  cwd: string
  homeDir: string
  claudeUsernsRestricted: boolean
  linkInWorkFolder?: boolean
  elevatedDefault?: boolean
}): SandboxStartWarning[] {
  const out: SandboxStartWarning[] = []
  if (o.provider === 'claude' && o.platform === 'linux' && o.claudeUsernsRestricted) out.push('claudeUserns')
  if (o.provider === 'codex' && o.platform === 'linux' && o.linkInWorkFolder === true) out.push('linkInWorkFolder')
  if (o.provider === 'codex' && o.platform === 'win32' && o.elevatedDefault === true) out.push('elevatedDefault')
  const denyOnly = o.provider === 'claude' && o.platform === 'win32'
  if (!denyOnly && holdsHome(o.cwd, o.homeDir, o.platform)) out.push('homeInWorkFolder')
  return out
}

/** The files the bubblewrap check reads, none of them root-only. */
export const UBUNTU_BWRAP = {
  /** AppArmor is on when this reads `Y` (libapparmor src/kernel.c `aa_is_enabled`/`param_check_enabled`). */
  enabled: '/sys/module/apparmor/parameters/enabled',
  /** Ubuntu's profile for bubblewrap, shipped from 25.04 ("AppArmor now comes with a bwrap profile
   *  (bwrap-userns-restrict)", Ubuntu 25.04 release notes); "AppArmor profiles are located in the /etc/apparmor.d
   *  directory" (Ubuntu Server docs, AppArmor). Upstream's text: "bwrap is allowed access to user namespaces and
   *  capabilities within the user namespace, but its children do not have capabilities". */
  profile: '/etc/apparmor.d/bwrap-userns-restrict',
  /** "The /etc/apparmor.d/disable directory can be used … to disable a profile" (Ubuntu Server docs, AppArmor). */
  disabled: '/etc/apparmor.d/disable/bwrap-userns-restrict'
} as const

/**
 * Whether Ubuntu's AppArmor profile confines bubblewrap here (Task E fix round 2), asked once per process: AppArmor on,
 * the profile in /etc/apparmor.d, not disabled through /etc/apparmor.d/disable, and not in complain mode (a `complain`
 * flag on the profile, which `aa-complain` sets). `read` gives a file's text, or null when it is not there; one that
 * throws counts as null. Anything that cannot be read leans towards no warning: this is a hint, not a gate, and a
 * loaded profile is not readable without root (aa-status needs it), so a profile disabled at run time without the
 * symlink still reads as confined.
 */
export function ubuntuBwrapRestricted(read: (p: string) => string | null): boolean {
  const get = (p: string): string | null => {
    try {
      return read(p)
    } catch {
      return null
    }
  }
  if (!get(UBUNTU_BWRAP.enabled)?.trim().startsWith('Y')) return false
  const profile = get(UBUNTU_BWRAP.profile)
  if (profile === null) return false
  if (get(UBUNTU_BWRAP.disabled) !== null) return false
  return !/flags\s*=\s*\([^)]*\bcomplain\b/.test(profile)
}

/** A file's text, or null when it cannot be read. Three small local files under /sys and /etc, read once per process. */
export function readTextOrNull(p: string): string | null {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** The Ubuntu check as the app and the Host each ask it: once per process, on its first sandboxed Claude start, and
 *  never off Linux. `read` is a test seam. */
export function claudeUsernsCheck(platform: NodeJS.Platform, read: (p: string) => string | null = readTextOrNull): () => boolean {
  let answer: boolean | undefined
  return () => (answer ??= platform === 'linux' && ubuntuBwrapRestricted(read))
}
