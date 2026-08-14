import { promises as fs } from 'node:fs'
import path from 'node:path'

/** What the .NET CLI accepts as its PROJECT|SOLUTION argument. */
const PROJECT_EXTS = new Set(['.csproj', '.fsproj', '.sln'])

/** Never descended into. bin/obj hold build output — a copied or generated project file in there is
 *  not one the user means to run — and node_modules/.git are the usual large-directory traps. */
const SKIP_DIRS = new Set(['node_modules', 'bin', 'obj', '.git'])

/** How many directory levels below the project root are visited. A .NET solution keeps its projects
 *  a level or two down (src/App/App.csproj), so three is enough in practice, and it is the reason this
 *  scan stays cheap enough to run on every form open: a full walk of a large repository is not. */
const MAX_DEPTH = 3

/** The .NET project and solution files in a project — feeds the dotnet form's project Select (and,
 *  through it, RunTypePicker's "detected" grouping: a non-empty list is the detection signal).
 *
 *  Paths come back relative to the project root, with the platform's own separator: that is what the
 *  configuration stores (run.start resolves a relative path against the root, and an absolute one would
 *  break the moment the project moves), and it matches what the form's "Browse…" picker produces via
 *  toRelativeCwd, so the same file picked either way is the same string.
 *
 *  Sorted so the list does not reshuffle between opens — readdir order is filesystem-dependent.
 *
 *  An unreadable directory is skipped rather than thrown, so the whole scan degrades to a shorter list
 *  (or an empty one) — the same contract as composeScanner/pythonScanner: a scan failure empties the
 *  hint, it never throws up to the IPC caller. */
export async function listDotnetProjects(projectPath: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // missing, or not readable — nothing to report from here
    }
    for (const entry of entries) {
      // isDirectory() is false for a symlink, so this never follows one — no cycle to guard against
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH || SKIP_DIRS.has(entry.name)) continue
        await walk(path.join(dir, entry.name), depth + 1)
      } else if (PROJECT_EXTS.has(path.extname(entry.name).toLowerCase())) {
        found.push(path.relative(projectPath, path.join(dir, entry.name)))
      }
    }
  }
  await walk(projectPath, 0)
  return found.sort()
}
