// The GitHub lifecycle's policy defaults (GitHub lifecycle design §5.1, G7a): set in Settings › GitHub, read by the
// Host when a lifecycle Job is made (settings/githubLifecycle.ts), copied into the Job and never read for it again. The
// store's narrowing, the Host's read and the pane's bounds are these, so none of them can differ. Node-free: the
// renderer's pane uses them.
import { GITHUB_LIFECYCLE_DEFAULTS, type GitHubLifecyclePolicy } from './lifecycle'

export type GitHubLifecycleDefaults = Omit<GitHubLifecyclePolicy, 'ci'>

/** Astera's own CI reruns a Job allows. A Run keeps its last 20 reruns, so a limit at 20 or more could never be
 *  reached; turning the automatic reruns off is how a person says none. */
export const LIFECYCLE_RERUNS = { min: 1, max: 10 }
/** How long a round waits for CI. It must outlast the three minutes a pushed head may show no check, and a day is
 *  longer than any CI a person waits on. */
export const LIFECYCLE_CI_WAIT_MINUTES = { min: 10, max: 1440 }

const within = (v: unknown, b: { min: number; max: number }): v is number => typeof v === 'number' && Number.isInteger(v) && v >= b.min && v <= b.max

/** Each value narrowed on its own: one out of its bounds (a hand edit) takes its default and leaves the others. */
export function githubLifecycleDefaultsOf(v: unknown): GitHubLifecycleDefaults {
  const o = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  return {
    autoRerunInfrastructureFailures:
      typeof o.autoRerunInfrastructureFailures === 'boolean' ? o.autoRerunInfrastructureFailures : GITHUB_LIFECYCLE_DEFAULTS.autoRerunInfrastructureFailures,
    maxInfrastructureReruns: within(o.maxInfrastructureReruns, LIFECYCLE_RERUNS) ? o.maxInfrastructureReruns : GITHUB_LIFECYCLE_DEFAULTS.maxInfrastructureReruns,
    ciWaitMinutes: within(o.ciWaitMinutes, LIFECYCLE_CI_WAIT_MINUTES) ? o.ciWaitMinutes : GITHUB_LIFECYCLE_DEFAULTS.ciWaitMinutes
  }
}

/** A value taken whole or not at all (the Settings pane's save): the three values, each in its bounds, else null. The
 *  pane and the file then never disagree about what was set. */
export function exactGithubLifecycleDefaults(v: unknown): GitHubLifecycleDefaults | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const narrowed = githubLifecycleDefaultsOf(o)
  const same =
    o.autoRerunInfrastructureFailures === narrowed.autoRerunInfrastructureFailures &&
    o.maxInfrastructureReruns === narrowed.maxInfrastructureReruns &&
    o.ciWaitMinutes === narrowed.ciWaitMinutes
  return same ? narrowed : null
}
