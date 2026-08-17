import { isSamePath } from '../files/tree'
import type { WorktreeInfo } from '../types'

/** The repository a project path belongs to. A registered worktree resolves back to the repo it was
 *  created from; every other path is returned unchanged.
 *
 *  Why this exists: a worker dispatched with `--worktree new` gets a freshly created worktree as its
 *  cwd (main/orchestration/coordinator.ts → createWorktree), and SessionInfo.cwd is that same value
 *  (sessions/manager.ts) — a path under the worktree registry root, outside the repository entirely.
 *  Anything scoped by "the active tab's cwd" therefore asks about a path no Run was ever created
 *  with. A worktree is the same project wearing a different path, and WorktreeInfo.repoPath is the
 *  original repo root recorded at creation time, so this is a registry lookup and not a heuristic.
 *
 *  Matching is isSamePath rather than isPathWithin. "At or below a worktree" would also swallow a
 *  nested repository checked out inside one — a vendored or gitignored clone — whose Runs belong to
 *  that nested project, which is the same reason runsForProject compares exactly (files/tree.ts).
 *  assertAllowedPath's worktree lookup does use isPathWithin, but that is a containment guard for
 *  file access, a different question from "which project is this".
 *
 *  Passing unregistered paths through unchanged is what makes this safe to apply to every path that
 *  arrives: a plain project root, a worktree the app did not create, and a directory that is not a
 *  repository at all all come back as given.
 *
 *  This module is main-side — isSamePath pulls in node:path, so it must not be added to
 *  tsconfig.web.json's include (the same note as orchestration/view.ts). */
export function repoPathOf(worktrees: WorktreeInfo[], projectPath: string): string {
  return worktrees.find((w) => isSamePath(w.path, projectPath))?.repoPath ?? projectPath
}
