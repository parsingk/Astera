// Checkpoint(core/orchestration/checkpoint.ts)에 넣을 저장소 수준 git 요약. 그 파일은 fs를
// 만지지 않는 순수 조립기이므로, 실제 git 호출은 여기 main 쪽에서 하고 결과만 인자로 넘긴다.
//
// git.ts(core/worktrees)의 execFile 어댑터를 그대로 쓴다 — shell 없이 실행하고(따옴표 문제 회피),
// 실패는 던지지 않고 ok:false로 돌아온다. gitWatcher.ts가 같은 모듈에서 gitDir을 가져다 쓰는 것과
// 같은 관례다: main 레이어가 git을 새로 배선하지 않고 core의 어댑터를 재사용한다.
import { git } from '../core/worktrees/git'
import type { GitSummary } from '../core/orchestration/checkpoint'

export interface GitSummaryDeps {
  /** git 실행 어댑터. RollingDeps(main/rolling.ts)의 copy?/probeActivity? 와 같은 관례 — 테스트
   *  주입용이고, 넘기지 않으면 실제 git(core/worktrees/git.ts)을 쓴다. 모든 기존 호출부는
   *  이 인자를 생략하므로 그대로다. */
  git?: typeof git
}

/** 큰따옴표 한 쌍만 벗긴다 — 그 안의 백슬래시 이스케이프(제어문자·따옴표 자체가 이름에 든 경우)는
 *  풀지 않는다. git status --short(비 -z)는 공백이 든 이름을 큰따옴표로 감싼다 — core.quotePath
 *  문서가 말하는 "unusual byte(0x80 이상)" 대상이 아닌데도 실측상 그렇다(-z를 쓰지 않는 한 끌
 *  방법이 없다). 감싸지 않은 이름은 그대로 돌려준다. */
function unquotePath(p: string): string {
  return p.length >= 2 && p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p
}

/** git status --short 한 줄에서 상태 코드 2글자 + 구분 공백을 떼고 경로만 남긴다.
 *  status.ts의 parsePorcelainZ와 달리 여기서는 파일 상태(new/modified/...)를 담지 않는다 —
 *  Checkpoint가 필요로 하는 것은 "무엇이 바뀌었나"뿐이다(브리핑 표에 상태 코드 칸이 없다).
 *
 *  rename/copy는 "old -> new" 형태로 온다 — 그대로 두면 파일 하나가 아니라 존재하지 않는 문자열
 *  하나가 changed에 들어가고, 그 값은 Checkpoint.filesModified를 거쳐 재개 패킷까지 그대로
 *  흘러간다(fix round 1 — 리뷰가 잡은 값 오류). X 위치(줄의 첫 글자)만 확인한다 — status.ts의
 *  parsePorcelainZ와 같은 관례고, status --short는 unstaged rename을 감지하지 않으므로(수동
 *  mv는 D + ?? 두 줄로 나뉜다, git mv만 R로 나온다) 실전에서 R/C는 늘 그 자리에 온다. 화살표가
 *  새 경로 문자열 자체에 또 나오는 이름은 다루지 않는다 — 그 모호함을 완전히 없애려면 -z 포맷이
 *  필요한데, 이 함수는 브리핑이 지정한 대로 --short를 쓴다(status.ts의 "no guessing to recover"와
 *  같은 태도: 못 가르는 값은 더 틀리게 만들지 않고 있는 그대로 둔다). */
function changedPaths(shortStatus: string): string[] {
  if (shortStatus === '') return []
  const ARROW = ' -> '
  // trim:false로 받은 원본이라 마지막 줄 뒤에 개행이 남아 split이 빈 문자열을 하나 더 낳는다.
  return shortStatus
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const rest = line.slice(3).trim()
      const isRenameOrCopy = line[0] === 'R' || line[0] === 'C'
      const arrowIdx = rest.indexOf(ARROW)
      const raw = isRenameOrCopy && arrowIdx !== -1 ? rest.slice(arrowIdx + ARROW.length) : rest
      return unquotePath(raw)
    })
}

/**
 * 저장소 수준 git 요약 하나를 읽는다. 워크트리가 사라졌거나, 그 경로가 git 저장소가 아니거나,
 * git 이 PATH 에 없으면 — 즉 `rev-parse HEAD` 조차 안 되면 — 전체를 null 로 돌린다. 재개를 만드는
 * 쪽(Task 4)은 그 null 을 "이 절은 비운다"로만 받아들이고 재개 자체를 막지 않는다.
 *
 * `rev-parse HEAD` 가 성공한 뒤로는(= 유효한 저장소가 확인된 뒤로는) 나머지 세 번의 호출은 필드
 * 단위로만 실패를 흡수한다 — branch/diffstat 은 그 필드만 null, changed 는 빈 배열(타입이
 * `string[]` 이라 "모른다"를 표현할 자리가 없다; 실패와 "변경 없음"이 같은 값으로 접힌다).
 * 절대 던지지 않는다. (exit 실패인데 stdout에 내용이 남는 경우를 실제 git으로 안정적으로
 * 재현할 수 없어서, 이 가드가 실제로 지키는지는 gitSummary.test.ts가 git을 주입해 고정한다.)
 */
export async function readGitSummary(
  cwd: string,
  deps: GitSummaryDeps = {}
): Promise<GitSummary | null> {
  const run = deps.git ?? git
  const head = await run(['rev-parse', 'HEAD'], { cwd })
  if (!head.ok || head.stdout === '') return null

  const [branch, status, diffstat] = await Promise.all([
    run(['branch', '--show-current'], { cwd }),
    // porcelain: 상태 코드 두 글자가 앞쪽 공백일 수 있다(" M f.txt") — trim:true(기본값)면 그
    // 선행 공백이 통째로 날아가 changedPaths의 고정폭 slice(3)가 어긋난다.
    run(['status', '--short'], { cwd, trim: false }),
    run(['diff', '--stat'], { cwd })
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
