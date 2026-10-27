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
