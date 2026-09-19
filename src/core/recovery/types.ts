// What recovery knows about one lost worker, and what it decides. Pure data: the journal, the
// worktree and the settings are read by main and arrive here as plain values (P1 design §4).
import type { Message } from '../i18n'
import type { Provider } from '../providers/meta'
import type { RepairReason } from '../orchestration/types'

export type RecoveryStrategy = 'resume-native' | 'redispatch' | 'recheck' | 'smart-resume' | 'review'

/** Spec §21. `unsafe` is a `review` the UI words more strongly: the tree must not be touched. */
export type RecoveryClass = 'safe' | 'review' | 'unsafe'

export interface LostAttempt {
  runId: string
  taskId: string
  /** The Dispatch that was lost. The new attempt links back to it through `retryOf`. */
  dispatchId: string
  provider: Provider
  accountId: string
  /** Where that worker was working — the worktree, or the project root for a `current` dispatch. */
  cwd: string
  /** The provider's own conversation id, when the app learned it before the loss. */
  nativeSessionId?: string
  /** A PROMPT_WRITE_CONFIRMED row exists for this Dispatch: the prompt really left the app. null when
   *  the journal could not be read; recovery must treat that as a reason to stop, because `false`
   *  here is positive evidence that nothing was started. */
  promptConfirmed: boolean | null
  /** HEAD when the attempt started (its first checkpoint), or null when no checkpoint recorded one. */
  baseHead: string | null
  /** The Task names a run configuration to prove itself with, so a check can judge committed work. */
  hasValidateConfig: boolean
  /** The app drives this Run (`Run.autoDispatch`). When it does not, a coordinator owns dispatching. */
  appDriven: boolean
  /** 유실된 attempt 가 repair 였다면 그 사유(설계 §10). 새 attempt 도 repair 다 — 그 Task 는 아직 수렴 중이다 */
  repair?: RepairReason
}

export interface GitFacts {
  /** The folder is there and is a git repository. */
  exists: boolean
  head: string | null
  /** Anything uncommitted, tracked or not. null when git could not be asked; recovery must treat that as a reason to stop. */
  dirty: boolean | null
  inProgress: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null
  /** Whether any file is conflicted. null when git could not be asked; recovery must treat that as a reason to stop. */
  conflicts: boolean | null
  branch: string | null
}

export interface RecoveryDecision {
  strategy: RecoveryStrategy
  class: RecoveryClass
  /** One English sentence, journaled as-is. The journal is a record and its records are English. */
  reason: string
  /** The same sentence for the screen: the Gate's question and the Timeline row are written in the
   *  app's language, while `reason` above stays English for the file. A key rather than a finished
   *  sentence because this function is pure and holds no language (core/i18n's `Message`). */
  reasonMessage: Message
}
