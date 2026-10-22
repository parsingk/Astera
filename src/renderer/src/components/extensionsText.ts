// The sentences Settings › Extensions shows (Agent Control Plane release 1 design §4.10), apart from the component so
// each is tested as text: an item's kind, how its copy in an account stands, why something cannot be shared, the
// import dialog and what the person picked in it, and why a call came back with nothing. No environment value ever
// reaches this side; the Host answers names only.
import type { MessageKey, MessageParams } from '../../../core/i18n'
import type { ExtensionKind, SkipReason, SyncOutcome } from '../../../core/extensions/types'
import type { NotShareableReason } from '../../../core/extensions/envRules'
import { looksSecret } from '../../../core/extensions/envRules'

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
const OUTCOMES: Record<SyncOutcome, MessageKey> = {
  written: 'settings.extensions.outcome.written',
  unchanged: 'settings.extensions.outcome.unchanged',
  adopted: 'settings.extensions.outcome.adopted',
  restored: 'settings.extensions.outcome.restored',
  conflict: 'settings.extensions.outcome.conflict',
  removed: 'settings.extensions.outcome.removed',
  forgotten: 'settings.extensions.outcome.forgotten',
  failed: 'settings.extensions.outcome.failed',
  'not-applicable': 'settings.extensions.outcome.not-applicable'
}
const REASONS: Record<NotShareableReason, MessageKey> = {
  'env-reference': 'settings.extensions.reason.env-reference',
  'astera-own': 'settings.extensions.reason.astera-own',
  'header-secret': 'settings.extensions.reason.header-secret',
  'arg-secret': 'settings.extensions.reason.arg-secret'
}
const MCP_STATES: Record<'given' | SkipReason, MessageKey> = {
  given: 'settings.extensions.mcp.given',
  'account-own': 'settings.extensions.mcp.account-own',
  'account-unreadable': 'settings.extensions.mcp.account-unreadable',
  'launch-chars': 'settings.extensions.mcp.launch-chars',
  'gateway-unavailable': 'settings.extensions.mcp.gateway-unavailable',
  provider: 'settings.extensions.mcp.provider',
  transport: 'settings.extensions.mcp.transport'
}
const ENV_SOURCES: Record<string, MessageKey> = {
  secret: 'settings.extensions.envSource.secret',
  value: 'settings.extensions.envSource.value',
  inherit: 'settings.extensions.envSource.inherit'
}

/** The heading of a kind's group. */
export const kindLabel = (k: ExtensionKind, t: T): string => t(KINDS[k])
/** One item of a kind, before its name. */
export const kindOneLabel = (k: ExtensionKind, t: T): string => t(KIND_ONE[k])
/** How an item's copy in one account stands after the last sync; one this app does not know by itself. */
export const outcomeLabel = (o: string, t: T): string => (Object.hasOwn(OUTCOMES, o) ? t(OUTCOMES[o as SyncOutcome]) : o)
/** Whether one account's sessions get a shared MCP server, or why not (final review I1). */
export const mcpStateLabel = (s: string, t: T): string => (Object.hasOwn(MCP_STATES, s) ? t(MCP_STATES[s as 'given' | SkipReason]) : s)
export const reasonLabel = (r: string, t: T): string => (Object.hasOwn(REASONS, r) ? t(REASONS[r as NotShareableReason]) : r)
/** Where an MCP server's environment value comes from, as the Host names it. */
export const envSourceLabel = (s: string, t: T): string => (Object.hasOwn(ENV_SOURCES, s) ? t(ENV_SOURCES[s]) : s)

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
const secretId = (i: Pick<FoundItem, 'kind' | 'name'>, env: string): string => `secret:${i.kind}:${i.name}:${env}`

/** The import dialog for what `extensions-discover` found in the account labelled `label`: one choice an item that can
 *  be shared, then one per environment name of an MCP server, "keep as a secret", checked when the name reads as a
 *  credential; what cannot be shared is listed in the body with why. Nothing starts checked but the secrets. */
export function importPrompt(
  items: readonly FoundItem[],
  label: string,
  t: T
): { title: string; body: string; footer: string; confirmLabel: string; choices: { id: string; label: string; hint?: string; defaultChecked: boolean }[] } {
  const choices: { id: string; label: string; hint?: string; defaultChecked: boolean }[] = []
  for (const i of items.filter((x) => x.shareable)) {
    choices.push({ id: itemId(i), label: `${kindOneLabel(i.kind, t)} ${i.name}`, defaultChecked: false })
    for (const env of i.mcp?.envNames ?? [])
      choices.push({
        id: secretId(i, env),
        label: t('settings.extensions.import.keepSecret', { server: i.name, name: env }),
        hint: t('settings.extensions.import.secretHint'),
        defaultChecked: looksSecret(env)
      })
  }
  const refused = items
    .filter((x) => !x.shareable)
    .map((i) => t('settings.extensions.import.notShareable', { kind: kindOneLabel(i.kind, t), name: i.name, reason: reasonLabel(i.reason ?? '', t) }))
  return {
    title: t('settings.extensions.import.title', { label }),
    body: [t('settings.extensions.import.body', { label }), ...refused].join('\n'),
    footer: t('settings.extensions.import.footer'),
    confirmLabel: t('settings.extensions.import.confirm'),
    choices
  }
}

/** What the person picked in `importPrompt`'s dialog: each checked item, an MCP server with the names it keeps as
 *  secrets (always given, so an unchecked default is not taken back by the Host's own default). */
export function picksOf(items: readonly FoundItem[], checked: readonly string[]): ImportPick[] {
  const on = new Set(checked)
  return items
    .filter((i) => i.shareable && on.has(itemId(i)))
    .map((i) =>
      i.kind === 'mcp'
        ? { kind: i.kind, name: i.name, secretNames: (i.mcp?.envNames ?? []).filter((env) => on.has(secretId(i, env))) }
        : { kind: i.kind, name: i.name }
    )
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
