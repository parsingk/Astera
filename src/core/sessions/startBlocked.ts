// Why the new-session dialog's start button is dead. The button had five conditions and said nothing
// about any of them; two of them resolve asynchronously (the git check on the chosen folder, and the
// default-account preselect that runs after it), so a person who had filled everything in met a dead
// button that came alive on its own a few seconds later (design D4).
//
// A pure function because the renderer has no test environment — the same arrangement
// orchestration/nodeMeta.ts uses.
export type StartBlocked = 'no-cwd' | 'no-account' | 'cli-missing' | 'no-schedule' | 'checking-folder'

export function startBlockedBy(a: {
  cwd: string
  starting: boolean
  resolvingRepo: boolean
  accountIds: string[]
  cliMissing: boolean
  schedOn: boolean
  hasSchedule: boolean
}): StartBlocked | null {
  // Already pressed. The button being dead is the press, not a condition to explain.
  if (a.starting) return null
  // Ordered by what the person can do about it. The folder check is last because it is the one that
  // clears itself — telling someone to wait is only useful when there is nothing else to fix first.
  if (!a.cwd) return 'no-cwd'
  if (a.accountIds.some((id) => !id)) return 'no-account'
  if (a.cliMissing) return 'cli-missing'
  if (a.schedOn && !a.hasSchedule) return 'no-schedule'
  if (a.resolvingRepo) return 'checking-folder'
  return null
}
