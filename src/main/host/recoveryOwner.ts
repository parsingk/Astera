// Who recovers lost workers, from the app's side (remote runtime design §2.6, DC-3): this app, only in front of a
// Host that does not announce `recovery`. The answer read while a Host was there to ask is kept (appJournal's P8
// rule), so a Host that is briefly away does not hand recovery back to the app for that moment. Before any Host
// answered, the app does not recover: an app with no Host has no orchestration to recover.
import { hostSpeaksRecovery } from './outdated'

export interface RecoveryOwner {
  appRecovers(): boolean
}

export function createRecoveryOwner(status: () => { connected: boolean; unresponsive?: boolean; features: readonly string[] }): RecoveryOwner {
  let last = false
  return {
    appRecovers: () => {
      try {
        const s = status()
        if (s.connected || s.unresponsive === true) last = !hostSpeaksRecovery(s)
      } catch {
        /* the last answer stands */
      }
      return last
    }
  }
}
