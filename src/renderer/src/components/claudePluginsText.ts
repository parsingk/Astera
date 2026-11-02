// The words the Plugins group in Settings › MCP & Skills shows for the shared Claude Code plugins (Claude plugin sharing
// design §5.9), apart from the component so each is tested as text. A failure Astera decided carries a code and is said
// in the person's language; one Claude Code reported is shown in Claude Code's own words.
import type { MessageKey, MessageParams } from '../../../core/i18n'
import type {
  ClaudePluginContents,
  ClaudePluginDependency,
  ClaudePluginFailureCode,
  ClaudePluginHolder,
  ClaudePluginJob,
  ClaudePluginRefusal,
  OfferedClaudePlugin,
  SharedClaudePlugin
} from '../../../core/extensions/claudePlugins/types'
import type { ConfirmChoice } from '../lib/confirm'

type T = (key: MessageKey, params?: MessageParams) => string
type LabelOf = (accountId: string) => string

/** A shared plugin as `pluginList` answers it: whether its folder (or a dependency's) is gone, each account's own copy
 *  of the same id, the enabled shared plugins that need it, and what it brings (absent from a Host that does not say). */
export type ListedClaudePlugin = SharedClaudePlugin & {
  missing: boolean
  accountCopies: ClaudePluginHolder[]
  requiredBy: string[]
  contents?: ClaudePluginContents
}

const REFUSALS: Record<ClaudePluginRefusal | 'not-offered', MessageKey> = {
  'user-config': 'settings.extensions.plugin.reason.user-config',
  'source-credential': 'settings.extensions.plugin.reason.source-credential',
  'source-unsupported': 'settings.extensions.plugin.reason.source-unsupported',
  'not-from-marketplace': 'settings.extensions.plugin.reason.not-from-marketplace',
  'name-taken': 'settings.extensions.plugin.reason.name-taken',
  // A share the Host refused because no account offers the id any more (removed meanwhile, or shared already)
  'not-offered': 'settings.extensions.plugin.reason.not-offered'
}
const CODES: Record<ClaudePluginFailureCode, MessageKey> = {
  'already-shared': 'settings.extensions.plugin.code.already-shared',
  'not-shared': 'settings.extensions.plugin.code.not-shared',
  'not-shareable': 'settings.extensions.plugin.code.not-shareable',
  'marketplace-mismatch': 'settings.extensions.plugin.code.marketplace-mismatch',
  'home-unreadable': 'settings.extensions.plugin.code.home-unreadable',
  'not-listed': 'settings.extensions.plugin.code.not-listed',
  'dependency-missing': 'settings.extensions.plugin.code.dependency-missing',
  'catalog-unreadable': 'settings.extensions.plugin.code.catalog-unreadable',
  'store-unreadable': 'settings.extensions.plugin.code.store-unreadable',
  refused: 'settings.extensions.plugin.code.refused',
  'timed-out': 'settings.extensions.plugin.code.timed-out'
}

/** Why a plugin cannot be shared; a reason this build does not know reads as the Host's own word. */
export const refusalLabel = (r: string, t: T): string => (Object.hasOwn(REFUSALS, r) ? t(REFUSALS[r as ClaudePluginRefusal]) : r)

/** A job the Host has not finished: the tab reads the list again while one is. */
export const isLiveJob = (j: Pick<ClaudePluginJob, 'state'>): boolean => j.state === 'queued' || j.state === 'running'

/** Where a job stands, or null once it is done and the list says the rest. */
export function jobLine(j: ClaudePluginJob, t: T): string | null {
  switch (j.state) {
    case 'queued':
      return t('settings.extensions.plugin.queued')
    case 'running':
      if (j.kind === 'check') return t('settings.extensions.plugin.checking')
      if (j.kind === 'remove') return t('settings.extensions.plugin.removing')
      return t('settings.extensions.plugin.installing')
    case 'needs-confirmation':
      return t('settings.extensions.plugin.needsConfirmation')
    case 'failed':
      // A code a newer Host sends that this build has no words for falls back to the message
      if (j.code !== undefined && Object.hasOwn(CODES, j.code)) return t(CODES[j.code])
      return t('settings.extensions.plugin.failed', { message: j.message ?? '' })
    case 'done':
      return null
  }
}

/** What a row says first: files that are gone (update installs them again), then an update, then that it is off. */
export function rowState(p: Pick<ListedClaudePlugin, 'missing' | 'update' | 'enabled'>): 'missing' | 'update' | 'off' | 'ok' {
  if (p.missing) return 'missing'
  if (p.update !== undefined) return 'update'
  if (!p.enabled) return 'off'
  return 'ok'
}

/** The update mark. A check compares the catalog, not versions (R3), so the versions are named only when the catalog
 *  offers a different one. */
export function updateLabel(current: string, offered: string | null, t: T): string {
  return offered !== null && offered !== current
    ? t('settings.extensions.plugin.updateAvailable', { from: current, to: offered })
    : t('settings.extensions.plugin.updateAvailableNoVersion')
}

/** The accounts holding a plugin, each with its version, joined with commas; one where it is switched off says so. */
export function holdersHint(holders: readonly ClaudePluginHolder[], labelOf: LabelOf, t: T): string {
  return holders.map((h) => `${labelOf(h.accountId)} ${h.version}${h.enabled ? '' : ` (${t('settings.extensions.off')})`}`).join(', ')
}

/** The body of the Off and Remove confirmations (P4): the accounts whose own copy runs again from their next session,
 *  with its version, and the shared plugins that keep loading this one while they are on. An account whose own copy
 *  is switched off does not run it, so it is not named. */
export function offConfirmBody(p: Pick<ListedClaudePlugin, 'accountCopies' | 'requiredBy'>, labelOf: LabelOf, t: T, action: 'off' | 'remove' = 'off'): string {
  const own = p.accountCopies.filter((h) => h.enabled)
  const lines = [
    own.length > 0
      ? t(action === 'off' ? 'settings.extensions.plugin.offBody' : 'settings.extensions.plugin.removeBody', { list: holdersHint(own, labelOf, t) })
      : t(action === 'off' ? 'settings.extensions.plugin.offBodyNone' : 'settings.extensions.plugin.removeBodyNone')
  ]
  if (p.requiredBy.length > 0) lines.push(t('settings.extensions.plugin.offRequiredBy', { list: p.requiredBy.join(', ') }))
  return lines.join('\n')
}

/** Each account's own copy, worded by what runs there (P4): while the shared plugin is on, the shared version stands in
 *  for it; while off, the account's own version runs, unless that copy is switched off in the account too. */
export function ownCopyLines(p: Pick<ListedClaudePlugin, 'enabled' | 'accountCopies'>, labelOf: LabelOf, t: T): string[] {
  return p.accountCopies.map((h) => {
    const params = { account: labelOf(h.accountId), version: h.version }
    if (p.enabled) return t('settings.extensions.plugin.ownCopy', params)
    return t(h.enabled ? 'settings.extensions.plugin.ownCopyOff' : 'settings.extensions.plugin.ownCopyOffDisabled', params)
  })
}

/** What Claude Code installed with the plugin, which loads with it (§5.4), one line each. */
export const dependencyLines = (deps: readonly ClaudePluginDependency[], t: T): string[] =>
  deps.map((d) => t('settings.extensions.plugin.dependency', { name: d.id, version: d.version }))

const CONTENT_KINDS: [kind: 'skills' | 'commands' | 'agents' | 'mcpServers', key: MessageKey][] = [
  ['skills', 'settings.extensions.plugin.contents.skills'],
  ['commands', 'settings.extensions.plugin.contents.commands'],
  ['agents', 'settings.extensions.plugin.contents.agents'],
  ['mcpServers', 'settings.extensions.plugin.contents.mcpServers']
]

/** What the plugin brings (§5.9): a line a kind it has, with the count and the names, then whether it has hooks. */
export function contentLines(c: ClaudePluginContents | undefined, t: T): string[] {
  if (c === undefined) return []
  const lines = CONTENT_KINDS.flatMap(([kind, key]) => (c[kind].length === 0 ? [] : [t(key, { count: c[kind].length, list: c[kind].join(', ') })]))
  if (c.hooks) lines.push(t('settings.extensions.plugin.contents.hooks'))
  return lines
}

/** The register dialog for what `pluginDiscover` found across the Claude accounts: one choice a plugin that can be
 *  shared, labelled with its id over the accounts holding it and, on a line of its own, the version a share would
 *  install when the catalog says (§5.3). A plugin that cannot be shared is not a choice; it is listed in the body with
 *  why, as is each account whose plugins could not be read (ruling P-2). Nothing starts checked. */
export function pluginPrompt(
  found: readonly OfferedClaudePlugin[],
  unreadable: readonly string[],
  labelOf: LabelOf,
  t: T
): { title: string; body: string; footer: string; confirmLabel: string; choices: ConfirmChoice[] } {
  const hint = (p: OfferedClaudePlugin): string =>
    [holdersHint(p.holders, labelOf, t), ...(typeof p.offeredVersion === 'string' ? [t('settings.extensions.plugin.offeredVersion', { version: p.offeredVersion })] : [])].join('\n')
  const choices = found.filter((p) => p.shareable).map((p) => ({ id: p.id, label: p.id, hint: hint(p), defaultChecked: false }))
  const refused = found.flatMap((p) => (p.shareable ? [] : [`${p.id}: ${refusalLabel(p.reason, t)}`]))
  return {
    title: t('settings.extensions.plugin.register'),
    body: [
      t('settings.extensions.plugin.registerBody'),
      ...refused,
      ...unreadable.map((accountId) => t('settings.extensions.plugin.unreadable', { account: labelOf(accountId) }))
    ].join('\n'),
    footer: t('settings.extensions.import.footer'),
    confirmLabel: t('settings.extensions.import.confirm'),
    choices
  }
}

/** The latest job for one plugin id, the Host listing jobs in the order they were asked for. */
export const latestJob = (jobs: readonly ClaudePluginJob[], target: string): ClaudePluginJob | undefined => jobs.filter((j) => j.target === target).at(-1)

/** A line for each plugin id the list does not hold whose latest job has something to say: a share under way or
 *  stopped, or a removal (which takes the entry out first) under way or failed. `stopped` is one that ended. */
export function pendingLines(jobs: readonly ClaudePluginJob[], listed: ReadonlySet<string>, t: T): { id: string; line: string; stopped: boolean }[] {
  const latest = new Map<string, ClaudePluginJob>()
  for (const j of jobs) if (j.target !== undefined) latest.set(j.target, j)
  return [...latest].flatMap(([id, j]) => {
    const line = listed.has(id) ? null : jobLine(j, t)
    return line === null ? [] : [{ id, line, stopped: !isLiveJob(j) }]
  })
}
