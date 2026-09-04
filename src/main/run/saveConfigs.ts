import type { RunConfig, SaveConfigsResult, SaveReason } from '../../core/run/types'
import { migrateRunConfigs } from '../../core/run/migrate'
import { hasUnsafeWin32Chars } from '../../core/run/build'
import { isSeedId } from '../../core/run/draft'

// cmd.exe interprets & | ^ % ! < > even inside double quotes — assembly cannot guard against that, so
// it is rejected at save time. **Only values that land in the command string are checked.** id/name
// are metadata, cwd is handed to the PTY as its working directory rather than interpolated, folder and
// temporary are tree metadata and never reach a command string, javaHome/springProfiles become
// environment variables, and beforeLaunch/members hold configuration ids the launch planner reads — no
// id is ever interpolated into a command. Why an exclude list: the failure direction is the safe one —
// a new field defaults to being checked.
const NOT_IN_COMMAND = new Set([
  'id', 'name', 'cwd', 'env', 'folder', 'javaHome', 'springProfiles', 'beforeLaunch', 'members', 'temporary'
])

/** The Run Configurations dialog's Apply: the project's stored list becomes `configs`, wholesale — an
 *  item missing from the list is deleted, a new id added, a known id replaced, and the list's order is
 *  the order stored. Every item is checked before anything is written and one failure fails the batch,
 *  with every offending item named, so the dialog never sees a half-applied store. The project path
 *  itself is guarded by the caller (assertAllowedPath) — a disallowed project is a programming error,
 *  not user input, and throws as before. */
export async function saveConfigsBatch(a: {
  projectPath: string
  configs: RunConfig[]
  platform: NodeJS.Platform
  assertConfigCwd: (projectPath: string, cwd: unknown) => Promise<void>
  store: { save(projectPath: string, configs: RunConfig[]): Promise<void> }
}): Promise<SaveConfigsResult> {
  const errors: { id: string; reason: SaveReason }[] = []
  const count = new Map<string, number>()
  for (const c of a.configs) {
    const id = typeof c?.id === 'string' ? c.id : ''
    count.set(id, (count.get(id) ?? 0) + 1)
  }
  for (const c of a.configs) {
    const id = typeof c?.id === 'string' ? c.id : ''
    // Seeds are detected from the project's files, never stored; a duplicate id would make the tree
    // and the store disagree about which row a click means. Both are INVALID_CONFIG, like a shape
    // migrateRunConfigs will not accept — an incomplete configuration is accepted (allowIncomplete),
    // as ＋ creates one with its required field still empty; run.start is what refuses to run it.
    if (id === '' || isSeedId(id) || (count.get(id) ?? 0) > 1 || migrateRunConfigs([c], { allowIncomplete: true }).length === 0) {
      errors.push({ id, reason: 'INVALID_CONFIG' })
      continue
    }
    try {
      await a.assertConfigCwd(a.projectPath, c.cwd)
    } catch {
      errors.push({ id, reason: 'INVALID_CWD' })
      continue
    }
    if (a.platform === 'win32' && c.type !== 'shell') {
      for (const [k, v] of Object.entries(c as unknown as Record<string, unknown>)) {
        if (NOT_IN_COMMAND.has(k)) continue
        if (typeof v === 'string' && hasUnsafeWin32Chars(v)) {
          errors.push({ id, reason: 'UNSAFE_VALUE' })
          break
        }
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  await a.store.save(a.projectPath, a.configs)
  return { ok: true, configs: a.configs }
}
