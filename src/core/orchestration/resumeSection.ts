// Checkpoint -> Resume Packet. 결정론적 문자열 조립뿐이다 — LLM 호출이 전혀 없다(SPEC 9.1). 모양은
// DESIGN §8 의 Job Resume Packet 예시가 정본이고, 거기 없는 절(DEPENDENCIES·HUMAN
// DECISIONS·PREVIOUS WORKER REPORTS·REPORT WHEN DONE)은 이 Checkpoint 가 그 예시보다 더 많이 담고
// 있어서 늘린 것이다 — 옮겨 적지 않고 같은 라벨 관례(전부 대문자 절 이름, "- " 불릿)만 따른다.
//
// 이 파일도 순수하다. checkpoint.ts 의 타입만 가져온다.
import type { Checkpoint, CheckpointReport } from './checkpoint'
import type { WorkerState } from './types'

/** Packet 은 작아야 한다(SPEC 9.3) — diff 본문·소스·knowledge 파일 내용을 안 담는 대신, 남는
 *  자리를 잡아먹을 수 있는 유일한 가변 길이 절은 PREVIOUS WORKER REPORTS 다. 6000 자는 대략
 *  1500 토큰 안팎으로, 구조화된 절(목표·Task·의존성·변경 파일)이 다 들어가고도 보고 몇 개가
 *  들어갈 여유를 남긴다. */
export const MAX_PACKET_CHARS = 6000

const WORKER_STATE_TEXT: Record<WorkerState, string> = {
  ready: 'The previous worker session has no recorded stop yet.',
  failed: 'The previous worker session ended in a failed state.',
  stopped: 'The previous worker session ended (exit code 0).',
  outcome_unknown: 'The previous worker session ended, but the outcome could not be determined.'
}

function jobSection(c: Checkpoint): string {
  return `JOB\n${c.objective}`
}

function taskSection(c: Checkpoint): string {
  return `CURRENT TASK\n${c.taskTitle}\n\n${c.taskSpec}`
}

function dependenciesSection(c: Checkpoint): string | null {
  if (!c.dependencies.length) return null
  const lines = c.dependencies.map((d) => `- ${d.title} (${d.status})`)
  return `DEPENDENCIES\n${lines.join('\n')}`
}

function stateSection(c: Checkpoint): string {
  const bullets: string[] = []
  bullets.push(
    c.limitResetsAt
      ? `The previous worker stopped because of a usage limit. It resets at ${c.limitResetsAt}.`
      : WORKER_STATE_TEXT[c.workerState]
  )
  if (c.worktreeMoved !== null) {
    bullets.push(
      c.worktreeMoved
        ? 'The worktree has changed since the previous worker stopped — inspect the current diff before continuing.'
        : 'The worktree has not changed since the previous worker stopped.'
    )
  }
  if (c.validation) {
    bullets.push(`The last validation result: ${c.validation.summary} (config: ${c.validation.configId}).`)
  }
  return `CURRENT STATE\n${bullets.map((b) => `- ${b}`).join('\n')}`
}

function decisionsSection(c: Checkpoint): string | null {
  if (!c.decisions.length) return null
  const lines = c.decisions.map((d) =>
    d.status === 'resolved' && d.resolution
      ? `- ${d.question} -> ${d.resolution}`
      : `- ${d.question} (still open, awaiting a decision)`
  )
  return `HUMAN DECISIONS\n${lines.join('\n')}`
}

function reportsSection(reports: CheckpointReport[]): string | null {
  if (!reports.length) return null
  const lines = reports.map((r) => `- ${r.subject}: ${r.body}`)
  return `PREVIOUS WORKER REPORTS\n${lines.join('\n')}`
}

function filesSection(c: Checkpoint): string | null {
  if (!c.filesModified.length && !c.git?.diffstat) return null
  const lines = c.filesModified.map((f) => `- ${f}`)
  const diffstat = c.git?.diffstat ? [`Diffstat: ${c.git.diffstat}`] : []
  return `CHANGED FILES\n${[...lines, ...diffstat].join('\n')}`
}

const BEFORE_EDITING = `BEFORE EDITING
1. Inspect git status.
2. Inspect the current git diff before editing.
3. Read the changed files.
4. Reproduce any failing tests.
5. Continue from the current implementation.

Preserve the existing worktree and unfinished changes.`

// buildSpecFile(coordinator.ts) 의 Reporting obligation 과 같은 명령 모양이다(SPEC 9.2 — "spec
// 파일의 보고 의무와 같은 문구여야 한다"). taskId·dispatchId 는 재개 뒤에도 그대로 유효하다
// (Checkpoint.dispatchId 의 주석).
function reportSection(c: Checkpoint): string {
  return `REPORT WHEN DONE
Report through the existing Astera task protocol — do not invent a different path. Run this exactly
once when the work is finished:

  astera send --type worker_done \\
    --task-id ${c.taskId} --dispatch-id ${c.dispatchId} \\
    --outcome succeeded --subject "<one-line status>" --body - \\
    --files-modified "path/a,path/b" --json

Failure is a terminal report too — use --outcome failed.`
}

const HEADER = 'You are continuing an existing Astera Job.\n\nDo not start the task from scratch.'

function assemble(sections: Array<string | null>): string {
  return sections.filter((s): s is string => s !== null && s.length > 0).join('\n\n')
}

function sectionsFor(c: Checkpoint, reports: CheckpointReport[]): Array<string | null> {
  return [
    HEADER,
    jobSection(c),
    taskSection(c),
    dependenciesSection(c),
    stateSection(c),
    decisionsSection(c),
    reportsSection(reports),
    filesSection(c),
    BEFORE_EDITING,
    reportSection(c)
  ]
}

/** Checkpoint -> Packet 문자열. 같은 Checkpoint 는 항상 같은 문자열을 낸다 — 시계도, map/set
 *  순회 순서도 읽지 않는다(Checkpoint.reports 는 이미 배열이고, 이 함수는 그 순서를 그대로 쓴다).
 *
 *  크기 상한을 넘으면 **PREVIOUS WORKER REPORTS 부터 자른다** — 그 절이 이 Packet 에서 유일하게
 *  가변 길이인 자리이고, 나머지(목표·Task·의존성·변경 파일·지시문)는 구조화된 값이라 잘라내면
 *  새 워커가 딛고 설 사실 자체가 사라진다. 오래된 보고부터 버리고 최근 것을 남긴다 — 정지 직전에
 *  가장 가까운 서술이 다음 워커에게 더 쓸모 있다. */
export function formatResumeSection(c: Checkpoint): string {
  const full = assemble(sectionsFor(c, c.reports))
  if (full.length <= MAX_PACKET_CHARS) return full
  for (let n = c.reports.length - 1; n >= 0; n--) {
    const kept = c.reports.slice(c.reports.length - n)
    const candidate = assemble(sectionsFor(c, kept))
    if (candidate.length <= MAX_PACKET_CHARS) return candidate
  }
  return assemble(sectionsFor(c, []))
}
