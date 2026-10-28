import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorktreeRemoveResult } from '../types'
import { isPathWithin, isSamePath } from '../files/tree'
import { clearReadOnly } from '../files/clearReadOnly'
import { git, gitVersionAtLeast, isCleanWorktree, listGitWorktrees, GIT_WRITE_TIMEOUT_MS } from './git'

/** Options for a call that changes the repository — see GIT_WRITE_TIMEOUT_MS. A `worktree remove`
 *  killed part-way leaves the folder half deleted with git's record of it still in place, so writes
 *  are never cut short at the read default. */
const write = (cwd: string): { cwd: string; timeoutMs: number } => ({ cwd, timeoutMs: GIT_WRITE_TIMEOUT_MS })
import type { WorktreeStore } from './registry'
import { askUntilAnswered, defaultActionPresenceCheck, type PresenceCheck } from './presence'
import { detachLinks, type DetachResult } from './detachLinks'

/** What the index says about this worktree: the paths git tracks as symlinks (mode 120000), relative
 *  with `/`, case folded where the file system folds it, and whether it has any submodule (a 160000
 *  entry). null when git could not say. */
async function trackedIndex(worktreePath: string): Promise<{ links: Set<string>; submodules: boolean } | null> {
  const r = await git(['ls-files', '-s', '-z'], { cwd: worktreePath, trim: false })
  if (!r.ok) return null
  const fold = process.platform === 'win32' || process.platform === 'darwin'
  const links = new Set<string>()
  let submodules = false
  for (const rec of r.stdout.split('\0')) {
    const tab = rec.indexOf('\t')
    if (tab < 0) continue
    if (rec.startsWith('160000 ')) submodules = true
    if (!rec.startsWith('120000 ')) continue
    const p = rec.slice(tab + 1)
    links.add(fold ? p.toLowerCase() : p)
  }
  return { links, submodules }
}

/** Takes the links out of a worktree before `git worktree remove` runs on it (detachLinks.ts): Git for
 *  Windows' remove deletes through a junction, into the folder outside it points at. Without force,
 *  git's own tracked symlinks are spared: git never follows them, and removing one would make the
 *  worktree dirty and the removal refused, leaving it damaged. Also without force, a worktree with
 *  submodules is refused first (HAS_SUBMODULES): git refuses to remove one without force, and taking
 *  its links out beforehand would only have cost its node_modules links. Throws LINKS_UNVERIFIED when
 *  the walk could not finish; nothing is removed then. */
async function detachBeforeRemove(
  worktreePath: string,
  force: boolean,
  detach: (root: string, opts: { keep?: (rel: string) => boolean }) => Promise<DetachResult>
): Promise<void> {
  let keep: ((rel: string) => boolean) | undefined
  if (!force) {
    const tracked = await trackedIndex(worktreePath)
    if (!tracked)
      throw new Error(`LINKS_UNVERIFIED: git could not list the tracked files, nothing was removed (${worktreePath})`)
    if (tracked.submodules)
      throw new Error(`HAS_SUBMODULES: the worktree has submodules, remove it with force (${worktreePath})`)
    const fold = process.platform === 'win32' || process.platform === 'darwin'
    keep = (rel) => tracked.links.has(fold ? rel.toLowerCase() : rel)
  }
  const r = await detach(worktreePath, keep ? { keep } : {})
  if (!r.ok)
    throw new Error(
      `LINKS_UNVERIFIED: the links in the folder could not all be checked and taken out, nothing was removed (${worktreePath}): ${r.reason}`
    )
}

/** Whether a failed removal was a permission refusal (win32 only): an error's EPERM/EACCES code, or
 *  git's own wording on stderr, since git reports it as text rather than a code. */
export function isPermissionFailure(failure: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false
  const code = (failure as { code?: unknown } | null)?.code
  if (code === 'EPERM' || code === 'EACCES') return true
  const text = typeof failure === 'string' ? failure : failure instanceof Error ? failure.message : ''
  return /permission denied|access is denied|EPERM|EACCES/i.test(text)
}

/** Dangerous paths: the repo itself, a parent that contains the repo, home, a parent that contains home, the filesystem root */
export function isDangerousRemovalPath(
  worktreePath: string,
  repoPath: string,
  homeDir: string
): boolean {
  const p = path.resolve(worktreePath)
  if (isSamePath(p, repoPath) || isSamePath(p, homeDir)) return true
  if (isPathWithin(p, repoPath) || isPathWithin(p, homeDir)) return true // p is an ancestor of them
  if (isSamePath(p, path.parse(p).root)) return true
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
 *  entry other than .git it counts as "unverifiable" and force is required (a different question from DIRTY).
 *  .git is skipped because a proven orphan's .git is our own marker; with ownership unproven it has to be
 *  counted (countGitDir), since a .git *directory* means a separate repo rather than a leftover of ours. */
async function countOrphanEntries(
  worktreePath: string,
  opts?: { countGitDir?: boolean }
): Promise<number> {
  try {
    const entries = await fs.readdir(worktreePath)
    return opts?.countGitDir ? entries.length : entries.filter((e) => e !== '.git').length
  } catch (err) {
    // ENOENT (a TOCTOU race after the presence check) and EACCES/EPERM (permission denied) both converge on "unverifiable"
    throw new Error(
      `ORPHAN_UNVERIFIABLE: ${worktreePath} (${err instanceof Error ? err.message : String(err)})`
    )
  }
}

/** create() makes <root>/<repoDirName> on the way to the worktree, and nothing else ever removed it —
 *  so a repo whose last worktree is gone left an empty directory behind for good. rmdir is not recursive:
 *  a surviving sibling worktree turns this into a silent no-op. The registry root itself is left alone,
 *  since it can be a path the user chose for other things too. */
async function pruneEmptyRepoDir(worktreePath: string, root: string): Promise<void> {
  const parent = path.dirname(path.resolve(worktreePath))
  if (isSamePath(parent, root) || !isPathWithin(root, parent)) return
  await fs.rmdir(parent).catch(() => {}) // ENOTEMPTY / ENOENT / EACCES all mean "leave it"
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

/** Whether the worktree's folder is there, asked asynchronously and with a time limit, on the
 *  per-root action lane (presence.ts: a check stuck on another drive never refuses this one). A sync
 *  existsSync on a folder on a dead network share froze the calling thread (the Electron main thread,
 *  or the Host's) for 20 to 60 s. **Only `missing` counts as gone**: a timeout or any other error is
 *  "not known", and nothing is deleted on it (the registry entry least of all). A refusal (no call was
 *  made) is asked again a few times (askUntilAnswered); one that lasts is "could not check", which
 *  deletes nothing either. */
async function folderState(p: string, check: PresenceCheck): Promise<'present' | 'missing'> {
  const r = await askUntilAnswered(check, p)
  if (r === 'present' || r === 'missing') return r
  throw new Error(
    r === 'refused'
      ? `WORKTREE_UNREACHABLE: the folder could not be checked just now, nothing was removed (${p})`
      : `WORKTREE_UNREACHABLE: folder not reachable, nothing was removed (${p})`
  )
}

export async function removeWorktree(args: {
  id: string
  force?: boolean
  registry: WorktreeStore
  isPathInUse: (worktreePath: string) => string | null
  /** Test seam; defaults to the process-wide action-lane check (presence.ts). */
  presence?: PresenceCheck
  /** Test seam: the link walk before git removes the folder (detachLinks.ts). */
  detach?: (root: string, opts: { keep?: (rel: string) => boolean }) => Promise<DetachResult>
  /** Test seams for the retry after a permission failure: git's `worktree remove` call, the orphan
   *  folder's delete, and the read-only clearing. */
  removeGit?: typeof git
  rmDir?: (p: string) => Promise<void>
  clear?: (dir: string) => Promise<number>
}): Promise<WorktreeRemoveResult> {
  const clear = args.clear ?? clearReadOnly
  const rmDir = args.rmDir ?? ((p: string) => fs.rm(p, { recursive: true, force: true }))
  const removeGit = args.removeGit ?? git
  const info = args.registry.get(args.id)
  if (!info) throw new Error(`NOT_MANAGED: not a worktree created by this app (${args.id})`)
  const presence = args.presence ?? defaultActionPresenceCheck

  const inUse = args.isPathInUse(info.path)
  if (inUse) throw new Error(`IN_USE: ${inUse}`)
  if (isDangerousRemovalPath(info.path, info.repoPath, os.homedir()))
    throw new Error(`DANGEROUS_PATH: ${info.path}`)

  // Re-query the source of truth — when the repo itself is gone and the directory is gone too, just clean up
  let rows
  try {
    rows = await listGitWorktrees(info.repoPath)
  } catch {
    if ((await folderState(info.path, presence)) === 'missing') {
      await pruneEmptyRepoDir(info.path, args.registry.getRoot())
      await args.registry.removeEntry(args.id)
      return { removed: true, branchDeleted: false }
    }
    throw new Error(`ORPHAN_UNPROVEN: cannot inspect the original repo (${info.repoPath})`)
  }
  const row = rows.find((r) => isSamePath(r.path, info.path))

  let branchDeleted = false
  let branchPreserved: { branch: string; head: string } | undefined

  if (!row) {
    // git has forgotten it
    await git(['worktree', 'prune'], write(info.repoPath))
    if ((await folderState(info.path, presence)) === 'present') {
      if (!(await isProvenOrphanDir(info.path, info.repoPath))) {
        // Without proof there is no telling our worktree from an unrelated directory — but an empty one
        // has nothing to lose, and demanding proof there left the row undeletable forever
        if ((await countOrphanEntries(info.path, { countGitDir: true })) > 0)
          throw new Error(`ORPHAN_UNPROVEN: ownership cannot be proven, so nothing is deleted (${info.path})`)
      } else if (!args.force) {
        const entryCount = await countOrphanEntries(info.path)
        if (entryCount > 0) throw new Error(`ORPHAN_UNVERIFIABLE: ${info.path}`)
      }
      try {
        await rmDir(info.path)
      } catch (err) {
        // The same one retry as for git's removal below, after the read-only attribute is cleared.
        let failure = err
        if (isPermissionFailure(err) && (await clear(info.path)) > 0) {
          try {
            await rmDir(info.path)
            failure = null
          } catch (again) {
            failure = again
          }
        }
        if (failure) throw new Error(`GIT_REMOVE_FAILED: ${failure instanceof Error ? failure.message : String(failure)}`)
      }
    }
  } else {
    // If the directory is already gone, git status itself is impossible and there is nothing to inspect — skip the cleanliness check.
    // Force or not, the folder is asked about first: before git removes it, its links are taken out
    // (detachBeforeRemove — git would delete through a junction into the folder it points at), and
    // that walk is not run on a folder that did not answer. Unreachable throws; nothing is removed.
    // A locked worktree is refused by git without force; refused here first, before the link walk
    // would have taken its node_modules links out for nothing.
    if (!args.force && row.locked)
      throw new Error(`WORKTREE_LOCKED: the worktree is locked (git worktree lock), nothing was removed (${info.path})`)
    if ((await folderState(info.path, presence)) === 'present') {
      if (!args.force) {
        const { clean, changedCount } = await isCleanWorktree(info.path)
        if (!clean) throw new Error(`DIRTY: ${changedCount}`)
      }
      await detachBeforeRemove(info.path, args.force === true, args.detach ?? detachLinks)
    }
    const removeArgs = args.force
      ? ['worktree', 'remove', '--force', info.path]
      : ['worktree', 'remove', info.path]
    let rm = await removeGit(removeArgs, write(info.repoPath))
    // Files the sandbox's user wrote can be read-only to this one (Windows only), which fails the
    // removal with a permission error part-way. Clearing the attribute and trying once more is
    // enough; a second failure is reported as it is.
    if (!rm.ok && isPermissionFailure(`${rm.stderr}\n${rm.stdout}`) && (await clear(info.path)) > 0)
      rm = await removeGit(removeArgs, write(info.repoPath))
    if (!rm.ok) throw new Error(`GIT_REMOVE_FAILED: ${rm.stderr || rm.stdout}`)
    await git(['worktree', 'prune'], write(info.repoPath))
  }

  // Branch deletion: -d → squash detection → -D; on failure the branch is preserved
  const del = await git(['branch', '-d', '--', info.branch], write(info.repoPath))
  if (del.ok) branchDeleted = true
  else if (await isBranchMerged(info.repoPath, info.branch)) {
    branchDeleted = (await git(['branch', '-D', '--', info.branch], write(info.repoPath))).ok
  }
  if (!branchDeleted) {
    const head = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${info.branch}`], {
      cwd: info.repoPath
    })
    if (head.ok) branchPreserved = { branch: info.branch, head: head.stdout }
  }

  await pruneEmptyRepoDir(info.path, args.registry.getRoot())
  await args.registry.removeEntry(args.id)
  return { removed: true, branchDeleted, ...(branchPreserved ? { branchPreserved } : {}) }
}
