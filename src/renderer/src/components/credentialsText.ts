// The words Settings › Security & Access › Credentials and Audit Logs' credential uses show (credentials design §5, §7),
// and the small readings of what the Host answers, apart from the components so each is tested as text. The Host keeps
// the list and the uses and checks every change; this side only says what it answered, in the person's language. No value
// is ever part of any of it: an entry holds names.
import type { MessageKey, MessageParams } from '../../../core/i18n'
import type { CredentialUse } from '../../../core/audit/types'
import type { CredentialEntry, HideOnlyEntry, McpSecretEntry } from '../../../core/credentials/types'
import type { CredentialUsesQuery } from '../../../core/types'
import { ACTION_PHRASES } from '../../../core/audit/phrases'
import { failureLine } from './extensionsText'

type T = (key: MessageKey, params?: MessageParams) => string
type Failure = { ok: false; code: string; message: string; reason?: string }

/** An entry as credentials-list answers it: an MCP entry also says whether a session would inherit any of its
 *  variables now (`present`) and when it was last used through the Gateway. */
export type ListedEntry = HideOnlyEntry | (McpSecretEntry & { present?: boolean; lastUsedAt?: string })

export interface ListedPreset {
  id: string
  label: string
  measuredOn: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')

export interface ListedProject {
  path: string
  name: string
}

/** credentials-list's answer: the entries, presets and projects it could read as such. */
export function listOf(body: unknown): { entries: ListedEntry[]; presets: ListedPreset[]; projects: ListedProject[] } {
  const b = isObject(body) ? body : {}
  const entries = (Array.isArray(b.entries) ? b.entries : []).filter(
    (e): e is ListedEntry =>
      isObject(e) &&
      (e.kind === 'hide-only' || e.kind === 'mcp-secret') &&
      typeof e.id === 'string' &&
      isStrings(e.envNames) &&
      isObject(e.hide) &&
      typeof e.hide.on === 'boolean' &&
      (e.kind === 'hide-only' ? typeof e.alias === 'string' && isStrings(e.presets) : typeof e.serverName === 'string')
  )
  const presets = (Array.isArray(b.presets) ? b.presets : []).filter(
    (p): p is ListedPreset => isObject(p) && typeof p.id === 'string' && typeof p.label === 'string' && isStrings(p.measuredOn)
  )
  const projects = (Array.isArray(b.projects) ? b.projects : []).filter(
    (p): p is ListedProject => isObject(p) && typeof p.path === 'string' && typeof p.name === 'string'
  )
  return { entries, presets, projects }
}

export const entryName = (e: CredentialEntry): string => (e.kind === 'hide-only' ? e.alias : e.serverName)

/** What an entry keeps out of sessions: its variable names, then its presets by their labels. */
export function hidesText(e: CredentialEntry, presets: readonly Pick<ListedPreset, 'id' | 'label'>[]): string {
  const named = e.kind === 'hide-only' ? e.presets.map((id) => presets.find((p) => p.id === id)?.label ?? id) : []
  return [...e.envNames, ...named].join(', ')
}

/** A folder as the platform compares it: one kind of slash, no trailing one, the case folded where the file system folds
 *  it (as core/files/tree's comparablePath does, which the renderer cannot import). */
const comparable = (p: string, platform: string): string => {
  const s = p.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s
}

export const samePath = (a: string, b: string, platform: string): boolean => comparable(a, platform) === comparable(b, platform)

/** A project's name by its folder while the app knows the project. */
export const projectNameOf = (projects: readonly { path: string; name: string }[], folder: string, platform: string): string | undefined =>
  projects.find((p) => samePath(p.path, folder, platform))?.name

/** Where an entry hides: every agent session, the sessions of the projects it is narrowed to (by name while the app
 *  knows the project, else by its folder), or nowhere while its switch is off. */
export function whereText(e: CredentialEntry, projectName: (path: string) => string | undefined, t: T): string {
  if (!e.hide.on) return t('settings.credentials.where.off')
  if (e.hide.projects === undefined) return t('settings.credentials.where.all')
  return t('settings.credentials.where.projects', { names: e.hide.projects.map((p) => projectName(p) ?? p).join(', ') })
}

/** What turning an entry's switch on changes for the person, where it is more than the names it lists: the gh preset
 *  takes away what agents did with gh; an MCP server keeps working through Astera, or nothing changes now when no
 *  session would inherit its variables. Null when the names say it all. */
export function switchNote(e: CredentialEntry & { present?: boolean }, t: T): string | null {
  if (e.kind === 'mcp-secret') return e.present === false ? t('settings.credentials.note.mcpNothingNow') : t('settings.credentials.note.mcp')
  return e.presets.includes('gh') ? t('settings.credentials.note.gh') : null
}

/** Variable names as typed: separated by commas or spaces, each once. */
export const splitNames = (s: string): string[] => [...new Set(s.split(/[\s,]+/).filter((n) => n !== ''))]

const REFUSALS: Record<string, MessageKey> = {
  'protected-name': 'settings.credentials.refuse.protected-name',
  'bad-name': 'settings.credentials.refuse.bad-name',
  empty: 'settings.credentials.refuse.empty',
  'unknown-preset': 'settings.credentials.refuse.unknown-preset',
  'alias-empty': 'settings.credentials.refuse.alias-empty'
}

/** Why the Host did not answer or refused: a damaged list, the Host away, a refused entry by its reason, else what the
 *  Host said. */
export function credentialFailure(r: Failure, t: T): string {
  if (r.reason === 'damaged') return t('settings.credentials.damaged')
  if (r.code === 'HOST_NOT_RUNNING') return t('settings.credentials.noHost')
  if (r.reason !== undefined && Object.hasOwn(REFUSALS, r.reason)) return t(REFUSALS[r.reason])
  return failureLine(r, t, { read: true })
}

/** The actions a use can be, in words: Audit Logs' own phrases where the tool calls have the same action. */
const USE_ACTIONS: Record<CredentialUse['action'], MessageKey> = {
  'mcp.call': ACTION_PHRASES['mcp.call'],
  'github.read': 'settings.credentials.action.github.read',
  'github.pr.create': ACTION_PHRASES['github.pr.create'],
  'github.ci.rerun': 'settings.credentials.action.github.ci.rerun',
  'github.write': ACTION_PHRASES['github.write'],
  'git.remote.write': ACTION_PHRASES['git.remote.write']
}

const ACTORS: Record<CredentialUse['actor'], MessageKey> = {
  session: 'settings.credentials.actor.session',
  mcp: 'settings.credentials.actor.mcp',
  app: 'settings.credentials.actor.app',
  host: 'settings.credentials.actor.host',
  controller: 'settings.credentials.actor.controller',
  outside: 'settings.credentials.actor.outside'
}

const OUTCOMES: Record<CredentialUse['outcome'], MessageKey> = {
  ok: 'settings.credentials.outcome.ok',
  failed: 'settings.credentials.outcome.failed'
}

const EVIDENCE: Record<CredentialUse['evidence'], MessageKey> = {
  managed: 'settings.credentials.evidence.managed',
  observed: 'settings.credentials.evidence.observed'
}

const word = <K extends string>(table: Record<K, MessageKey>, k: string, t: T): string => (Object.hasOwn(table, k) ? t(table[k as K]) : k)

/** A session by its tab's title while this app has one, else by the start of its id (one closed since, or a worker's). */
export const sessionName = (id: string, sessionTitle: (id: string) => string | undefined, t: T): string =>
  sessionTitle(id) ?? `${t(ACTORS.session)} ${id.slice(0, 8)}`

/** A use as a row: who asked (a session by its name), what it did, to what, how it went and how Astera knows. */
export function useLine(
  u: CredentialUse,
  sessionTitle: (id: string) => string | undefined,
  t: T
): { who: string; action: string; target: string; outcome: string; evidence: string } {
  const who = u.sessionId !== undefined ? sessionName(u.sessionId, sessionTitle, t) : word(ACTORS, u.actor, t)
  return { who, action: word(USE_ACTIONS, u.action, t), target: u.resource, outcome: word(OUTCOMES, u.outcome, t), evidence: word(EVIDENCE, u.evidence, t) }
}

export interface UsesCursor {
  until: string
  beforeId: string
}

const USE_STRINGS = ['id', 'at', 'actor', 'provider', 'action', 'resource', 'outcome', 'evidence'] as const

/** credentials-uses' answer: the uses it could read as such, and where the next page starts when the Host stopped at the
 *  limit (the last row's time and id, the order a page is in). */
export function usesPageOf(body: unknown): { uses: CredentialUse[]; next: UsesCursor | null } {
  const b = isObject(body) ? body : {}
  const uses = (Array.isArray(b.uses) ? b.uses : []).filter((u): u is CredentialUse => isObject(u) && USE_STRINGS.every((k) => typeof u[k] === 'string'))
  const last = uses.at(-1)
  return { uses, next: b.truncated === true && last !== undefined ? { until: last.at, beforeId: last.id } : null }
}

export type UsesFilters = Pick<CredentialUsesQuery, 'entryId' | 'provider' | 'sessionId'>

/** A later page after the rows already shown, without showing one twice. */
export function appendUses(rows: readonly CredentialUse[], more: readonly CredentialUse[]): CredentialUse[] {
  const seen = new Set(rows.map((r) => r.id))
  return [...rows, ...more.filter((r) => !seen.has(r.id))]
}

/** The sessions the rows name, each once in the order they first appear, after those earlier reads found. */
export function useSessions(rows: readonly CredentialUse[], before: readonly string[] = []): string[] {
  const out = [...before]
  for (const r of rows) if (r.sessionId !== undefined && !out.includes(r.sessionId)) out.push(r.sessionId)
  return out
}

/** The line the uses view shows instead of rows: why there is nothing. Null when the rows say it all. */
export function usesStateLine(s: { failure: Failure | null; count: number }, t: T): string | null {
  if (s.failure !== null) return credentialFailure(s.failure, t)
  return s.count === 0 ? t('settings.credentials.uses.empty') : null
}

/** Every key this file and the section say, so a test can hold the four catalogs to them. */
export const CREDENTIAL_KEYS: MessageKey[] = [
  'settings.credentials.hint',
  'settings.credentials.sessions',
  'settings.credentials.none',
  'settings.credentials.kind.mcp',
  'settings.credentials.kind.hideOnly',
  'settings.credentials.where.all',
  'settings.credentials.where.projects',
  'settings.credentials.where.off',
  'settings.credentials.hide',
  'settings.credentials.scope.label',
  'settings.credentials.scope.projects',
  'settings.credentials.scope.noProjects',
  'settings.credentials.note.gh',
  'settings.credentials.note.mcp',
  'settings.credentials.note.mcpNothingNow',
  'settings.credentials.presetNote',
  'settings.credentials.preset.unmeasured',
  'settings.credentials.damaged',
  'settings.credentials.noHost',
  'settings.credentials.reset',
  'settings.credentials.reset.title',
  'settings.credentials.reset.body',
  'settings.credentials.add',
  'settings.credentials.alias',
  'settings.credentials.envNames',
  'settings.credentials.envNames.hint',
  'settings.credentials.presets',
  'settings.credentials.create',
  'settings.credentials.save',
  'settings.credentials.delete',
  'settings.credentials.delete.title',
  'settings.credentials.delete.body',
  'settings.credentials.protected',
  'settings.credentials.lastUsed',
  'settings.credentials.hidesNothing',
  ...Object.values(REFUSALS),
  'settings.credentials.view.label',
  'settings.credentials.view.calls',
  'settings.credentials.view.uses',
  'settings.credentials.uses.hint',
  'settings.credentials.uses.empty',
  'settings.credentials.filter.entry',
  'settings.credentials.filter.allEntries',
  'settings.credentials.filter.provider',
  'settings.credentials.filter.allProviders',
  'settings.credentials.provider.mcp',
  'settings.credentials.provider.github',
  'settings.credentials.col.who',
  'settings.credentials.col.result',
  ...Object.values(USE_ACTIONS),
  ...Object.values(ACTORS),
  ...Object.values(OUTCOMES),
  ...Object.values(EVIDENCE)
]
