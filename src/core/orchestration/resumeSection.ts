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

/** 왜 이 세션이 여기 있는가 — 이 절의 첫 줄이 그 답이다.
 *
 *  **정지 스냅샷이 1순위다.** 롤 경로에서 Dispatch 는 닫히지 않으므로 `workerState` 는 'ready' 로,
 *  `limitResetsAt` 은 비어 있는 채로 남는다(checkpoint.ts 의 `stop` 주석) — 그 둘만 보면 이 절이
 *  항상 "아직 기록된 정지가 없다" 를 낸다. 스냅샷이 없을 때만 예전 두 값으로 내려간다: 스냅샷이
 *  생기기 전에 만들어진 Dispatch 와, 롤링이 아닌 경로로 닫힌 Dispatch 가 그쪽이다. */
function stopReasonText(c: Checkpoint): string {
  if (c.stop) {
    if (c.stop.reason === 'switching')
      return 'The previous worker session stopped on a usage limit and the app moved it to another account.'
    return c.stop.resetsAt
      ? `The previous worker session stopped on a usage limit and the app waited for that account to recover (expected at ${c.stop.resetsAt}).`
      : 'The previous worker session stopped on a usage limit and the app waited for that account to recover.'
  }
  return c.limitResetsAt
    ? `The previous worker session stopped on a usage limit. It resets at ${c.limitResetsAt}.`
    : WORKER_STATE_TEXT[c.workerState]
}

function stateSection(c: Checkpoint): string {
  const bullets: string[] = []
  bullets.push(stopReasonText(c))
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

/** 한 줄 노트에 실을 변경 파일 수의 상한. 이 노트는 살아 있는 PTY 에 **한 줄로** 타이핑되므로
 *  (줄바꿈이 곧 Enter 다) 목록이 길어지면 한 줄이 화면을 뒤덮는다. 넘치는 개수는 숫자로 알린다 —
 *  전체 목록은 어차피 `git status` 로 직접 볼 수 있고, 그것을 하라고 말하는 것이 이 노트다. */
const NOTE_FILES_MAX = 20

/**
 * **살아 있는 세션**에 덧붙이는 한 줄. 전체 Packet 이 아니다.
 *
 * `SPEC §11.5` 가 정한 대로, `--resume` 을 부르지 않는 재개 경로(claude 의 `resumeInPlace`·idle
 * nudge·리셋 앵커)는 같은 프로세스가 계속 도는 것이고 **떨어뜨린 것이 없으니 인계할 것도 없다.**
 * 그 자리에 전체 Packet 을 주면 대화가 온전한 에이전트에게 "처음부터 다시 하지 말라"·Task 지시문·
 * 의존성 목록·재정렬 의식을 다시 읽히는 것이 되고, 그것은 방금 리셋된 할당량을 이미 아는 것을
 * 재구성하는 데 쓰는 일이다. 그래서 여기서는 §11.5 (a) 가 말한 **대체가 아닌 덧붙임** 형태만
 * 만든다: 기다리는 동안 무엇이 바뀌었는가.
 *
 * 아이러니를 적어 둔다 — 이 경로가 HEAD 기준점을 **가장 믿을 수 있는** 자리다. reattach 게시가
 * 없어 정지 시점 스냅샷을 덮어쓸 것이 애초에 없다.
 *
 * git 을 못 읽었으면(`git === null`) `null` 이다. 그때 확인한 것이 하나도 없으므로 할 말이 없고,
 * **모르는 것을 말하지 않는 것**이 이 기능의 하드 제약이다(DESIGN §19). 반환 문자열에는 줄바꿈이
 * 없다 — 조각을 공백으로만 잇는다.
 */
export function formatResumeNote(c: Checkpoint): string | null {
  if (!c.git) return null
  const parts: string[] = []
  // worktreeMoved 가 null 이면(정지 시점 HEAD 가 없어 비교가 불가능하면) 이 문장을 아예 만들지
  // 않는다 — "바뀌지 않았다"를 확인 없이 단정하는 것이 이 라운드가 고친 사고 그 자체다.
  if (c.worktreeMoved === true)
    parts.push(`While you waited the worktree moved to ${c.git.head ?? 'a new commit'}.`)
  else if (c.worktreeMoved === false) parts.push('While you waited the worktree did not move.')
  const changed = c.git.changed
  if (changed.length === 0) parts.push('There are no uncommitted changes right now.')
  else {
    const shown = changed.slice(0, NOTE_FILES_MAX)
    const more = changed.length - shown.length
    parts.push(
      `Uncommitted changes right now: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`
    )
  }
  parts.push('Check the current git diff before editing.')
  return parts.join(' ')
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
