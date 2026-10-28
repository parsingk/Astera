// What a sandboxed start warns about (Task E fix round 2; the person's decision, 2026-10-29): the session starts as it
// does today, and its tab says why the sandbox will not keep out what the person may expect it to, or why its shell will
// not work. Nothing here refuses a start. Pure: the managers decide, the app and Host wiring word and deliver.
import { readFileSync } from 'node:fs'
import { isPathWithin } from '../files/tree'
import type { Message, MessageKey } from '../i18n'

export type SandboxStartWarning = 'claudeUserns' | 'homeInWorkFolder'

/** Where a session manager tells a sandboxed start's warnings (SessionManager.sandboxWarn, ChatSessionManager's twin):
 *  the app and the Host each give one, which words them in the person's language into the session's tab and its log.
 *  `claudeUsernsRestricted` is the Ubuntu check, run once per process by whoever gives the sink. */
export interface SandboxWarnSink {
  claudeUsernsRestricted(): boolean
  warn(sessionId: string, warnings: readonly SandboxStartWarning[]): void
}

/** What a manager does after a sandboxed start: decides the warnings and tells the sink, once. Never throws: a sink that
 *  fails costs the warning, not the session. */
export function tellSandboxStart(
  sink: SandboxWarnSink | undefined,
  o: { sessionId: string; provider: 'claude' | 'codex'; platform: NodeJS.Platform; cwd: string; homeDir: string },
  log: (m: string) => void
): void {
  if (!sink) return
  try {
    const restricted = o.provider === 'claude' && o.platform === 'linux' ? sink.claudeUsernsRestricted() : false
    const ws = sandboxStartWarnings({ provider: o.provider, platform: o.platform, cwd: o.cwd, homeDir: o.homeDir, claudeUsernsRestricted: restricted })
    if (ws.length > 0) sink.warn(o.sessionId, ws)
  } catch (err) {
    log(`sandbox: the start warnings of session=${o.sessionId} could not be told: ${String(err)}`)
  }
}

/**
 * The warnings for one sandboxed start, in a fixed order:
 * - `claudeUserns`: a Claude session on Linux where Ubuntu's AppArmor profile confines bubblewrap
 *   (`claudeUsernsRestricted`, ubuntuBwrapRestricted below), so srt's apply-seccomp cannot make its namespace and every
 *   shell command fails. Codex is not affected (its own sandbox ran normally on Ubuntu 26, run 40761549024).
 * - `homeInWorkFolder`: the work folder is the home folder or holds it, so the sandbox lets the session write anything
 *   in the home folder. Containment is the sandbox code's own path rule (core/files/tree.ts isPathWithin: case folded
 *   on Windows and macOS only). Both CLIs, every OS.
 */
export function sandboxStartWarnings(o: {
  provider: 'claude' | 'codex'
  platform: NodeJS.Platform
  cwd: string
  homeDir: string
  claudeUsernsRestricted: boolean
}): SandboxStartWarning[] {
  const out: SandboxStartWarning[] = []
  if (o.provider === 'claude' && o.platform === 'linux' && o.claudeUsernsRestricted) out.push('claudeUserns')
  if (isPathWithin(o.cwd, o.homeDir, o.platform)) out.push('homeInWorkFolder')
  return out
}

const KEYS: Record<SandboxStartWarning, MessageKey> = {
  claudeUserns: 'session.sandbox.warn.claudeUserns',
  homeInWorkFolder: 'session.sandbox.warn.homeInWorkFolder'
}

/** The one message a chat's notice carries for its warnings (a chat shows one notice): each alone, or both in one
 *  sentence pair; null for none. A terminal tab gets a line per warning instead (sandboxWarningLines). */
export function sandboxWarningMessage(ws: readonly SandboxStartWarning[]): Message | null {
  if (ws.length === 0) return null
  if (ws.length > 1) return { key: 'session.sandbox.warn.claudeUsernsAndHome' }
  return { key: KEYS[ws[0]] }
}

/** The messages a terminal tab gets, one line each. */
export const sandboxWarningMessages = (ws: readonly SandboxStartWarning[]): Message[] => ws.map((w) => ({ key: KEYS[w] }))

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
