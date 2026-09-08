// The recovery decision (P1 design §4). Spec §13's order with REATTACH_PROCESS removed: no worker
// process survives this app's death on any supported platform, so that branch could never fire —
// keeping a process alive across a restart is the Host's job (spec §22, a later phase).
//
// Pure and total: the same three observations always give the same decision, which is what makes a
// sweep safe to repeat after a crash in the middle of one.
import type { MessageKey, MessageParams } from '../i18n'
import type { GitFacts, LostAttempt, RecoveryDecision, RecoveryStrategy } from './types'

/** Every row writes its sentence twice: `reason` in English for the journal, `key` for the screen.
 *  They are the same sentence, so they are written side by side here and cannot drift apart
 *  unnoticed. The keys all live under `jobs.recovery.reason.`, one per row of the table. */
const decide = (
  strategy: RecoveryStrategy,
  cls: RecoveryDecision['class'],
  reason: string,
  reasonKey: MessageKey,
  reasonParams?: MessageParams
): RecoveryDecision => ({
  strategy,
  class: cls,
  reason,
  reasonKey,
  ...(reasonParams ? { reasonParams } : {})
})

/** Starting an agent on a Run the app does not drive would take the coordinator's dispatching
 *  authority, and the coordinator died with the app; this app deliberately does not respawn one. */
const needsDispatchAuthority = (s: RecoveryStrategy): boolean => s === 'redispatch' || s === 'smart-resume'

export function decideRecovery(a: {
  attempt: LostAttempt
  git: GitFacts
  smartResume: boolean
}): RecoveryDecision {
  const { attempt, git, smartResume } = a

  if (!git.exists)
    return decide(
      'review',
      'unsafe',
      'the worktree is gone, so nothing can be verified or continued there',
      'jobs.recovery.reason.worktreeGone'
    )
  if (git.inProgress)
    return decide(
      'review',
      'unsafe',
      `a ${git.inProgress} is in progress in the worktree and must not be resumed automatically`,
      'jobs.recovery.reason.operationInProgress',
      { operation: git.inProgress }
    )
  if (git.conflicts)
    return decide('review', 'unsafe', 'the worktree holds conflicted files', 'jobs.recovery.reason.conflicts')
  if (git.dirty === null || git.conflicts === null)
    return decide(
      'review',
      'review',
      'the worktree could not be read, so nothing about it can be relied on',
      'jobs.recovery.reason.treeUnreadable'
    )
  // `review`, not `unsafe`: the worktree is fine, it is our own record that is missing. Without this
  // an unreadable journal would arrive as `promptConfirmed: false`, which the rows below read as
  // positive evidence that nothing was started, and a locked or corrupt file would restart a worker.
  if (attempt.promptConfirmed === null)
    return decide(
      'review',
      'review',
      'the journal could not be read, so nothing about this attempt can be relied on',
      'jobs.recovery.reason.journalUnreadable'
    )

  const chosen = ((): RecoveryDecision => {
    if (attempt.nativeSessionId)
      return decide(
        'resume-native',
        'safe',
        "the provider's own session can be resumed, so the conversation continues",
        'jobs.recovery.reason.nativeSession'
      )
    // A worktree worker is obliged to commit as it goes, so a moved HEAD proves output exists, not
    // that the Task is done — the check is what can judge that (spec §16 Example E).
    if (attempt.baseHead !== null && git.head !== null && git.head !== attempt.baseHead)
      return attempt.hasValidateConfig
        ? decide(
            'recheck',
            'safe',
            'the worker committed before it was lost, so its check decides the outcome',
            'jobs.recovery.reason.committedWithCheck'
          )
        : decide(
            'review',
            'review',
            'the worker committed before it was lost and the Task has no check to prove the result',
            'jobs.recovery.reason.committedNoCheck'
          )
    // One row, not two: spec §13.3's Safe re-dispatch is "no prompt was dispatched AND no worktree
    // changes occurred", and §21 SAFE says "re-dispatch before any prompt/mutation happened". A
    // second row on `!promptConfirmed` alone would add exactly one case — the prompt never left and
    // the tree is dirty — which is the one case that must not restart on its own. It falls through
    // to the Smart Resume row below instead, like any other unfinished work. The reason names
    // whichever of the two facts is the one worth telling.
    if (!git.dirty)
      return attempt.promptConfirmed
        ? decide(
            'redispatch',
            'safe',
            'the worker produced nothing, so restarting it duplicates no work',
            'jobs.recovery.reason.producedNothing'
          )
        : decide(
            'redispatch',
            'safe',
            'the prompt never left the app, so nothing was started',
            'jobs.recovery.reason.promptNeverLeft'
          )
    if (smartResume)
      return decide(
        'smart-resume',
        'safe',
        'the worktree holds unfinished work, so a new worker starts from a briefing',
        'jobs.recovery.reason.briefing'
      )
    return decide(
      'review',
      'review',
      'the worktree holds unfinished work and Smart Resume is off',
      'jobs.recovery.reason.smartResumeOff'
    )
  })()

  // The journal keeps the composed sentence, because the row it replaces is worth knowing. The
  // screen gets a sentence of its own instead: the rider fires for two strategies only, and what a
  // person needs from it is the same either way — the app did not start anything because starting is
  // not its call on this Run.
  if (!attempt.appDriven && needsDispatchAuthority(chosen.strategy))
    return decide(
      'review',
      'review',
      `${chosen.reason}, but this Run is driven by a coordinator, which decides what to start`,
      'jobs.recovery.reason.coordinatorRun'
    )
  return chosen
}
