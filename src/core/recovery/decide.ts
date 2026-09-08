// The recovery decision (P1 design §4). Spec §13's order with REATTACH_PROCESS removed: no worker
// process survives this app's death on any supported platform, so that branch could never fire —
// keeping a process alive across a restart is the Host's job (spec §22, a later phase).
//
// Pure and total: the same three observations always give the same decision, which is what makes a
// sweep safe to repeat after a crash in the middle of one.
import type { GitFacts, LostAttempt, RecoveryDecision, RecoveryStrategy } from './types'

const decide = (strategy: RecoveryStrategy, cls: RecoveryDecision['class'], reason: string): RecoveryDecision => ({
  strategy,
  class: cls,
  reason
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
    return decide('review', 'unsafe', 'the worktree is gone, so nothing can be verified or continued there')
  if (git.inProgress)
    return decide('review', 'unsafe', `a ${git.inProgress} is in progress in the worktree and must not be resumed automatically`)
  if (git.conflicts)
    return decide('review', 'unsafe', 'the worktree holds conflicted files')

  const chosen = ((): RecoveryDecision => {
    if (attempt.nativeSessionId)
      return decide('resume-native', 'safe', "the provider's own session can be resumed, so the conversation continues")
    // A worktree worker is obliged to commit as it goes, so a moved HEAD proves output exists, not
    // that the Task is done — the check is what can judge that (spec §16 Example E).
    if (attempt.baseHead !== null && git.head !== null && git.head !== attempt.baseHead)
      return attempt.hasValidateConfig
        ? decide('recheck', 'safe', 'the worker committed before it was lost, so its check decides the outcome')
        : decide('review', 'review', 'the worker committed before it was lost and the Task has no check to prove the result')
    if (!attempt.promptConfirmed)
      return decide('redispatch', 'safe', 'the prompt never left the app, so nothing was started')
    if (!git.dirty)
      return decide('redispatch', 'safe', 'the worker produced nothing, so restarting it duplicates no work')
    if (smartResume)
      return decide('smart-resume', 'safe', 'the worktree holds unfinished work, so a new worker starts from a briefing')
    return decide('review', 'review', 'the worktree holds unfinished work and Smart Resume is off')
  })()

  if (!attempt.appDriven && needsDispatchAuthority(chosen.strategy))
    return decide('review', 'review', `${chosen.reason}, but this Run is driven by a coordinator, which decides what to start`)
  return chosen
}
