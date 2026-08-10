import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WorktreeInfo } from '../types'
import { isPathWithin } from '../files/tree'
import {
  git, repoRoot, gitUserName, detectBaseRef, toFullRef, fetchBaseRef, localBranchExists
} from './git'
import {
  autoName, branchNameFor, candidateName, slugify, worktreePathFor, MAX_SUFFIX_ATTEMPTS
} from './naming'
import { copyWorktreeInclude } from './include'
import type { WorktreeRegistry } from './registry'
import type { Message } from '../i18n'

const WORKTREE_ADD_TIMEOUT_MS = 180_000

export async function createWorktree(args: {
  repoPath: string
  name?: string
  /** The branch to fork from, in short form ('develop' or 'origin/develop'). Optional: the orchestration
   *  path creates worker worktrees without a user in the loop and keeps the automatic detection. */
  baseRef?: string
  registry: WorktreeRegistry
}): Promise<{ info: WorktreeInfo; warnings: Message[] }> {
  const repo = await repoRoot(args.repoPath)
  if (!repo) throw new Error(`NOT_GIT_REPO: ${args.repoPath}`)

  const warnings: Message[] = []
  const baseSlug = args.name && args.name.trim() !== '' ? slugify(args.name) : autoName()
  const username = await gitUserName(repo)

  // A base the user picked is used as given; only the automatic path probes. Validation is the same for
  // both — toFullRef below rejects anything that does not resolve, so a branch deleted between the picker
  // rendering and the spawn lands on NO_BASE rather than a confusing git error.
  const baseRef = args.baseRef ?? (await detectBaseRef(repo))
  if (!baseRef) throw new Error('NO_BASE: could not find a default branch (origin/HEAD, main or master)')
  if ((await fetchBaseRef(repo, baseRef)) === 'stale')
    warnings.push({ key: 'worktree.create.fetchFailed', params: { baseRef } })
  const fullBase = await toFullRef(repo, baseRef)
  if (!fullBase) throw new Error(`NO_BASE: cannot resolve the ${baseRef} ref`)

  // Name-collision avoidance loop: checks the local branch and the path
  const root = args.registry.getRoot()
  let slug: string | null = null
  let branch = ''
  let wtPath = ''
  for (let attempt = 1; attempt <= MAX_SUFFIX_ATTEMPTS; attempt++) {
    const cand = candidateName(baseSlug, attempt)
    const candBranch = branchNameFor(username, cand)
    const candPath = worktreePathFor(root, repo, cand)
    if (!isPathWithin(root, candPath)) throw new Error(`DANGEROUS_PATH: ${candPath}`)
    if (await localBranchExists(repo, candBranch)) continue
    if (existsSync(candPath)) continue
    slug = cand
    branch = candBranch
    wtPath = candPath
    break
  }
  if (!slug) throw new Error(`NAME_EXHAUSTED: no name starting with '${baseSlug}' is available (20 attempts)`)

  await fs.mkdir(path.dirname(wtPath), { recursive: true })
  const add = await git(['worktree', 'add', '--no-track', '-b', branch, wtPath, fullBase], {
    cwd: repo,
    timeoutMs: WORKTREE_ADD_TIMEOUT_MS
  })
  if (!add.ok) throw new Error(`GIT_ADD_FAILED: ${add.stderr || add.stdout}`)

  try {
    // follow-up configuration only produces warnings
    const setBase = await git(['config', '--local', `branch.${branch}.base`, fullBase], { cwd: repo })
    if (!setBase.ok) warnings.push({ key: 'worktree.create.baseRecordFailed' })
    const autoSetup = await git(['config', '--get', 'push.autoSetupRemote'], { cwd: repo })
    if (!autoSetup.ok) {
      const set = await git(['config', '--local', 'push.autoSetupRemote', 'true'], { cwd: repo })
      if (!set.ok) warnings.push({ key: 'worktree.create.autoSetupRemoteFailed' })
    }
    warnings.push(...(await copyWorktreeInclude(repo, wtPath)))

    const info: WorktreeInfo = {
      id: randomUUID(),
      repoPath: repo,
      path: wtPath,
      name: slug,
      branch,
      baseRef,
      createdAt: new Date().toISOString()
    }
    await args.registry.add(info)
    return { info, warnings }
  } catch (err) {
    // rollback: do not leave behind the worktree and branch that were just created
    await git(['worktree', 'remove', '--force', wtPath], { cwd: repo })
    await git(['branch', '-D', branch], { cwd: repo })
    await git(['worktree', 'prune'], { cwd: repo })
    throw err
  }
}
