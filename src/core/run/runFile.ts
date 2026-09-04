// What a file in the tree implies. Right-clicking `seed.py` offers "Run 'seed.py'" only because this
// module can name a kind for it; everything it cannot name is a file with no menu item.
//
// The rules read the basename only. The configuration built from them stores the whole
// project-relative path, which is the form node's `file`, compose's `composeFile` and dotnet's
// `project` are already stored in.
import type { RunConfig, RunConfigType } from './types'
import { COMPOSE_FILE_NAMES } from './compose'

/** How many temporary configurations a project keeps. Exported so the eviction and its test read the
 *  same number. IntelliJ's default, and the reason a convenience does not fill the list up. */
export const MAX_TEMPORARY = 5

const COMPOSE = new Set<string>(COMPOSE_FILE_NAMES)

/** The kind a file's name implies, or null when nothing runnable does.
 *
 *  **What is deliberately absent, and why.** `Dockerfile` needs an image tag a filename cannot supply,
 *  so the configuration would be one the tree marks ⚠ and ▶ refuses — offered from a menu that implied
 *  it would run. `.ts` depends on whether the user's Node strips types. `package.json`, `build.gradle`
 *  and `pom.xml` each imply many runnable things rather than one, and every one of those already has a
 *  detected configuration. */
export function runnableKindForFile(basename: string): RunConfigType | null {
  const lower = basename.toLowerCase()
  if (COMPOSE.has(lower)) return 'compose'
  // Before the plain .py rule: a test file is a test file.
  if (/^test_.+\.py$/.test(lower) || /^.+_test\.py$/.test(lower)) return 'pytest'
  if (lower.endsWith('.py')) return 'python'
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'node'
  if (lower.endsWith('.csproj') || lower.endsWith('.fsproj') || lower.endsWith('.sln')) return 'dotnet'
  return null
}

/** The configuration a file implies, or null when nothing runnable does.
 *
 *  `path` is project-relative with forward slashes. `id` and `name` are the caller's: only it knows
 *  which ids and names the project's list already holds. The result is **not** marked temporary —
 *  whether a configuration is provisional is the caller's decision, not the filename's. */
export function configForFile(path: string, id: string, name: string): RunConfig | null {
  const basename = path.split('/').pop() ?? path
  const kind = runnableKindForFile(basename)
  switch (kind) {
    case 'python':
      return { id, name, type: 'python', file: path }
    case 'pytest':
      return { id, name, type: 'pytest', target: path }
    case 'node':
      return { id, name, type: 'node', file: path }
    case 'compose':
      return { id, name, type: 'compose', composeFile: path }
    case 'dotnet':
      return { id, name, type: 'dotnet', project: path }
    default:
      return null
  }
}
