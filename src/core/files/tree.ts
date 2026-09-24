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

/**
 * run-create 가 --cwd 를 저장하기 전에 통과시키는 해석기 — **앱(ipc.ts)과 Host(host/projectRoots.ts)가
 * 같이 부르는 하나**다. 후보를 모으는 것은 부르는 쪽이고, 규칙은 모두 여기 있다.
 *
 * **후보는 두 목록이고 순서가 있다.** 워크트리 레지스트리의 repoPath 가 먼저, 기록이 아는 프로젝트
 * 경로가 뒤다. 같은 폴더가 두 표기로 오면 projectRootOf 가 먼저 만난 것을 고르므로 순서가 저장될
 * 표기를 정한다.
 *
 * **세션 cwd 는 후보가 아니다.** 워커 세션의 cwd 는 워크트리라서 후보에 넣으면 Run.cwd 가 워크트리
 * **안으로** 내려간다 — 정규화가 하려는 것과 정반대 방향이다.
 *
 * 워크트리는 path 가 아니라 repoPath 를 넣는다. path 를 넣으면 Run.cwd 가 워크트리가 되고, 그 값은
 * worker-start 가 runCwd 로도 쓰므로 워커가 도는 자리까지 바뀐다. 다만 이 후보가 **워크트리 안에서
 * 만든 Run 을 저장소로 올려 주지는 않는다** — 워크트리는 레지스트리 루트(기본 ~/astera-worktrees)
 * 아래, 저장소 밖에 있어서 projectRootOf 의 포함 판정에 걸리지 않기 때문이다. 그 경우의 소유 판정은
 * 읽는 쪽에서 한다(core/orchestration/view.ts 의 runsForProject 가 r.cwd 를 repoPathOf 로 되돌린다).
 * 여기서 repoPath 가 하는 일은, 저장소 루트가 기록의 프로젝트 경로에 아직 없을 때 그 자리를 채워
 * 주는 것이다.
 *
 * **걷기를 git 저장소 경계에서 멈춘다.** Run.cwd 는 표시용 값이 아니다 — worker-start 가 runCwd 로
 * 넘겨 `--worktree current` 는 그 자리에서 워커를 돌리고 `--worktree new` 는 그 경로의 저장소로
 * 워크트리를 만든다. 세션을 연 적 없는 중첩 저장소(서브모듈, 벤더링된 클론)에서 run-create 를 부르면
 * 그 저장소는 후보가 아니고 부모만 후보라서, 경계가 없으면 정규화가 저장소 밖으로 올라가고 워커가
 * 엉뚱한 저장소에서 돈다.
 *
 * 후보 하나하나에 git 을 부르지 않는다. projectRootOf 는 target 을 담는 후보만 고르므로, 남은 판정은
 * "그 후보가 target 의 저장소 루트 아래인가"뿐이다 — 저장소 루트와 target 사이의 디렉터리에는 .git 이
 * 있을 수 없고(있었다면 그것이 target 의 저장소 루트다), 따라서 그 구간의 후보는 전부 같은 저장소다.
 * git 호출(repoRoot)은 target 에 대해 한 번뿐이다. repoRoot 를 주입받는 것은 이 파일이 git 을
 * 모르게 두기 위해서다(core/worktrees/git.ts 의 repoRoot 가 실제 값이다).
 *
 * cwd 가 저장소가 아니면(repoRoot 가 null) 경계 자체가 없다. 이때 후보를 전부 버리면 정규화가 통째로
 * 사라져 하위 디렉터리 Run 이 다시 보이지 않게 되는데, 막으려는 피해(워커가 다른 저장소에서 도는
 * 것)는 저장소 안에서만 생긴다. 그래서 이 경우에는 경계를 걸지 않는다.
 *
 * 담는 후보가 없으면 받은 cwd 를 그대로 돌려준다(projectRootOf). 대소문자와 구분자는 isPathWithin 과
 * comparablePath 의 규칙을 따른다.
 */
export async function resolveProjectRootFrom(a: {
  cwd: string
  /** 워크트리 레지스트리의 repoPath 들. 앞선다. */
  repoPaths: readonly string[]
  /** 기록이 아는 프로젝트 경로들(HistoryIndex.knownProjectPaths, 또는 Host 의 ProjectPathListing). */
  projectPaths: readonly string[]
  repoRoot(dir: string): Promise<string | null>
}): Promise<string> {
  const candidates = [...a.repoPaths, ...a.projectPaths]
  const root = await a.repoRoot(a.cwd)
  const bounded = root === null ? candidates : candidates.filter((c) => isPathWithin(root, c))
  return projectRootOf(bounded, a.cwd)
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
