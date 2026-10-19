// The views the public reads answer with (`jobs get`, `runs get`, `tasks list --brief`), and the public events carry
// (publicEvents.ts, SDK 1d): one definition, so an event's payload is what a read of the same object shows. Moved out
// of command.ts with no change.
import type { JobOutcome, RunOutcome as RunOutcomePublic } from '../publicContract'
import type { RunOutcome } from '../types'
import type { OrchState } from './state'
import type { Job, JobRun, Task } from './types'
import { outcomeOf, progressOf } from './view'
import { githubLifecycleOf } from '../github/view'
import { lifecycleFactsOf } from './lifecycleTask'

/**
 * 계획과 회차에 붙는 파생값 — 공개 읽기 표면이 상태를 말하는 방식(공개 CLI 설계 §6).
 *
 * **저장된 칸이 아니다.** Job 에도 JobRun 에도 상태 칸은 없고, 상태는 그것이 거느린 Task 에 있다.
 * 화면이 쓰는 함수를 그대로 쓴다(view.ts 의 outcomeOf·progressOf) — 같은 Job 을 앱에서 보는 것과
 * 셸에서 보는 것이 다르면 둘 중 하나는 거짓이다.
 *
 * `questionsOpen` 을 따로 세는 이유는 status 명령과 같다: 그것만이 **사람을 기다리는** 수이고,
 * 나머지 상태와 달리 사람이 답해야 움직인다.
 *
 * One deliberate difference: for a Job with no Run the app's Jobs view (view.ts snapshotFor) keeps
 * `running`, which its glyph and sort rely on, and shows its "not started" chip from `pendingStart`,
 * while the CLI/MCP view says `pending` (jobView below).
 */
const derivedFor = (
  s: OrchState,
  ownerId: string,
  runIds: readonly string[]
): { outcome: RunOutcome; progress: { done: number; total: number }; questionsOpen: number } => ({
  outcome: outcomeOf(s, ownerId),
  progress: progressOf(s, ownerId),
  questionsOpen: s.gates.filter((g) => g.status === 'open' && runIds.includes(g.runId)).length
})

/** 그 계획의 마지막 회차. 번호로 고른다 — 배열의 순서가 곧 시간순이 아니다(앞 회차를 지워도
 *  남은 번호는 그대로다). */
export const latestRunOf = (s: OrchState, job: Job): JobRun | undefined =>
  s.runs.filter((r) => r.jobId === job.id).sort((a, b) => a.ordinal - b.ordinal).at(-1)

/** 회차가 없으면 계획의 정의 Task 를 센다 — tasksOwnedBy 가 두 id 를 다 받는다(view.ts). */
export const jobView = (s: OrchState, job: Job, run: JobRun | undefined): Record<string, unknown> => ({
  ...job,
  ...derivedFor(s, run?.id ?? job.id, run ? [run.id] : []),
  // A Job with no Run has started nothing. outcomeOf reads a Task-less owner as running (right for a
  // Run just made), so without this a Job whose `jobs run` failed read `running` beside
  // `pendingStart: true` (the e2e check of 2026-10-01). `pending` is JOB_STATES' word for it, and
  // stateWord reads it as PENDING. The app's sidebar keeps its own row (view.ts) with its
  // not-started chip, and a scheduled Job still reads SCHEDULED, since stateWord asks that first.
  ...(run === undefined ? { outcome: 'pending' satisfies JobOutcome } : {}),
  // Its latest Run is paused: the same word runView gives that Run.
  ...(run?.paused === true ? { outcome: 'paused' satisfies JobOutcome } : {})
})

/** A paused Run's `outcome` is `paused` (e2e 2026-10-01: `runs stop` left `paused: true` beside
 *  `outcome: "running"`). outcomeOf reads only the Tasks, so it cannot see the pause. `paused` is the
 *  JOB_STATES word, and stateWord puts it ahead of the Tasks' outcome, as this does.
 *
 *  A GitHub lifecycle Job's Run carries `github`, derived from the Host's record (githubState, kept back). */
export const runView = (s: OrchState, run: JobRun): Record<string, unknown> => {
  const policy = s.jobs.find((j) => j.id === run.jobId)?.github
  const github = policy ? githubLifecycleOf(policy, run.githubState, lifecycleFactsOf(s, run.id)) : undefined
  return {
    ...run,
    ...derivedFor(s, run.id, [run.id]),
    ...(run.paused === true ? { outcome: 'paused' satisfies RunOutcomePublic } : {}),
    ...(github !== undefined ? { github } : {})
  }
}

/** A spec longer than this is cut in a brief Task (`tasks list --brief`, and every Task an event carries). */
const BRIEF_SPEC_CHARS = 160

/** `tasks list --brief`: the spec on one line, cut at 160 characters, with the mark of the cut. */
export const briefTask = (t: Task): Record<string, unknown> => {
  const spec = t.spec.replace(/\s+/g, ' ')
  return { ...t, spec: spec.slice(0, BRIEF_SPEC_CHARS), spec_truncated: spec.length > BRIEF_SPEC_CHARS }
}
