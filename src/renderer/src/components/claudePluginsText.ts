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
import type { CodexPluginAccountState, CodexPluginFailureCode } from '../../../core/extensions/codexPlugins/types'
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
  // The same words as the refusal the register dialog shows before a share is asked for
  'name-taken': 'settings.extensions.plugin.reason.name-taken',
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

// The words for each Codex failure code. `refused` and `timed-out` are also Claude codes, but their Claude wording names
// claude and Claude Code, so Codex has its own
const CODEX_CODES: Record<CodexPluginFailureCode, MessageKey> = {
  'marketplace-taken': 'settings.extensions.plugin.codex.code.marketplace-taken',
  'codex-unsupported': 'settings.extensions.plugin.codex.code.codex-unsupported',
  'config-unreadable': 'settings.extensions.plugin.codex.code.config-unreadable',
  'hooks-unreadable': 'settings.extensions.plugin.codex.code.hooks-unreadable',
  refused: 'settings.extensions.plugin.codex.code.refused',
  'timed-out': 'settings.extensions.plugin.codex.code.timed-out'
}

/** Why a plugin cannot be shared; a reason this build does not know reads as the Host's own word. */
export const refusalLabel = (r: string, t: T): string => (Object.hasOwn(REFUSALS, r) ? t(REFUSALS[r as ClaudePluginRefusal]) : r)

/** A job the Host has not finished: the tab reads the list again while one is. */
export const isLiveJob = (j: Pick<ClaudePluginJob, 'state'>): boolean => j.state === 'queued' || j.state === 'running'

/** How long after a plugin job ends the list is still read for the Codex outcome. */
export const CODEX_CATCH_UP_MS = 3 * 60_000

/** Whether the Codex outcome may still be catching up with the last share, update or removal (not a check, which changes
 *  no plugin). The Codex sync starts after the job ends and runs codex in each account, so the last read of a job can see
 *  it done while the rows still trail it. That is so while a listed Codex account has no row, or one written before the
 *  job ended, and it is given up 3 minutes after the job ended, however the rows stand: an account with nothing to
 *  record may never get a row. No listed Codex account, no job that ended, or a time that cannot be read waits for
 *  nothing. */
export function codexCatchingUp(
  jobs: readonly Pick<ClaudePluginJob, 'kind' | 'endedAt'>[],
  rows: readonly Pick<CodexPluginAccountState, 'accountId' | 'at'>[],
  codexAccountIds: readonly string[],
  now: number
): boolean {
  const ends = jobs.flatMap((j) => (j.kind !== 'check' && j.endedAt !== undefined ? [Date.parse(j.endedAt)] : [])).filter(Number.isFinite)
  if (codexAccountIds.length === 0 || ends.length === 0) return false
  const endedAt = Math.max(...ends)
  if (now >= endedAt + CODEX_CATCH_UP_MS) return false
  return codexAccountIds.some((id) => {
    const row = rows.find((r) => r.accountId === id)
    return row === undefined || Date.parse(row.at) < endedAt
  })
}

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

/** One line per Codex account, in the order the accounts are listed (§5.8), with the outcome row the sync left for it. A
 *  failure comes first: the Host keeps the installs when only the trust of the hooks failed, and the attention mark has to
 *  have its reason on the row. Then held: the new version could not be made into a Codex copy, so the account keeps the
 *  one it has and waits for nothing. Then waiting, but only while this plugin is not at the shared version (the account
 *  waits as a whole, for any plugin it has to change), then the version Codex has, and otherwise not installed yet, which
 *  is also what a held plugin the account does not have reads as. An own plugin of the same name that Astera turned off in
 *  the account adds a line. A failure Astera decided is worded; one Codex reported, or a code this build does not know, is
 *  shown as the message. A row of an account no longer listed says nothing. While two or more accounts all have the
 *  shared version and nothing else to say, one line says so for all of them, and the turned-off lines follow it. */
export function codexLines(
  p: Pick<ListedClaudePlugin, 'name' | 'version'>,
  rows: readonly CodexPluginAccountState[],
  codexAccountIds: readonly string[],
  labelOf: LabelOf,
  t: T
): string[] {
  const accounts = codexAccountIds.map((id) => {
    const row = rows.find((r) => r.accountId === id)
    const account = labelOf(id)
    const version = row !== undefined && Object.hasOwn(row.installed, p.name) ? row.installed[p.name] : undefined
    let state: string
    let shared = false
    if (row?.failure !== undefined) {
      const { code, message } = row.failure
      const reason = code !== undefined && Object.hasOwn(CODEX_CODES, code) ? t(CODEX_CODES[code]) : message
      state = t('settings.extensions.plugin.codex.failed', { account, reason })
    } else if (version !== undefined && row?.held?.includes(p.name) === true) state = t('settings.extensions.plugin.codex.held', { account })
    else if (row?.waiting === true && version !== p.version) state = t('settings.extensions.plugin.codex.waiting', { account })
    else if (version !== undefined) {
      state = t('settings.extensions.plugin.codex.installed', { account, version })
      shared = version === p.version
    } else state = t('settings.extensions.plugin.codex.pending', { account })
    const off = (row?.turnedOff ?? []).filter((own) => own.split('@')[0] === p.name).map((own) => t('settings.extensions.plugin.codex.turnedOff', { account, id: own }))
    return { state, shared, off }
  })
  if (accounts.length > 1 && accounts.every((a) => a.shared)) {
    return [t('settings.extensions.plugin.codex.allInstalled', { count: accounts.length, version: p.version }), ...accounts.flatMap((a) => a.off)]
  }
  return accounts.flatMap((a) => [a.state, ...a.off])
}

/** How Codex differs for what this plugin brings (§5.8): agents are left out, commands become skills, and Astera trusts
 *  the hooks. A note for each the plugin has; none from a Host that does not say what it brings. The row shows them only
 *  while a Codex account exists. */
export function codexNotes(p: Pick<ListedClaudePlugin, 'name' | 'contents'>, t: T): string[] {
  const c = p.contents
  if (c === undefined) return []
  return [
    ...(c.agents.length > 0 ? [t('settings.extensions.plugin.codex.noteAgents')] : []),
    ...(c.commands.length > 0 ? [t('settings.extensions.plugin.codex.noteCommands', { name: p.name })] : []),
    ...(c.hooks ? [t('settings.extensions.plugin.codex.noteHooks')] : [])
  ]
}

/** Whether a Codex account failed, which the collapsed row marks as it does a failed job. A failure belongs to the account,
 *  not to one plugin, so `p` does not narrow it. */
export const codexAttention = (_p: Pick<ListedClaudePlugin, 'name'>, rows: readonly CodexPluginAccountState[]): boolean => rows.some((r) => r.failure !== undefined)

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

const PLUGIN_CHOICE = 'plugin:'

/** The plugins `pluginDiscover` found in the account picked in the register menu, as choices of that account's dialog
 *  (K4), the area after its servers and skills under the Plugins heading: one choice a plugin that can be shared, its id
 *  alone, hinted with the version a share would install when the catalog says (§5.3). A plugin that cannot be shared is
 *  not a choice; it is listed with why, for the dialog's body. Nothing starts checked. */
export function pluginChoices(found: readonly OfferedClaudePlugin[], t: T): { choices: ConfirmChoice[]; refused: string[] } {
  const group = t('settings.extensions.plugin.group')
  const choices = found
    .filter((p) => p.shareable)
    .map((p) => ({
      id: `${PLUGIN_CHOICE}${p.id}`,
      label: p.id,
      group,
      ...(typeof p.offeredVersion === 'string' ? { hint: t('settings.extensions.plugin.offeredVersion', { version: p.offeredVersion }) } : {}),
      defaultChecked: false
    }))
  const refused = found.flatMap((p) => (p.shareable ? [] : [`${p.id}: ${refusalLabel(p.reason, t)}`]))
  return { choices, refused }
}

/** The plugin ids among the choices the person checked in the register dialog. */
export const pickedPluginIds = (checked: readonly string[]): string[] =>
  checked.filter((id) => id.startsWith(PLUGIN_CHOICE)).map((id) => id.slice(PLUGIN_CHOICE.length))

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
