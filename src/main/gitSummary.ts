// Checkpoint(core/orchestration/checkpoint.ts)에 넣을 저장소 수준 git 요약. 그 파일은 fs를
// 만지지 않는 순수 조립기이므로, 실제 git 호출은 여기 main 쪽에서 하고 결과만 인자로 넘긴다.
//
// git.ts(core/worktrees)의 execFile 어댑터를 그대로 쓴다 — shell 없이 실행하고(따옴표 문제 회피),
// 실패는 던지지 않고 ok:false로 돌아온다. gitWatcher.ts가 같은 모듈에서 gitDir을 가져다 쓰는 것과
// 같은 관례다: main 레이어가 git을 새로 배선하지 않고 core의 어댑터를 재사용한다.
import { git } from '../core/worktrees/git'
import type { GitSummary } from '../core/orchestration/checkpoint'

/** git status --short 한 줄에서 상태 코드 2글자 + 구분 공백을 떼고 경로만 남긴다.
 *  status.ts의 parsePorcelainZ와 달리 여기서는 파일 상태(new/modified/...)를 담지 않는다 —
 *  Checkpoint가 필요로 하는 것은 "무엇이 바뀌었나"뿐이다(브리핑 표에 상태 코드 칸이 없다). */
function changedPaths(shortStatus: string): string[] {
  if (shortStatus === '') return []
  // trim:false로 받은 원본이라 마지막 줄 뒤에 개행이 남아 split이 빈 문자열을 하나 더 낳는다.
  return shortStatus
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.slice(3).trim())
}

/**
 * 저장소 수준 git 요약 하나를 읽는다. 워크트리가 사라졌거나, 그 경로가 git 저장소가 아니거나,
 * git 이 PATH 에 없으면 — 즉 `rev-parse HEAD` 조차 안 되면 — 전체를 null 로 돌린다. 재개를 만드는
 * 쪽(Task 4)은 그 null 을 "이 절은 비운다"로만 받아들이고 재개 자체를 막지 않는다.
 *
 * `rev-parse HEAD` 가 성공한 뒤로는(= 유효한 저장소가 확인된 뒤로는) 나머지 세 번의 호출은 필드
 * 단위로만 실패를 흡수한다 — branch/diffstat 은 그 필드만 null, changed 는 빈 배열(타입이
 * `string[]` 이라 "모른다"를 표현할 자리가 없다; 실패와 "변경 없음"이 같은 값으로 접힌다).
 * 절대 던지지 않는다.
 */
export async function readGitSummary(cwd: string): Promise<GitSummary | null> {
  const head = await git(['rev-parse', 'HEAD'], { cwd })
  if (!head.ok || head.stdout === '') return null

  const [branch, status, diffstat] = await Promise.all([
    git(['branch', '--show-current'], { cwd }),
    // porcelain: 상태 코드 두 글자가 앞쪽 공백일 수 있다(" M f.txt") — trim:true(기본값)면 그
    // 선행 공백이 통째로 날아가 changedPaths의 고정폭 slice(3)가 어긋난다.
    git(['status', '--short'], { cwd, trim: false }),
    git(['diff', '--stat'], { cwd })
  ])

  return {
    head: head.stdout,
    // 로컬 브랜치가 아니면(detached HEAD) 성공해도 빈 문자열이 온다 — 그 경우도 null.
    branch: branch.ok && branch.stdout !== '' ? branch.stdout : null,
    changed: status.ok ? changedPaths(status.stdout) : [],
    // 변경이 없을 때도 빈 문자열로 성공한다 — diff 본문은 절대 담기지 않는다(--stat 은 요약 줄뿐).
    diffstat: diffstat.ok && diffstat.stdout !== '' ? diffstat.stdout : null
  }
}
