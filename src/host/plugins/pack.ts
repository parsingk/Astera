// A plugin package made from a checked copy of its folder (Plugin Platform V2, Phase 2 step 4a, spec E4 pack): npm's
// layout, every file under `package/`, so the Host's own extractor (tarball.ts) reads it and `install --file` installs
// it. Deterministic: entries sorted by path, one fixed time, no owner, a mode that says only whether a file is executable,
// and a gzip header that names no system, so the same folder packed by the same Astera gives the same bytes and checksum.
// (zlib is the Astera build's, so a later Astera may compress the same files to other bytes.)
//
// What goes in follows npm (the person's decision, 2026-11-25): package.json's `files` chooses the files, with
// package.json, a README, a LICENSE and the entry and ui always; node_modules stays out but for the packages
// bundleDependencies names and the packages those need. A dependency the package would not carry is named (`unpacked`),
// so pack can refuse a package that would not run: `install --file` fetches nothing.
//
// Left out, and named in the answer: junk anywhere (a .git folder, .DS_Store, Thumbs.db, desktop.ini, macOS ._ files,
// npm-debug.log), credentials anywhere (.env files but .env.example, .envrc, .npmrc, .netrc, .pypirc, .yarnrc.yml,
// .git-credentials, SSH keys, whatever is under .ssh or .aws), and outside node_modules keys and certificates and an old
// package at the top. A dependency keeps its own keys and certificates: one it ships may be what it runs on.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import ignore, { type Ignore } from 'ignore'

const BLOCK = 512
/** npm's own fixed time for every entry, 1985-10-26T08:15:00Z. */
const MTIME = 499162500

const JUNK = /^(?:\.DS_Store|Thumbs\.db|desktop\.ini|npm-debug\.log.*|\._.+)$/i
const CREDENTIAL = /^(?:\.env(?:\..+)?|\.envrc|\.npmrc|_?\.?netrc|\.pypirc|\.yarnrc\.yml|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519).*)$/i
const CREDENTIAL_FOLDERS = new Set(['.ssh', '.aws'])
const KEY = /\.(?:pem|key|p12|pfx|ppk|jks|keystore)$/i

/** Whether the file at `rel` (its path with `/`) stays out of a package. */
export function leftOutOfPackage(rel: string): boolean {
  const parts = rel.split('/')
  const name = parts[parts.length - 1]
  if (parts.includes('.git') || JUNK.test(name)) return true
  if ((name !== '.env.example' && CREDENTIAL.test(name)) || parts.slice(0, -1).some((p) => CREDENTIAL_FOLDERS.has(p))) return true
  if (parts[0] === 'node_modules') return false
  return KEY.test(name) || (parts.length === 1 && name.toLowerCase().endsWith('.tgz'))
}

/** A header field: `value` as bytes, NUL padded. */
const put = (h: Buffer, at: number, len: number, value: string): void => {
  h.write(value, at, len, 'utf8')
}
const octal = (n: number, len: number): string => n.toString(8).padStart(len - 1, '0') + '\0'

function header(name: string, size: number, type: '0' | 'x', executable = false): Buffer {
  const h = Buffer.alloc(BLOCK)
  put(h, 0, 100, name)
  put(h, 100, 8, octal(executable ? 0o755 : 0o644, 8))
  put(h, 108, 8, octal(0, 8))
  put(h, 116, 8, octal(0, 8))
  put(h, 124, 12, octal(size, 12))
  put(h, 136, 12, octal(MTIME, 12))
  h.fill(0x20, 148, 156)
  put(h, 156, 1, type)
  put(h, 257, 6, 'ustar\0')
  put(h, 263, 2, '00')
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += h[i]
  put(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ')
  return h
}

const padded = (body: Buffer): Buffer[] => [body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK)]

/** A pax record `<len> path=<value>\n`, its length counting itself. */
function paxRecord(value: string): Buffer {
  const rest = Buffer.byteLength(` path=${value}\n`)
  let len = rest + String(rest).length
  if (String(len).length !== String(rest).length) len = rest + String(len).length
  return Buffer.from(`${len} path=${value}\n`, 'utf8')
}

/** The tar of `entries`, each a file at `package/<path>`. A name past the header's 100 bytes rides in a pax header. */
export function tarOf(entries: readonly { path: string; body: Buffer; executable?: boolean }[]): Buffer {
  const out: Buffer[] = []
  for (const e of entries) {
    const name = `package/${e.path}`
    if (Buffer.byteLength(name) > 100) {
      const pax = paxRecord(name)
      out.push(header('PaxHeader', pax.length, 'x'), ...padded(pax))
    }
    out.push(header(Buffer.byteLength(name) > 100 ? name.slice(0, 50) : name, e.body.length, '0', e.executable === true), ...padded(e.body))
  }
  out.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(out)
}

/** gzip at one level, its header's system byte set to Unix's, as zlib writes another on each platform. */
export function gzipFixed(tar: Buffer): Buffer {
  const gz = gzipSync(tar, { level: 9 })
  gz[9] = 3
  return gz
}

/** Every regular file under `root` by its path with `/`, in code unit order. The copy a folder check made holds no link. */
async function filesUnder(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (at: string, rel: string): Promise<void> => {
    for (const e of await fs.readdir(at, { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) await walk(path.join(at, e.name), r)
      else if (e.isFile()) out.push(r)
    }
  }
  await walk(root, '')
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

const ALWAYS_AT_TOP = /^(?:readme|license|licence)(?:\..*)?$/i

const exists = (at: string): Promise<boolean> => fs.stat(at).then(() => true, () => false)
const readJson = async (file: string): Promise<Record<string, unknown>> => {
  try {
    const v: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
const namesOf = (v: unknown): string[] => (typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.keys(v) : [])

/** What of the folder at `copy` npm's rules put in a package: whether a path is chosen, and the dependencies left out. */
async function packRules(copy: string): Promise<{ chosen: (rel: string) => boolean; unpacked: string[] }> {
  const pkg = await readJson(path.join(copy, 'package.json'))
  const astera = (typeof pkg.astera === 'object' && pkg.astera !== null ? pkg.astera : {}) as Record<string, unknown>
  const always = new Set(['package.json', ...[astera.entry, astera.ui].filter((v): v is string => typeof v === 'string').map((v) => v.replace(/^\.\//, ''))])
  // `files`, each line on its own and the last that matches deciding, so a later `!` takes a file back out of a folder
  // an earlier line chose (gitignore's rule that keeps a file in an excluded folder excluded is not npm's here)
  const lines = Array.isArray(pkg.files) ? pkg.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : null
  const matchers: { negated: boolean; ig: Ignore }[] | null = lines
    ? lines.map((l) => (l.startsWith('!') ? { negated: true, ig: ignore().add(l.slice(1)) } : { negated: false, ig: ignore().add(l) }))
    : null
  const inFiles = (rel: string): boolean => {
    if (matchers === null) return true
    let chosen = false
    for (const m of matchers) if (m.ig.ignores(rel)) chosen = !m.negated
    return chosen
  }

  // bundleDependencies (or bundledDependencies): a list of names, or true for every dependency; with each, the packages
  // it needs, nested under it or hoisted to the top
  const dependencies = namesOf(pkg.dependencies)
  const bundleField = pkg.bundleDependencies ?? pkg.bundledDependencies
  const bundled = bundleField === true ? dependencies : Array.isArray(bundleField) ? bundleField.filter((n): n is string => typeof n === 'string') : []
  const packages = new Set<string>()
  const queue = bundled.map((n) => `node_modules/${n}`)
  while (queue.length > 0) {
    const dir = queue.shift() as string
    if (packages.has(dir) || !(await exists(path.join(copy, ...dir.split('/'))))) continue
    packages.add(dir)
    const own = await readJson(path.join(copy, ...dir.split('/'), 'package.json'))
    for (const dep of [...namesOf(own.dependencies), ...namesOf(own.optionalDependencies)]) {
      const nested = `${dir}/node_modules/${dep}`
      queue.push((await exists(path.join(copy, ...nested.split('/')))) ? nested : `node_modules/${dep}`)
    }
  }
  const unpacked = dependencies.filter((n) => !packages.has(`node_modules/${n}`))
  const chosen = (rel: string): boolean => {
    if (rel.startsWith('node_modules/')) return [...packages].some((p) => rel.startsWith(`${p}/`))
    if (always.has(rel) || (!rel.includes('/') && ALWAYS_AT_TOP.test(rel))) return true
    return inFiles(rel)
  }
  return { chosen, unpacked }
}

/** The package of the folder at `copy`: its gzipped tar, the files in it and the files left out (each list sorted), how
 *  many files npm's rules skipped, and the dependencies it does not carry. */
export async function packFolder(copy: string): Promise<{ tgz: Buffer; files: string[]; leftOut: string[]; skipped: number; unpacked: string[] }> {
  const rules = await packRules(copy)
  const all = await filesUnder(copy)
  const candidates = all.filter(rules.chosen)
  const files = candidates.filter((rel) => !leftOutOfPackage(rel))
  const leftOut = candidates.filter((rel) => leftOutOfPackage(rel))
  const entries = await Promise.all(
    files.map(async (rel) => {
      const at = path.join(copy, ...rel.split('/'))
      // Executable stays executable, as a folder install keeps it; Windows keeps no such bit, so nothing there is
      const executable = ((await fs.stat(at)).mode & 0o111) !== 0
      return { path: rel, body: await fs.readFile(at), executable }
    })
  )
  return { tgz: gzipFixed(tarOf(entries)), files, leftOut, skipped: all.length - candidates.length, unpacked: rules.unpacked }
}
