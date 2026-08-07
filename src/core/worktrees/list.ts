import { existsSync } from 'node:fs'
import path from 'node:path'
import type { WorktreeListItem, WorktreeStatus } from '../types'
import { listGitWorktrees } from './git'
import type { WorktreeRegistry } from './registry'

const samePath = (a: string, b: string): boolean =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/** Status from cross-checking the registry against git worktree list. git is called once per repo. */
export async function listWithStatus(registry: WorktreeRegistry): Promise<WorktreeListItem[]> {
  const items = registry.list()
  const repos = [...new Set(items.map((w) => w.repoPath))]
  const rowsByRepo = new Map<string, Array<{ path: string }> | null>()
  for (const repo of repos) {
    try {
      rowsByRepo.set(repo, await listGitWorktrees(repo))
    } catch {
      rowsByRepo.set(repo, null) // repo unreachable — judged by directory existence alone
    }
  }
  return items.map((w) => {
    const rows = rowsByRepo.get(w.repoPath)
    const registered = rows?.some((r) => samePath(r.path, w.path)) ?? false
    const exists = existsSync(w.path)
    const status: WorktreeStatus = !exists ? 'missing' : registered ? 'ok' : 'orphan-dir'
    return { ...w, status }
  })
}
