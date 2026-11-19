// The Host's read of the external reviewers in app-settings.json (the narrowing is externalReviewers.ts).
import { readFileRetrying } from '../renameRetry'
import { reviewerSettingsOf, type ReviewerSettings } from './externalReviewers'
import { RepairNeeded } from './repairNeeded'
import { settingsObjectOf } from './settingsObject'

/**
 * The Host's read. Read only, and through the retrying read: the app replaces app-settings.json by
 * rename, which can fail with EBUSY or EPERM on Windows for a moment (the same read accounts and the
 * Host's other settings reads use).
 *
 * - **Missing file:** empty settings.
 * - **Unreadable, or not a JSON object: it throws `RepairNeeded`**, as `readAppSettingsObject` does. It
 *   is not answered as empty, since the file may have chosen a reviewer.
 */
export async function readReviewerSettings(filePath: string): Promise<ReviewerSettings> {
  let text: string
  try {
    text = await readFileRetrying(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { reviewers: [], reviewBy: null }
    throw new RepairNeeded(`app-settings.json could not be read (${String(err)}); open Astera to repair it`, 'app-settings.json')
  }
  let obj: Record<string, unknown>
  try {
    obj = settingsObjectOf(text)
  } catch {
    throw new RepairNeeded('app-settings.json is not a valid settings file; open Astera to repair it', 'app-settings.json')
  }
  return reviewerSettingsOf(obj)
}
