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
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Quota exceeded or storage disabled — this is a display preference, not data worth throwing
    // over. The change is honoured for the rest of this session but will not survive a restart.
  }
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

/** 여러 경로를 한 번에 해제한다 — 설정 화면의 정리가 수십 개를 함께 지우기 때문이다. unhide 를
 *  그 횟수만큼 부르면 localStorage 쓰기와 구독자 통지가 매번 일어나고, 통지마다 목록이 다시 그려진다.
 *  지울 것이 하나도 없으면 쓰지도 알리지도 않는다(unhide 의 규칙과 같다). */
export function unhideMany(projectPaths: string[]): void {
  const drop = new Set(projectPaths)
  const cur = read()
  const next = cur.filter((p) => !drop.has(p))
  if (next.length === cur.length) return
  write(next)
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
