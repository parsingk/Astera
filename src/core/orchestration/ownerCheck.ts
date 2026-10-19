// The app's ownership check (main's orch.command door, ipc.ts `orchLocalCommand`): a command naming a Run, Task, Dispatch
// or Gate of another project than the one the window shows is refused before it runs. Moved here from main/ipc.ts so it
// is tested (G7a final review M3, which added the GitHub answers and reconverge: they now reach GitHub through the Host,
// where main's copy had stopped them with its own 409). Node-free.
import { resolveRunId, type OrchState } from './state'

// orch.command 의 args 에서 Run id·Task id·Dispatch id 를 읽는 키 — 명령마다 다르고, 짐작이 아니라
// server.ts 의 switch 를 다시 열어 확인한 값만 적었다: task-create 는 args.runId, run-start·
// run-merge 는 args.run, run-delete 는 args.id, task-update 는
// args.id, dispatch-show·gate-create 는 args.task, worker-start 는 args.taskId 를 먼저 보고 없으면
// args.task 를 본다(server.ts 의 handleCommand, 'worker-start' 분기), worker-stop 은 Task id 가 아니라 args.dispatch — Dispatch id
// 라 그 Dispatch 의 taskId 로 한 번 더 찾아야 Run 에 닿는다. 이 표들이 담는 것은 "id 를 나르는
// 모든 명령"이 아니라 지금 렌더러가 실제로 부르는 명령뿐이다 — 여기 없는 명령 중에도 id 를
// 나르는 것이 있다(task-list 는 args.run, gate-resolve 는 args.id, worker-show 는 args.dispatch
// 등). 새 호출부가 id 를 나르는 명령을 추가로 부르게 되면 그 키를 여기에 넣는다.
//
// **run-merge 가 이 문을 통과하는 첫 번째 "남의 프로젝트 폴더에서 git merge 를 돌리는 명령" 이다** —
// 그래서 run-start·run-delete 와 함께 여기 들어왔다. 그 셋이 없던 동안 orchOwnerMismatch 는 그
// args.run/args.id 를 아예 보지 않았고, 그것은 소유 판정이 있는 이유(다른 프로젝트의 Run 을 이
// 문으로 건드리지 못한다)가 가장 무거운 명령들에서만 비어 있었다는 뜻이다.
export const RUN_ID_ARG: Record<string, string> = {
  'task-create': 'runId',
  'run-start': 'run',
  'run-merge': 'run',
  'run-pause': 'run',
  'run-resume': 'run',
  'run-delete': 'id',
  // Phase 10: the renderer names the Run as `runId`; a file of another project's Run is not read through this door.
  'runs-changed-files': 'runId',
  'runs-diff': 'runId',
  // G7a final review M3: carrying a Run through GitHub again pushes its branch
  'runs-reconverge': 'id'
}
export const TASK_ID_ARG: Record<string, string[]> = {
  'task-update': ['id'],
  'dispatch-show': ['task'],
  'gate-create': ['task'],
  'worker-start': ['taskId', 'task']
}
export const DISPATCH_ID_ARG: Record<string, string> = { 'worker-stop': 'dispatch' }
/** G7a final review M3: an answer names its question, whose Task names the Run. A GitHub question's continue
 *  fast-forwards the Run from GitHub and rerun reruns its CI. */
export const GATE_ID_ARG: Record<string, string> = { 'gate-resolve': 'id', 'questions-answer': 'id' }

/** orch.command 가 받은 명령의 args 가 project 가 아닌 다른 프로젝트의 Run·Task·Dispatch 를
 *  가리키면 그 이유를 문자열로, 아니면 null 을 돌려준다.
 *
 *  **소유 판정을 복제하지 않는다** — orch.runDetail 이 이미 쓰는 runsForProject 를 그대로
 *  부른다(위 orch.runDetail 의 주석과 같은 이유: 규칙을 다시 쓰면 그 규칙이 막는 조합을 이
 *  door 가 통과시키는 우회로가 된다).
 *
 *  이 명령의 args 에 id 가 없거나(위 세 표에 그 명령이 없다), 있어도 그 id 를 가진 Run·Task·
 *  Dispatch 가 애초에 존재하지 않으면 null 이다 — 그것은 소유 판정이 아니라 '없는 id' 오류이고,
 *  handleCommand 자신이 이미 그 오류를 안다(예: task-update 의 `unknown task`). 여기서 막는 것은
 *  존재하는데 다른 프로젝트 것인 경우 하나뿐이다 — 그래서 지금 있는 아홉 호출부(NewTaskModal 의
 *  task-create, RunDetail 의 run-start·run-merge·worker-start·dispatch-show·worker-stop·
 *  task-update·gate-create, App 의 run-delete)는 모두 projectPath 와 짝이 맞는 id 를 보내므로 이
 *  판정을 통과한다. */
export function ownerMismatchOf(
  state: OrchState,
  project: string,
  /** The ids of the Runs and Jobs the project holds (ipc.ts `idsOfProject`, the same rule orch.runDetail uses). */
  owned: ReadonlySet<string>,
  cmd: string,
  args: Record<string, unknown>
): string | null {
  const strArg = (key: string): string | null => {
    const v = args[key]
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  const runBelongs = (id: string): boolean => owned.has(id)

  const runKey = RUN_ID_ARG[cmd]
  const named = runKey ? strArg(runKey) : null
  const runId = named ? (resolveRunId(state, named) ?? named) : null
  if (runId) {
    if (!state.runs.some((r) => r.id === runId)) return null
    return runBelongs(runId) ? null : `run ${runId} does not belong to ${project}`
  }

  const taskKeys = TASK_ID_ARG[cmd]
  const taskId = taskKeys ? (taskKeys.map(strArg).find((v) => v !== null) ?? null) : null
  if (taskId) {
    const task = state.tasks.find((t) => t.id === taskId)
    if (!task) return null
    return runBelongs(task.runId ?? task.jobId ?? '') ? null : `task ${taskId} does not belong to ${project}`
  }

  const dispatchKey = DISPATCH_ID_ARG[cmd]
  const dispatchId = dispatchKey ? strArg(dispatchKey) : null
  if (dispatchId) {
    const dispatch = state.dispatches.find((d) => d.id === dispatchId)
    const task = dispatch ? state.tasks.find((t) => t.id === dispatch.taskId) : undefined
    if (!task) return null
    return runBelongs(task.runId ?? task.jobId ?? '') ? null : `dispatch ${dispatchId} does not belong to ${project}`
  }

  const gateKey = GATE_ID_ARG[cmd]
  const gateId = gateKey ? strArg(gateKey) : null
  if (gateId) {
    const gate = state.gates.find((g) => g.id === gateId)
    const task = gate ? state.tasks.find((t) => t.id === gate.taskId) : undefined
    if (!task) return null
    return runBelongs(task.runId ?? task.jobId ?? '') ? null : `question ${gateId} does not belong to ${project}`
  }

  return null
}
