// Why the new-session dialog's start button is dead. The button had five conditions and said nothing
// about any of them; two of them resolve asynchronously (the git check on the chosen folder, and the
// default-account preselect that runs after it), so a person who had filled everything in met a dead
// button that came alive on its own a few seconds later (design D4).
//
// A pure function because the renderer has no test environment — the same arrangement
// orchestration/nodeMeta.ts uses.
export type StartBlocked =
  | 'no-cwd'
  | 'no-account'
  | 'cli-missing'
  | 'no-schedule'
  | 'checking-folder'
  | 'checking-cli'

export function startBlockedBy(a: {
  cwd: string
  starting: boolean
  resolvingRepo: boolean
  accountIds: string[]
  cliMissing: boolean
  schedOn: boolean
  hasSchedule: boolean
  // Whether the per-folder CLI check for the *current* cwd has come back yet. Without this, picking a
  // folder whose CLI verdict is still in flight left the button exactly as pressable as one that had
  // already passed — the git check clears in milliseconds and cliMissing still held the previous
  // folder's answer, so Start was live on a folder nobody had actually checked (the exact miss this
  // task exists to close).
  checkingCli: boolean
}): StartBlocked | null {
  // Already pressed. The button being dead is the press, not a condition to explain.
  if (a.starting) return null
  // Ordered by what the person can do about it. The two checks are last because they are the ones
  // that clear themselves — telling someone to wait is only useful when there is nothing else to fix
  // first. Between the two, cliMissing (a completed, actionable verdict) still outranks checkingCli
  // (no verdict yet) below.
  if (!a.cwd) return 'no-cwd'
  if (a.accountIds.some((id) => !id)) return 'no-account'
  if (a.cliMissing) return 'cli-missing'
  if (a.schedOn && !a.hasSchedule) return 'no-schedule'
  if (a.resolvingRepo) return 'checking-folder'
  if (a.checkingCli) return 'checking-cli'
  return null
}
