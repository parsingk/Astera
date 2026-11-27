// The registry's author and maintainer commands (Phase 4, spec E4 `publish` and M2), answered here with no Host. They
// prepare a catalog; none of them uploads, publishes or changes anything outside the files named.
//
//   plugins publish            packs a folder and prints the entry a registry pull request would add
//   plugins registry-validate  checks an index and the artifacts beside it, as the Host will read them
//   plugins registry-sign      signs an index's exact bytes with a maintainer's key (index.json.sig)
//   plugins registry-keygen    writes a new maintainer key, and prints the public half a catalog source is set with
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CliError } from '../core/orchestration/cliOutput'
import { CATALOG_CATEGORIES, entryMismatch, isBesideIndex, parseCatalog } from '../core/plugins/catalog'
import { parseManifest } from '../core/plugins/manifest'
import { generateCatalogKey, signIndex } from '../host/plugins/catalogVerify'
import { PackageRefused, extractPackage } from '../host/plugins/tarball'
import { pluginDevCommand } from './pluginDev'

type Outcome = { ok: true; body: Record<string, unknown> } | { ok: false; error: CliError }
const invalid = (message: string): Outcome => ({ ok: false, error: { code: 'INVALID_ARGUMENTS', message } })
const failed = (message: string, details?: Record<string, unknown>): Outcome => ({ ok: false, error: { code: 'FAILED', message, ...(details ? { details } : {}) } })
const isHttps = (v: string): boolean => {
  try {
    return new URL(v).protocol === 'https:'
  } catch {
    return false
  }
}

export async function pluginRegistryCommand(a: { cmd: string; args: Record<string, unknown>; cwd: string; version: string }): Promise<Outcome> {
  try {
    if (a.cmd === 'plugins-publish') return await publish(a)
    if (a.cmd === 'plugins-registry-validate') return await validate(a)
    if (a.cmd === 'plugins-registry-sign') return await signFile(a)
    if (a.cmd === 'plugins-registry-keygen') return await keygen(a)
  } catch (e) {
    return failed(`${a.cmd.replace('-', ' ')} could not finish: ${e instanceof Error ? e.message : String(e)}`)
  }
  return invalid(`${a.cmd} is not one of the registry commands`)
}

async function publish(a: { args: Record<string, unknown>; cwd: string; version: string }): Promise<Outcome> {
  const { path: folder, artifactUrl, publisher, category = 'development', out } = a.args
  if (typeof folder !== 'string' || folder === '') return invalid('plugins publish needs --path <folder>')
  if (typeof artifactUrl !== 'string' || !(isHttps(artifactUrl) || isBesideIndex(artifactUrl)))
    return invalid('plugins publish needs --artifact-url: the https address, or the path beside the index, the package will be served from')
  if (typeof publisher !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(publisher)) return invalid('plugins publish needs --publisher: lower-case letters, digits and -')
  if (!(CATALOG_CATEGORIES as readonly unknown[]).includes(category)) return invalid(`--category must be one of ${CATALOG_CATEGORIES.join(', ')}`)
  // The package is made exactly as `plugins pack` makes it, checked the same way
  const packed = await pluginDevCommand({ cmd: 'plugins-pack', args: { path: folder, ...(typeof out === 'string' ? { out } : {}) }, cwd: a.cwd, version: a.version })
  if (!packed.ok) return packed
  const file = packed.body.file as string
  const pkg = JSON.parse(await fs.readFile(path.join(path.resolve(a.cwd, folder), 'package.json'), 'utf8')) as Record<string, unknown>
  const read = parseManifest(pkg)
  if (!read.ok) return failed(`the folder's package.json cannot be read: ${read.problems.join('; ')}`)
  const m = read.manifest
  const repo = typeof pkg.repository === 'string' ? pkg.repository : typeof (pkg.repository as { url?: unknown } | undefined)?.url === 'string' ? (pkg.repository as { url: string }).url : undefined
  const sourceUrl = repo !== undefined ? repo.replace(/^git\+/, '').replace(/\.git$/, '') : undefined
  const bytes = await fs.readFile(file)
  const entry = {
    id: m.id,
    publisher,
    name: m.displayName,
    category,
    trustLevel: m.trust,
    ...(m.description !== undefined ? { description: m.description } : {}),
    ...(typeof pkg.license === 'string' ? { license: pkg.license } : {}),
    ...(sourceUrl !== undefined && isHttps(sourceUrl) ? { sourceUrl } : {}),
    versions: [
      {
        version: m.version,
        asteraRange: m.engines ?? `>=${m.minAsteraVersion ?? a.version}`,
        artifactUrl,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        permissions: [...m.permissions]
      }
    ]
  }
  return { ok: true, body: { entry, file, sha256: entry.versions[0].sha256, uploaded: false } }
}

async function validate(a: { args: Record<string, unknown>; cwd: string }): Promise<Outcome> {
  if (typeof a.args.path !== 'string' || a.args.path === '') return invalid('plugins registry-validate needs --path <index.json>')
  const file = path.resolve(a.cwd, a.args.path)
  const text = await fs.readFile(file, 'utf8').catch(() => null)
  if (text === null) return invalid(`${a.args.path} cannot be read`)
  const parsed = parseCatalog(text)
  if (!parsed.ok) return failed(`${a.args.path} has problems: ${parsed.problems.join('; ')}`, { problems: parsed.problems })
  // Every package beside the index is the bytes it names, extracts within the Host's limits, and is its entry (the same
  // id, version and trust level, asking for no more than listed), as an install will check (final review m11); an https
  // one is checked when it is installed
  const problems: string[] = []
  const warnings: string[] = []
  let checked = 0
  const base = path.dirname(file)
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-registry-'))
  try {
    for (const e of parsed.catalog.plugins) {
      let before: string[] | null = null
      for (const v of e.versions) {
        // A version asking for more than the one before it is for a maintainer to read by hand
        if (before !== null) {
          const more = v.permissions.filter((x) => !(before as string[]).includes(x))
          if (more.length > 0) warnings.push(`${e.id} ${v.version} asks for ${more.join(', ')} beyond the version before it: review it by hand`)
        }
        before = v.permissions
        if (isHttps(v.artifactUrl)) continue
        const at = path.resolve(base, v.artifactUrl)
        const bytes = await fs.readFile(at).catch(() => null)
        checked += 1
        if (bytes === null) problems.push(`${e.id} ${v.version}: ${v.artifactUrl} is missing`)
        else if (bytes.length !== v.sizeBytes) problems.push(`${e.id} ${v.version}: ${v.artifactUrl} is ${bytes.length} bytes, not ${v.sizeBytes}`)
        else if (createHash('sha256').update(bytes).digest('hex') !== v.sha256) problems.push(`${e.id} ${v.version}: ${v.artifactUrl} does not have the sha256 the index names`)
        else {
          const out = path.join(work, `${checked}`)
          try {
            await extractPackage(at, out)
            const read = parseManifest(JSON.parse(await fs.readFile(path.join(out, 'package.json'), 'utf8')))
            if (!read.ok) problems.push(`${e.id} ${v.version}: its package.json has problems: ${read.problems.join('; ')}`)
            else {
              const mismatch = entryMismatch(read.manifest, e, v)
              if (mismatch !== null) problems.push(`${e.id} ${v.version}: ${mismatch}`)
            }
          } catch (err) {
            problems.push(`${e.id} ${v.version}: ${err instanceof PackageRefused ? err.message : `the package cannot be read: ${err instanceof Error ? err.message : String(err)}`}`)
          }
        }
      }
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {})
  }
  if (problems.length > 0) return failed(`${a.args.path} has problems: ${problems.join('; ')}`, { problems, ...(warnings.length > 0 ? { warnings } : {}) })
  return { ok: true, body: { valid: true, sequence: parsed.catalog.sequence, plugins: parsed.catalog.plugins.length, artifactsChecked: checked, problems: [], ...(warnings.length > 0 ? { warnings } : {}) } }
}

async function signFile(a: { args: Record<string, unknown>; cwd: string }): Promise<Outcome> {
  const { path: index, keyFile, keyId } = a.args
  if (typeof index !== 'string' || typeof keyFile !== 'string' || typeof keyId !== 'string') return invalid('plugins registry-sign needs --path <index.json>, --key-file <pem> and --key-id <id>')
  // Only an index that validates is signed: a maintainer never signs what an install would refuse (final review m11)
  const checked = await validate({ args: { path: index }, cwd: a.cwd })
  if (!checked.ok) return failed(`${index} does not validate, so it was not signed: ${checked.error.message}`, checked.error.details)
  const file = path.resolve(a.cwd, index)
  const bytes = await fs.readFile(file)
  const pem = await fs.readFile(path.resolve(a.cwd, keyFile), 'utf8')
  const signature = `${file}.sig`
  await fs.writeFile(signature, signIndex(bytes, keyId, pem))
  return { ok: true, body: { signature, keyId, sha256: createHash('sha256').update(bytes).digest('hex') } }
}

async function keygen(a: { args: Record<string, unknown>; cwd: string }): Promise<Outcome> {
  const { out, keyId } = a.args
  if (typeof out !== 'string' || typeof keyId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) return invalid('plugins registry-keygen needs --out <folder> and --key-id <id>')
  const folder = path.resolve(a.cwd, out)
  const privateKeyFile = path.join(folder, `${keyId}.pem`)
  if (await fs.stat(privateKeyFile).then(() => true, () => false)) return invalid(`${privateKeyFile} already exists; a key is never written over`)
  const k = generateCatalogKey()
  await fs.mkdir(folder, { recursive: true })
  // Only its owner may read the private half, where the platform has modes
  await fs.writeFile(privateKeyFile, k.privateKeyPem, { mode: 0o600, flag: 'wx' })
  return { ok: true, body: { keyId, publicKey: k.publicKey, privateKeyFile } }
}
