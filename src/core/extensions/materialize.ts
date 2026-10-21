// Shared skills, commands and agents copied into every account (Agent Control Plane release 1 design §4.6). The
// canonical copy lives under `extensions/`; each account gets a managed copy, and what Astera owns is recorded in
// `extension-state/materialized.json`, never marked inside the person's files (no junctions or symlinks). A copy the
// person edited is backed up before it is restored, one they already had is adopted when identical and left as a
// conflict when not, and removal deletes only unchanged copies Astera wrote. Running it twice changes nothing (AC-14).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { extensionPaths } from '../profile/paths'
import { providerOf } from '../providers/meta'
import { writeThroughTmp } from '../accounts/fileQueue'
import { renameRetrying } from '../renameRetry'
import { keepDamaged, readStoreFile } from '../storeFile'
import { withFileLock } from '../fileLock'
import { hashFile, hashTree } from './hash'
import { readExtensionRegistry } from './registry'
import type { Account, Provider } from '../types'
import type { FileExtension, SyncOutcome } from './types'

export interface MaterializedRecord {
  id: string
  accountId: string
  provider: Provider
  destination: string
  sourceHash: string
  materializedHash: string
  /** Found already in place and identical (D10): forgotten, never deleted, when the entry goes. */
  adopted: boolean
  lastSyncedAt: string
}

export type { SyncOutcome }

export interface SyncItem {
  id: string
  accountId: string
  outcome: SyncOutcome
  detail?: string
}

interface StateFile {
  version: 1
  records: MaterializedRecord[]
}

let seq = 0
const keyOf = (accountId: string, id: string): string => `${accountId}\0${id}`
const fileName = (e: Pick<FileExtension, 'kind' | 'name'>): string => (e.kind === 'skill' ? e.name : `${e.name}.md`)
const folderOf = (kind: FileExtension['kind']): string => (kind === 'skill' ? 'skills' : kind === 'command' ? 'commands' : 'agents')
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function canonicalOf(profileDir: string, e: FileExtension): string {
  const p = extensionPaths(profileDir)
  return path.join(e.kind === 'skill' ? p.skills : e.kind === 'command' ? p.commands : p.agents, fileName(e))
}
const destinationOf = (account: Account, e: FileExtension): string => path.join(account.configDir, folderOf(e.kind), fileName(e))
/** Skills go to both providers, commands and agents to Claude only. */
const applies = (e: FileExtension, provider: Provider): boolean => e.providers.includes(provider) && (e.kind === 'skill' || provider === 'claude')

const hashOf = (kind: FileExtension['kind'], p: string): Promise<string> => (kind === 'skill' ? hashTree(p) : hashFile(p))
async function hashIfThere(kind: FileExtension['kind'], p: string): Promise<string | null> {
  const there = await fs.stat(p).then(() => true, () => false)
  return there ? hashOf(kind, p) : null
}

/** Puts the canonical copy at `dest` through a temporary sibling, so a half copy never sits under the real name. */
async function writeCopy(kind: FileExtension['kind'], from: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true })
  if (kind !== 'skill') {
    await writeThroughTmp(dest, await fs.readFile(from, 'utf8'))
    return
  }
  const tmp = `${dest}.${process.pid}.${++seq}.tmp`
  try {
    await fs.cp(from, tmp, { recursive: true })
    await fs.rm(dest, { recursive: true, force: true })
    await renameRetrying(tmp, dest)
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}

async function backUp(profileDir: string, stamp: string, accountId: string, e: FileExtension, dest: string): Promise<void> {
  const to = path.join(extensionPaths(profileDir).backups, stamp.replace(/[:.]/g, '-'), accountId, e.kind, fileName(e))
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.cp(dest, to, { recursive: true })
}

/** The copies Astera owns now. Throws when the state file is there but cannot be read; a damaged one is kept aside. */
export async function readState(profileDir: string): Promise<MaterializedRecord[]> {
  const file = extensionPaths(profileDir).materializedState
  const read = await readStoreFile(file)
  if (read.kind === 'missing') return []
  if (read.kind === 'unreadable') throw new Error(`${file} could not be read (${String(read.error)})`)
  try {
    const s = JSON.parse(read.text) as StateFile
    if (s.version === 1 && Array.isArray(s.records)) return s.records
  } catch {
    /* kept aside below */
  }
  // Starting over is safe: with no record nothing is deleted, an identical copy is adopted again and an edited one
  // becomes a conflict
  await keepDamaged(file, read.text)
  return []
}

async function writeState(profileDir: string, records: MaterializedRecord[]): Promise<void> {
  const file = extensionPaths(profileDir).materializedState
  await fs.mkdir(path.dirname(file), { recursive: true })
  const sorted = [...records].sort((a, b) => keyOf(a.accountId, a.id).localeCompare(keyOf(b.accountId, b.id)))
  await writeThroughTmp(file, JSON.stringify({ version: 1, records: sorted } satisfies StateFile, null, 2) + '\n')
}

async function syncOne(a: {
  profileDir: string
  account: Account
  entry: FileExtension
  record: MaterializedRecord | undefined
  now: string
}): Promise<{ outcome: SyncOutcome; record: MaterializedRecord | undefined }> {
  const { entry, account, record } = a
  const source = canonicalOf(a.profileDir, entry)
  const sourceHash = await hashOf(entry.kind, source)
  const destination = destinationOf(account, entry)
  const found = await hashIfThere(entry.kind, destination)
  const recordOf = (adopted: boolean): MaterializedRecord => ({
    id: entry.id, accountId: account.id, provider: providerOf(account), destination, sourceHash, materializedHash: sourceHash, adopted, lastSyncedAt: a.now
  })
  if (found === null) {
    await writeCopy(entry.kind, source, destination)
    return { outcome: 'written', record: recordOf(record?.adopted ?? false) }
  }
  if (!record) {
    if (found === sourceHash) return { outcome: 'adopted', record: recordOf(true) }
    return { outcome: 'conflict', record: undefined }
  }
  if (found === sourceHash) {
    const same = record.sourceHash === sourceHash && record.materializedHash === sourceHash && record.destination === destination
    return { outcome: 'unchanged', record: same ? record : recordOf(record.adopted) }
  }
  if (found === record.materializedHash) {
    await writeCopy(entry.kind, source, destination)
    return { outcome: 'written', record: recordOf(record.adopted) }
  }
  await backUp(a.profileDir, a.now, account.id, entry, destination)
  await writeCopy(entry.kind, source, destination)
  return { outcome: 'restored', record: recordOf(record.adopted) }
}

/** A record whose entry is gone, disabled or no longer for this account: its copy is deleted only when Astera wrote
 *  it and nobody changed it; otherwise the copy stays and the record is dropped. */
async function retire(record: MaterializedRecord, kind: FileExtension['kind'] | undefined): Promise<SyncOutcome> {
  if (record.adopted) return 'forgotten'
  const k = kind ?? (path.extname(record.destination) === '.md' ? 'command' : 'skill')
  const found = await hashIfThere(k, record.destination)
  if (found === null) return 'removed'
  if (found !== record.materializedHash) return 'forgotten'
  await fs.rm(record.destination, { recursive: true, force: true })
  return 'removed'
}

async function accountFolderThere(account: Account): Promise<void> {
  const st = await fs.stat(account.configDir).catch(() => null)
  if (!st?.isDirectory()) throw new Error(`the account folder is missing: ${account.configDir}`)
}

/** One sync or replace at a time across processes, the Host's and `astera ext sync`'s (final review M2): a record lost
 *  between two writers would turn a copy Astera wrote into an adopted one, which removal then leaves behind. */
const stateLocked = <T>(profileDir: string, fn: () => Promise<T>): Promise<T> =>
  withFileLock(path.dirname(extensionPaths(profileDir).materializedState), fn, { waitMs: 60_000, staleMs: 600_000 })

export async function syncMaterialized(a: { profileDir: string; accounts: Account[]; now?: () => string }): Promise<{ items: SyncItem[] }> {
  // A profile that shares no file and owns no copy has nothing to lock or write (the Host syncs at every start)
  const nothing =
    !(await readExtensionRegistry(a.profileDir)).entries.some((e) => e.kind !== 'mcp') &&
    !(await fs.stat(extensionPaths(a.profileDir).materializedState).then(() => true, () => false))
  if (nothing) return { items: [] }
  return stateLocked(a.profileDir, () => syncUnlocked(a))
}

async function syncUnlocked(a: { profileDir: string; accounts: Account[]; now?: () => string }): Promise<{ items: SyncItem[] }> {
  const now = (a.now ?? (() => new Date().toISOString()))()
  const registry = await readExtensionRegistry(a.profileDir)
  const files = registry.entries.filter((e): e is FileExtension => e.kind !== 'mcp')
  const kindOf = new Map(files.map((e) => [e.id, e.kind]))
  const old = await readState(a.profileDir)
  // An account no longer registered keeps its folder as it is; only its records go (final review M5)
  const registered = new Set(a.accounts.map((x) => x.id))
  const next = new Map(old.filter((r) => registered.has(r.accountId)).map((r) => [keyOf(r.accountId, r.id), r]))
  const items: SyncItem[] = []

  for (const account of a.accounts) {
    const provider = providerOf(account)
    const enabled = files.filter((e) => e.enabled)
    const wanted = enabled.filter((e) => applies(e, provider))
    for (const e of enabled) if (!applies(e, provider)) items.push({ id: e.id, accountId: account.id, outcome: 'not-applicable' })
    try {
      await accountFolderThere(account)
    } catch (err) {
      // Its records stay as they were: nothing about the account could be looked at
      for (const e of wanted) items.push({ id: e.id, accountId: account.id, outcome: 'failed', detail: message(err) })
      continue
    }
    for (const entry of wanted) {
      const key = keyOf(account.id, entry.id)
      try {
        const r = await syncOne({ profileDir: a.profileDir, account, entry, record: next.get(key), now })
        if (r.record) next.set(key, r.record)
        items.push({ id: entry.id, accountId: account.id, outcome: r.outcome })
      } catch (err) {
        items.push({ id: entry.id, accountId: account.id, outcome: 'failed', detail: message(err) })
      }
    }
    const wantedIds = new Set(wanted.map((e) => e.id))
    for (const record of old) {
      if (record.accountId !== account.id || wantedIds.has(record.id)) continue
      try {
        const outcome = await retire(record, kindOf.get(record.id))
        next.delete(keyOf(record.accountId, record.id))
        items.push({ id: record.id, accountId: account.id, outcome })
      } catch (err) {
        items.push({ id: record.id, accountId: account.id, outcome: 'failed', detail: message(err) })
      }
    }
  }
  // Written only when a record changed: a run that changed nothing, and a profile that shares nothing, write nothing
  const records = [...next.values()]
  const same = records.length === old.length && records.every((r) => old.includes(r))
  if (!same) await writeState(a.profileDir, records)
  return { items }
}

/** "Replace with the shared copy" for a conflict: the account's own copy is backed up, then the shared one written
 *  and recorded as Astera's. */
export function replaceConflict(a: { profileDir: string; accountId: string; id: string; accounts: Account[]; now?: () => string }): Promise<void> {
  return stateLocked(a.profileDir, () => replaceUnlocked(a))
}

async function replaceUnlocked(a: { profileDir: string; accountId: string; id: string; accounts: Account[]; now?: () => string }): Promise<void> {
  const now = (a.now ?? (() => new Date().toISOString()))()
  const account = a.accounts.find((x) => x.id === a.accountId)
  if (!account) throw new Error(`no account ${a.accountId}`)
  await accountFolderThere(account)
  const entry = (await readExtensionRegistry(a.profileDir)).entries.find((e): e is FileExtension => e.id === a.id && e.kind !== 'mcp')
  if (!entry) throw new Error(`no shared item ${a.id}`)
  const source = canonicalOf(a.profileDir, entry)
  const destination = destinationOf(account, entry)
  if ((await hashIfThere(entry.kind, destination)) !== null) await backUp(a.profileDir, now, account.id, entry, destination)
  await writeCopy(entry.kind, source, destination)
  const sourceHash = await hashOf(entry.kind, source)
  const records = (await readState(a.profileDir)).filter((r) => !(r.accountId === account.id && r.id === entry.id))
  records.push({ id: entry.id, accountId: account.id, provider: providerOf(account), destination, sourceHash, materializedHash: sourceHash, adopted: false, lastSyncedAt: now })
  await writeState(a.profileDir, records)
}
