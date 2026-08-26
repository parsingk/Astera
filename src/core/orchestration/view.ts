// Read-only projections of OrchState for the Jobs sidebar. The renderer has no test environment
// (vitest runs environment: 'node', no jsdom), so every judgement the view needs lives here.
//
// This module is main-side, not renderer-side: it imports isSamePath and repoPathOf, both of which
// pull in node:path, so it must not be added to tsconfig.web.json's include. The renderer never
// calls these functions directly — it consumes the already-folded OrchSnapshot snapshotFor returns,
// which the 'orch.list' handler and the 'orch:state' push (src/main/ipc.ts) both hand across the
// bridge.
// Adding this file to the web tsconfig to make an import resolve is the wrong fix; it
// either fails (files/tree.ts's node:path import has no declarations there) or "succeeds" by adding
// "types": ["node"], which loosens the guard that keeps Node globals out of the renderer typecheck.
import { isSamePath } from '../files/tree'
import { runsWorkingIn, runWorktrees } from './integrate'
import type { JobRun, JobTask, OrchSnapshot, RunOutcome, WorktreeInfo } from '../types'
import { repoPathOf } from '../worktrees/repo'
import type { OrchState } from './state'
import { eventCountFor } from './timeline'
import { FAILURE_LIMIT } from './types'
import type { Run, Task } from './types'

/** 한 프로젝트에 속한 Run 들, 최신순.
 *
 *  끝난 Run 을 아래로 보내는 것은 여기가 아니라 snapshotFor 다 — 그 판정(outcomeOf)이 Task 를
 *  읽어야 하는데 이 함수는 Run 만 돌려준다.
 *
 *  Matching is isSamePath rather than ===: Run.cwd is the project root even when the Run works in
 *  its own worktree (Run.worktree holds that, and this comparison deliberately does not look at it —
 *  a Run belongs to the project it was created for), but the same path can arrive with a different drive
 *  letter or casing on win32, and a string compare would silently drop the Run from the list.
 *  isPathWithin (base-or-below) is the wrong shape here, not just a stricter one than needed:
 *  orchestration.json is a single app-wide store, not scoped per project, and nothing constrains
 *  what --cwd a Run is created with, so "at or below" would also match a Run whose cwd is a nested
 *  repository below this project root — a Run that belongs to that nested project, not this one.
 *
 *  r.cwd 는 비교 전에 repoPathOf 를 통과한다 — **양쪽을 같은 방식으로 정규화하는 것**이 요점이다.
 *  'orch.list' 는 렌더러가 보낸 경로에 이미 repoPathOf 를 걸어 저장소 경로로 만들어 두는데
 *  (src/main/ipc.ts), 워크트리 안에서 만들어진 Run 은 cwd 가 워크트리 그대로다. 워크트리는
 *  레지스트리 루트(기본 ~/astera-worktrees) 아래, 저장소 **밖**에 있어서 저장 시점의 정규화
 *  (projectRootOf)가 닿지 않으므로, 여기서 되돌리지 않으면 그 Run 은 저장소 탭에서도 워크트리
 *  탭에서도 보이지 않는다. repoPathOf 는 등록된 워크트리에 대한 정확 일치 조회이고 나머지 경로는
 *  그대로 통과시키므로, 이 정규화가 소유 판정을 넓히지는 않는다.
 *
 *  worktrees 를 주입받는 이유는 snapshotFor 의 isKnownSession 과 같다 — 레지스트리는 main 의
 *  것이고(core.worktrees) 이 층은 프레임워크에 의존하지 않는다. */
export function runsForProject(
  state: OrchState,
  projectPath: string,
  worktrees: WorktreeInfo[]
): Run[] {
  return state.runs
    .filter((r) => isSamePath(projectPath, repoPathOf(worktrees, r.cwd)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Completed Tasks over total Tasks, unweighted.
 *
 *  'failed' does not count as done: a Task can still be retried until consecutiveFailures reaches
 *  FAILURE_LIMIT, and counting it would make the bar run ahead and then fall back on the next
 *  attempt. (The direction document's mock reads "5/7 … 78%"; 5/7 is 71% — the ratio here is the
 *  plain one, not that figure.) */
export function progressOf(state: OrchState, runId: string): { done: number; total: number } {
  const tasks = state.tasks.filter((t) => t.runId === runId)
  return { done: tasks.filter((t) => t.status === 'completed').length, total: tasks.length }
}

/** Task 가 더 움직이지 않는가.
 *
 *  failed 는 그것만으로 terminal 이 아니다 — 전이표(types.ts)의 `failed: ['dispatched', 'blocked']`
 *  가 말하듯 실패한 Task 는 재시도되고, 그것이 FAILURE_LIMIT 까지의 정상 흐름이다. 바로 위
 *  progressOf 가 같은 이유로 failed 를 완료로 세지 않는다. 재시도가 소진되어야(연속 실패가
 *  FAILURE_LIMIT) 더 움직이지 않는다. */
const isTerminal = (t: Task): boolean =>
  t.status === 'completed' || (t.status === 'failed' && t.consecutiveFailures >= FAILURE_LIMIT)

/** Run 이 끝났는지, 끝났다면 성공인지 실패인지.
 *
 *  **저장된 값이 아니라 파생이다.** 명시적인 close 명령을 두면 코디네이터가 그것을 부른다는
 *  규율에 기대게 되고, 잊으면 화면은 지금과 똑같아진다.
 *
 *  terminal 의 정의는 store.ts 의 TTL 정리와 **일부러 다르다.** 그쪽은 30일간 아무 일도 없었던
 *  Run 을 버릴지 정하는 자리라 재시도 중인 Task 가 있을 수 없고, 재시도가 남았는지 여부가 결과를
 *  바꾸지 않는다. 여기는 지금 도는 Run 에 라벨을 붙이는 자리다 — 두 번째 시도를 기다리는 Task 를
 *  '실패'로 적으면 다음 시도에서 라벨이 사라진다. 같은 상수로 묶지 말 것.
 *
 *  Task 가 없으면 running: Run 만 만들고 Task 를 아직 만들지 않은 상태가 정상적인 시작 지점이다.
 *  every 는 빈 배열에 참이므로, 이 가드가 없으면 방금 만든 Run 이 completed 로 보인다.
 *  (store.ts 가 같은 이유로 own.length > 0 을 두고 있다.)
 *
 *  failed 가 completed 를 이긴다 — 사람이 손봐야 하는 Run 을 목록에서 바로 찾을 수 있어야 한다.
 *
 *  대가: 모두 끝난 뒤 Task 가 추가되면 completed 가 running 으로 되돌아간다. 진행률 숫자도 같은
 *  방식으로 움직이므로 정직한 표시라고 본다. */
export function outcomeOf(state: OrchState, runId: string): RunOutcome {
  const tasks = state.tasks.filter((t) => t.runId === runId)
  if (tasks.length === 0) return 'running'
  if (!tasks.every(isTerminal)) return 'running'
  return tasks.some((t) => t.status === 'failed') ? 'failed' : 'completed'
}

/** One Task row.
 *
 *  sessionId comes from the Task's most recent Dispatch, not from the open one: a retry opens a new
 *  Dispatch for the same Task, and a finished worker's session is still the session this row points
 *  at. It is dropped unless isKnownSession accepts it — that predicate asks whether **this process
 *  still has a session under that id**, which excludes exactly two things:
 *
 *  - the `pending:<hex>` placeholder worker-start commits before the coordinator has produced a real
 *    session id (server.ts) — that value names no session and would otherwise reach the renderer on
 *    every dispatch, for as long as the spawn and the worktree take;
 *  - a Dispatch left over from a previous app run — orchestration.json outlives the process, the
 *    session map does not.
 *
 *  It is **not** a liveness check and must not be read as one. A worker that exited keeps its entry
 *  in the session map (SessionManager only flips status to 'exited'; nothing is ever removed), so its
 *  tab is still there and its row stays clickable — which is what the user wants after a worker
 *  finishes. worker-release kills the PTY, and that lands in the same place: still listed, still
 *  clickable.
 *
 *  provider and startedAt are a separate lookup, and separate on purpose: they answer "is this
 *  running right now", so they come from the **open** Dispatch, while sessionId answers "what tab
 *  does this row open" and keeps pointing at the most recent Dispatch even once it has ended.
 *
 *  **The two lookups always land on the same record when either finds one**, and that is not a
 *  coincidence worth removing: openDispatch and openReviewDispatch both reject a Task that already
 *  has an open Dispatch (state.ts), so a retry can only start after the previous attempt ended and
 *  its startedAt is therefore always the largest. What actually differs is the *absence* — once
 *  nothing is running, provider and startedAt vanish while sessionId stays. That is the behaviour
 *  the sidebar needs: the badge and the clock must disappear the moment the work stops, well before
 *  the tab they sat next to stops being worth opening. Keeping the lookups apart is how each one
 *  says what it means rather than what it happens to equal. */
function jobTaskOf(
  state: OrchState,
  task: Task,
  isKnownSession: (sessionId: string) => boolean
): JobTask {
  const dispatches = state.dispatches
    .filter((d) => d.taskId === task.id)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const latest = dispatches[dispatches.length - 1]
  // 열린 Dispatch 만이 "지금 도는 중"을 말할 수 있다. 위 주석대로 이것은 latest 와 같은 레코드가
  // 되지만, 같아지는 것이 규칙(Task 당 열린 Dispatch 하나)의 결과일 뿐이므로 뜻이 다른 두 조회를
  // 하나로 합치지 않는다 — 합치면 그 규칙이 바뀌는 날 조용히 틀린다.
  const running = dispatches.find((d) => !d.outcome && !d.endedAt)
  const open = state.gates
    .filter((g) => g.taskId === task.id && g.status === 'open')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.accountIds !== undefined ? { accountIds: task.accountIds } : {}),
    sessionId: latest && isKnownSession(latest.sessionId) ? latest.sessionId : undefined,
    // The oldest open Gate is the one the orchestrator has to answer first, so that is the one the
    // row shows and the one the answer form resolves. openGates carries the rest as a count rather
    // than a second question. id 가 함께 가는 이유는 gate-resolve 가 그것을 요구하기 때문이고,
    // options 는 코디네이터가 고를 것을 준 경우다 — 셋이 한 묶음인 이유는 JobTask.gate 의 주석에 있다.
    ...(open[0]
      ? {
          gate: {
            id: open[0].id,
            question: open[0].question,
            ...(open[0].options ? { options: open[0].options } : {})
          }
        }
      : {}),
    openGates: open.length,
    ...(running ? { provider: running.provider, startedAt: running.startedAt } : {})
  }
}

/** The whole Jobs sidebar payload for one project — what both 'orch.list' and the 'orch:state' push
 *  send. Folding here rather than in the IPC layer is what makes these rules testable: src/main/ipc.ts
 *  imports electron at line 1 and exposes nothing but registerIpc(core, win, …), so a function defined
 *  inside it cannot be reached by a test at all. That is a property of **that file**, not of main —
 *  vitest.config.ts includes main's test files as well and 32 of them exist. The renderer is the
 *  layer with no test environment at all (vitest runs environment: 'node', no jsdom).
 *
 *  isKnownSession is injected because session ownership belongs to main (core.sessions.list()) and
 *  this layer is framework-free. worktrees is injected for the same reason — the registry is
 *  core.worktrees, and runsForProject needs it to map a worktree-rooted Run.cwd back to its
 *  repository (see there). nextFireOf is injected for the same reason again — a template's next
 *  fire time lives in the ticker's memory, not in OrchState. */
export function snapshotFor(
  state: OrchState,
  projectPath: string,
  isKnownSession: (sessionId: string) => boolean,
  worktrees: WorktreeInfo[],
  /** 예약 템플릿의 다음 발화 시각(epoch ms), 없으면 null. **상태에 없는 값이라 주입된다** —
   *  무장은 ticker 의 메모리에 있다(src/main/ipc.ts). isKnownSession 과 같은 갈래다. */
  nextFireOf: (runId: string) => number | null,
  /** 그 폴더가 아직 있는가. **상태에 없는 값이라 주입된다** — Dispatch 의 cwd 는 워크트리를 지운 뒤에도
   *  상태에 남으므로 runWorktrees 는 이미 사라진 폴더를 계속 낸다. 걸러내지 않으면 삭제 확인 창이
   *  "워크트리 3개" 라고 말하면서 실제로는 두 개만 있는 일이 생긴다(그렇게 보고됐다).
   *
   *  레지스트리가 아니라 **존재**를 묻는다. 레지스트리는 앱이 만든 것만 알아서, 오케스트레이터가
   *  직접 만들어 워커를 넣은 워크트리를 빠뜨린다 — 그것도 사람이 지우고 합칠 수 있는 폴더다.
   *  isKnownSession·nextFireOf 와 같은 갈래로 주입받는다(이 층은 fs 를 만지지 않는다). */
  exists: (path: string) => boolean
): OrchSnapshot {
  // 폴더 사실을 **한 번만** 센다 — Run 마다 다시 세면 같은 순회가 Run 수만큼 돌고, 그보다 나쁜
  // 것은 두 값(폴더 수준과 Run 수준)이 다른 순간의 상태를 볼 수 있다는 것이다.
  const workingHere = runsWorkingIn(state, projectPath)
  const runs = runsForProject(state, projectPath, worktrees).map((run): JobRun => {
    const { done, total } = progressOf(state, run.id)
    const worktreesOf = runWorktrees(state, run.id).filter(exists)
    return {
      id: run.id,
      objective: run.objective,
      // Run 이 그대로 들고 있는 값을 그대로 옮긴다 — 계산도 기본값도 여기서 넣지 않는다(JobRun
      // 의 주석과 같다). worker-start 에 --agent/--account 를 채우는 일과 워크트리 배치 규칙
      // (동시 실행 한도가 1 이하일 때만 프로젝트 폴더)의 판단은 이 값을 받은 렌더러가 한다.
      provider: run.provider,
      concurrency: run.concurrency,
      outcome: outcomeOf(state, run.id),
      done,
      total,
      eventCount: eventCountFor(state, run.id),
      // 내가 그 폴더에 있고, 나 말고도 있는가. 크기만 보면 남의 얽힘까지 내 줄에 그리게 된다
      sharesProjectFolder: workingHere.has(run.id) && workingHere.size > 1,
      ...(run.pendingStart ? { pendingStart: true } : {}),
      ...(run.paused ? { paused: true } : {}),
      // 빈 배열은 싣지 않는다 — sameSnapshot 의 문자열을 이유 없이 늘리고, "워크트리를 안 썼다" 와
      // "이 칸이 없다" 가 화면에서 같은 뜻이다(JobRun.children 과 같은 판단)
      ...(worktreesOf.length > 0 ? { worktrees: worktreesOf } : {}),
      ...(run.schedule ? { schedule: run.schedule } : {}),
      ...(run.fireCount !== undefined ? { fireCount: run.fireCount } : {}),
      ...(run.fireOrdinal !== undefined ? { fireOrdinal: run.fireOrdinal } : {}),
      ...(run.schedule && nextFireOf(run.id) !== null
        ? { nextFireAt: nextFireOf(run.id) as number }
        : {}),
      // createdAt ascending — the order the orchestrator declared the Tasks in, which is the order
      // the dependency chain reads in. Task.deps is not a total order, so it cannot sort this.
      tasks: state.tasks
        .filter((t) => t.runId === run.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((t) => jobTaskOf(state, t, isKnownSession))
    }
  })
  // 회차를 템플릿 밑으로 접는다. **최상위에서 빠지지만 사라지지는 않는다** — 이 프로젝트에 부모가
  // 없는 회차(템플릿의 cwd 가 바뀌었거나 손으로 고친 파일)는 그대로 최상위에 남는다: 삼키면
  // 목록에서 사라지고, 그 Run 을 지울 문도 없어진다.
  const byId = new Map(runs.map((r) => [r.id, r]))
  const parented = new Set<string>()
  for (const r of runs) {
    const parentId = state.runs.find((x) => x.id === r.id)?.templateId
    if (parentId === undefined) continue
    const parent = byId.get(parentId)
    if (!parent) continue
    // runsForProject 가 이미 최신순으로 정렬해 두었으므로 순서대로 밀어 넣으면 최신순이 된다
    parent.children = [...(parent.children ?? []), r]
    parented.add(r.id)
  }
  const top = runs.filter((r) => !parented.has(r.id))
  // 도는 Run 이 먼저. runsForProject 가 이미 최신순으로 정렬해 두었고 Array.prototype.sort 는
  // 안정 정렬이라, 같은 그룹 안의 최신순은 이 단계에서 보존된다.
  //
  // 템플릿은 언제나 이 앞 묶음에 들어간다 — outcomeOf 가 배치되지 않는 Task 를 terminal 로 보지
  // 않아 늘 'running' 을 준다. 우연이지만 원하는 자리다: 예약은 지금 도는 것과 함께 위에 있어야
  // 하고, 아래로 내려가면 회차가 쌓일수록 정의를 찾기 어려워진다.
  return {
    runs: top.sort((a, b) => {
      const ar = a.outcome === 'running'
      const br = b.outcome === 'running'
      return ar === br ? 0 : ar ? -1 : 1
    }),
    projectFolderBusy: workingHere.size > 0
  }
}

/** Whether two folds show the same thing — the guard that keeps a push from going out when nothing
 *  the view can see has changed.
 *
 *  Most orchestration writes still do not touch this projection: a heartbeat, a Delivery being taken
 *  or acknowledged. All of them commit state, and the push hangs off every commit (src/main/ipc.ts),
 *  so without this the sidebar is re-sent constantly with an identical payload. Comparing the result
 *  instead of debouncing the trigger kills the whole class and has nothing to tune.
 *
 *  **A status message is deliberately no longer in that list.** JobRun.eventCount counts the
 *  timeline's events, so any message that becomes an event changes this fold and lets the push
 *  through — that is the point of the field (see there), because a question or a progress report
 *  moves no Task status and would otherwise never reach the renderer. heartbeat is excluded from the
 *  count for exactly this reason (core/orchestration/timeline.ts's SKIP).
 *
 *  **This is a serialized compare, and it is only sound for values snapshotFor built.** JSON.stringify
 *  is key-order sensitive, and what makes that safe here is that both sides come out of the object
 *  literals above, so the key order is fixed by this file rather than by the caller. An absent
 *  optional (sessionId, gateQuestion) is dropped from the string entirely, which is still correct —
 *  it can only be dropped on both sides at once, and any change into or out of undefined changes the
 *  string. If this ever has to compare snapshots from another source, replace it with a structural
 *  compare rather than trying to normalise the input. */
export const sameSnapshot = (a: OrchSnapshot, b: OrchSnapshot): boolean =>
  JSON.stringify(a) === JSON.stringify(b)
