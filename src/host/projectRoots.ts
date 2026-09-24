// The Host's own answer to `resolveProjectRoot` (orchDeps' HOST_RESOLVES): the project root a Job's
// `--cwd` is normalised to before it is stored, found with no app to ask.
//
// **The same rule the app applies, not a second copy.** Both call `resolveProjectRootFrom`
// (core/files/tree.ts); what differs is only where the two candidate lists come from:
// - the worktree repoPaths come from the Host's own registry (host/worktrees.ts), as the app's come
//   from `core.worktrees.list()`;
// - the known project paths come from the transcripts of the accounts in the profile's accounts.json,
//   listed by `ProjectPathListing` (core/history/projects.ts), where the app asks its watched
//   HistoryIndex. There is no watcher here: the listing keys its memo on file mtime signatures, so a
//   second `jobs create` does not parse an unchanged folder again.
//
// **Reads only.** accounts.json and session-cwd.json are the app's files. The cwd memo is opened
// read-only (SessionCwdCache's `readOnly`): what the app has memoised speeds the codex listing up, and
// what this Host learns stays in its memory. A second writer on that file could interleave with the
// app's own flush.
//
// Imports only core modules and node builtins: this bundles into the Host, which runs on a plain
// node.exe. Nothing here imports chokidar (the reason the listing left core/history/index.ts).
import path from 'node:path'
import { readAccountEntries } from '../core/accounts/accountsFile'
import { resolveProjectRootFrom } from '../core/files/tree'
import { ProjectPathListing } from '../core/history/projects'
import { SessionCwdCache } from '../core/history/sessionCwdCache'
import { makeDescriptors } from '../core/providers/descriptor'
import { repoRoot as gitRepoRoot } from '../core/worktrees/git'

export interface HostProjectRoots {
  /** `OrchServerDeps.resolveProjectRoot`: the deepest known project that holds `cwd` inside its git
   *  repository, or `cwd` itself. Rejects when accounts.json cannot be read; the command layer logs
   *  that and keeps the path it was given. */
  resolve(cwd: string): Promise<string>
}

export function createHostProjectRoots(a: {
  profileDir: string
  /** The Host worktree registry's repoPaths, from memory (`HostWorktrees.repoPaths`). */
  repoPaths(): string[]
  platform?: NodeJS.Platform
  /** Test seam; the wiring leaves it out and git answers. */
  repoRoot?: (dir: string) => Promise<string | null>
}): HostProjectRoots {
  const platform = a.platform ?? process.platform
  const memo = new SessionCwdCache(path.join(a.profileDir, 'session-cwd.json'), platform, { readOnly: true })
  // Loaded once, at the first resolve: after that the app's later additions are not seen, and a miss
  // is parsed and remembered here instead — the same answer, a parse later.
  let loaded: Promise<unknown> | null = null
  const listing = new ProjectPathListing(makeDescriptors(platform), memo)
  const repoRoot = a.repoRoot ?? gitRepoRoot
  return {
    resolve: async (cwd) => {
      await (loaded ??= memo.load())
      const accounts = await readAccountEntries(path.join(a.profileDir, 'accounts.json'))
      return resolveProjectRootFrom({
        cwd,
        repoPaths: a.repoPaths(),
        projectPaths: await listing.projectPaths(accounts),
        repoRoot
      })
    }
  }
}
