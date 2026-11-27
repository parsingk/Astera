// A plugin catalog's index (Phase 4, spec M2): the JSON a maintainer signs, read by the same rules in the Host, the CLI
// and the app. It names exact versions, each an https artifact with its sha256 and size, the permissions it may ask
// for, and the trust level its manifest must have; and the versions revoked. Pure: the signature, the fetch and the
// cache are the Host's (host/plugins/catalog*.ts).
import { isSemver, npmNameProblem, satisfiesRange, type PluginManifest, type PluginTrust } from './manifest'

export const CATALOG_SCHEMA_VERSION = 1
/** No artifact is larger than this, whatever an entry says (design: at most `sizeBytes` and never over 50 MiB). */
export const CATALOG_ARTIFACT_MAX_BYTES = 50 * 1024 * 1024
/** The index itself is read up to this size. */
export const CATALOG_INDEX_MAX_BYTES = 5 * 1024 * 1024
export const CATALOG_CATEGORIES = ['development', 'agents', 'devops', 'themes', 'quality'] as const
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number]
const TRUST_LEVELS: readonly PluginTrust[] = ['trusted', 'restricted-ui', 'declarative']
const MAX_PLUGINS = 1000
const MAX_VERSIONS = 100
const TEXT_MAX = 64
const DESCRIPTION_MAX = 500
const NOTES_MAX = 2000
const REASON_MAX = 300
const URL_MAX = 2048
const SHA256 = /^[0-9a-f]{64}$/
/** An artifact beside the index: forward slashes, no scheme, no root, no `..` part (resolved against the index's address). */
const BESIDE = /^(?![./])(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\-/]{1,512}$/
export const isBesideIndex = (v: string): boolean => BESIDE.test(v) && !/^[A-Za-z]:/.test(v)
const PUBLISHER = /^[a-z0-9][a-z0-9-]{0,63}$/
/** Control characters other than a tab, and the invisible or direction-changing ones a name could hide behind. */
const UNSAFE_TEXT = /[\x00-\x08\x0a-\x1f\x7f-\x9f​-‏‪-‮⁠-⁤⁦-⁩﻿]/

export interface CatalogVersion {
  version: string
  asteraRange: string
  artifactUrl: string
  sha256: string
  sizeBytes: number
  permissions: string[]
  releaseNotes?: string
}

export interface CatalogEntry {
  id: string
  publisher: string
  name: string
  category: CatalogCategory
  trustLevel: PluginTrust
  description?: string
  license?: string
  sourceUrl?: string
  issuesUrl?: string
  versions: CatalogVersion[]
}

export interface CatalogRevocation {
  id: string
  /** A semver version, or `*` for every version. */
  version: string
  reason: string
}

export interface Catalog {
  sequence: number
  /** When the index stops being good to install from, in ms since the epoch. */
  expires: number
  plugins: CatalogEntry[]
  revoked: CatalogRevocation[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isHttps = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > URL_MAX) return false
  try {
    return new URL(v).protocol === 'https:'
  } catch {
    return false
  }
}
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= max && !UNSAFE_TEXT.test(v) ? v.trim() : null)

function versionOf(v: unknown, at: string, problems: string[]): CatalogVersion | null {
  if (!isObject(v)) {
    problems.push(`plugins: ${at}: a version is not an object`)
    return null
  }
  if (!isSemver(v.version)) {
    problems.push(`plugins: ${at}: version ${String(v.version)} is not a semver version`)
    return null
  }
  const where = `plugins: ${at} ${v.version}`
  const before = problems.length
  if (typeof v.asteraRange !== 'string' || satisfiesRange('0.0.0', v.asteraRange) === null)
    problems.push(`${where}: asteraRange ${String(v.asteraRange)} is not a range Astera reads`)
  if (!isHttps(v.artifactUrl) && !(typeof v.artifactUrl === 'string' && isBesideIndex(v.artifactUrl)))
    problems.push(`${where}: artifactUrl must be an https address or a path beside the index`)
  if (typeof v.sha256 !== 'string' || !SHA256.test(v.sha256)) problems.push(`${where}: sha256 must be 64 lower-case hex characters`)
  if (typeof v.sizeBytes !== 'number' || !Number.isInteger(v.sizeBytes) || v.sizeBytes < 1 || v.sizeBytes > CATALOG_ARTIFACT_MAX_BYTES)
    problems.push(`${where}: sizeBytes must be a whole number from 1 to ${CATALOG_ARTIFACT_MAX_BYTES}`)
  if (!Array.isArray(v.permissions) || !v.permissions.every((p) => typeof p === 'string' && /^[a-z][a-z.-]{0,63}$/.test(p)))
    problems.push(`${where}: permissions must be a list of names`)
  const notes = v.releaseNotes === undefined ? undefined : typeof v.releaseNotes === 'string' && v.releaseNotes.length <= NOTES_MAX ? v.releaseNotes : null
  if (notes === null) problems.push(`${where}: releaseNotes must be text of at most ${NOTES_MAX} characters`)
  if (problems.length > before) return null
  return {
    version: v.version,
    asteraRange: (v.asteraRange as string).trim(),
    artifactUrl: v.artifactUrl as string,
    sha256: v.sha256 as string,
    sizeBytes: v.sizeBytes as number,
    permissions: [...(v.permissions as string[])],
    ...(notes !== undefined ? { releaseNotes: notes } : {})
  }
}

function entryOf(p: unknown, problems: string[]): CatalogEntry | null {
  if (!isObject(p)) {
    problems.push('plugins: an entry is not an object')
    return null
  }
  const named = npmNameProblem(p.id)
  if (named !== null) {
    problems.push(`plugins: ${String(p.id)}: ${named}`)
    return null
  }
  const id = p.id as string
  const before = problems.length
  const publisher = typeof p.publisher === 'string' && PUBLISHER.test(p.publisher) ? p.publisher : null
  if (publisher === null) problems.push(`plugins: ${id}: publisher must be lower-case letters, digits and -, at most 64`)
  const name = text(p.name, TEXT_MAX)
  if (name === null) problems.push(`plugins: ${id}: name must be text of 1 to ${TEXT_MAX} characters, with no control or invisible character`)
  if (!(CATALOG_CATEGORIES as readonly unknown[]).includes(p.category))
    problems.push(`plugins: ${id}: category ${String(p.category)} is not one of ${CATALOG_CATEGORIES.join(', ')}`)
  if (!(TRUST_LEVELS as readonly unknown[]).includes(p.trustLevel)) problems.push(`plugins: ${id}: trustLevel ${String(p.trustLevel)} is not one of ${TRUST_LEVELS.join(', ')}`)
  const description = p.description === undefined ? undefined : text(p.description, DESCRIPTION_MAX)
  if (description === null) problems.push(`plugins: ${id}: description must be text of at most ${DESCRIPTION_MAX} characters`)
  const license = p.license === undefined ? undefined : text(p.license, TEXT_MAX)
  if (license === null) problems.push(`plugins: ${id}: license must be text of at most ${TEXT_MAX} characters`)
  for (const field of ['sourceUrl', 'issuesUrl'] as const) if (p[field] !== undefined && !isHttps(p[field])) problems.push(`plugins: ${id}: ${field} must be an https address`)
  if (!Array.isArray(p.versions) || p.versions.length === 0 || p.versions.length > MAX_VERSIONS) {
    problems.push(`plugins: ${id}: versions must list 1 to ${MAX_VERSIONS} versions`)
    return null
  }
  const versions: CatalogVersion[] = []
  for (const v of p.versions) {
    const read = versionOf(v, id, problems)
    if (read === null) continue
    if (versions.some((x) => x.version === read.version)) {
      problems.push(`plugins: ${id} names version ${read.version} twice`)
      continue
    }
    versions.push(read)
  }
  if (problems.length > before) return null
  return {
    id,
    publisher: publisher as string,
    name: name as string,
    category: p.category as CatalogCategory,
    trustLevel: p.trustLevel as PluginTrust,
    ...(description !== undefined ? { description: description as string } : {}),
    ...(license !== undefined ? { license: license as string } : {}),
    ...(p.sourceUrl !== undefined ? { sourceUrl: p.sourceUrl as string } : {}),
    ...(p.issuesUrl !== undefined ? { issuesUrl: p.issuesUrl as string } : {}),
    versions
  }
}

/** The index `source` holds, or every problem with it. */
export function parseCatalog(source: string): { ok: true; catalog: Catalog } | { ok: false; problems: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return { ok: false, problems: ['the index is not JSON'] }
  }
  if (!isObject(raw)) return { ok: false, problems: ['the index is not a JSON object'] }
  const problems: string[] = []
  if (raw.schemaVersion !== CATALOG_SCHEMA_VERSION) problems.push(`schemaVersion ${String(raw.schemaVersion)} is not one this Astera reads (${CATALOG_SCHEMA_VERSION})`)
  if (typeof raw.sequence !== 'number' || !Number.isInteger(raw.sequence) || raw.sequence < 1) problems.push('sequence must be a whole number of 1 or more')
  const expires = typeof raw.expires === 'string' ? Date.parse(raw.expires) : NaN
  if (!Number.isFinite(expires)) problems.push('expires must be a date and time')
  const plugins: CatalogEntry[] = []
  if (!Array.isArray(raw.plugins) || raw.plugins.length > MAX_PLUGINS) problems.push(`plugins must be a list of at most ${MAX_PLUGINS}`)
  else
    for (const p of raw.plugins) {
      const e = entryOf(p, problems)
      if (e === null) continue
      if (plugins.some((x) => x.id === e.id)) {
        problems.push(`plugins names ${e.id} twice`)
        continue
      }
      plugins.push(e)
    }
  const revoked: CatalogRevocation[] = []
  if (raw.revoked !== undefined && !Array.isArray(raw.revoked)) problems.push('revoked must be a list')
  else
    for (const r of (raw.revoked as unknown[] | undefined) ?? []) {
      if (!isObject(r) || typeof r.id !== 'string' || npmNameProblem(r.id) !== null) {
        problems.push('revoked: an entry does not name a plugin')
        continue
      }
      if (r.version !== '*' && !isSemver(r.version)) {
        problems.push(`revoked: ${r.id}: version ${String(r.version)} must be a semver version or *`)
        continue
      }
      const reason = text(r.reason, REASON_MAX)
      if (reason === null) {
        problems.push(`revoked: ${r.id}: reason must be text of 1 to ${REASON_MAX} characters`)
        continue
      }
      revoked.push({ id: r.id, version: r.version as string, reason })
    }
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, catalog: { sequence: raw.sequence as number, expires, plugins, revoked } }
}

/** Why `version` of `id` is revoked, or null. */
export function isRevoked(c: Pick<Catalog, 'revoked'>, id: string, version: string): string | null {
  return c.revoked.find((r) => r.id === id && (r.version === '*' || r.version === version))?.reason ?? null
}

export const isExpired = (c: Pick<Catalog, 'expires'>, now: number): boolean => now > c.expires

/** -1, 0 or 1 by release, then a prerelease before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): [number[], string] => {
    const [core, pre = ''] = v.split('+')[0].split(/-(.*)/s)
    return [core.split('.').map(Number), pre]
  }
  const [ca, pa] = parse(a)
  const [cb, pb] = parse(b)
  for (let i = 0; i < 3; i++) if (ca[i] !== cb[i]) return ca[i] < cb[i] ? -1 : 1
  if (pa === pb) return 0
  if (pa === '') return 1
  if (pb === '') return -1
  return pa < pb ? -1 : 1
}

/** The highest version of `entry` this Astera runs that is not revoked, or null. */
export function latestCompatible(entry: CatalogEntry, hostVersion: string, revoked: (version: string) => string | null): CatalogVersion | null {
  return (
    [...entry.versions]
      .filter((v) => satisfiesRange(hostVersion, v.asteraRange) === true && revoked(v.version) === null)
      .sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
  )
}

/** Why the package installed for `entry`'s `version` is not what the catalog lists, or null: the same id, version and
 *  trust level, asking for no permission the version does not list. */
export function entryMismatch(m: Pick<PluginManifest, 'id' | 'version' | 'trust' | 'permissions'>, entry: Pick<CatalogEntry, 'id' | 'trustLevel'>, version: Pick<CatalogVersion, 'version' | 'permissions'>): string | null {
  if (m.id !== entry.id) return `the package is ${m.id}, the catalog lists ${entry.id}`
  if (m.version !== version.version) return `the package is version ${m.version}, the catalog lists ${version.version}`
  if (m.trust !== entry.trustLevel) return `the package is ${m.trust}, the catalog lists it as ${entry.trustLevel}`
  const extra = m.permissions.filter((p) => !version.permissions.includes(p))
  if (extra.length > 0) return `the package asks for ${extra.join(', ')}, which the catalog does not list`
  return null
}
