// This computer's agent profiles as the screens last read them (Agent Profiles design §8): one list the pickers, the
// Job card, the Run detail and the session tabs share, so a profile made or renamed in Settings shows everywhere without
// each of them asking the Host again. A read that fails keeps the last list: a name then falls back to the id.
import { useEffect, useSyncExternalStore } from 'react'
import type { AgentProfile } from '../../../core/agentProfiles/types'

let profiles: AgentProfile[] = []
const listeners = new Set<() => void>()
/** One read at a time: every Job card naming an unknown profile asks at once when the list shows. */
let reading: Promise<void> | null = null

/** Settings › Agent profiles hands over every list it reads, so the rest of the app follows its changes. */
export function publishAgentProfiles(next: AgentProfile[]): void {
  profiles = next
  for (const l of listeners) l()
}

export function reloadAgentProfiles(): Promise<void> {
  reading ??= window.api.agentProfiles
    .list()
    .catch(() => null)
    .then((r) => {
      if (r?.ok && Array.isArray(r.body.profiles)) publishAgentProfiles(r.body.profiles as AgentProfile[])
    })
    .finally(() => {
      reading = null
    })
  return reading
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

const snapshot = (): AgentProfile[] => profiles

/** The list as last read, without asking. The same snapshot serves a render to a string (the components' tests). */
export const useKnownAgentProfiles = (): AgentProfile[] => useSyncExternalStore(subscribe, snapshot, snapshot)

/** The list for a screen that names the profiles `ids` (a Job card, a session tab): read again once whenever it does
 *  not name one of them, a profile made from the CLI since the last read. One deleted since stays unknown after that
 *  read, and the screen shows its id. */
export function useAgentProfilesNaming(ids: readonly string[]): AgentProfile[] {
  const list = useKnownAgentProfiles()
  const missing = ids.filter((id) => !list.some((p) => p.id === id)).join(',')
  useEffect(() => {
    if (missing !== '') void reloadAgentProfiles()
  }, [missing])
  return list
}

/** The list, read again when the caller mounts: for a form that offers profiles. */
export function useAgentProfiles(): AgentProfile[] {
  useEffect(() => {
    void reloadAgentProfiles()
  }, [])
  return useKnownAgentProfiles()
}
