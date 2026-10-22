// The words Settings › Extensions shows (Agent Control Plane, release 1 design §4.10, release 2 §4.5), apart from the
// component so each is tested as text. The screen says only what a person acts on: what is shared, whether an account
// cannot use it and why, and what went wrong; how the sharing works underneath is not explained there. No environment
// value ever reaches this side; the Host answers names only.
import type { MessageKey, MessageParams } from '../../../core/i18n'
import type { ExtensionKind, SkipReason } from '../../../core/extensions/types'
import type { NotShareableReason } from '../../../core/extensions/envRules'

type T = (key: MessageKey, params?: MessageParams) => string

const KINDS: Record<ExtensionKind, MessageKey> = {
  mcp: 'settings.extensions.kind.mcp',
  skill: 'settings.extensions.kind.skill',
  command: 'settings.extensions.kind.command',
  agent: 'settings.extensions.kind.agent'
}
const KIND_ONE: Record<ExtensionKind, MessageKey> = {
  mcp: 'settings.extensions.kindOne.mcp',
  skill: 'settings.extensions.kindOne.skill',
  command: 'settings.extensions.kindOne.command',
  agent: 'settings.extensions.kindOne.agent'
}
const REASONS: Record<NotShareableReason, MessageKey> = {
  'env-reference': 'settings.extensions.reason.env-reference',
  'astera-own': 'settings.extensions.reason.astera-own',
  'header-secret': 'settings.extensions.reason.header-secret',
  'arg-secret': 'settings.extensions.reason.arg-secret'
}
const NOT_GIVEN: Record<SkipReason, MessageKey> = {
  'account-own': 'settings.extensions.mcp.account-own',
  'account-unreadable': 'settings.extensions.mcp.account-unreadable',
  'launch-chars': 'settings.extensions.mcp.launch-chars',
  'gateway-unavailable': 'settings.extensions.mcp.gateway-unavailable',
  provider: 'settings.extensions.mcp.provider',
  transport: 'settings.extensions.mcp.transport'
}

/** The heading of a kind's group. */
export const kindLabel = (k: ExtensionKind, t: T): string => t(KINDS[k])
/** One item of a kind, before its name. */
export const kindOneLabel = (k: ExtensionKind, t: T): string => t(KIND_ONE[k])
export const reasonLabel = (r: string, t: T): string => (Object.hasOwn(REASONS, r) ? t(REASONS[r as NotShareableReason]) : r)
/** Why an account does not get a shared MCP server, when the person can do something about it or should know: an account
 *  using its own server of that name (the one it was imported from, often) or one the server is not for says nothing. */
export const notGivenWorthSaying = (s: string): boolean => s !== 'given' && s !== 'account-own' && s !== 'provider'

/** Why one account's sessions do not get a shared MCP server. */
export const notGivenLabel = (s: string, t: T): string => (Object.hasOwn(NOT_GIVEN, s) ? t(NOT_GIVEN[s as SkipReason]) : s)

/** What is wrong with one account's copy of a shared skill, command or agent, or null when nothing a person acts on. */
export function copyProblem(outcome: string, t: T): string | null {
  if (outcome === 'conflict') return t('settings.extensions.outcome.conflict')
  if (outcome === 'failed') return t('settings.extensions.outcome.failed')
  return null
}

/** What is wrong with a shared MCP server's process, or null while it is fine or simply not started yet. */
export function serverProblem(s: { state: string; lastError?: string } | undefined, t: T): string | null {
  if (s?.state === 'failed') return t('settings.extensions.gateway.failed', { error: s.lastError ?? '' })
  if (s?.state === 'restarting') return t('settings.extensions.gateway.restarting')
  return null
}

/** What the Host found in a default account (`extensions-discover`), as far as this side needs it. */
export interface FoundItem {
  kind: ExtensionKind
  name: string
  shareable: boolean
  reason?: string
  mcp?: { envNames?: string[] }
}

export interface ImportPick {
  kind: ExtensionKind
  name: string
  secretNames?: string[]
}

const itemId = (i: Pick<FoundItem, 'kind' | 'name'>): string => `item:${i.kind}:${i.name}`

/** Astera's own skills and server, which an account always has: never offered, and not worth a line either. */
export const offeredItems = (items: readonly FoundItem[]): FoundItem[] => items.filter((i) => i.reason !== 'astera-own')

/** The import dialog for what `extensions-discover` found in the account labelled `label`: one choice an item that can
 *  be shared; what cannot be shared is listed in the body with why, Astera's own left out. Nothing starts checked. */
export function importPrompt(
  items: readonly FoundItem[],
  label: string,
  t: T
): { title: string; body: string; footer: string; confirmLabel: string; choices: { id: string; label: string; defaultChecked: boolean }[] } {
  const choices = items.filter((x) => x.shareable).map((i) => ({ id: itemId(i), label: `${kindOneLabel(i.kind, t)} ${i.name}`, defaultChecked: false }))
  const refused = offeredItems(items)
    .filter((x) => !x.shareable)
    .map((i) => t('settings.extensions.import.notShareable', { kind: kindOneLabel(i.kind, t), name: i.name, reason: reasonLabel(i.reason ?? '', t) }))
  return {
    title: t('settings.extensions.import.title', { label }),
    body: [t('settings.extensions.import.body'), ...refused].join('\n'),
    footer: t('settings.extensions.import.footer'),
    confirmLabel: t('settings.extensions.import.confirm'),
    choices
  }
}

/** What the person picked in `importPrompt`'s dialog. An MCP server's environment values are all kept in Astera's
 *  secret store: none of them reaches a session, so there is nothing for the person to choose there. */
export function picksOf(items: readonly FoundItem[], checked: readonly string[]): ImportPick[] {
  const on = new Set(checked)
  return items
    .filter((i) => i.shareable && on.has(itemId(i)))
    .map((i) => (i.kind === 'mcp' ? { kind: i.kind, name: i.name, secretNames: i.mcp?.envNames ?? [] } : { kind: i.kind, name: i.name }))
}

/** Why a call came back with nothing, as the Host's route says it. */
export function failureLine(r: { ok: false; code: string; message: string }, t: T, o: { read?: boolean } = {}): string {
  switch (r.code) {
    case 'HOST_NOT_RUNNING':
      return t('settings.plugins.fail.noHost')
    case 'NOT_SUPPORTED':
      return t('settings.extensions.fail.notSupported', { message: r.message })
    case 'TIMEOUT':
      return o.read === true ? t('settings.plugins.fail.timeoutRead') : t('settings.plugins.fail.timeout')
    case 'HOST_LOST':
      return o.read === true ? t('settings.plugins.fail.lostRead') : t('settings.plugins.fail.lost')
    default:
      return r.message
  }
}
