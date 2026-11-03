// The comparison hash (Remote Runtime governance design §6.2): what a controller compares to tell whether a Runtime
// holds the same skill, command or agent. Unlike the registry hash (`hash.ts`), text files hash with CRLF folded to LF
// and OS metadata files are left out, so a skill checked out on Windows compares equal to its macOS copy. The `cmp1:`
// prefix keeps it from ever being compared equal to a registry hash.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { canonicalOf } from './materialize'
import type { FileExtension } from './types'

const OS_METADATA = new Set(['thumbs.db', 'desktop.ini'])

/** True for files an OS writes beside the real ones: `.DS_Store`, `._*`, and `Thumbs.db`/`desktop.ini` in any case. */
export function isOsMetadata(name: string): boolean {
  return name === '.DS_Store' || name.startsWith('._') || OS_METADATA.has(name.toLowerCase())
}

/** Text, as git decides it (no NUL in the first 8000 bytes), has each `\r\n` made `\n`; a lone `\r` stays. */
export function normalized(bytes: Buffer): Buffer {
  if (bytes.subarray(0, 8000).includes(0)) return bytes
  const out = Buffer.allocUnsafe(bytes.length)
  let n = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue
    out[n++] = bytes[i]
  }
  return out.subarray(0, n)
}

/** The relative paths ("/"-joined) a folder's comparison hash covers: every file, OS metadata files left out. Shared with
 *  the Runtime report's stamp (controlPlane/local.ts), so both skip the same files. */
export async function comparedFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (isOsMetadata(e.name)) continue
    const r = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) out.push(...(await comparedFiles(dir, r)))
    else if (e.isFile()) out.push(r)
  }
  return out
}

/** A relative path as it is hashed, sorted and stamped: in NFC (final review F11), since macOS can hand out a name
 *  decomposed that Windows and Linux keep composed, and the same skill must compare the same on both. */
export const comparedName = (rel: string): string => rel.normalize('NFC')

/** The comparison hash of a folder: as `hashTree`, over normalized contents and without OS metadata files. */
export async function compareHashTree(dir: string): Promise<string> {
  const h = createHash('sha256')
  const files = (await comparedFiles(dir)).map((rel) => ({ rel, name: comparedName(rel) }))
  for (const f of files.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
    h.update(f.name).update('\0').update(normalized(await fs.readFile(path.join(dir, f.rel)))).update('\0')
  }
  return `cmp1:sha256:${h.digest('hex')}`
}

/** The comparison hash of one file's normalized contents. */
export async function compareHashFile(file: string): Promise<string> {
  return `cmp1:sha256:${createHash('sha256').update(normalized(await fs.readFile(file))).digest('hex')}`
}

/** The comparison hash of an entry's canonical copy: a tree for a skill, a file for a command or an agent. */
export function compareHashOf(profileDir: string, e: FileExtension): Promise<string> {
  const p = canonicalOf(profileDir, e)
  return e.kind === 'skill' ? compareHashTree(p) : compareHashFile(p)
}
