// Claude Code runs hooks and the statusLine command through bash, and finds it by
// CLAUDE_CODE_GIT_BASH_PATH or its own search. When Git is installed off the standard path the
// search fails ("requires bash but Git Bash was not found"), the statusLine capture never runs, and
// the app never learns the session id or the usage figures that come with it — which disables the
// native-session leg of Job Continuity recovery and the usage gate of account rolling. So the app
// looks for a real Git Bash itself and hands the path to every session it spawns.
//
// Pure: the filesystem arrives as `probe`, the environment as `env`. Windows-shaped, because that is
// where the problem is; on other platforms the probe simply finds nothing and null is returned.
// win32 semantics on purpose, on every host: CLAUDE_CODE_GIT_BASH_PATH is a Windows-only concept, so
// the separators and the delimiter this parses are Windows' ones wherever the tests happen to run.
// The plain 'node:path' takes the host's semantics, which turned these tests red on the macOS and
// Linux legs of the CI matrix while passing on a Windows developer machine.
import { win32 as path } from 'node:path'

/** Where a Git for Windows install keeps the bash that hooks need, relative to the install root. */
const BIN_BASH = path.join('bin', 'bash.exe')
const ROOTS = ['C:\\Program Files\\Git', 'C:\\Program Files (x86)\\Git']

/** `System32\bash.exe` is the WSL launcher, not Git Bash: handing it over makes the hook fail
 *  differently rather than work. Recognized by folder name, case-insensitively. */
const isWslBash = (p: string): boolean => /[\\/]system32[\\/]bash\.exe$/i.test(p)

function pathEntries(env: Record<string, string | undefined>): string[] {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  const value = key ? env[key] : undefined
  return value ? value.split(path.delimiter).filter((s) => s !== '') : []
}

/**
 * The Git Bash to hand to a spawned agent, or null when there is nothing to add — either the user
 * already set `CLAUDE_CODE_GIT_BASH_PATH` (never overwritten: their choice wins) or no real Git Bash
 * could be found (better to leave the CLI's own error than to point it at the wrong binary).
 */
export function findGitBash(
  env: Record<string, string | undefined>,
  probe: (p: string) => boolean
): string | null {
  if (env.CLAUDE_CODE_GIT_BASH_PATH) return null
  // Check if PATH key exists in environment (case-insensitive)
  const hasPath = Object.keys(env).some((k) => k.toUpperCase() === 'PATH')
  const candidates: string[] = []
  for (const entry of pathEntries(env)) {
    // A PATH entry is usually <root>\cmd or <root>\bin; both sit one level under the install root.
    candidates.push(path.join(entry, 'bash.exe'), path.join(path.dirname(entry), BIN_BASH))
  }
  // Only check standard roots if PATH was actually set in the environment
  if (hasPath) {
    for (const root of ROOTS) candidates.push(path.join(root, BIN_BASH))
  }
  for (const c of candidates) {
    if (isWslBash(c)) continue
    if (probe(c)) return c
  }
  return null
}
