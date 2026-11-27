// The sentences Settings › Plugins shows (plugin runtime design slice 2d), apart from the component so each is tested
// as text: a permission and a status in words, the install warning (spec §31), what a settings form changed (§23-24),
// how a plugin stands after a save, and why a call came back with nothing.
import type { MessageKey, MessageParams } from '../../../core/i18n'
import type { SettingField } from '../../../core/plugins/settings'

type T = (key: MessageKey, params?: MessageParams) => string

const PERMISSIONS: Record<string, MessageKey> = {
  'projects.read': 'settings.plugins.perm.projects.read',
  'jobs.read': 'settings.plugins.perm.jobs.read',
  'jobs.create': 'settings.plugins.perm.jobs.create',
  'jobs.run': 'settings.plugins.perm.jobs.run',
  'runs.read': 'settings.plugins.perm.runs.read',
  'runs.control': 'settings.plugins.perm.runs.control',
  'tasks.read': 'settings.plugins.perm.tasks.read',
  'tasks.write': 'settings.plugins.perm.tasks.write',
  'questions.read': 'settings.plugins.perm.questions.read',
  'questions.answer': 'settings.plugins.perm.questions.answer',
  'completion.read': 'settings.plugins.perm.completion.read',
  'events.subscribe': 'settings.plugins.perm.events.subscribe',
  'github.read': 'settings.plugins.perm.github.read',
  'github.write': 'settings.plugins.perm.github.write',
  'how-it-works.read': 'settings.plugins.perm.how-it-works.read',
  // Plugin API 2's UI permissions (core/plugins/manifest.ts PLUGIN_UI_PERMISSIONS)
  'commands.register': 'settings.plugins.perm.commands.register',
  'panels.register': 'settings.plugins.perm.panels.register',
  'workspace.read': 'settings.plugins.perm.workspace.read',
  'themes.register': 'settings.plugins.perm.themes.register'
}

const STATUSES: Record<string, MessageKey> = {
  running: 'settings.plugins.status.running',
  starting: 'settings.plugins.status.starting',
  stopped: 'settings.plugins.status.stopped',
  failed: 'settings.plugins.status.failed',
  disabled: 'settings.plugins.status.disabled',
  incompatible: 'settings.plugins.status.incompatible',
  ready: 'settings.plugins.status.ready'
}

/** A permission in words; one this app does not know (a newer Host's) by its name. */
export const permissionLabel = (p: string, t: T): string => (Object.hasOwn(PERMISSIONS, p) ? t(PERMISSIONS[p]) : p)

export const statusLabel = (s: string, t: T): string => (Object.hasOwn(STATUSES, s) ? t(STATUSES[s]) : s)

/** A plugin's trust level in words (ADR-008). A Host that does not say runs only API 1 plugins, which are trusted code. */
export const trustLabel = (trust: unknown, t: T): string =>
  trust === 'restricted-ui'
    ? t('settings.plugins.trust.restrictedUi')
    : trust === 'declarative'
      ? t('settings.plugins.trust.declarative')
      : t('settings.plugins.trust.trusted')

/** The class a trust level is drawn with: an unknown one as trusted, as its label is. */
export const trustClass = (trust: unknown): 'trusted' | 'restricted-ui' | 'declarative' =>
  trust === 'restricted-ui' || trust === 'declarative' ? trust : 'trusted'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** The install warning (spec §31) for what `plugins.inspect` answered about `folder`: what it is, one choice a
 *  permission (unchecking one grants the rest, design P6), then the trust sentence in `footer`, below the choices.
 *  Every install asks again (P6); on an update, `previous` is the installed plugin as the list shows it, and a
 *  permission it asked for and was not granted starts unchecked, so a "no" given once is not turned into a "yes" by
 *  an Enter (2d final review I2). What the update newly asks for starts checked, as on a first install. */
export function installPrompt(
  inspection: Record<string, unknown>,
  /** The folder it is installed from, the npm package (plugins 2e), or the catalog (Phase 4). */
  from: string | { npm: string } | { catalog: { publisher: string; sha256: string } },
  t: T,
  previous?: { permissions?: unknown; requested?: unknown }
): { title: string; body: string; footer: string; confirmLabel: string; choices: { id: string; label: string; hint: string; defaultChecked: boolean }[] } {
  const permissions = list(inspection.permissions)
  const capabilities = list(inspection.capabilities)
  const installed = inspection.installed as { version?: unknown } | undefined
  const lines = [
    t('settings.plugins.install.what', { id: str(inspection.id), version: str(inspection.version) }),
    typeof from === 'string'
      ? t('settings.plugins.install.from', { folder: from })
      : 'npm' in from
        ? t('settings.plugins.install.fromNpm', { spec: from.npm })
        : t('settings.plugins.install.fromCatalog', { publisher: from.catalog.publisher, sha256: from.catalog.sha256 }),
    ...(installed && typeof installed.version === 'string' ? [t('settings.plugins.install.replaces', { version: installed.version })] : []),
    ...(str(inspection.description) !== '' ? [str(inspection.description)] : []),
    ...(capabilities.length > 0 ? [t('settings.plugins.install.capabilities', { list: capabilities.join(', ') })] : []),
    ...(inspection.compatible === false ? [t('settings.plugins.install.incompatible', { reason: str(inspection.reason) })] : [])
  ]
  const granted = installed && previous ? list(previous.permissions) : null
  const asked = installed && previous ? list(previous.requested) : []
  const withheld = (p: string): boolean => granted !== null && asked.includes(p) && !granted.includes(p)
  return {
    title: t('settings.plugins.install.title', { name: str(inspection.displayName) || str(inspection.id) }),
    body: lines.join('\n'),
    footer: [
      permissions.length > 0 ? t('settings.plugins.install.uncheck') : t('settings.plugins.install.noPermissions'),
      '',
      // ADR-008: a UI-only plugin is never introduced as trusted code, and a plugin with code always is; a themes-only one
      // runs no code and shows no page (Phase 2 remaining)
      inspection.trust === 'restricted-ui'
        ? t('settings.plugins.install.restrictedUi')
        : inspection.trust === 'declarative'
          ? t('settings.plugins.install.declarative')
          : t('settings.plugins.install.trust')
    ].join('\n'),
    confirmLabel: t('settings.plugins.install.button'),
    choices: permissions.map((p) => ({
      id: p,
      label: permissionLabel(p, t),
      hint: withheld(p) ? `${p} · ${t('settings.plugins.install.notGrantedBefore')}` : p,
      defaultChecked: !withheld(p)
    }))
  }
}

/** What a settings form changed, as `plugins.configure` takes it, or null when nothing did. `draft` holds only what the
 *  person touched. An emptied field goes back to its default (unset), unless it showed that default already. A secret
 *  is never shown (spec §23): its empty box leaves it as it is, and only `clear` unsets it. */
export function configureChanges(
  fields: readonly SettingField[],
  shown: { values: Record<string, unknown>; secrets: Record<string, unknown> },
  draft: Record<string, string | boolean>,
  clear: ReadonlySet<string>
): { set: Record<string, string | boolean>; unset: string[] } | null {
  const set: Record<string, string | boolean> = {}
  const unset: string[] = []
  for (const f of fields) {
    const has = Object.hasOwn(draft, f.key)
    if (f.secret) {
      if (clear.has(f.key)) {
        if (shown.secrets[f.key] === 'set') unset.push(f.key)
      } else if (has && typeof draft[f.key] === 'string' && draft[f.key] !== '') set[f.key] = draft[f.key]
      continue
    }
    if (!has) continue
    const v = draft[f.key]
    const current = shown.values[f.key]
    if (f.type === 'boolean') {
      // One with no value shows unchecked, so unchecking it again is no change (2d final review M6).
      if (typeof v === 'boolean' && v !== (current === true)) set[f.key] = v
      continue
    }
    const text = String(v)
    if (current !== undefined && text === String(current)) continue
    if (text.trim() === '') {
      if (current !== undefined && current !== f.default) unset.push(f.key)
      continue
    }
    set[f.key] = text
  }
  return Object.keys(set).length > 0 || unset.length > 0 ? { set, unset } : null
}

/** How the plugin stands after a save (`plugins.configure`'s status, reason and restarted). */
export function configureDoneLine(body: Record<string, unknown>, t: T): string {
  if (body.restarted === true) return t('settings.plugins.done.restarted')
  switch (body.status) {
    case 'running':
    case 'starting':
      return t('settings.plugins.done.starting')
    case 'failed':
      return t('settings.plugins.done.failed')
    case 'disabled':
      return t('settings.plugins.done.disabled')
    default: {
      if (typeof body.reason !== 'string') return t('settings.plugins.done.saved')
      // Still held back: the settings it needs, in the app's words (2d final review M1).
      const keys = neededSettings(body.reason)
      return keys !== null ? t('settings.plugins.done.needs', { keys }) : t('settings.plugins.done.held', { reason: body.reason })
    }
  }
}

/** The settings a held-back plugin needs, read from the Host's reason (manager.ts `heldBack`, pinned by manager.test.ts),
 *  or null for any other reason. */
const neededSettings = (reason: string): string | null => /^needs settings: ([^;]+); set them with astera plugins configure\b/.exec(reason)?.[1] ?? null

/** The Host's reason a plugin does not run, as the tab shows it. A held-back plugin's names the settings it needs and
 *  points at the CLI; beside a Configure button it says that instead. Any other reason is the Host's, or the plugin's
 *  own words, as they came. */
export function reasonLine(reason: string, t: T): string {
  const keys = neededSettings(reason)
  return keys !== null ? t('settings.plugins.needsSettings', { keys }) : reason
}

/** Why a call came back with nothing: in the app's words when no Host answered or it runs no plugins, else the Host's
 *  own sentence. A change that was not answered may have been made, and the list says whether; a read that was not
 *  answered says only that, since the list is what failed (2d final review I1). */
export function failureLine(r: { ok: false; code: string; message: string; reason?: string }, t: T, o: { read?: boolean } = {}): string {
  switch (r.code) {
    case 'HOST_NOT_RUNNING':
      return t('settings.plugins.fail.noHost')
    case 'NOT_SUPPORTED':
      return t('settings.plugins.fail.notSupported', { message: r.message })
    case 'TIMEOUT':
      return o.read === true ? t('settings.plugins.fail.timeoutRead') : t('settings.plugins.fail.timeout')
    case 'HOST_LOST':
      return o.read === true ? t('settings.plugins.fail.lostRead') : t('settings.plugins.fail.lost')
    // The Host's sentence points at a CLI flag; the app has a folder button (2e final review M4).
    case 'PLUGIN_NPM_MISSING':
      return t('settings.plugins.fail.npmMissing')
    // Why Astera could not have its own npm (plugins 2e-2), a blocking network in so many words (the user's decision).
    case 'PLUGIN_NPM_BLOCKED':
      return t('settings.plugins.fail.npmBlocked', { reason: r.reason ?? r.message })
    case 'PLUGIN_NPM_ALTERED':
      return t('settings.plugins.fail.npmAltered')
    case 'PLUGIN_NPM_FETCH_FAILED':
      // Only the reason the Host gives on its own: the rest of its sentence is the advice the app's words give.
      return t('settings.plugins.fail.npmFailed', { message: r.reason ?? r.message })
    default:
      return r.message
  }
}

/** Whether a failure is about npm itself, which the tab keeps as a notice under the package row until an install from
 *  npm works (the user's decision 2026-10-13), rather than a toast that goes. */
export const npmNotice = (r: { ok: false; code: string; message: string }): boolean => /^PLUGIN_NPM_(?:BLOCKED|ALTERED|FETCH_FAILED|MISSING)$/.test(r.code)

/** Why an install did not happen. Its one conflict is the folder changing between the warning and the install (the
 *  Host checks the copy against what was shown, design P6): said in the app's words, with that nothing was installed
 *  (2d final review M4). */
export function installFailureLine(r: { ok: false; code: string; message: string }, t: T): string {
  return r.code === 'CONFLICT' ? t('settings.plugins.install.changed') : failureLine(r, t)
}
