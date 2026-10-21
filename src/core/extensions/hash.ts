// Content hashes of skills, commands and agents (Agent Control Plane release 1 design §4.3, §4.6): a folder hashes
// its sorted relative paths and bytes, so the same content hashes the same wherever it sits.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

async function files(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) out.push(...(await files(dir, r)))
    else if (e.isFile()) out.push(r)
  }
  return out
}

/** sha256 of a folder's files: each relative path (with `/`) and its bytes, in sorted path order. */
export async function hashTree(dir: string): Promise<string> {
  const h = createHash('sha256')
  for (const rel of (await files(dir)).sort()) {
    h.update(rel).update('\0').update(await fs.readFile(path.join(dir, rel))).update('\0')
  }
  return `sha256:${h.digest('hex')}`
}

/** sha256 of one file's bytes. */
export async function hashFile(file: string): Promise<string> {
  return `sha256:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`
}
