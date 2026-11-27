// Where the plugin catalog is, the last index the Host verified, and the artifacts it downloads (Phase 4, design calls
// 1 to 4). The source is an https address or the absolute path of a .json index on this computer (an offline mirror, or
// a registry checked out), with the keys the person trusts it with. An index is fetched with its signature, verified,
// read and accepted only if it does not go back; the copy kept is verified again with the keys set now each time it is
// read, so changing the keys takes effect at once. A network failure keeps the copy it had. Artifacts are downloaded
// once into `.downloads`, by the sha256 the index names, and are never trusted for any other reason than those bytes.
import { createHash, createPublicKey } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CATALOG_INDEX_MAX_BYTES, isBesideIndex, isExpired, parseCatalog, type Catalog, type CatalogVersion } from '../../core/plugins/catalog'
import { acceptIndex, verifyIndex, type CatalogKey } from './catalogVerify'

export const CATALOG_SOURCE_FILE = 'catalog-source.json'
export const CATALOG_CACHE_FILE = 'catalog-cache.json'
export const CATALOG_DOWNLOADS = '.downloads'
const FETCH_TIMEOUT_MS = 20_000
const MAX_KEYS = 8

export interface CatalogSource {
  url: string
  keys: CatalogKey[]
}

export type CatalogView =
  | { configured: false }
  | {
      configured: true
      url: string
      /** The last index verified, null when none could be read yet. */
      catalog: Catalog | null
      fetchedAt?: number
      expired?: boolean
      /** Why the kept copy could not be read (its keys changed, it is damaged). */
      problem?: string
    }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isHttpsUrl = (v: string): boolean => {
  try {
    return new URL(v).protocol === 'https:'
  } catch {
    return false
  }
}
const isLocalIndex = (v: string): boolean => path.isAbsolute(v) && v.toLowerCase().endsWith('.json') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)
const sha256Of = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const isEd25519PublicKey = (base64: string): boolean => {
  try {
    return createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType === 'ed25519'
  } catch {
    return false
  }
}

/** Why `v` cannot be a catalog source, or null. */
export function catalogSourceProblem(v: unknown): string | null {
  if (!isObject(v)) return 'a source must be { url, keys }'
  if (typeof v.url !== 'string' || !(isHttpsUrl(v.url) || isLocalIndex(v.url))) return 'url must be an https address or the absolute path of a .json index on this computer'
  if (!Array.isArray(v.keys) || v.keys.length === 0 || v.keys.length > MAX_KEYS) return `keys must list 1 to ${MAX_KEYS} keys`
  for (const k of v.keys) {
    if (!isObject(k) || typeof k.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(k.id)) return 'a key needs an id of letters, digits and . _ -'
    if (typeof k.publicKey !== 'string' || !isEd25519PublicKey(k.publicKey)) return `key ${k.id} is not an Ed25519 public key`
  }
  return null
}

export interface CatalogStore {
  source(): Promise<CatalogSource | null>
  setSource(s: CatalogSource): Promise<void>
  /** Forgets the source and the copy kept with it. */
  clearSource(): Promise<void>
  /** Fetches, verifies and keeps a newer index; the copy kept stays when anything fails. */
  refresh(): Promise<{ ok: true } | { ok: false; problem: string }>
  current(): Promise<CatalogView>
  /** The artifact's file in `.downloads`, its bytes checked against the index. */
  download(v: CatalogVersion): Promise<string>
}

export function createCatalogStore(d: { root: string; now: () => number; fetch?: typeof fetch }): CatalogStore {
  const sourceFile = path.join(d.root, CATALOG_SOURCE_FILE)
  const cacheFile = path.join(d.root, CATALOG_CACHE_FILE)
  const downloads = path.join(d.root, CATALOG_DOWNLOADS)
  const doFetch = d.fetch ?? fetch

  const readJson = async (file: string): Promise<unknown> => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
      return null
    }
  }
  const writeJson = async (file: string, v: unknown): Promise<void> => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(v, null, 2))
    await fs.rename(tmp, file)
  }

  async function source(): Promise<CatalogSource | null> {
    const v = await readJson(sourceFile)
    return catalogSourceProblem(v) === null ? (v as CatalogSource) : null
  }

  /** At most `max` bytes from an https address, refusing one answered from elsewhere than https. */
  async function fetchBytes(url: string, max: number, what: string): Promise<Buffer> {
    const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' })
    if (res.url && !isHttpsUrl(res.url)) throw new Error(`${what} was answered from ${res.url}, not an https address`)
    if (!res.ok) throw new Error(`${what} answered ${res.status}`)
    if (!res.body) return Buffer.alloc(0)
    const reader = res.body.getReader()
    const parts: Buffer[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel().catch(() => {})
        throw new Error(`${what} is larger than the ${max} bytes the catalog names`)
      }
      parts.push(Buffer.from(value))
    }
    return Buffer.concat(parts)
  }

  async function readLocal(file: string, max: number, what: string): Promise<Buffer> {
    const st = await fs.stat(file).catch(() => null)
    if (!st || !st.isFile()) throw new Error(`${what} is not a file`)
    if (st.size > max) throw new Error(`${what} is larger than the ${max} bytes the catalog names`)
    return fs.readFile(file)
  }

  const read = (url: string, max: number, what: string): Promise<Buffer> => (isHttpsUrl(url) ? fetchBytes(url, max, what) : readLocal(url, max, what))

  type Kept = { url: string; fetchedAt: number; sequence: number; sha256: string; index: string; sig: string }
  const kept = async (url: string): Promise<Kept | null> => {
    const v = await readJson(cacheFile)
    return isObject(v) && v.url === url && typeof v.index === 'string' && typeof v.sig === 'string' ? (v as unknown as Kept) : null
  }

  return {
    source,
    async setSource(s) {
      const problem = catalogSourceProblem(s)
      if (problem !== null) throw new Error(problem)
      await writeJson(sourceFile, { url: s.url, keys: s.keys.map((k) => ({ id: k.id, publicKey: k.publicKey })) })
    },
    async clearSource() {
      await fs.rm(sourceFile, { force: true })
      await fs.rm(cacheFile, { force: true })
    },
    async refresh() {
      const s = await source()
      if (s === null) return { ok: false, problem: 'no catalog is set' }
      try {
        const bytes = await read(s.url, CATALOG_INDEX_MAX_BYTES, 'the index')
        const sig = (await read(`${s.url}.sig`, 4096, 'the index signature')).toString('utf8')
        const verified = verifyIndex(bytes, sig, s.keys)
        if (!verified.ok) return { ok: false, problem: verified.problem }
        const parsed = parseCatalog(bytes.toString('utf8'))
        if (!parsed.ok) return { ok: false, problem: `the index cannot be read: ${parsed.problems.slice(0, 3).join('; ')}` }
        const sha256 = sha256Of(bytes)
        const before = await kept(s.url)
        const refused = acceptIndex(before, { sequence: parsed.catalog.sequence, sha256 })
        if (refused !== null) return { ok: false, problem: refused }
        await writeJson(cacheFile, { url: s.url, fetchedAt: d.now(), sequence: parsed.catalog.sequence, sha256, index: bytes.toString('utf8'), sig })
        return { ok: true }
      } catch (e) {
        return { ok: false, problem: e instanceof Error ? e.message : String(e) }
      }
    },
    async current() {
      const s = await source()
      if (s === null) return { configured: false }
      const k = await kept(s.url)
      if (k === null) return { configured: true, url: s.url, catalog: null }
      // Verified again with the keys set now: a key taken away stops the copy it signed
      const verified = verifyIndex(Buffer.from(k.index, 'utf8'), k.sig, s.keys)
      if (!verified.ok) return { configured: true, url: s.url, catalog: null, fetchedAt: k.fetchedAt, problem: verified.problem }
      const parsed = parseCatalog(k.index)
      if (!parsed.ok) return { configured: true, url: s.url, catalog: null, fetchedAt: k.fetchedAt, problem: 'the kept index cannot be read' }
      return { configured: true, url: s.url, catalog: parsed.catalog, fetchedAt: k.fetchedAt, expired: isExpired(parsed.catalog, d.now()) }
    },
    async download(v) {
      const s = await source()
      if (s === null) throw new Error('no catalog is set')
      let at: string
      if (isHttpsUrl(v.artifactUrl)) at = v.artifactUrl
      else if (!isBesideIndex(v.artifactUrl)) throw new Error(`${v.artifactUrl} is not beside the index`)
      else if (isHttpsUrl(s.url)) at = new URL(v.artifactUrl, s.url).href
      else {
        const base = path.dirname(s.url)
        at = path.resolve(base, v.artifactUrl)
        if (!at.startsWith(base + path.sep)) throw new Error(`${v.artifactUrl} is not beside the index`)
      }
      const file = path.join(downloads, `${v.sha256}.tgz`)
      const have = await fs.readFile(file).catch(() => null)
      if (have && have.length === v.sizeBytes && sha256Of(have) === v.sha256) return file
      const bytes = await read(at, v.sizeBytes, v.artifactUrl)
      if (bytes.length !== v.sizeBytes) throw new Error(`${v.artifactUrl} is not the package the catalog names: it is ${bytes.length} bytes, not ${v.sizeBytes}`)
      if (sha256Of(bytes) !== v.sha256) throw new Error(`${v.artifactUrl} is not the package the catalog names: its sha256 differs`)
      await fs.mkdir(downloads, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await fs.writeFile(tmp, bytes)
      await fs.rename(tmp, file)
      return file
    }
  }
}
