import { existsSync } from 'node:fs'
import path from 'node:path'
import type { WorktreeListItem, WorktreeStatus } from '../types'
import { git, listGitWorktrees } from './git'
import type { WorktreeRegistry } from './registry'

const samePath = (a: string, b: string): boolean =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/**
 * Status from cross-checking the registry against git worktree list. git is called once per repo.
 *
 * **폴더가 사라진 항목은 목록을 만드는 이 자리에서 걷는다.** 그런 항목에는 관리할 것이 남아 있지
 * 않다 — 사람이 그 줄에서 할 수 있는 일은 줄을 지우는 것뿐이었고, 예약 작업이 회차마다 워크트리를
 * 만들면서 그 줄이 스물일곱 개까지 쌓여 하나씩 x 를 눌러야 했다. 목록을 부르는 것이 곧 정리다.
 *
 * git 쪽 메타데이터(.git/worktrees/<name>)도 함께 걷는다 — `git worktree prune` 은 **디렉터리가
 * 사라진 항목만** 지우고 잠긴 워크트리는 건드리지 않는 git 자신의 정기 정리다(gc 가 알아서 하는
 * 그것). 걷지 않으면 저장소에 잔해가 남는다. 저장소를 읽을 수 없으면 prune 은 건너뛰고 레지스트리
 * 항목만 지운다 — 그쪽에 닿을 수 없으니 할 수 있는 것이 그것뿐이다.
 *
 * **대가**: 워크트리를 담은 드라이브가 잠깐 빠진 동안 목록을 부르면 그 항목들을 잊는다. 폴더와
 * 브랜치는 그대로 남으므로 잃는 것은 "앱이 이것을 관리한다"는 기록뿐이고, 되돌리려면 그 폴더를
 * 지우거나 다시 만들면 된다. 그 드문 경우를 위해 "폴더 없음" 줄을 늘 남겨 두는 것보다 낫다고 보았다.
 */
export async function listWithStatus(registry: WorktreeRegistry): Promise<WorktreeListItem[]> {
  const items = registry.list()
  const repos = [...new Set(items.map((w) => w.repoPath))]
  const rowsByRepo = new Map<string, Array<{ path: string }> | null>()
  for (const repo of repos) {
    try {
      rowsByRepo.set(repo, await listGitWorktrees(repo))
    } catch {
      rowsByRepo.set(repo, null) // repo unreachable — prune 을 부를 수 없다(아래)
    }
  }
  const dead = items.filter((w) => !existsSync(w.path))
  // prune 은 저장소마다 한 번이다 — 같은 저장소의 항목 여럿이 사라졌을 때 그 수만큼 git 을 부르지
  // 않는다(한 번이 그 저장소의 잔해를 모두 걷는다).
  for (const repo of new Set(dead.filter((w) => rowsByRepo.get(w.repoPath) !== null).map((w) => w.repoPath)))
    await git(['worktree', 'prune'], { cwd: repo })
  for (const w of dead) await registry.removeEntry(w.id)
  const deadIds = new Set(dead.map((w) => w.id))
  return items
    .filter((w) => !deadIds.has(w.id))
    .map((w) => {
      const rows = rowsByRepo.get(w.repoPath)
      const registered = rows?.some((r) => samePath(r.path, w.path)) ?? false
      // 여기 오는 항목은 폴더가 있다(위에서 걸렀다) — 남은 질문은 git 이 아는가 하나다
      const status: WorktreeStatus = registered ? 'ok' : 'orphan-dir'
      return { ...w, status }
    })
}
