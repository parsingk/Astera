// The one place the Job Continuity / Smart Resume coupling lives (spec §3, design §3). Pure so the
// four combinations of spec §3.5 are a table test; AppSettingsStore only persists what this returns.
import type { ResumeStrategy } from '../types'

export interface ContinuitySettings {
  jobContinuity: boolean
  resumeStrategy: ResumeStrategy
}

export interface ContinuityToggleResult extends ContinuitySettings {
  /** True only when turning Job Continuity on also turned Smart Resume on. The settings screen shows
   *  the notice from this, not from comparing before and after (spec §3.2). */
  smartResumeTurnedOn: boolean
}

/** Turning Job Continuity on while Smart Resume is off turns Smart Resume on too: full automatic
 *  recovery sometimes needs a new session with a semantic handoff. Turning it off never touches
 *  Smart Resume (spec §3.4), and Smart Resume may be turned off again afterwards (spec §3.3) — that
 *  path does not go through this function. */
export function applyContinuityToggle(prev: ContinuitySettings, next: boolean): ContinuityToggleResult {
  if (next && prev.resumeStrategy === 'original')
    return { jobContinuity: true, resumeStrategy: 'smart', smartResumeTurnedOn: true }
  return { jobContinuity: next, resumeStrategy: prev.resumeStrategy, smartResumeTurnedOn: false }
}
