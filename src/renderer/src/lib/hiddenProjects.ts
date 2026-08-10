/** Hidden history projects. HistoryBrowser hides one from a project row's context menu, and the
 *  settings modal's History tab is the only place they come back — two screens that must see the same
 *  list without threading props through App.tsx. Same module-singleton shape as worktreeBus.ts
 *  (Set<listener> + emit).
 *  Paths are stored exactly as ProjectSummary.projectPath handed them over. Comparison-time
 *  normalization belongs to the main process (norm() in core/history/index.ts); a second rule here
 *  would let the two drift with no way to tell which one is wrong. */

const KEY = 'cm.historyHidden'
const listeners = new Set<() => void>()
let cache: string[] | null = null

function read(): string[] {
  if (cache) return cache
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    // A non-array (a hand-edited value, or an older shape) is as unusable as broken JSON
    cache = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  } catch {
    cache = [] // corrupt JSON — this is a display preference, so starting empty beats throwing
  }
  return cache
}

function write(next: string[]): void {
  cache = next
  localStorage.setItem(KEY, JSON.stringify(next))
  for (const listener of listeners) listener()
}

export function list(): string[] {
  return read()
}

export function hide(projectPath: string): void {
  const cur = read()
  if (cur.includes(projectPath)) return // no write, and therefore no notification
  write([...cur, projectPath])
}

export function unhide(projectPath: string): void {
  const cur = read()
  if (!cur.includes(projectPath)) return
  write(cur.filter((p) => p !== projectPath))
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
