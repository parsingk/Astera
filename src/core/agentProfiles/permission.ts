// What a spawn takes from the agent profile it is started from (Agent Profiles design §5): the profile's real id, and
// whether the session asks for permission. An explicit `bypass` or `ask` overrides the app-wide agentPermissionMode;
// `inherit` changes nothing. Used by every spawn path, the app's and the Host's.
import { findProfile, readAgentProfiles } from './store'
import type { AgentProfile, ProfilePermission } from './types'

/** `bypass` is true and `ask` false; anything else (`inherit`, no profile) is the app-wide reader's answer, whose
 *  RepairNeeded on a damaged settings file still refuses the spawn. */
export async function bypassFor(permission: ProfilePermission | undefined, appWideYolo: () => Promise<boolean>): Promise<boolean> {
  if (permission === 'bypass') return true
  if (permission === 'ask') return false
  return appWideYolo()
}

/** The profile a spawn names, by id or by name, with the bypass it starts with: the caller's own when it gave one, else
 *  the profile's choice. Null when it names none, and null with one log line when it names one that is not found or the
 *  store cannot be read: the spawn then starts as it did before profiles. The id is the profile's own, so a session
 *  started by the profile's name still holds it for the Host's delete guard, which compares ids. `sandbox` is the
 *  profile's switch (sandbox design §6), never a caller's: only the profile turns it on or off. */
export async function profileSpawn(a: {
  profileDir: string
  agentProfileId?: string
  bypassPermissions?: boolean
  appWideYolo: () => Promise<boolean>
  log: (line: string) => void
}): Promise<{ agentProfileId: string; bypassPermissions: boolean; sandbox: boolean } | null> {
  if (a.agentProfileId === undefined) return null
  let profile: AgentProfile | null
  try {
    profile = findProfile(await readAgentProfiles(a.profileDir), a.agentProfileId)
  } catch (e) {
    a.log(`agent profiles: could not be read, so profile ${a.agentProfileId} is not applied (${e instanceof Error ? e.message : String(e)})`)
    return null
  }
  if (!profile) {
    a.log(`agent profiles: profile ${a.agentProfileId} was not found, so the session starts without one`)
    return null
  }
  return {
    agentProfileId: profile.id,
    bypassPermissions: a.bypassPermissions ?? (await bypassFor(profile.permission, a.appWideYolo)),
    sandbox: profile.sandbox
  }
}

/** The app's spawn path (Task 8 fix round 1): `profileSpawn`, except that a profile which does not resolve leaves the
 *  session with the caller's own value or, when it gave none, the app-wide mode: what a spawn without a profile gets
 *  from the new-session dialog (design §5), never no bypass at all. */
export async function appProfileSpawn(a: {
  profileDir: string
  agentProfileId: string
  bypassPermissions?: boolean
  appWideYolo: () => Promise<boolean>
  log: (line: string) => void
}): Promise<{ agentProfileId?: string; bypassPermissions: boolean; sandbox?: boolean }> {
  return (await profileSpawn(a)) ?? { bypassPermissions: a.bypassPermissions ?? (await a.appWideYolo()) }
}
