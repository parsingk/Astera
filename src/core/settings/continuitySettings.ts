// app-settings.json's Job Continuity toggle and resume strategy, for the Host, which has no
// AppSettingsStore (Host journal P7). Read at start and on journal-reload. Narrowed as the store
// narrows them; a missing or damaged file is off, so nothing is journaled on a guess.
import { readFileRetrying } from '../renameRetry'
import { settingsObjectOf } from './settingsObject'

export interface ContinuitySettingsRead {
  /** `jobContinuityEnabled === true`. */
  enabled: boolean
  /** `resumeStrategy === 'smart'`. */
  smartResume: boolean
}

export async function readContinuitySettings(settingsPath: string): Promise<ContinuitySettingsRead> {
  try {
    const o = settingsObjectOf(await readFileRetrying(settingsPath))
    return { enabled: o.jobContinuityEnabled === true, smartResume: o.resumeStrategy === 'smart' }
  } catch {
    return { enabled: false, smartResume: false }
  }
}
