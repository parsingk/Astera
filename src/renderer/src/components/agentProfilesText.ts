// The words Settings › Agent profiles shows and the profile pickers' choices (Agent Profiles design §8), apart from the
// components so each is tested as text. The Host checks every profile and answers a refusal with a reason in a word;
// this side only says it.
import type { MessageKey, MessageParams } from '../../../core/i18n'
import type { AgentProfile, ProfilePermission } from '../../../core/agentProfiles/types'
import type { PluginsCallAnswer } from '../../../core/types'
import { metaOf, providerOf, type Provider } from '../../../core/providers/meta'
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

/** What the app's spawn sends of what it was given: the profile and the bypass each when present, so a restart keeps a
 *  session's profile beside the bypass it already resolved (that value keeps winning); with no profile, the bypass key
 *  exactly as before profiles. The dialog leaves the bypass out when a profile is picked (permissionFields). */
export function spawnPermission(o: { agentProfileId?: string; bypassPermissions?: boolean }): { agentProfileId?: string; bypassPermissions?: boolean } {
  if (o.agentProfileId === undefined) return { bypassPermissions: o.bypassPermissions }
  return { agentProfileId: o.agentProfileId, ...(o.bypassPermissions !== undefined ? { bypassPermissions: o.bypassPermissions } : {}) }
}

/** The profile of a conversation a tab of this app held (its resumed session id or its chat thread id), for resuming
 *  it from history. Undefined when no tab here knows it: the transcript itself does not record a profile, so the resume
 *  then takes the one the app recorded for the conversation (sessions.resumeDefaults); resumeProfile decides. */
export function profileOfConversation(
  sessions: readonly { resumeSessionId?: string; threadId?: string; agentProfileId?: string }[],
  conversationId: string
): string | undefined {
  return sessions.find((s) => s.agentProfileId !== undefined && (s.resumeSessionId === conversationId || s.threadId === conversationId))?.agentProfileId
}

/** The profile a history resume carries, decided once: an open tab's for the conversation first, else the one the app
 *  recorded for it, while this computer's list still has it (archived too). Null when there is neither or the id no
 *  longer resolves: the resume is then the dialog's own, without a profile, as before. The same one names the dialog's
 *  line, decides its permission and goes to the spawn. */
export function resumeProfile(profiles: readonly AgentProfile[], tab: string | undefined, recorded: string | null): AgentProfile | null {
  const id = tab ?? recorded
  return id === null ? null : (profiles.find((p) => p.id === id) ?? null)
}

/** The line the history resume dialog shows when the conversation resumes as a profile (resumeProfile); null when it
 *  carries none, and the dialog says nothing. */
export function resumeAsLine(profile: AgentProfile | null, t: T): string | null {
  return profile === null ? null : t('agentProfiles.resumeAs', { name: profile.name })
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

/** What the editor's add list offers: the accounts not picked yet, and once one is picked only its provider's. A
 *  profile's accounts take turns on one conversation, which only one provider's CLI can carry on (the Host refuses a mix
 *  as `mixed-provider`). */
export function addableAccounts<A extends { id: string; provider?: Provider }>(accounts: readonly A[], picked: readonly string[]): A[] {
  const first = accounts.find((a) => a.id === picked[0])
  return accounts.filter((a) => !picked.includes(a.id) && (first === undefined || providerOf(a) === providerOf(first)))
}

/** An account's provider by name, after its label in the add list. */
export const providerSuffix = (a: { provider?: Provider }): string => ` (${metaOf(a).displayName})`

/** What the sandbox switch's lines say (sandbox design §6): what it does for the profile's CLI on each OS, then its
 *  limits. Before an account is picked the profile has no CLI yet, and both are said. */
export function sandboxHintKeys(provider: Provider | undefined): MessageKey[] {
  const codex: MessageKey = 'settings.agentProfiles.sandboxHint.codex'
  const claude: MessageKey = 'settings.agentProfiles.sandboxHint.claude'
  const lines = provider === 'codex' ? [codex] : provider === 'claude' ? [claude] : [codex, claude]
  return [...lines, 'settings.agentProfiles.sandboxHint.limits']
}

/** Whether a Codex home's Windows sandbox is set up, as the Host answers it (core/sandbox/windowsReadiness.ts). */
export type SandboxState = 'ready' | 'not-set-up' | 'check-failed'
const SANDBOX_STATES: Record<SandboxState, MessageKey> = {
  ready: 'settings.agentProfiles.sandboxState.ready',
  'not-set-up': 'settings.agentProfiles.sandboxState.not-set-up',
  'check-failed': 'settings.agentProfiles.sandboxState.check-failed'
}
const isState = (s: unknown): s is SandboxState => typeof s === 'string' && Object.hasOwn(SANDBOX_STATES, s)

/** A readiness in words; one a newer Host gives, as it was named. */
export const sandboxStateLine = (s: string, t: T): string => (isState(s) ? t(SANDBOX_STATES[s]) : s)

/** 설정하기 is offered for an account that is not set up, and only then: one that could not be asked about would not be
 *  helped by it (windowsReadiness.ts). */
export const offersSetUp = (s: SandboxState | null): boolean => s === 'not-set-up'

/** The profile's Codex accounts that are still registered, in its order. */
const codexAccountsOf = <A extends { id: string; provider?: Provider }>(p: AgentProfile, accounts: readonly A[]): A[] =>
  p.accountIds.map((id) => accounts.find((a) => a.id === id)).filter((a): a is A => a !== undefined && providerOf(a) === 'codex')

/** Whether the editor shows each Codex account's readiness (Task 8): a stored profile with the sandbox on, on Windows,
 *  where Codex's elevated sandbox is set up per account, with a Codex account. */
export function sandboxReadinessShown(p: AgentProfile, platform: string, accounts: readonly { id: string; provider?: Provider }[]): boolean {
  return p.sandbox && platform === 'win32' && codexAccountsOf(p, accounts).length > 0
}

/** The readiness lines, one per Codex account of the profile in its order, with what the Host answered (null while it is
 *  still being asked). An account the Host left out, or an answer that did not come, could not be asked about. */
export function readinessRows(
  p: AgentProfile,
  accounts: readonly { id: string; label: string; provider?: Provider }[],
  answer: PluginsCallAnswer | null
): { accountId: string; label: string; state: SandboxState | null }[] {
  const said = new Map<string, SandboxState>()
  if (answer?.ok && Array.isArray(answer.body.accounts))
    for (const e of answer.body.accounts as unknown[]) {
      const o = typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : {}
      if (typeof o.accountId === 'string' && isState(o.state)) said.set(o.accountId, o.state)
    }
  return codexAccountsOf(p, accounts).map((a) => ({
    accountId: a.id,
    label: a.label,
    state: answer === null ? null : (said.get(a.id) ?? 'check-failed')
  }))
}
