// The person's global git excludes, for a sandboxed session whose git cannot read them where they are (sandbox design §6):
// a Claude session on Linux, whose exclude file adds srt's names to them (claudeStart.ts), and a Codex session on
// Windows, whose elevated sandbox runs it as an account of its own that cannot read the person's home (the copy below).
// `core.excludesFile` passed through GIT_CONFIG takes the place of theirs, so each file starts with their own.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeScript } from '../sessions/statusline'

const slashed = (p: string): string => p.replace(/\\/g, '/')

/** Runs git and answers what it printed, trimmed; null when it failed or printed nothing (`config --get` exits 1 for a key
 *  that is not set). */
export type RunGit = (args: string[], o: { cwd: string; env: Record<string, string | undefined> }) => Promise<string | null>

export const runGitFile: RunGit = (args, o) =>
  new Promise((resolve) => {
    execFile('git', args, { env: o.env as NodeJS.ProcessEnv, cwd: o.cwd, timeout: 5_000, windowsHide: true, encoding: 'utf8' }, (err, stdout) =>
      resolve(err ? null : stdout.trim() || null)
    )
  })

/** The person's effective `core.excludesFile`, with `~` expanded (`--path`): asked with no scope, so a GIT_CONFIG_GLOBAL or
 *  GIT_CONFIG_* entry of theirs counts as it would for git, but outside any repository (the temp folder), since the file
 *  is shared by every session whatever its folder. */
export const GIT_EXCLUDES_ARGS = ['config', '--path', '--get', 'core.excludesFile']

/** Where git reads the person's excludes: `core.excludesFile` when it is set (`configured`, git's effective value,
 *  GIT_EXCLUDES_ARGS), else `$XDG_CONFIG_HOME/git/ignore`, else `~/.config/git/ignore` (git-config(1)). */
export function globalExcludesPath(configured: string | null, env: Record<string, string | undefined>, home: string): string {
  const h = slashed(home).replace(/\/+$/, '')
  if (configured) return configured.startsWith('~/') ? `${h}/${configured.slice(2)}` : configured
  const xdg = env.XDG_CONFIG_HOME ? slashed(env.XDG_CONFIG_HOME).replace(/\/+$/, '') : ''
  return xdg ? `${xdg}/git/ignore` : `${h}/.config/git/ignore`
}

/** The person's global excludes as git would read them with `env` and `homeDir`; '' when they have none, or none that can
 *  be read. */
export async function globalExcludesText(o: { env: Record<string, string | undefined>; homeDir: string; tmpDir: string; runGit: RunGit }): Promise<string> {
  const configured = await o.runGit(GIT_EXCLUDES_ARGS, { cwd: o.tmpDir, env: o.env }).catch(() => null)
  return fs.readFile(globalExcludesPath(configured, o.env, o.homeDir), 'utf8').catch(() => '')
}

/** Windows Codex: the copy of the person's excludes, in TEMP, which the elevated sandbox lets a session read and write
 *  (npm's cache is there too, codexProfile.ts npmCacheOf); one per profile, keyed as the Host's address is (the first
 *  twelve hex digits of the profile folder's SHA-256). */
export const codexExcludesFileOf = (tmpDir: string, profileDir: string): string =>
  `${slashed(tmpDir).replace(/\/+$/, '')}/astera-git-excludes-${createHash('sha256').update(profileDir).digest('hex').slice(0, 12)}`

/** Writes the copy a sandboxed Codex session on Windows reads, from the person's global excludes as they are now, and
 *  answers its path; null when they have none (nothing is written) or it could not be written (said in the log): the
 *  session's git is then pointed nowhere new. Never rejects. */
export type CodexExcludes = () => Promise<string | null>

export function codexExcludesWriter(o: {
  /** Astera's profile folder, which names the copy. */
  profileDir: string
  /** os.tmpdir(), where the copy goes, and where git is asked. */
  tmpDir: string
  /** The person's home and environment, for where git keeps their excludes. */
  homeDir: string
  env: Record<string, string | undefined>
  /** Test injection; default runs git. */
  runGit?: RunGit
  log: (m: string) => void
}): CodexExcludes {
  const file = codexExcludesFileOf(o.tmpDir, o.profileDir)
  const runGit = o.runGit ?? runGitFile
  return async () => {
    const text = await globalExcludesText({ env: o.env, homeDir: o.homeDir, tmpDir: o.tmpDir, runGit })
    if (text.trim() === '') return null
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
    } catch (err) {
      o.log(`sandbox: the folder for ${file} could not be made: ${String(err)}`)
      return null
    }
    // Swapped in whole: a session already running may be reading it
    if (await writeScript(file, text)) return file
    o.log(`sandbox: the copy of the git excludes ${file} could not be written; the sandboxed Codex session's git cannot read the person's own`)
    return null
  }
}
