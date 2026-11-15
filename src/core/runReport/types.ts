// The Run report's shape (run report design §4.1). Type-only imports, plus its one constant: the renderer imports this file.
import type { ActorGroup, CheckResult, TaskStatus } from '../orchestration/types'
import type { CiVerdict, GitHubInvalidatedReason } from '../github/lifecycle'
import type { TokenTotals } from '../types'

export const RUN_REPORT_VERSION = 1

export interface RunReportCheck {
  name: string
  /** The last round's status; 'not-run' when it never ran */
  final: CheckResult['status']
  failedRounds: number
  /** checkHistory held HISTORY_MAX rounds */
  atLeast?: true
  unstable?: true
  skipped?: true
  outsideSandbox?: true
}

export interface RunReportReview {
  rounds: number
  passed: boolean
  blocking: string[]
  fileToolsOnly?: true
  /** Who reviewed, distinct, in start order: `Claude`, `Codex` or an external reviewer's name. Absent when no review
   *  Dispatch has an outcome, and in a report stored before the field */
  reviewedBy?: string[]
}

export interface RunReportTask {
  title: string
  status: TaskStatus
  lifecycle?: true
  /** Every non-review Dispatch, lost ones included */
  attempts: number
  /** Counted as repairCountIn counts, split by reason */
  repairs: { check: number; review: number }
  grantedExtra: number
  /** Empty: the Task had none */
  checks: RunReportCheck[]
  /** Absent: no review was asked or ran */
  review?: RunReportReview
  override?: { reason: string; by: ActorGroup }
}

export interface RunReportGitHub {
  pr?: { number: number; url: string }
  ci?: { verdict: CiVerdict; sha: string }
  ciFailedRounds: number
  ciFailedAtLeast?: true
  reruns: { astera: number; person: number; atLeast?: true }
  /** mergeReadyHolds at the Run's end */
  mergeReady?: { headSha: string }
  /** When it did not hold and a reason is recorded */
  withheld?: GitHubInvalidatedReason
}

/** A caveat's Task: its title, and `lifecycle` when it is the Run's lifecycle Task, whose stored title is in one language
 *  and is named in the reader's */
interface CaveatTask {
  task: string
  lifecycle?: true
}

export type RunReportCaveat =
  /** `reason` on one line, cut at 300 characters when the report is built */
  | ({ kind: 'forced'; by: ActorGroup; reason: string } & CaveatTask)
  | ({ kind: 'check-skipped'; check: string } & CaveatTask)
  | { kind: 'ci-skipped' }
  /** One per Task, every check of it that ran outside the sandbox */
  | ({ kind: 'outside-sandbox'; checks: string[] } & CaveatTask)
  | ({ kind: 'review-outside-sandbox' } & CaveatTask)
  | ({ kind: 'policy-changed' } & CaveatTask)
  | ({ kind: 'suspicious-files'; count: number } & CaveatTask)
  | ({ kind: 'unstable'; check: string } & CaveatTask)

export interface RunReport {
  version: typeof RUN_REPORT_VERSION
  runId: string
  /** The Job's name on one line, cut at 60 characters; empty in the pull request version, which names the Run by its
   *  ordinal only */
  job: string
  ordinal: number
  outcome: 'completed' | 'failed'
  startedAt: string
  endedAt: string
  tasks: RunReportTask[]
  /** Present iff the Job has a lifecycle policy */
  github?: RunReportGitHub
  interruptions: { limitWaits: number; waitedMs: number; switches: number; restarts: number }
  interventions: { answers: Record<ActorGroup, number>; forced: { task: string; by: ActorGroup }[]; noPersonSteppedIn: boolean }
  caveats: RunReportCaveat[]
  cost?: { tokens?: TokenTotals; coordinatorTokens?: TokenTotals; accountIds: string[] }
}
