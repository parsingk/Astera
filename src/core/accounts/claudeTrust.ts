// Pre-marking a folder as trusted for claude, so the agent's "Is this a project you created or one
// you trust?" menu does not fire on a worker nobody is sitting in front of.
//
// **This file exists because the assumption that it was unnecessary was measured and found wrong.**
// codexTrust.ts said, and the orchestration seam repeated, that `--dangerously-skip-permissions`
// covers claude's trust prompt too. It does not. A Job worker dispatched into a fresh worktree
// stopped at the menu with that flag on its own command line (checked in the process list), and
// `~/.claude.json` had 47 project entries and not one under the worktree root — so no claude worker
// had ever got past it on that machine. The flag sets the permission policy; trust is a different
// question, exactly as codex's note already said about its own bypass flag.
//
// **Only the worktree is trusted, not the repository behind it — and that was measured, not assumed.**
// codex's counterpart widens to the repository root because codex resolves a worktree to its
// repository when it looks trust up, and an entry for the worktree alone would be one it never reads.
// That widening then has to defend itself against a forged `.git` file naming any directory on the
// machine, which is why codexTrustRoot checks the reciprocal backlink.
//
// claude looked like it might be the same: a worker started in a worktree, and claude created a
// project record for the **repository root** with `hasTrustDialogAccepted: false`. That record is its
// own bookkeeping (allowedTools, mcpServers, lastVersionBase). The trust check read the entry for the
// worktree — the worker went straight to work and reported `worker_done` with the file it was asked
// for. So the narrow claim is the one claude honours, nothing here widens, and there is nothing to
// forge: the path marked is the one the app made seconds earlier and is about to spawn into.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { foldPathCase } from '../files/paths'

/** The name claude keeps its own state under, inside a config directory or the home root. */
export const CLAUDE_CONFIG_FILE = '.claude.json'

/**
 * The key claude writes a project under.
 *
 * Read off the real file rather than guessed: all 47 entries on the machine this was built against
 * use forward slashes, an upper-case drive letter and no trailing separator, on Windows. So that is
 * the form written here — an entry in any other spelling is an entry claude does not find.
 */
export function claudeProjectKey(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/.test(slashed) ? slashed[0].toUpperCase() + slashed.slice(1) : slashed
}

/** Separator-insensitive comparison key, case-insensitive where the filesystem is (foldPathCase —
 *  win32 and darwin), for "does this file already say so". The same reason codexTrust has one: the
 *  same folder reaches us spelled several ways on win32. On linux a differently cased key is a
 *  different folder, and taking its entry for ours would leave ours untrusted. */
const sameKey = (p: string, platform: string): string => foldPathCase(claudeProjectKey(p), platform)

/** The file claude reads for this account.
 *
 *  **The ambient account's state is in the home root, not in its config directory.** That is the
 *  rule cliEnv.ts follows when it declines to set `CLAUDE_CONFIG_DIR` for the default account, and
 *  the reason it gives is this very file: onboarding, login and folder trust live in
 *  `~/.claude.json` and are only read when that variable is unset. Writing into
 *  `<home>/.claude/.claude.json` for that account would write a file claude never opens. */
export function claudeConfigFileFor(a: {
  configDir: string
  homeDir: string
  ambient: boolean
}): string {
  return path.join(a.ambient ? a.homeDir : a.configDir, CLAUDE_CONFIG_FILE)
}

/**
 * Returns `existing` with `projectPath` marked trusted, or `existing` unchanged when it already is.
 *
 * **Parsed and re-serialised, unlike the TOML counterpart.** config.toml is a file the user writes
 * by hand, so codexTrust does string surgery to keep their comments and ordering; `.claude.json` is
 * written only by claude itself, has no comments, and doing surgery on 134 KB of nested JSON to
 * insert one boolean is the riskier of the two. The indentation is taken from the file so the result
 * is not reformatted into one line.
 *
 * Everything else is preserved: the object is spread, not rebuilt. Unchanged input returns the
 * identical string, which is what lets the caller skip the write entirely.
 */
export function upsertClaudeTrust(
  existing: string,
  projectPath: string,
  platform: string = process.platform
): string {
  const key = claudeProjectKey(projectPath)
  const text = existing.charCodeAt(0) === 0xfeff ? existing.slice(1) : existing
  const root: Record<string, unknown> = text.trim() === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
  const projects = (root.projects ?? {}) as Record<string, Record<string, unknown>>
  // An entry already spelled some other way is honoured rather than duplicated — two entries for
  // one folder is a file whose meaning depends on which one claude reads.
  const found = Object.keys(projects).find((k) => sameKey(k, platform) === sameKey(key, platform))
  const target = found ?? key
  const entry = projects[target] ?? {}
  if (entry.hasTrustDialogAccepted === true) return existing
  const next = {
    ...root,
    projects: { ...projects, [target]: { ...entry, hasTrustDialogAccepted: true } }
  }
  return JSON.stringify(next, null, indentOf(text)) + (text.endsWith('\n') ? '\n' : '')
}

/** The indentation the file already uses, so rewriting it does not reflow every line. Two spaces is
 *  what claude writes; a file that is one long line keeps being one long line. */
function indentOf(text: string): number {
  const m = /\n(\s+)"/.exec(text)
  return m ? m[1].replace(/\t/g, '  ').length : 0
}

/**
 * Marks `workspacePath` trusted in one claude account's state file.
 *
 * A no-op when it already says so, which is what keeps this off the write path of every worker start
 * after the first in a given worktree.
 *
 * The write follows markCodexProjectTrusted: back the file up to `.bak`, then tmp+rename, so a
 * failure cannot leave claude with half a config.
 *
 * **The race is real and accepted.** A claude session running right now rewrites this same file, and
 * a read-modify-write can lose a concurrent write. It is narrowed rather than solved: the file is
 * read immediately before the write, the write happens at most once per worktree, and the previous
 * contents are on disk as `.bak`. Locking it would mean holding a lock claude itself does not take.
 */
export async function markClaudeProjectTrusted(
  file: string,
  workspacePath: string
): Promise<void> {
  let existing = ''
  try {
    existing = await fs.readFile(file, 'utf8')
  } catch {
    // absent is the empty file — upsertClaudeTrust writes the whole object
  }
  const next = upsertClaudeTrust(existing, workspacePath)
  if (next === existing) return
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.copyFile(file, file + '.bak').catch(() => {}) // ignored when the target is absent
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, next, 'utf8')
  await fs.rename(tmp, file)
}
