// app-settings.json's resumeStrategy, for the Host, which has no AppSettingsStore (S6). Read fresh at
// each ask; anything but 'smart' is the default, as the store reads it.
import { readFileRetrying } from '../renameRetry'
import { settingsObjectOf } from './settingsObject'
import type { ResumeStrategy } from '../types'

/** app-settings.json's `resumeStrategy`, read fresh; 'original' for a missing, damaged or other value. */
export async function readResumeStrategy(settingsPath: string): Promise<ResumeStrategy> {
  try {
    return settingsObjectOf(await readFileRetrying(settingsPath)).resumeStrategy === 'smart' ? 'smart' : 'original'
  } catch {
    return 'original'
  }
}
