import path from 'node:path'
import ignore from 'ignore'
import { foldPathCase } from './paths'

/** A directory entry. path is the absolute path main joined and sent down — the renderer never has to join paths. */
export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

/** Folders first, then by name (case-insensitive). Does not mutate the input.
 *
 *  numeric compares a run of digits as the number it spells, so episode_2 lands before episode_11
 *  instead of after it. Codepoint order is wrong for the names people actually give files, which
 *  are numbered far more often than not, and it is what Explorer and Finder already do. */
export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

/** A path in the form two spellings of one entry share: resolved (which on win32 also unifies the
 *  separators), then case-folded where the platform ignores case (foldPathCase in paths.ts — win32 and
 *  darwin fold, linux compares exactly). The main-side comparison key; the node-free modules the
 *  renderer imports call foldPathCase directly. */
export function comparablePath(p: string, platform: string = process.platform): string {
  return foldPathCase(path.resolve(p), platform)
}

/** Whether target is base itself or a path below it — the path guard for the files IPC.
 *  Requiring a separator boundary blocks false positives from sibling prefixes (D:\proj vs D:\proj2). */
export function isPathWithin(base: string, target: string, platform: string = process.platform): boolean {
  const b = comparablePath(base, platform)
  const t = comparablePath(target, platform)
  return t === b || t.startsWith(b + path.sep)
}

/** Whether a and b are the same path — ownership, not containment. isPathWithin's "at or below"
 *  is right for a guard (the files IPC must not escape a root), but wrong for "does this Run belong
 *  to this project": isPathWithin(project, run.cwd) is also true for a nested repository below the
 *  project root, which silently pulls in a Run that belongs to a different, nested project. Shares
 *  comparablePath with isPathWithin, so it inherits the same case rule (folded on win32 and darwin only). */
export function isSamePath(a: string, b: string, platform: string = process.platform): boolean {
  return comparablePath(a, platform) === comparablePath(b, platform)
}

/** How files.rename treats its target. 'noop' when both name the same path exactly. 'viaTemp' when
 *  they differ only in case on a platform that folds case (win32, darwin): the two are one file, a direct
 *  rename can fail or do nothing there, and the target "already exists" as the file itself — so the
 *  exists check is skipped and the rename goes through a temporary name. 'checkThenRename' otherwise:
 *  refuse when the target exists, then rename. On linux a case-only rename is that last kind — `A.txt`
 *  beside `a.txt` is another file, and skipping the check would overwrite it.
 *
 *  The case comparison is on the strings as given, not resolved, as the handler always did. */
export function renamePlan(
  from: string,
  to: string,
  platform: string = process.platform
): 'noop' | 'viaTemp' | 'checkThenRename' {
  if (path.resolve(from) === path.resolve(to)) return 'noop'
  return foldPathCase(from, platform) === foldPathCase(to, platform) ? 'viaTemp' : 'checkThenRename'
}

/** target을 담는 후보 중 **가장 깊은** 것. 담는 것이 없으면 target을 그대로 돌려준다.
 *
 *  Run.cwd를 저장 전에 프로젝트 루트로 맞추는 데 쓴다. 소유 판정(isSamePath)이 '동일'이라
 *  하위 디렉터리에서 만들어진 Run은 어떤 프로젝트에도 속하지 못하는데, 질의를 '포함'으로
 *  넓히면 중첩 저장소의 Run이 부모 프로젝트로 새어 든다. 그래서 질의가 아니라 데이터를
 *  경계에서 바로잡는다.
 *
 *  가장 깊은 것을 고르는 이유도 같다 — 후보가 중첩되어 있을 때 바깥을 고르면 그 누수가
 *  저장 시점으로 옮겨 갈 뿐이다.
 *
 *  담는 것이 없을 때 던지지 않는 이유: Run은 앱이 아직 모르는 경로에도 만들어질 수 있고,
 *  여기서 실패하면 오케스트레이션 전체가 멈춘다. 정규화는 최선 노력이지 검증이 아니다 —
 *  검증은 ipc.ts의 assertAllowedPath가 한다.
 *
 *  돌려주는 값은 roots에 들어온 **원본 표기**다. 정규화된 소문자 경로를 돌려주면 그것이
 *  그대로 Run.cwd에 저장된다. */
export function projectRootOf(roots: string[], target: string): string {
  let best: string | null = null
  for (const root of roots) {
    if (!isPathWithin(root, target)) continue
    if (best === null || comparablePath(root).length > comparablePath(best).length) best = root
  }
  return best ?? target
}

// Excluded from the watcher — language-neutral, cross-language heavy/generated directories.
// Under gitignore semantics a name with no slash matches at any depth.
const CURATED_IGNORE = [
  '.git', '.hg', '.svn',
  'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', '.ruff_cache',
  'target', 'build', 'dist', 'out', 'bin', 'obj', '.gradle', 'vendor',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.idea'
]

/** The watcher's ignore matcher. Combines the curated list with the root .gitignore (when there is
 *  one) and reports whether a root-relative path is excluded. The exclusion is watcher-only — it has
 *  no effect on what the tree displays. */
export function buildIgnoreMatcher(gitignoreText: string | null): (relPath: string) => boolean {
  const ig = ignore()
  ig.add(CURATED_IGNORE)
  if (gitignoreText) ig.add(gitignoreText)
  return (relPath: string): boolean => {
    if (!relPath) return false // the root itself
    return ig.ignores(relPath.replace(/\\/g, '/'))
  }
}
