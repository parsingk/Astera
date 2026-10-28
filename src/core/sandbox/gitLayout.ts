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
  /** Every `config.worktree` git may read for this repository: the checkout's own, the main checkout's, then each other
   *  worktree's (`<commonDir>/worktrees/<id>`) found when the layout was read. git reads them under
   *  `extensions.worktreeConfig`, which `git sparse-checkout` turns on later, and one can set `core.hooksPath`. */
  worktreeConfigs: string[]
  /** What decides where git reads its config and hooks from (final fix pass, C1), absolute with forward slashes: this
   *  checkout's `<gitDir>/commondir`, the common directory's own `commondir` (which would redirect the main checkout and
   *  every worktree at once), its `modules` folder (the submodules' git directories, whose config and hooks a
   *  superproject's `git status` runs), then each other worktree's `<commonDir>/worktrees/<id>/commondir`, found when the
   *  layout was read. A sandbox keeps them read-only, and the start makes the missing ones first (ensureGitFiles). */
  gitFiles: string[]
}

const slashed = (p: string): string => p.replace(/\\/g, '/')

const real = async (p: string): Promise<string> => {
  try {
    return slashed(await fs.promises.realpath(p))
  } catch {
    return slashed(path.resolve(p))
  }
}

/** The worktrees' git directories under the common directory, by id, in order. */
async function worktreeIdsOf(commonDir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(path.join(commonDir, 'worktrees'), { withFileTypes: true }).catch(() => [])
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/** worktreeConfigs and gitFiles of a layout, from one read of the common directory's worktrees. */
async function gitPathsOf(gitDir: string, commonDir: string): Promise<Pick<GitLayout, 'worktreeConfigs' | 'gitFiles'>> {
  const ids = await worktreeIdsOf(commonDir)
  const ofWorktrees = (name: string): string[] => ids.map((id) => `${commonDir}/worktrees/${id}/${name}`)
  return {
    worktreeConfigs: [...new Set([`${gitDir}/config.worktree`, `${commonDir}/config.worktree`, ...ofWorktrees('config.worktree')])],
    gitFiles: [...new Set([`${gitDir}/commondir`, `${commonDir}/commondir`, `${commonDir}/modules`, ...ofWorktrees('commondir')])]
  }
}

/** Walks up from `cwd` to the first `.git`; null when there is none. A `.git` file is a linked worktree's pointer. A
 *  submodule's checkout has a `.git` file too (`gitdir: <superproject>/.git/modules/<name>`), so it is read as
 *  `worktree: true`: its git directory is under the superproject's `modules`, and with no `commondir` there its common
 *  directory is that git directory itself. */
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
      return { cwd: asked, top: slashed(dir), gitDir: g, commonDir: g, worktree: false, ...(await gitPathsOf(g, g)) }
    }
    if (st?.isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.promises.readFile(dotGit, 'utf8'))
      if (!pointer) return null
      const gitDir = await real(path.resolve(dir, pointer[1]))
      const common = await fs.promises.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => null)
      const commonDir = common?.trim() ? await real(path.resolve(gitDir, common.trim())) : gitDir
      return { cwd: asked, top: slashed(dir), gitDir, commonDir, worktree: true, ...(await gitPathsOf(gitDir, commonDir)) }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Makes each missing `config.worktree` of the layout, empty, whether or not the extension is on. The sandbox keeps them
 * read-only, but a read-only entry for a file that is not there does not stop Codex's Windows sandbox from creating it
 * (inventory §23.3). An empty one changes nothing for git. A file already there is never touched, and a worktree whose
 * folder went away since the layout was read is skipped.
 */
export async function ensureWorktreeConfigFiles(layout: GitLayout): Promise<{ created: string[] }> {
  const created: string[] = []
  for (const p of layout.worktreeConfigs) {
    try {
      await fs.promises.writeFile(p, '', { flag: 'wx' })
      created.push(p)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOENT') throw err
    }
  }
  return { created }
}

/** What a missing `commondir` is made with: git reads the file relative to the git directory it is in, so `.` names that
 *  directory itself, which is what git takes when there is no file. */
export const COMMONDIR_SELF = '.\n'

/**
 * Makes each missing entry of `layout.gitFiles` (final fix pass, C1), on every OS: a `commondir` holding `.`, and the
 * `modules` folder, empty. The sandbox keeps them read-only, and a read-only entry holds only for a path that exists
 * (inventory §23.3); made this way neither changes what git does. A file or folder already there is never touched, and
 * one whose folder went away since the layout was read (a worktree removed meanwhile) is skipped.
 */
export async function ensureGitFiles(layout: GitLayout): Promise<{ created: string[] }> {
  const created: string[] = []
  for (const p of layout.gitFiles) {
    try {
      if (path.posix.basename(p) === 'modules') await fs.promises.mkdir(p)
      else await fs.promises.writeFile(p, COMMONDIR_SELF, { flag: 'wx' })
      created.push(p)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOENT') throw err
    }
  }
  return { created }
}
