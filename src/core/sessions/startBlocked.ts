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
  // Whether the primary account's CLI is missing from this machine *at all* (existence, not per-folder
  // runnability — final review wave, F1). Runnability used to live in this flag too, and that was the
  // bug: a CLI a toolchain manager refuses to run in the chosen folder (Volta rejecting that folder's
  // package.json — the reviewer's own machine) is exactly the case the F5 bypass retry exists to
  // survive, and gating Start on it made the retry unreachable — the shim was found, the per-folder
  // probe failed, Start stayed dead, nothing ever spawned, and the fix built for that machine never
  // got to run. The dialog's own `cliFailsHere` warning still says the true, more specific thing
  // ("installed, but does not run here"); it just cannot disable the button any more.
  cliMissing: boolean
  schedOn: boolean
  hasSchedule: boolean
}): StartBlocked | null {
  // Already pressed. The button being dead is the press, not a condition to explain.
  if (a.starting) return null
  // Ordered by what the person can do about it — the one remaining wait state (checking-folder) is
  // last because it clears itself. There used to be a second wait state here, checkingCli: the
  // per-folder CLI-runnability probe can take up to 10s, and without a flag for "still running" the
  // button stayed pressable on the *previous* folder's cliMissing answer for that whole window. That
  // race only mattered while runnability could gate Start. Now that it cannot (see cliMissing above),
  // an in-flight or stale runnability verdict decides nothing here, so the flag was removed rather
  // than kept wired to a decision it no longer makes — paying up to 10 seconds of dead button per
  // folder pick for information nobody downstream reads is not a trade worth keeping.
  if (!a.cwd) return 'no-cwd'
  if (a.accountIds.some((id) => !id)) return 'no-account'
  if (a.cliMissing) return 'cli-missing'
  if (a.schedOn && !a.hasSchedule) return 'no-schedule'
  if (a.resolvingRepo) return 'checking-folder'
  return null
}
