// 다 끝난 예약 회차의 워크트리를 걷어도 되는가에 대한 **순수 판정**. 실제 삭제는 배선이 한다
// (src/main/ipc.ts 의 reapWorktree) — integrate.ts 가 병합 판정과 실제 병합을 나눈 것과 같은 경계다.
//
// **왜 이 파일이 따로 있는가.** 이 판정은 outcomeOf(view.ts)와 runWorktrees(integrate.ts)를 함께
// 봐야 하는데, view.ts 가 integrate.ts 를 임포트한다. integrate.ts 에 두면 순환이 되고, view.ts 에
// 두면 "사이드바를 위한 읽기 전용 투영" 이라는 그 파일의 일과 어긋난다.
//
// main-side 다 — 두 임포트 모두 node:path 를 끌어온다. tsconfig.web.json 의 include 에 넣지 않는다.
import { runWorktrees } from './integrate'
import type { OrchState } from './state'
import { outcomeOf } from './view'

/** 워크트리를 걷어도 되는 예약 회차들과 그 폴더들.
 *
 *  **회차만이다**(`templateId`). 평범한 Run 의 폴더는 남긴다 — 사람이 결과를 보러 오고, 프로젝트로
 *  합치는 버튼도 그 폴더가 있어야 동작한다. 회차는 발화마다 하나씩 쌓이는 것이 문제였다.
 *
 *  **완료된 것만이다.** 실패한 회차의 폴더는 사람이 열어 볼 이유가 있다. 아직 도는 것은 말할 것도
 *  없다 — outcomeOf 가 그 둘을 각각 'failed' 와 'running' 으로 가른다.
 *
 *  **열린 Dispatch 가 없어야 한다.** outcomeOf 가 이미 모든 Task 가 terminal 이라고 말했으면 열린
 *  Dispatch 는 없어야 하지만, 둘은 따로 기록되는 사실이고 orchestration.json 은 손으로 고쳐진다.
 *  reapWorktree 가 세션을 다시 확인하기는 하나, 걷으려 **시도조차 하지 않는 것**이 로그를 읽을 수
 *  있게 한다(시도하고 거절된 것과 애초에 대상이 아닌 것은 다른 줄이어야 한다).
 *
 *  **합치지 않고 걷는다.** 회차가 한 일은 브랜치에 남는다 — removeWorktree 의 브랜치 삭제가
 *  `git branch -d`(합쳐지지 않은 브랜치는 거부) → 스쿼시 판정 → `-D` 순서라서, 합치지 않은 커밋이
 *  있으면 브랜치가 저절로 살아남고 결과의 branchPreserved 에 실려 온다. 예약은 도는 것 자체가
 *  목적이고 결과를 프로젝트로 가져오는 것은 사람이 고를 일이라는 결정이 여기 들어 있다.
 *
 *  폴더 목록은 runWorktrees 를 쓴다 — 삭제 경로가 쓰는 그 판정이다. Run 워크트리만 내면, 통합이
 *  실패해 아직 합쳐지지 않은 Task 워크트리가 그 회차에 남았을 때 그것이 영원히 쌓인다.
 *
 *  **isAppWorktree 로 걸러야 하는 이유는 이 판정이 끝나지 않는다는 것이다.** Dispatch 의 cwd 는
 *  워크트리를 지운 뒤에도 상태에 남으므로 runWorktrees 는 이미 걷힌 경로를 계속 낸다. 걸러내지 않으면
 *  부르는 쪽이 **저장마다** 같은 회차를 다시 걷으려 하고, reapWorktree 가 그때마다 "앱 워크트리가
 *  아니다" 를 한 줄 남긴다 — 5분마다 도는 예약이 있으면 그 줄이 끝없이 쌓인다. 레지스트리는 main 의
 *  것이라 판정만 받는다(snapshotFor 의 isKnownSession 과 같은 갈래). */
export function reapableChildRuns(
  s: OrchState,
  isAppWorktree: (path: string) => boolean
): Array<{ runId: string; worktrees: string[] }> {
  const out: Array<{ runId: string; worktrees: string[] }> = []
  for (const run of s.runs) {
    if (run.templateId === undefined) continue
    if (outcomeOf(s, run.id) !== 'completed') continue
    const taskIds = new Set(s.tasks.filter((t) => t.runId === run.id).map((t) => t.id))
    const open = s.dispatches.some((d) => taskIds.has(d.taskId) && !d.outcome && !d.endedAt)
    if (open) continue
    const worktrees = runWorktrees(s, run.id).filter(isAppWorktree)
    if (worktrees.length === 0) continue
    out.push({ runId: run.id, worktrees })
  }
  return out
}
