// The agent profiles the app's Jobs view reads to say which archived profiles a schedule waits on (lifecycle design §5).
//
// The fold (ipc.ts orchSnapshotOf) is synchronous and runs on the main thread after every commit, so it cannot read the
// store; it reads the profiles last read here. They are read again lazily, never on a timer of their own:
// - by the fold, in the background, once they are older than ARCHIVED_REREAD_MS (an archive made with the CLI);
// - at once, before orch.list folds and after each profile change the app makes.
// A read that changes the set of archived profiles (or an archived one's name) asks for the Jobs view to be pushed again.
// A store that cannot be read counts as no archived profiles: the row is a hint, and the fire is the gate.
import type { AgentProfile } from '../core/agentProfiles/types'

/** How old the profiles the fold reads may be before it starts a read: about the time a person takes to look from a
 *  terminal back to Astera. */
export const ARCHIVED_REREAD_MS = 5_000

export interface ArchivedProfilesCache {
  /** The profiles last read. Starts a read in the background when they are older than ARCHIVED_REREAD_MS. */
  profiles(): readonly AgentProfile[]
  /** Reads them now. One asked while a read is out reads once more after it, since that read may have started before
   *  the change being waited for. Never rejects. */
  refresh(): Promise<void>
}

/** What the Jobs view shows of the profiles: the archived ones, by id and name. */
const keyOf = (profiles: readonly AgentProfile[]): string =>
  JSON.stringify(profiles.filter((p) => p.status === 'archived').map((p) => [p.id, p.name]))

export function createArchivedProfilesCache(d: {
  read: () => Promise<readonly AgentProfile[]>
  nowMs: () => number
  /** The archived set changed: fold and push the Jobs view again. */
  onChange: () => void
  log: (line: string) => void
}): ArchivedProfilesCache {
  let profiles: readonly AgentProfile[] = []
  let key = keyOf(profiles)
  let readAt = -Infinity
  let failing = false
  let out: Promise<void> | null = null
  let again = false

  const readOnce = async (): Promise<void> => {
    readAt = d.nowMs()
    let next: readonly AgentProfile[]
    try {
      next = await d.read()
      failing = false
    } catch (e) {
      // Said once until a read works again: the fold asks every few seconds
      if (!failing) d.log(`agent profiles: could not read them for the Jobs view, so no schedule shows one archived (${e instanceof Error ? e.message : String(e)})`)
      failing = true
      next = []
    }
    profiles = next
    const k = keyOf(next)
    if (k === key) return
    key = k
    try {
      d.onChange()
    } catch (e) {
      d.log(`agent profiles: the Jobs view push after a read failed (${String(e)})`)
    }
  }

  const refresh = (): Promise<void> => {
    if (out) {
      again = true
      return out
    }
    out = (async () => {
      do {
        again = false
        await readOnce()
      } while (again)
    })().finally(() => {
      out = null
    })
    return out
  }

  return {
    profiles: () => {
      if (out === null && d.nowMs() - readAt >= ARCHIVED_REREAD_MS) void refresh()
      return profiles
    },
    refresh
  }
}
