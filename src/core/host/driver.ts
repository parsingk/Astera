// Who drives Jobs on this profile right now (design §4.3, §4.6). A value the Host computes, never a
// lease anyone holds.
import { readFileRetrying } from '../renameRetry'
import { settingsObjectOf } from '../settings/settingsObject'

export type Driver = 'host' | 'app' | 'parked'
export type DispatchGate = 'no-settings' | 'migrated' | 'not-migrated' | 'unreadable'
/** The caller id every command the Host issues for itself runs under (R9). */
export const HOST_CALLER = 'astera:host'

/** An app that keeps dispatch drives (it will, whatever we say: its scheduler runs on every push).
 *  Otherwise the F62 marker decides: work an old toggle parked must not be spent before an app has
 *  run the migration (ruling F62), and a file that cannot be read cannot say it was not (R2). */
export function driverOf(a: { appKeepsDispatch: boolean; gate: DispatchGate }): Driver {
  if (a.appKeepsDispatch) return 'app'
  if (a.gate === 'not-migrated' || a.gate === 'unreadable') return 'parked'
  return 'host'
}

/** Read only, every time it is asked: an app's migration lands in this file between two commits. */
export async function readDispatchGate(settingsPath: string): Promise<DispatchGate> {
  let text: string
  try {
    text = await readFileRetrying(settingsPath)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no-settings' : 'unreadable'
  }
  try {
    return settingsObjectOf(text).orchAlwaysOnMigrated === true ? 'migrated' : 'not-migrated'
  } catch {
    return 'unreadable'
  }
}
