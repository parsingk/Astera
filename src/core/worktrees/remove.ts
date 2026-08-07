import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorktreeRemoveResult } from '../types'
import { isPathWithin } from '../files/tree'
import { git, gitVersionAtLeast, isCleanWorktree, listGitWorktrees } from './git'
import type { WorktreeRegistry } from './registry'

const samePath = (a: string, b: string): boolean =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/** Dangerous paths: the repo itself, a parent that contains the repo, home, a parent that contains home, the filesystem root */
export function isDangerousRemovalPath(
  worktreePath: string,
  repoPath: string,
  homeDir: string
): boolean {
  const p = path.resolve(worktreePath)
  if (samePath(p, repoPath) || samePath(p, homeDir)) return true
  if (isPathWithin(p, repoPath) || isPathWithin(p, homeDir)) return true // p is an ancestor of them
  if (samePath(p, path.parse(p).root)) return true
  return false
}

/** Proves ownership of an orphaned directory: the gitdir in the .git "file" is under the original repo's .git/worktrees/ */
async function isProvenOrphanDir(worktreePath: string, repoPath: string): Promise<boolean> {
  try {
    const gitFile = path.join(worktreePath, '.git')
    const stat = await fs.lstat(gitFile)
    if (!stat.isFile()) return false
    const m = /^gitdir:\s*(.+)\s*$/m.exec(await fs.readFile(gitFile, 'utf8'))
    if (!m) return false
    const gitdir = path.resolve(worktreePath, m[1].trim())
    const adminRoot = path.join(path.resolve(repoPath), '.git', 'worktrees')
    return isPathWithin(adminRoot, gitdir)
  } catch {
    return false
  }
}

/** Gate for an orphaned directory whose cleanliness cannot be confirmed: git status is unusable (it is
 *  outside the original repo's management) so there is no way to know what changed — if there is even one
 *  entry other than .git it counts as "unverifiable" and force is required (a different question from DIRTY) */
async function countOrphanEntries(worktreePath: string): Promise<number> {
  try {
    const entries = await fs.readdir(worktreePath)
    return entries.filter((e) => e !== '.git').length
  } catch (err) {
    // ENOENT (a TOCTOU race after existsSync) and EACCES/EPERM (permission denied) both converge on "unverifiable"
    throw new Error(
      `ORPHAN_UNVERIFIABLE: ${worktreePath} (${err instanceof Error ? err.message : String(err)})`
    )
  }
}

/** The ref the merge check is made against: branch.<b>.base → origin/HEAD → HEAD */
async function mergeTarget(repo: string, branch: string): Promise<string> {
  const cfg = await git(['config', `branch.${branch}.base`], { cwd: repo })
  if (cfg.ok && cfg.stdout) {
    const ok = await git(['rev-parse', '--verify', '--quiet', `${cfg.stdout}^{commit}`], { cwd: repo })
    if (ok.ok) return cfg.stdout
  }
  const head = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: repo })
  if (head.ok && head.stdout) {
    const ok = await git(['rev-parse', '--verify', '--quiet', `${head.stdout}^{commit}`], { cwd: repo })
    if (ok.ok) return head.stdout
  }
  return 'HEAD'
}

/** Squash-merge detection: merge-tree yields an identical tree (git≥2.38), or cherry reports all '-' */
async function isBranchMerged(repo: string, branch: string): Promise<boolean> {
  const target = await mergeTarget(repo, branch)
  // A tag with the same name would come before the branch in rev precedence and cause a misjudgement, so the full ref is used
  const branchRef = `refs/heads/${branch}`
  if (target.startsWith('refs/remotes/'))
    await git(['fetch', '--prune', 'origin'], { cwd: repo, timeoutMs: 10_000 }) // best-effort, only when the target is remote
  if (await gitVersionAtLeast(2, 38)) {
    const merged = await git(['merge-tree', '--write-tree', target, branchRef], { cwd: repo })
    const targetTree = await git(['rev-parse', `${target}^{tree}`], { cwd: repo })
    if (merged.ok && targetTree.ok && merged.stdout === targetTree.stdout) return true
  }
  const cherry = await git(['cherry', target, branchRef], { cwd: repo })
  if (cherry.ok) {
    const lines = cherry.stdout === '' ? [] : cherry.stdout.split('\n')
    if (lines.every((l) => l.startsWith('-'))) return true // an empty list = no new commits → merged
  }
  return false
}

export async function removeWorktree(args: {
  id: string
  force?: boolean
  registry: WorktreeRegistry
  isPathInUse: (worktreePath: string) => string | null
}): Promise<WorktreeRemoveResult> {
  const info = args.registry.get(args.id)
  if (!info) throw new Error(`NOT_MANAGED: not a worktree created by this app (${args.id})`)

  const inUse = args.isPathInUse(info.path)
  if (inUse) throw new Error(`IN_USE: ${inUse}`)
  if (isDangerousRemovalPath(info.path, info.repoPath, os.homedir()))
    throw new Error(`DANGEROUS_PATH: ${info.path}`)

  // Re-query the source of truth — when the repo itself is gone and the directory is gone too, just clean up
  let rows
  try {
    rows = await listGitWorktrees(info.repoPath)
  } catch {
    if (!existsSync(info.path)) {
      await args.registry.removeEntry(args.id)
      return { removed: true, branchDeleted: false }
    }
    throw new Error(`ORPHAN_UNPROVEN: cannot inspect the original repo (${info.repoPath})`)
  }
  const row = rows.find((r) => samePath(r.path, info.path))

  let branchDeleted = false
  let branchPreserved: { branch: string; head: string } | undefined

  if (!row) {
    // git has forgotten it
    await git(['worktree', 'prune'], { cwd: info.repoPath })
    if (existsSync(info.path)) {
      if (!(await isProvenOrphanDir(info.path, info.repoPath)))
        throw new Error(`ORPHAN_UNPROVEN: ownership cannot be proven, so nothing is deleted (${info.path})`)
      if (!args.force) {
        const entryCount = await countOrphanEntries(info.path)
        if (entryCount > 0) throw new Error(`ORPHAN_UNVERIFIABLE: ${info.path}`)
      }
      try {
        await fs.rm(info.path, { recursive: true, force: true })
      } catch (err) {
        throw new Error(`GIT_REMOVE_FAILED: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } else {
    // If the directory is already gone, git status itself is impossible and there is nothing to inspect — skip the cleanliness check
    if (!args.force && existsSync(info.path)) {
      const { clean, changedCount } = await isCleanWorktree(info.path)
      if (!clean) throw new Error(`DIRTY: ${changedCount}`)
    }
    const rm = await git(
      args.force
        ? ['worktree', 'remove', '--force', info.path]
        : ['worktree', 'remove', info.path],
      { cwd: info.repoPath }
    )
    if (!rm.ok) throw new Error(`GIT_REMOVE_FAILED: ${rm.stderr || rm.stdout}`)
    await git(['worktree', 'prune'], { cwd: info.repoPath })
  }

  // Branch deletion: -d → squash detection → -D; on failure the branch is preserved
  const del = await git(['branch', '-d', '--', info.branch], { cwd: info.repoPath })
  if (del.ok) branchDeleted = true
  else if (await isBranchMerged(info.repoPath, info.branch)) {
    branchDeleted = (await git(['branch', '-D', '--', info.branch], { cwd: info.repoPath })).ok
  }
  if (!branchDeleted) {
    const head = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${info.branch}`], {
      cwd: info.repoPath
    })
    if (head.ok) branchPreserved = { branch: info.branch, head: head.stdout }
  }

  await args.registry.removeEntry(args.id)
  return { removed: true, branchDeleted, ...(branchPreserved ? { branchPreserved } : {}) }
}
