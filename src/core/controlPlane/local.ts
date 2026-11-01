// This machine's shared extensions as the Runtime report gives them (remote governance design §5.2, §5.3): each entry's
// id, kind, name, switch and providers, a file kind's comparison hash, an MCP server's secret names and its Gateway state.
// Built field by field, never spread from the entry, so an MCP launch definition (command, args, cwd, url, env values),
// where it was imported from and the Gateway's last error never reach a controller.
//
// A paired person may ask for the report again and again (ruling R9-2): the hashes are made at most HASH_AT_ONCE at a
// time, and each canonical copy's hash is kept against a stamp read from stat alone (its files' relative paths, sizes and
// mtimes, the same files compareHash covers), so an unchanged skill is not read again and a new or edited one is.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readExtensionRegistry } from '../extensions/registry'
import { compareHashOf, comparedFiles, comparedName } from '../extensions/compareHash'
import { canonicalOf } from '../extensions/materialize'
import type { ExtensionEntry, FileExtension } from '../extensions/types'
import type { UpstreamState } from '../../host/gateway/upstream'
import type { ReportExtension } from './report'

/** How many canonical copies are stamped and hashed at once, and how many of one skill's files are stat'ed at once. */
const HASH_AT_ONCE = 8
const STAT_AT_ONCE = 16

/** Each canonical copy's last hash, by its path, with the stamp it was made at. */
const hashes = new Map<string, { stamp: string; hash: string }>()

/** What stat says of a copy: for a skill folder, each covered file's relative path, size and mtime, sorted. */
async function stampOf(e: FileExtension, p: string): Promise<string> {
  const line = async (file: string, rel: string): Promise<string> => {
    const st = await fs.stat(file)
    return `${rel}\0${st.size}\0${st.mtimeMs}`
  }
  if (e.kind !== 'skill') return line(p, '')
  // Named, sorted and stamped as the hash names them (comparedName, final review F11)
  const files = (await comparedFiles(p)).map((rel) => ({ rel, name: comparedName(rel) }))
  files.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
  return (await pooled(files, STAT_AT_ONCE, (f) => line(path.join(p, f.rel), f.name))).join('\n')
}

/** The comparison hash of an entry's canonical copy, read again only when its stamp moved. Throws when it cannot be read. */
async function hashOf(profileDir: string, e: FileExtension): Promise<string> {
  const p = canonicalOf(profileDir, e)
  const stamp = `${e.kind}\n${await stampOf(e, p)}`
  const held = hashes.get(p)
  if (held?.stamp === stamp) return held.hash
  const hash = await compareHashOf(profileDir, e)
  hashes.set(p, { stamp, hash })
  return hash
}

/** `f` over `items`, at most `limit` running at once, the answers in the items' order. */
async function pooled<T, R>(items: readonly T[], limit: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await f(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Every registry entry as the report holds it. A registry that cannot be read, or is damaged, throws, as
 *  readExtensionRegistry does: an empty list would tell a controller this machine shares nothing. A read only (ruling
 *  R9-5): no copy of a damaged file is written beside it. */
export async function localReportExtensions(profileDir: string, gateway?: readonly UpstreamState[]): Promise<ReportExtension[]> {
  const { entries } = await readExtensionRegistry(profileDir, { keepDamaged: false })
  return pooled(entries, HASH_AT_ONCE, async (e: ExtensionEntry): Promise<ReportExtension> => {
    const out: ReportExtension = { id: e.id, kind: e.kind, name: e.name, enabled: e.enabled, providers: [...e.providers] }
    if (e.kind === 'mcp') {
      out.secretNames = Object.entries(e.env).flatMap(([name, v]) => ('secret' in v ? [name] : []))
      // The Gateway runs stdio servers only; its lastError can quote a command line or a path (§5.3), so only the state
      const held = e.transport === 'stdio' ? gateway?.find((s) => s.serverId === e.id) : undefined
      if (held) out.gateway = held.state
      return out
    }
    // A copy that cannot be read leaves the hash out: a controller then shows "cannot compare", not "different"
    const hash = await hashOf(profileDir, e).catch(() => undefined)
    if (hash !== undefined) out.compareHash = hash
    return out
  })
}
