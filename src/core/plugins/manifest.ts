// A plugin's manifest: the `astera` field of its package.json (SDK + Plugin spec §10, plugin runtime design P3). Pure,
// so the Host, the CLI and the app read a plugin by the same rules. What it may ask Astera for is design §2's table;
// whether this Astera runs it is `incompatibility` (spec §29).

import { parseSettingsSchema, type SettingField } from './settings'

/** The Plugin API versions this Astera speaks (spec §28): versioned apart from the Host protocol. API 2 (Workspace &
 *  Plugin Platform V2, spec E2) adds a UI page, contributed commands and panels, and an engines range, and makes the host
 *  entry optional; a v1 manifest reads exactly as before. */
export const PLUGIN_API_VERSIONS = ['1', '2'] as const

/** Spec §10's P0 capability types. Which of them this Astera serves is the Host's to say (design P8). */
export const PLUGIN_CAPABILITIES = ['event', 'job-source', 'completion-check', 'notification'] as const
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number]

/** Spec §11's permissions, completed so that every SDK command has exactly one (design §2). */
export const PLUGIN_PERMISSIONS = [
  'projects.read',
  'jobs.read',
  'jobs.create',
  'jobs.run',
  'runs.read',
  'runs.control',
  'tasks.read',
  'tasks.write',
  'questions.read',
  'questions.answer',
  'completion.read',
  'events.subscribe',
  'github.read',
  'github.write',
  'how-it-works.read'
] as const
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

/** What a plugin's UI may do (API 2 only), kept apart from the Host command permissions above, which each open SDK methods
 *  (core/host/pluginGate.ts): contribute commands, contribute panels, and read which project is open. */
export const PLUGIN_UI_PERMISSIONS = ['commands.register', 'panels.register', 'workspace.read'] as const
export type PluginUiPermission = (typeof PLUGIN_UI_PERMISSIONS)[number]

/** The permission a capability cannot work without (plugin Phase 3 N4): `event` and `notification` hand the plugin
 *  event content, which `events.subscribe` is the grant for. */
const CAPABILITY_NEEDS: Partial<Record<PluginCapability, PluginPermission>> = { event: 'events.subscribe', notification: 'events.subscribe' }

/** Why `capabilities` cannot work with `permissions` (those a manifest asks for, or those a person granted), or null. */
export function capabilityPermissionProblem(capabilities: readonly PluginCapability[], permissions: readonly string[]): string | null {
  for (const c of capabilities) {
    const need = CAPABILITY_NEEDS[c]
    if (need !== undefined && !permissions.includes(need)) return `the ${c} capability needs the ${need} permission`
  }
  return null
}

/** The permission each kind of contribution cannot work without (API 2), or null. */
export function contributionPermissionProblem(c: PluginContributions, permissions: readonly string[]): string | null {
  if (c.commands.length > 0 && !permissions.includes('commands.register')) return 'contributing commands needs the commands.register permission'
  if (c.panels.length > 0 && !permissions.includes('panels.register')) return 'contributing panels needs the panels.register permission'
  return null
}

/** Shown wherever a person approves a plugin (spec §31, design P1): permissions are not a sandbox. */
export const PLUGIN_TRUST_WARNING =
  'Plugins run trusted code on this machine: a plugin can do anything you can, and its permissions limit only what it asks Astera for.'

/** Shown instead, before a person approves a plugin with a UI and no host entry (ADR-008: restricted UI). */
export const PLUGIN_RESTRICTED_UI_NOTICE =
  'This plugin only shows pages in Astera panels: it starts no program on this machine, and it reaches Astera only through the permissions it asks for.'

/** Derived, never declared (ADR-008): a host entry is native code with the person's rights; a UI alone is restricted. */
export type PluginTrust = 'trusted' | 'restricted-ui'

export interface PluginContributions {
  /** Phase 2: a command opens its panel. */
  commands: { id: string; title: string; panel: string }[]
  panels: { id: string; title: string }[]
}

export interface PluginManifest {
  /** The package name: unique on npm, and what every command names the plugin by (design P3). */
  id: string
  name: string
  displayName: string
  version: string
  description?: string
  apiVersion: string
  /** The Node file the Host starts, relative to the plugin's folder and never leaving it. Always there in API 1; an API 2
   *  plugin without one runs no code outside its panels. */
  entry?: string
  /** API 2: the .html page the plugin's panels show, relative to its folder. */
  ui?: string
  capabilities: PluginCapability[]
  permissions: (PluginPermission | PluginUiPermission)[]
  minAsteraVersion?: string
  /** `engines.astera` at the top of package.json: comparators all of which this Astera must satisfy. */
  engines?: string
  /** API 2's `astera.contributes`; empty for API 1. */
  contributes: PluginContributions
  trust: PluginTrust
  /** `astera.settingsSchema`, read (settings.ts); none when the plugin has no settings. */
  settings: SettingField[]
}

/** npm's rule for new names, which also leaves out `~`: on Windows `astera~1` can be another folder's short name. */
const NAME = /^(?:@[a-z0-9-][a-z0-9-._]*\/)?[a-z0-9-][a-z0-9-._]*$/
/** A part of a name Windows will not keep as a folder of its own: a device name (with or without an extension), or one
 *  ending in a dot, which it drops. */
const NOT_A_FOLDER = /^(?:(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?|.*\.)$/
const NAME_MAX = 214
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
/** A semver version, as a manifest's `version` must be; an npm install's `expect.version` too (2e final review I3). */
export const isSemver = (v: unknown): v is string => typeof v === 'string' && SEMVER.test(v)
const DISPLAY_NAME_MAX = 64
const DESCRIPTION_MAX = 500
/** Control characters other than a tab (final review m5): the approval message prints the displayName and the
 *  description, where a line feed could fake lines ahead of the permissions and an escape could repaint the terminal. */
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Why `name` cannot be a plugin's package name, or null: npm's rule for new names, as one folder on every platform. A
 *  manifest's name and an npm spec's (npmSpec.ts) are read by the same rule. */
export function npmNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || name.length > NAME_MAX || !NAME.test(name)) return `name ${JSON.stringify(name ?? null)} is not an npm package name`
  if (name.replace(/^@/, '').split('/').some((part) => NOT_A_FOLDER.test(part))) return `name ${JSON.stringify(name)} cannot be a folder of its own on Windows`
  return null
}

/** A relative path that cannot leave the folder it is read in, on any platform, and is not a URL (spec E2 refuses a
 *  remote entrypoint). */
const pathProblem = (field: string, v: string): string | null => {
  if (/^[\\/]/.test(v) || /^[A-Za-z]:/.test(v)) return `${field} ${v} is not relative to the plugin`
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(v)) return `${field} ${v} is a URL; it must be a file in the plugin`
  if (v.split(/[\\/]/).includes('..')) return `${field} ${v} leaves the plugin`
  return null
}

const entryProblem = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.trim() === '') return 'astera.entry is missing: the file Astera starts, relative to the plugin'
  return pathProblem('astera.entry', v)
}

/** The UI page: a relative .html file, with no query or fragment the scheme would read as something else. */
const uiProblem = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.trim() === '') return 'astera.ui must be the .html page the plugin’s panels show, relative to the plugin'
  const where = pathProblem('astera.ui', v)
  if (where !== null) return where
  if (/[?#]/.test(v)) return `astera.ui ${v} holds a ? or #; it must be a plain file name`
  if (!/\.html$/i.test(v)) return `astera.ui ${v} is not an .html file`
  return null
}

const CONTRIBUTION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TITLE_MAX = 64
const MAX_COMMANDS = 50
const MAX_PANELS = 20

/** `astera.contributes` (API 2), with each problem named by its field. */
function contributionsOf(v: unknown, problems: string[]): PluginContributions {
  const out: PluginContributions = { commands: [], panels: [] }
  if (v === undefined) return out
  if (!isObject(v)) {
    problems.push('astera.contributes is not an object')
    return out
  }
  const items = (kind: 'commands' | 'panels', max: number): Record<string, unknown>[] => {
    const field = `astera.contributes.${kind}`
    const list = v[kind]
    if (list === undefined) return []
    if (!Array.isArray(list)) {
      problems.push(`${field} is not a list`)
      return []
    }
    if (list.length > max) {
      problems.push(`${field} lists ${list.length}; at most ${max}`)
      return []
    }
    const seen = new Set<string>()
    const kept: Record<string, unknown>[] = []
    for (const item of list) {
      if (!isObject(item)) {
        problems.push(`${field}: an entry is not an object`)
        continue
      }
      const id = item.id
      if (typeof id !== 'string' || !CONTRIBUTION_ID.test(id)) {
        problems.push(`${field}: ${String(id)} is not an id of lower-case letters, digits and . _ - (at most ${TITLE_MAX})`)
        continue
      }
      if (seen.has(id)) {
        problems.push(`${field} names ${id} twice`)
        continue
      }
      seen.add(id)
      const title = typeof item.title === 'string' ? item.title.trim() : ''
      if (title === '' || title.length > TITLE_MAX) {
        problems.push(`${field}: ${id} needs a title of 1 to ${TITLE_MAX} characters`)
        continue
      }
      if (CONTROL.test(title)) {
        problems.push(`${field}: ${id}’s title holds a control character`)
        continue
      }
      kept.push({ ...item, id, title })
    }
    return kept
  }
  out.panels = items('panels', MAX_PANELS).map((p) => ({ id: p.id as string, title: p.title as string }))
  const panelIds = new Set(out.panels.map((p) => p.id))
  for (const c of items('commands', MAX_COMMANDS)) {
    const panel = c.panel
    if (typeof panel !== 'string' || panel === '') {
      problems.push(`astera.contributes.commands: ${String(c.id)} names no panel to open`)
      continue
    }
    if (!panelIds.has(panel)) {
      problems.push(`astera.contributes.commands: ${String(c.id)} opens ${panel}, which is not a contributed panel`)
      continue
    }
    out.commands.push({ id: c.id as string, title: c.title as string, panel })
  }
  return out
}

type Comparator = { op: '>=' | '>' | '<=' | '<' | '='; at: [number, number, number] }

/** The comparators of an engines range, or null when it is not one Astera reads. */
function comparatorsOf(range: string): Comparator[] | null {
  const parts = range.trim().split(/\s+/).filter((p) => p !== '')
  if (parts.length === 0) return null
  const out: Comparator[] = []
  for (const p of parts) {
    const m = /^(>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)$/.exec(p)
    if (!m) return null
    out.push({ op: (m[1] ?? '=') as Comparator['op'], at: [Number(m[2]), Number(m[3]), Number(m[4])] })
  }
  return out
}

const ENGINES_FORM =
  'use comparators such as ">=1.7.0 <2.0.0" (>=, >, <=, <, = or a bare version, all of them must hold)'

/** A list of known names without repeats; the problems use the field's own name. */
function namesOf<T extends string>(field: string, v: unknown, known: readonly T[], kind: string, problems: string[]): T[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) {
    problems.push(`${field} is not a list`)
    return []
  }
  const out: T[] = []
  for (const name of v) {
    if (typeof name !== 'string' || !(known as readonly string[]).includes(name)) {
      problems.push(`${field}: ${String(name)} is not a ${kind}; they are ${known.join(', ')}`)
      continue
    }
    if (out.includes(name as T)) {
      problems.push(`${field} names ${name} twice`)
      continue
    }
    out.push(name as T)
  }
  return out
}

/** Every problem with the package, or the manifest it holds. */
export function parseManifest(pkg: unknown): { ok: true; manifest: PluginManifest } | { ok: false; problems: string[] } {
  if (!isObject(pkg)) return { ok: false, problems: ['package.json is not a JSON object'] }
  const problems: string[] = []
  const { name, version, displayName, description, astera, engines } = pkg
  const named = npmNameProblem(name)
  if (named !== null) problems.push(named)
  if (typeof version !== 'string' || !SEMVER.test(version)) problems.push(`version ${JSON.stringify(version ?? null)} is not a semver version`)
  if (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim() === '' || displayName.trim().length > DISPLAY_NAME_MAX))
    problems.push(`displayName must be text of 1 to ${DISPLAY_NAME_MAX} characters`)
  else if (typeof displayName === 'string' && CONTROL.test(displayName)) problems.push('displayName holds a control character')
  if (description !== undefined && typeof description !== 'string') problems.push('description must be text')
  else if (typeof description === 'string' && CONTROL.test(description)) problems.push('description holds a control character')
  if (astera === undefined) {
    problems.push('astera is missing: a plugin names its entry and Plugin API there')
    return { ok: false, problems }
  }
  if (!isObject(astera)) {
    problems.push('astera is not an object')
    return { ok: false, problems }
  }
  if (typeof astera.apiVersion !== 'string' || astera.apiVersion === '')
    problems.push(`astera.apiVersion is missing: the Plugin API the plugin is written for (${PLUGIN_API_VERSIONS.join(', ')})`)
  const v2 = astera.apiVersion === '2'
  // API 1 needs its entry, as it always did; API 2 takes an entry, a UI page or both
  const hasEntry = v2 ? astera.entry !== undefined : true
  const hasUi = v2 && astera.ui !== undefined
  if (hasEntry) {
    const entry = entryProblem(astera.entry)
    if (entry !== null) problems.push(entry)
  }
  if (hasUi) {
    const ui = uiProblem(astera.ui)
    if (ui !== null) problems.push(ui)
  }
  if (v2 && !hasEntry && !hasUi) problems.push('astera needs an entry, a ui or both: the Node file Astera starts, the page its panels show')
  const capabilities = namesOf('astera.capabilities', astera.capabilities, PLUGIN_CAPABILITIES, 'capability', problems)
  let asked: unknown = astera.permissions
  if (!v2 && Array.isArray(asked)) {
    // The UI permissions mean nothing to an API 1 plugin, which has no UI: said as such rather than as unknown names
    for (const p of asked) if ((PLUGIN_UI_PERMISSIONS as readonly unknown[]).includes(p)) problems.push(`astera.permissions: ${String(p)} needs Plugin API 2`)
    asked = asked.filter((p) => !(PLUGIN_UI_PERMISSIONS as readonly unknown[]).includes(p))
  }
  const permissions = namesOf<PluginPermission | PluginUiPermission>(
    'astera.permissions',
    asked,
    v2 ? [...PLUGIN_PERMISSIONS, ...PLUGIN_UI_PERMISSIONS] : PLUGIN_PERMISSIONS,
    'permission',
    problems
  )
  const needs = capabilityPermissionProblem(capabilities, permissions)
  if (needs !== null) problems.push(needs)
  const contributes = v2 ? contributionsOf(astera.contributes, problems) : { commands: [], panels: [] }
  const contributed = contributes.commands.length > 0 || contributes.panels.length > 0
  if (contributed && !hasUi) problems.push('astera.contributes needs astera.ui: a panel is a page of the plugin’s UI')
  const contributionNeeds = contributionPermissionProblem(contributes, permissions)
  if (contributionNeeds !== null) problems.push(contributionNeeds)
  // npm's own field, as VS Code reads engines.vscode
  const range = isObject(engines) ? engines.astera : undefined
  if (range !== undefined && (typeof range !== 'string' || comparatorsOf(range) === null))
    problems.push(`engines.astera ${JSON.stringify(range)} is not a range Astera reads: ${ENGINES_FORM}`)
  const min = astera.minAsteraVersion
  if (min !== undefined && (typeof min !== 'string' || !SEMVER.test(min)))
    problems.push(`astera.minAsteraVersion ${JSON.stringify(min)} is not a semver version`)
  const schema = parseSettingsSchema(astera.settingsSchema)
  if (!schema.ok) problems.push(...schema.problems)
  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    manifest: {
      id: name as string,
      name: name as string,
      displayName: typeof displayName === 'string' ? displayName.trim() : (name as string),
      version: version as string,
      ...(typeof description === 'string' ? { description: description.slice(0, DESCRIPTION_MAX) } : {}),
      apiVersion: astera.apiVersion as string,
      ...(hasEntry ? { entry: astera.entry as string } : {}),
      ...(hasUi ? { ui: astera.ui as string } : {}),
      capabilities,
      permissions,
      ...(typeof min === 'string' ? { minAsteraVersion: min } : {}),
      ...(typeof range === 'string' ? { engines: range.trim() } : {}),
      settings: schema.ok ? schema.fields : [],
      contributes,
      trust: hasEntry ? 'trusted' : 'restricted-ui'
    }
  }
}

/** The plugin's folder under `<profile>/plugins`: the id with its scope slash written as `+`, which no npm name holds,
 *  so two ids never share a folder (design P3). */
export const pluginFolderName = (id: string): string => id.replace('/', '+')

/** major, minor, patch; a prerelease or build tag is read as its release. Null when it is not a version. */
const release = (v: string): [number, number, number] | null => {
  const m = SEMVER.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Whether `version` satisfies every comparator of `range`, compared by release (a prerelease reads as its release); null
 *  when either is not something Astera reads. */
export function satisfiesRange(version: string, range: string): boolean | null {
  const have = release(version)
  const comparators = comparatorsOf(range)
  if (have === null || comparators === null) return null
  return comparators.every(({ op, at }) => {
    const d = have[0] - at[0] || have[1] - at[1] || have[2] - at[2]
    return op === '>=' ? d >= 0 : op === '>' ? d > 0 : op === '<=' ? d <= 0 : op === '<' ? d < 0 : d === 0
  })
}

/** Why this Astera will not run the plugin (spec §29, design P8), or null when it will. */
export function incompatibility(m: PluginManifest, host: { version: string; capabilities: readonly string[] }): string | null {
  if (!(PLUGIN_API_VERSIONS as readonly string[]).includes(m.apiVersion))
    return `this Astera speaks Plugin API ${PLUGIN_API_VERSIONS.join(', ')}; the plugin needs ${m.apiVersion}`
  if (m.engines !== undefined && satisfiesRange(host.version, m.engines) === false)
    return `the plugin needs Astera ${m.engines}; this is ${host.version}`
  if (m.minAsteraVersion !== undefined) {
    const need = release(m.minAsteraVersion)
    const have = release(host.version)
    const older = need !== null && have !== null && (have[0] - need[0] || have[1] - need[1] || have[2] - need[2]) < 0
    if (older) return `the plugin needs Astera ${m.minAsteraVersion} or newer; this is ${host.version}`
  }
  const missing = m.capabilities.find((c) => !host.capabilities.includes(c))
  if (missing !== undefined) return `this Astera does not run ${missing} plugins yet`
  return null
}
