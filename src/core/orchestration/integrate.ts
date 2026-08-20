// 워크트리에서 끝난 일을 프로젝트 폴더로 합쳐야 하는가에 대한 **순수 판정**. git 을 부르지 않고
// fs 도 만지지 않는다 — 상태만 보고 답하므로 테스트가 되고, 실제 병합(그리고 그 실패의 되돌리기)은
// 배선(src/main/ipc.ts)이 한다. slotsToFill 이 지키는 것과 같은 경계다.
//
// **판정이 먼저이고 git 이 나중인 이유는 값이다.** runScheduler 는 모든 setState 뒤에 돌고 그 대부분은
// 띄울 것이 없는 저장이다. pendingMerges 가 비면 git 프로세스가 하나도 뜨지 않는다 — 저장마다 git 을
// 두세 번 부르면 상태를 쓰는 모든 명령이 그만큼 느려진다(같은 이유로 그 루프는 슬롯이 없을 때 계정
// 조회 앞에서 빠진다).
import { isSamePath } from '../files/tree'
import type { OrchState } from './state'
import type { Task } from './types'

/** 의존 하나가 남긴 워크트리 — 그 의존 Task 의 id 와 그것이 돌았던 폴더 */
interface WorktreeDep {
  taskId: string
  cwd: string
}

/** 이 Task 의 의존들이 프로젝트 폴더 밖에 남긴, **끝난** 작업들.
 *
 *  "워크트리에서 돌았다"의 신호는 `dispatch.cwd` 가 `run.cwd` 가 아니라는 것이다. Run 이나 Dispatch 에
 *  따로 표시를 두지 않은 이유는 그것이 이미 사실이기 때문이다 — 두 번째 표시를 두면 둘이 갈라졌을 때
 *  어느 쪽이 맞는지 알 수 없다(coordinator.ts 가 커밋 의무를 a.worktree 가 아니라 확정된 cwd 에서
 *  유도하는 것과 같은 판단이다).
 *
 *  비교는 `!==` 가 아니라 `isSamePath` 다. 두 값은 따로 기록된다 — `Run.cwd` 는 run-create 가, 그
 *  Dispatch 의 cwd 는 createWorktree 나 worker-start 가 넣는다 — 그래서 같은 폴더를 대소문자나
 *  구분자만 다르게 적을 수 있다(Windows 드라이브 문자가 `d:` 와 `D:` 로 갈리는 경우가 그것이다).
 *  `!==` 로 비교하면 그때마다 있지도 않은 병합 대상이 생겨 통합 Task 가 헛으로 만들어진다.
 *  두 값이 모두 절대경로이므로 이 정규화는 결정적이다(path.resolve 가 cwd 를 끌어오지 않는다).
 *
 *  **끝나지 않은 Dispatch 는 세지 않는다** — 커밋 의무는 일이 끝날 때 이행되므로 아직 합칠 것이 없고,
 *  합칠 것이 없는데 통합 Task 를 만들면 그 Task 는 빈 병합을 하게 된다.
 *
 *  **끝난 것은 outcome 을 가리지 않는다.** 실패를 보고한 Dispatch 도 그 워크트리 브랜치에 커밋을 남길
 *  수 있고(에이전트가 커밋한 뒤 실패를 보고하는 순서다), 그 커밋을 두고 다음 Task 를 띄우면 그래프가
 *  "완료"라고 말하는 일이 프로젝트 폴더에 없다. `outcome === 'succeeded'` 로 좁히면 사람이
 *  `task-update --status completed` 로 손수 완료시킨 Task(성공한 Dispatch 가 하나도 없다)의
 *  워크트리를 통째로 빠뜨린다. */
function worktreeDeps(s: OrchState, taskId: string): WorktreeDep[] {
  const task = s.tasks.find((t) => t.id === taskId)
  if (!task) return []
  // Run 이 없으면 무엇과 비교해야 할지 알 수 없다. 명령으로는 만들 수 없는 조합이지만 입력은 명령이
  // 아니라 파일이다 — orchestration.json 은 프로세스보다 오래 살고 손으로 고쳐진다(schedule.ts 가
  // provider 없는 Run 을 건너뛰는 것과 같은 이유다).
  const run = s.runs.find((r) => r.id === task.runId)
  if (!run) return []
  const found: WorktreeDep[] = []
  // deps 순서로 걷는다 — 병합 순서가 되고, 같은 입력에 같은 순서여야 한다
  for (const depId of task.deps) {
    for (const d of s.dispatches) {
      if (d.taskId !== depId) continue
      // "아직 열려 있다"의 판정은 이 저장소의 것을 그대로 쓴다(schedule.ts 의 slotsToFill,
      // server.ts 의 worker-start). 두 번째 정의를 만들면 둘이 갈라진다.
      if (!d.outcome && !d.endedAt) continue
      if (isSamePath(d.cwd, run.cwd)) continue
      found.push({ taskId: depId, cwd: d.cwd })
    }
  }
  return found
}

/** 이 Task 를 띄우기 전에 프로젝트 폴더로 합쳐야 하는 워크트리들. 비어 있으면 그대로 띄운다.
 *
 *  **같은 워크트리는 하나로 합친다.** 한 Task 에 Dispatch 가 둘일 수 있다(재시도, 그리고 구현자가
 *  일한 트리에서 도는 검토 Dispatch) — 같은 폴더를 두 번 병합하는 것은 두 번째가 "Already up to
 *  date" 로 끝나므로 해롭지는 않지만, 통합 Task 의 spec 에 같은 줄이 두 번 실리면 그것을 읽는
 *  에이전트가 무엇이 다른지 찾느라 시간을 쓴다. 중복 판정은 Set 이 아니라 isSamePath 로 한다 —
 *  대소문자만 다른 두 값이 다른 것으로 남으면 애초에 이 함수가 막으려던 헛 병합이 그대로 생긴다.
 *  돌려주는 문자열은 처음 만난 쪽의 원래 값이다(정규화한 값을 주면 실제로 존재하지 않는 대소문자의
 *  경로를 git 에 넘기게 된다). */
export function pendingMerges(s: OrchState, taskId: string): string[] {
  const out: string[] = []
  for (const w of worktreeDeps(s, taskId)) {
    if (!out.some((p) => isSamePath(p, w.cwd))) out.push(w.cwd)
  }
  return out
}

/** 그 워크트리들을 남긴 의존 Task 들의 id. 통합 Task 의 `deps` 가 된다 — 그래프에서 통합 Task 가
 *  무엇을 합치는지 보이게 하는 것이 그 deps 의 유일한 일이다(모두 이미 completed 이므로 준비 판정을
 *  바꾸지는 않는다).
 *
 *  pendingMerges 와 같은 걸음을 두 번 걷지 않고 worktreeDeps 를 함께 쓴다 — 둘이 갈라지면 통합 Task 의
 *  deps 가 그 Task 가 실제로 합칠 워크트리와 어긋나고, 그것은 그래프가 거짓말을 하는 것이다. */
export function worktreeDepsOf(s: OrchState, taskId: string): string[] {
  return [...new Set(worktreeDeps(s, taskId).map((w) => w.taskId))]
}

/** 이 Task 를 기다리게 만든, 이미 있는 통합 Task. 있으면 **새로 만들지 않는다.**
 *
 *  표식은 `parentId` 다. 이것이 없으면 통합 Task 가 무한히 늘어난다: 병합을 기다리는 Task 는 통합
 *  Task 가 생긴 뒤에도 `ready` 로 남고(이미 있는 Task 의 deps 를 고치는 명령은 일부러 없다 — 그
 *  부재가 순환을 구조적으로 불가능하게 만든다), 스케줄러의 `attempted` 는 한 활성화 안에서만
 *  막으므로, 규칙이 없으면 **상태가 바뀔 때마다 통합 Task 가 하나씩 새로 생긴다.**
 *
 *  `deps` 집합을 비교해서 알아내지 않는다 — 기다리는 Task 와 그 형제들은 같은 deps 를 가질 수 있고,
 *  거기서 나온 거짓 양성은 통합 Task 가 **영원히 만들어지지 않는다**는 뜻이 된다(조용한 정지).
 *
 *  `parentId` 는 이 저장소에서 지금까지 쓰기만 하고 읽는 곳이 없었다(state.ts 가 존재만 검증한다).
 *  그래서 이 판정이 그 필드의 첫 독자다. 첫 독자가 되면서 그 필드는 **앱의 것으로 예약된다** —
 *  오케스트레이션 가이드 §4.2 에서 `--parent` 를 문법에서 빼고 그 예약을 적었다(server.ts 는 계속
 *  그 인자를 받는다: 제거가 아니라 광고 중단이다. 이 변경 전까지 아무도 읽지 않던 필드라 되돌아갈
 *  동작이 없다). 그래도 코디네이터가 그 인자를 쓰면 그 하위 Task 를 통합 Task 로 잘못 보고 새
 *  통합 Task 를 만들지 않는다 — 그 대가를 받는 이유는 반대 방향의 실패가 훨씬 나쁘기 때문이다:
 *  표식이 없으면 저장 한 번마다 Task 가 하나씩 늘어난다. */
export function integrationTaskFor(s: OrchState, taskId: string): Task | undefined {
  return s.tasks.find((t) => t.parentId === taskId)
}

/** 앱이 만든 통합 Task 인가. 통합 Task 자신은 통합 단계를 지나지 않는다.
 *
 *  **이것이 없으면 스케줄러가 통합 Task 를 끝없이 만든다.** 통합 Task 의 deps 는 그 워크트리 Task
 *  들이므로 통합 Task 자신에 대한 `pendingMerges` 도 비어 있지 않다 — 그것을 슬롯으로 집으면 그
 *  Task 를 위한 통합 Task 를 또 만들고, 그 Task 를 위한 것을 또 만든다. `attempted` 는 매번 새로
 *  생기는 id 를 막지 못하므로 한 활성화 안에서 do-while 이 영원히 돈다.
 *
 *  판정은 `integrationTaskFor` 의 뒤집은 짝이다(같은 필드를 본다) — 두 방향이 다른 표식을 보면
 *  갈라진다. */
export function isIntegrationTask(t: Task): boolean {
  return !!t.parentId
}

/** 지금 그 폴더에서 일하고 있는 워커들의 Run id.
 *
 *  **이 파일의 폴더 판정은 전부 여기서 나온다.** 부르는 쪽의 질문이 셋인데 답의 재료는 하나다:
 *  - 앱이 병합해도 되는가 → 비었는가 (workingInProjectFolder, 아래)
 *  - 이 폴더에 이미 누가 있는가 → 비었는가 (새 Run 을 만들 때 — 그 Run 은 아직 없으므로 Run 별로
 *    물을 수 없다)
 *  - 이 Run 이 남과 나눠 쓰는가 → 내가 들어 있고 크기가 2 이상인가
 *  셋을 각각 순회로 쓰면 "무엇을 세는가"가 세 벌이 되고, 그중 하나만 고쳐지는 날 화면과 병합
 *  판정이 서로 다른 말을 한다.
 *
 *  **Run 이 아니라 폴더로 센다.** 두 Run 이 같은 cwd 를 가질 수 있고(사이드바로 만든 Run 은 cwd 가
 *  프로젝트 루트로 정규화된다), 그때 위험한 것은 같은 폴더에서 도는 워커이지 같은 Run 에 속한
 *  워커가 아니다.
 *
 *  Task 를 찾지 못한 Dispatch 는 세지 않는다 — 어느 Run 것인지 말할 수 없는 것을 어느 Run 의
 *  것으로도 세면 안 된다. */
export function runsWorkingIn(s: OrchState, cwd: string): Set<string> {
  const runIds = new Set<string>()
  for (const d of s.dispatches) {
    if (d.outcome || d.endedAt || !isSamePath(d.cwd, cwd)) continue
    const runId = s.tasks.find((t) => t.id === d.taskId)?.runId
    if (runId !== undefined) runIds.add(runId)
  }
  return runIds
}

/** 지금 프로젝트 폴더에서 일하고 있는 워커가 있는가. 있으면 **앱은 병합하지 않는다.**
 *
 *  병합은 작업 트리를 바꾼다. 워커가 그 폴더에서 파일을 읽고 고치는 중에 앱이 그 아래에서 파일을
 *  갈아치우면, 그 워커는 자기가 읽은 것과 다른 트리에 편집을 얹는다 — 그 실패는 조용하고 되짚기
 *  어렵다. 통합 Task 자체가 프로젝트 폴더에서 도는 유일한 워커이므로(ipc.ts 의 배치 예외), 실제로
 *  이것이 막는 것은 "통합 에이전트가 합치는 중에 앱이 다른 접합점을 합치는" 경우다. */
export function workingInProjectFolder(s: OrchState, runId: string): boolean {
  const run = s.runs.find((r) => r.id === runId)
  if (!run) return false
  return runsWorkingIn(s, run.cwd).size > 0
}

/** 통합 Task 의 spec 본문. **영어다** — 이것을 읽는 것은 사람이 아니라 에이전트이고, 같은 이유로
 *  buildSpecFile 의 보고·커밋 의무도 영어다. (제목은 그래프에 뜨는 사람의 것이라 한국어이고, 둘 다
 *  i18n 카탈로그에 넣지 않는다 — 그 카탈로그는 렌더러의 문구를 위한 것이고 이 글은 main 에서
 *  조립된다.)
 *
 *  판정과 같은 파일에 두는 이유: 이 글이 나열하는 워크트리는 정확히 `pendingMerges` 가 돌려준 것들
 *  이어야 한다. 두 곳에 나누어 두면 한쪽만 고쳐졌을 때 에이전트가 합치라고 받은 목록과 앱이 합쳤다고
 *  믿는 목록이 갈라진다. 순수 함수이므로 이 파일의 경계(git 도 fs 도 만지지 않는다)는 그대로다. */
export function buildIntegrationSpec(a: {
  /** 병합이 일어나야 하는 프로젝트 폴더. 통합 Task 는 여기서 돈다 */
  runCwd: string
  /** 앱이 스스로 합치지 않고 멈춘 이유. 영어로 온다(git 의 말이 그대로 실릴 수 있다) */
  reason: string
  /** 합칠 워크트리들. branch 가 null 이면 앱이 그 폴더의 브랜치를 알아내지 못했다는 뜻이다 */
  worktrees: { path: string; branch: string | null }[]
}): string {
  const steps = a.worktrees
    .map((w, i) =>
      w.branch
        ? `${i + 1}. git merge --no-edit refs/heads/${w.branch}\n` +
          `   (that branch is checked out in the worktree at ${w.path})`
        : `${i + 1}. The app could not work out which branch belongs to the worktree at ${w.path}.\n` +
          '   Find it with `git worktree list` and merge it the same way.'
    )
    .join('\n')

  return `Several tasks in this run finished their work in separate git worktrees, each on its own
branch. Their commits have to come back into the project folder before the next task can start. The
app does that merge itself when it can — this time it stopped and handed it to you.

Why the app stopped: ${a.reason}

The repository is at ${a.runCwd} and that is your working directory. The branch it is on right now is
the merge target: do not switch branches and do not create a new one.

Merge these, in this order:

${steps}

When a merge conflicts, resolve it so that **both sides' work survives** — every one of these
branches is a finished task, so dropping one silently throws that task's result away. Then finish the
merge:

  git add <the files you resolved>
  git commit --no-edit

Four rules make the rest of the run work:

- Never leave a merge undone. Do not \`git merge --abort\` and move on, and never \`git reset --hard\`.
  The app cannot tell "merged" from "gave up": the next task runs against whatever this folder
  contains, so an abandoned merge silently ships the wrong tree. If a branch truly cannot be merged,
  report a failure naming it instead.
- Leave the working tree clean. \`git status --porcelain\` must print nothing when you are done — the
  app refuses to merge on top of uncommitted changes, so anything left behind stops the whole run
  and calls a human.
- Do not delete or move the worktrees or their branches. The app owns their lifecycle.
- Do not redo any of the tasks' work, and do not improve the code you are merging. This task is the
  merge and nothing else.
`
}
