// 한 Task 가 **왜** 완료 정책을 못 넘었는가 — 화면이 펼쳐 보는 것의 투영.
//
// 스냅숏(JobTask)과 따로인 이유가 이 파일의 존재 이유다. 스냅숏은 오케스트레이션이 바뀔 때마다
// 사이드바로 푸시되므로 무거운 것을 실을 수 없고, 첫 조각의 U4 가 요약·이슈·의심 파일·출력 꼬리를
// 거기서 뺀 근거가 그것이다. 이것은 **사람이 펼칠 때 한 번** 가져가는 것이라 그 근거에 걸리지
// 않는다(설계 §1 의 W1).
//
// `task-list` 를 렌더러가 부르는 대신 전용 투영을 두는 이유(W2): 그 명령은 Run 의 모든 Task 를
// spec 본문째 넘긴다. 한 Task 의 꼬리를 보려고 그것을 전부 건너보내는 것은 U4 가 막으려던 무게
// 그대로이고, 남의 Task 내용까지 화면에 들어온다.
import type { ReviewIssue, Task } from './types'

/** 검사 하나 — 칩이 말하지 않는 것(왜 실패했는지)까지. */
export interface CompletionCheckDetail {
  configId: string
  name: string
  status: 'passed' | 'failed' | 'timed-out' | 'not-run'
  exitCode?: number
  /** 실패·타임아웃한 검사에만 있다. 통과한 검사는 애초에 꼬리를 저장하지 않는다(첫 조각 U2) —
   *  그래서 여기서 지우는 것이 아니라, 원래 없는 것을 그대로 옮긴다. */
  outputTail?: string
  unstable?: true
}

export interface CompletionDetail {
  taskId: string
  checks: CompletionCheckDetail[]
  /** 막는 이슈만 펼친다. 판단에 쓰이는 것이 이것이고, 막지 않는 것까지 늘어놓으면 막는 것이 묻힌다 */
  blockingIssues: ReviewIssue[]
  /** 막지 않는 이슈는 개수만 — 있다는 사실은 말한다. 리뷰어가 아무 말도 안 한 것과 다르다 */
  otherIssueCount: number
  /** 검사 설정을 건드린 파일(명세 §38). 리뷰어에게 넘어간 그 목록을 사람도 본다 */
  suspiciousFiles: string[]
}

/**
 * 보여 줄 것이 하나도 없으면 `null` — 검사도, 이슈도, 의심 파일도 없는 Task 다. 빈 블록을 열어
 * 두면 사람이 "아직 안 왔나" 와 "없다" 를 구별할 수 없다.
 *
 * 순수 함수이고 core 에 있는 이유는 첫 조각 U11 과 같다: 렌더러에는 테스트 환경이 없다.
 */
export function completionDetailOf(task: Task): CompletionDetail | null {
  const checks: CompletionCheckDetail[] = (task.checks ?? []).map((c) => ({
    configId: c.configId,
    name: c.name,
    status: c.status,
    ...(c.exitCode !== undefined ? { exitCode: c.exitCode } : {}),
    ...(c.outputTail !== undefined ? { outputTail: c.outputTail } : {}),
    ...(c.unstable ? { unstable: true as const } : {})
  }))
  const issues = task.reviewIssues ?? []
  const blockingIssues = issues.filter((i) => i.blocking)
  const suspiciousFiles = task.suspiciousFiles ?? []
  if (checks.length === 0 && issues.length === 0 && suspiciousFiles.length === 0) return null
  return {
    taskId: task.id,
    checks,
    blockingIssues,
    otherIssueCount: issues.length - blockingIssues.length,
    suspiciousFiles
  }
}

/**
 * Run 과 Task 를 함께 확인하고 투영한다 — `orch.completion` 핸들러의 판정 전부.
 *
 * Task 가 **그 Run 의 것인지** 보는 것이 핵심이다. 호출자가 Run 소유만 확인하고 taskId 를 믿으면,
 * 그 문이 남의 Run 의 Task 를 읽는 우회로가 된다. 없는 Task 와 남의 Task 를 같은 `null` 로 답하는
 * 것도 의도다: 이유를 구분해 주면 그 차이가 "그 Task 는 있다" 를 알려 주는 신호가 된다.
 *
 * 핸들러가 아니라 여기 있는 이유는 첫 조각 U11 과 같다 — main 의 ipcMain 핸들러에는 테스트가 붙지
 * 않는다(이 저장소에 orch 핸들러를 부르는 테스트 파일이 없다). 판정을 순수 함수로 내리면 그 판정만은
 * 고정된다.
 */
export function completionForTaskOf(tasks: readonly Task[], runId: string, taskId: string): CompletionDetail | null {
  const task = tasks.find((t) => t.id === taskId && t.runId === runId)
  return task ? completionDetailOf(task) : null
}
