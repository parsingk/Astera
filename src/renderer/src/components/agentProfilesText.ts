// The words Settings › Agent profiles shows and the profile pickers' choices (Agent Profiles design §8), apart from the
// components so each is tested as text. The Host checks every profile and answers a refusal with a reason in a word;
// this side only says it.
import type { MessageKey, MessageParams } from '../../../core/i18n'
import type { AgentProfile, ProfilePermission } from '../../../core/agentProfiles/types'
import { failureLine } from './extensionsText'

type T = (key: MessageKey, params?: MessageParams) => string

/** What the Host refuses a profile with: the store's checks (validateProfile) and the delete guard's `in-use`. */
const REASONS = {
  'name-empty': 'settings.agentProfiles.reason.name-empty',
  'name-too-long': 'settings.agentProfiles.reason.name-too-long',
  'name-taken': 'settings.agentProfiles.reason.name-taken',
  'no-account': 'settings.agentProfiles.reason.no-account',
  'unknown-account': 'settings.agentProfiles.reason.unknown-account',
  'mixed-provider': 'settings.agentProfiles.reason.mixed-provider',
  'in-use': 'settings.agentProfiles.reason.in-use'
} as const satisfies Record<string, MessageKey>
export const PROFILE_REASONS = Object.keys(REASONS)

const PERMISSIONS: Record<ProfilePermission, MessageKey> = {
  inherit: 'settings.agentProfiles.permission.inherit',
  bypass: 'settings.agentProfiles.permission.bypass',
  ask: 'settings.agentProfiles.permission.ask'
}

export const reasonLine = (r: string, t: T): string => (Object.hasOwn(REASONS, r) ? t(REASONS[r as keyof typeof REASONS]) : r)
export const permissionLabel = (p: ProfilePermission, t: T): string => t(PERMISSIONS[p])

/** Why a profile call came back with nothing: the Host's reason in words when it gave one this side knows, else what
 *  Settings › MCP & Skills says for the same failure. */
export function profileFailureLine(r: { ok: false; code: string; message: string; reason?: string }, t: T): string {
  return r.reason !== undefined && Object.hasOwn(REASONS, r.reason) ? reasonLine(r.reason, t) : failureLine(r, t)
}

/** The accounts a picked profile fills the account list with: its own that are still registered, in its order. Null for
 *  an archived profile, which new work cannot pick (design §4). */
export function profileAccounts(p: AgentProfile, accounts: readonly { id: string }[]): string[] | null {
  if (p.status === 'archived') return null
  return p.accountIds.filter((id) => accounts.some((a) => a.id === id))
}

/** What a picker offers: the active profiles that still have an account, and the names of the active ones that do not,
 *  so the picker can say why they are missing. */
export function pickableProfiles(profiles: readonly AgentProfile[], accounts: readonly { id: string }[]): { pickable: AgentProfile[]; unpickable: string[] } {
  const pickable: AgentProfile[] = []
  const unpickable: string[] = []
  for (const p of profiles) {
    const live = profileAccounts(p, accounts)
    if (live === null) continue
    if (live.length > 0) pickable.push(p)
    else unpickable.push(p.name)
  }
  return { pickable, unpickable }
}

/** The new session's permission, as the spawn reads it: with a profile, its id and no bypassPermissions at all, because
 *  an explicit value wins over the profile's choice (Task 4); without one, the dialog's checkbox exactly as before. */
export function permissionFields(agentProfileId: string | undefined, bypassPermissions: boolean | undefined): { agentProfileId: string } | { bypassPermissions: boolean | undefined } {
  return agentProfileId !== undefined ? { agentProfileId } : { bypassPermissions }
}

/** Whether a new chat session will hold a permission prompt, so the dialog offers what to do with one nobody answers:
 *  the profile's choice when one is picked (inherit is the app-wide mode), else the dialog's checkbox. */
export function chatHoldsPrompts(profile: AgentProfile | undefined, appWideYolo: boolean, checkbox: boolean): boolean {
  if (profile === undefined) return !checkbox
  if (profile.permission === 'bypass') return false
  if (profile.permission === 'ask') return true
  return !appWideYolo
}

/** A profile's name for the screens that show only its id (Job card, Run detail, a session tab): the id itself when
 *  this computer's list does not have it, a profile deleted since or one on a paired Runtime. */
export const profileNameOf = (profiles: readonly AgentProfile[], id: string): string => profiles.find((p) => p.id === id)?.name ?? id
