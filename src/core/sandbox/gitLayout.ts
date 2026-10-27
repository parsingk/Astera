// Where a session folder's git data lives. A sandbox that makes the folder writable must still let git write its own
// directories, and a linked worktree keeps them outside the folder, so the builders need the layout before they can name them.
import fs from 'node:fs'
import path from 'node:path'

export interface GitLayout {
  /** The folder the layout was asked about, as a real path, so it can be compared with `top` however the caller spelled it. */
  cwd: string
  /** The folder holding `.git`. */
  top: string
  /** This checkout's own git directory (a linked worktree's lives under the main one's `worktrees`). */
  gitDir: string
  /** The git directory shared by every checkout of the repository: hooks and config live here. */
  commonDir: string
  worktree: boolean
}

const slashed = (p: string): string => p.replace(/\\/g, '/')

const real = async (p: string): Promise<string> => {
  try {
    return slashed(await fs.promises.realpath(p))
  } catch {
    return slashed(path.resolve(p))
  }
}

/** Walks up from `cwd` to the first `.git`; null when there is none. A `.git` file is a linked worktree's pointer. */
export async function gitLayoutOf(cwd: string): Promise<GitLayout | null> {
  let dir: string
  let asked: string
  try {
    dir = await fs.promises.realpath(cwd)
    asked = slashed(dir)
  } catch {
    return null
  }
  for (;;) {
    const dotGit = path.join(dir, '.git')
    const st = await fs.promises.stat(dotGit).catch(() => null)
    if (st?.isDirectory()) {
      const g = slashed(dotGit)
      return { cwd: asked, top: slashed(dir), gitDir: g, commonDir: g, worktree: false }
    }
    if (st?.isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.promises.readFile(dotGit, 'utf8'))
      if (!pointer) return null
      const gitDir = await real(path.resolve(dir, pointer[1]))
      const common = await fs.promises.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => null)
      const commonDir = common?.trim() ? await real(path.resolve(gitDir, common.trim())) : gitDir
      return { cwd: asked, top: slashed(dir), gitDir, commonDir, worktree: true }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** A config value as git reads it: quotes dropped, and a `;` or `#` outside them starting a comment. */
function configValue(raw: string): string {
  let out = ''
  let quoted = false
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === ';' || ch === '#')) break
    else out += ch
  }
  return out.trim()
}

/** Whether git reads `config.worktree`: `extensions.worktreeConfig` in the repository's config, read the way git reads a
 *  boolean (true, yes, on or 1, or the key with no value; section and key in any case; the last one wins). An
 *  `[include]` is not followed. */
async function worktreeConfigOn(commonDir: string): Promise<boolean> {
  const text = await fs.promises.readFile(path.join(commonDir, 'config'), 'utf8').catch(() => '')
  let section = ''
  let on = false
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    const head = /^\[\s*([^\]\s"]+)\s*(?:"([^"]*)"\s*)?\](.*)$/.exec(line)
    if (head) {
      section = head[2] === undefined ? head[1].toLowerCase() : `${head[1].toLowerCase()}.${head[2]}`
      line = head[3].trim()
    }
    if (section !== 'extensions') continue
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/.exec(line)
    if (!kv || kv[1].toLowerCase() !== 'worktreeconfig') continue
    on = kv[2] === undefined || /^(true|yes|on|1)$/i.test(configValue(kv[2]))
  }
  return on
}

/**
 * Makes an empty `config.worktree` in the checkout's git directory when git reads it there. The sandbox keeps that file
 * read-only, so a session cannot set `core.hooksPath` through it, but a read-only entry for a file that is not there yet
 * does not stop Codex's Windows sandbox from creating it (inventory §23.3). Without the extension git ignores the
 * file, so nothing is written; an empty one changes nothing.
 */
export async function ensureWorktreeConfigFile(layout: GitLayout): Promise<'created' | 'present' | 'not-needed'> {
  if (!(await worktreeConfigOn(layout.commonDir))) return 'not-needed'
  try {
    await fs.promises.writeFile(path.join(layout.gitDir, 'config.worktree'), '', { flag: 'wx' })
    return 'created'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'present'
    throw err
  }
}
