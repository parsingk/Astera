// The one sync the Host runs for Codex (Codex plugin sharing design §5.1, §5.3, §5.10): the list of what is shared is built
// from the store, the Codex copies and the marketplace file that lists them are kept, every Codex account is brought in
// line one after the other (reconcile.ts), the outcome is recorded, and the Codex copies no account uses are swept. It
// never rejects: whatever stops it is a log line, and the Claude side that called it is already done.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { withFileLock } from '../../fileLock'
import { extensionPaths } from '../../profile/paths'
import { providerOf } from '../../providers/meta'
import { renameRetrying } from '../../renameRetry'
import type { Account } from '../../types'
import { readClaudePlugins } from '../claudePlugins/store'
import type { SharedClaudePlugin } from '../claudePlugins/types'
import type { CodexPluginCliRun } from './cli'
import { codexCopyFolder, codexMarketplaceName, versionSegment, writeCodexCopy, writeCodexMarketplace } from './copy'
import type { CodexHooksList } from './hooks'
import { reconcileCodexAccount, type DesiredCodexPlugin } from './reconcile'
import { readCodexPluginAccounts, writeCodexPluginAccounts, type CodexPluginAccountState } from './state'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A shared plugin or a dependency of one, with the Claude copy its Codex copy is made from. */
interface Candidate extends DesiredCodexPlugin {
  id: string
  installPath: string
}

/** The name in a plugin id, `name@marketplace`; null for an id with no name. */
const nameOf = (id: string): string | null => {
  const at = id.lastIndexOf('@')
  return at <= 0 ? null : id.slice(0, at)
}

/** What this profile shares, one entry per name: each store entry in store order, then each dependency by the name in its
 *  id, at its recorded version, on when any plugin that is on records it. The name is all Codex has (the marketplace
 *  holds names), so a name two different plugins claim goes to one of them (ledger ruling PF2): a store entry over a
 *  dependency, an earlier over a later, and the one left out is logged. The same plugin at the same version, once as an
 *  entry and again as a dependency, is not a claim: it is one plugin, on when the entry is on or any plugin that is on
 *  records it, and so is what it records in turn. That is settled for the entries first, to the end of any chain of them,
 *  and only then are the dependencies read from the entries' final flags, so the store's order changes nothing. */
function candidatesOf(plugins: SharedClaudePlugin[], log: (line: string) => void): Candidate[] {
  const byName = new Map<string, Candidate>()
  const entries: { plugin: SharedClaudePlugin; want: Candidate }[] = []
  for (const e of plugins) {
    const held = byName.get(e.name)
    if (held !== undefined) {
      log(`codex plugins: ${e.id} is left out of Codex, ${held.id} already holds the name ${e.name}`)
      continue
    }
    const want = { id: e.id, name: e.name, version: e.version, enabled: e.enabled, installPath: e.installPath }
    byName.set(e.name, want)
    entries.push({ plugin: e, want })
  }
  const entryNames = new Set(byName.keys())

  // An entry that is on turns on each entry it records at the same id and version. Flags only turn on, so this ends.
  for (let changed = true; changed; ) {
    changed = false
    for (const { plugin, want } of entries) {
      if (!want.enabled) continue
      for (const dep of plugin.dependencies) {
        const name = nameOf(dep.id)
        const held = name === null ? undefined : byName.get(name)
        if (held !== undefined && !held.enabled && held.id === dep.id && held.version === dep.version) {
          held.enabled = true
          changed = true
        }
      }
    }
  }

  for (const { plugin, want } of entries) {
    for (const dep of plugin.dependencies) {
      const name = nameOf(dep.id)
      if (name === null) {
        log(`codex plugins: dependency ${dep.id} of ${plugin.id} is left out of Codex, it is not a plugin id`)
        continue
      }
      const held = byName.get(name)
      if (held === undefined) {
        byName.set(name, { id: dep.id, name, version: dep.version, enabled: want.enabled, installPath: dep.installPath })
      } else if (held.id === dep.id && held.version === dep.version) {
        // One plugin, not two claiming a name: an entry, already settled above, or a dependency two entries record
        held.enabled ||= want.enabled
      } else if (entryNames.has(name)) {
        log(`codex plugins: dependency ${dep.id} of ${plugin.id} is left out of Codex, the shared plugin ${held.id} holds the name ${name}`)
      } else if (held.version !== dep.version) {
        log(`codex plugins: dependency ${dep.id} at ${dep.version} of ${plugin.id} is left out of Codex, ${held.id} is wanted at ${held.version}`)
      } else {
        held.enabled ||= want.enabled
      }
    }
  }
  return [...byName.values()]
}

const isFolder = (p: string): Promise<boolean> => fs.stat(p).then((s) => s.isDirectory(), () => false)
const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false)

/** The folder a plugin's MCP servers keep their data in, one per plugin and shared by the Codex accounts. Named as a copy's
 *  folders are, so a name never leaves the folder that holds them all. */
const dataFolderOf = (profileDir: string, name: string): string => path.join(extensionPaths(profileDir).codexPluginData, versionSegment(name))

/** The candidates that have a Codex copy, made now when it is not there. A copy is made only when its version folder does
 *  not exist: a Codex account's MCP servers run from it, and making it again replaces the folder (writeCodexCopy). A copy
 *  is built beside its folder and swapped in, so a folder that is there is complete, and the plugin stays shared whether or
 *  not its Claude copy is still there. One with neither a Codex copy nor a Claude copy to make it from, or whose Claude
 *  copy cannot be converted, is left out and logged, and the rest go on. */
async function withCopies(profileDir: string, candidates: Candidate[], log: (line: string) => void): Promise<DesiredCodexPlugin[]> {
  const ready: DesiredCodexPlugin[] = []
  for (const c of candidates) {
    const to = codexCopyFolder(profileDir, c.name, c.version)
    if (!(await exists(to))) {
      if (!(await isFolder(c.installPath))) {
        log(`codex plugins: ${c.id} is left out of Codex, its Claude copy ${c.installPath} is gone`)
        continue
      }
      try {
        await writeCodexCopy({ from: c.installPath, to, name: c.name, version: c.version, dataDir: dataFolderOf(profileDir, c.name) })
      } catch (e) {
        log(`codex plugins: ${c.id} is left out of Codex, its copy could not be made (${messageOf(e)})`)
        continue
      }
    }
    ready.push({ name: c.name, version: c.version, enabled: c.enabled })
  }
  return ready
}

/** A row that says nothing is worth visiting an account for: no plugin installed, none turned off, no failure, not waiting. */
const isClean = (s: CodexPluginAccountState): boolean =>
  Object.keys(s.installed).length === 0 && s.turnedOff.length === 0 && s.failure === undefined && !s.waiting

async function sync(d: Parameters<typeof syncCodexPlugins>[0]): Promise<CodexPluginAccountState[]> {
  const now = d.now ?? (() => new Date())
  const paths = extensionPaths(d.profileDir)

  // The record of what each account has says which copies are still in use and which own plugins Astera turned off. A
  // record that is there and cannot be read could be either, so nothing is done on it.
  let before: CodexPluginAccountState[]
  try {
    before = await readCodexPluginAccounts(d.profileDir)
  } catch (e) {
    d.log(`codex plugins: the outcome file could not be read, so nothing was synced (${messageOf(e)})`)
    return []
  }
  // A store that cannot be read is not "nothing shared": taking it so would remove every shared plugin from every account.
  // The damaged file is kept aside by the Host's own reading, not here.
  let shared: SharedClaudePlugin[]
  try {
    shared = (await readClaudePlugins(d.profileDir, { keepDamaged: false })).plugins
  } catch (e) {
    d.log(`codex plugins: the shared plugin store could not be read, so nothing was synced (${messageOf(e)})`)
    return before
  }

  const accounts = d.accounts.filter((a) => providerOf(a) === 'codex')
  const candidates = candidatesOf(shared, d.log)
  // The copies and the marketplace exist for the accounts that will add them: with none, or with nothing to share, none
  // is made. With nothing desired but rows left, the accounts are reconciled to remove what they have.
  let desired: DesiredCodexPlugin[] = []
  if (accounts.length > 0 && candidates.length > 0) {
    desired = await withCopies(d.profileDir, candidates, d.log)
    if (desired.length > 0) {
      try {
        await writeCodexMarketplace(d.profileDir, desired)
      } catch (e) {
        d.log(`codex plugins: the marketplace file could not be written, so nothing was synced (${messageOf(e)})`)
        return before
      }
    }
  }

  const lock = <T>(fn: () => Promise<T>): Promise<T> => withFileLock(paths.codexConfigLock, fn, { waitMs: 60_000, staleMs: 600_000 })
  const marketplace = { name: codexMarketplaceName(d.profileDir), root: paths.codexPluginHome }
  const results: CodexPluginAccountState[] = []
  for (const account of accounts) {
    results.push(
      await reconcileCodexAccount({
        account,
        homeDir: d.homeDir,
        marketplace,
        desired,
        previous: before.find((r) => r.accountId === account.id),
        busy: d.liveAccountIds.has(account.id),
        run: d.run,
        hooks: d.hooks,
        lock,
        now
      })
    )
  }

  // A row of an account that is gone is not in `results`, and a clean one is not worth keeping: an account with nothing
  // shared stops being visited, and with no row left the file goes, so the next sync with nothing shared runs nothing
  const rows = results.filter((s) => !isClean(s))
  try {
    if (rows.length > 0) await writeCodexPluginAccounts(d.profileDir, rows)
    else await fs.rm(paths.codexPluginAccounts, { force: true })
  } catch (e) {
    d.log(`codex plugins: the outcome could not be recorded (${messageOf(e)})`)
  }

  // After the accounts, so a version one of them still holds is in `rows`. What is current is what the store shares, copy
  // or not
  await sweepCodexCopies(d.profileDir, rows, candidates)
  return rows
}

/** Brings every Codex account in line with what this profile shares, records how each went, and sweeps the Codex copies no
 *  account uses. Runs nothing and writes nothing for a profile that shares no plugin and has no rows (§4). Resolves to the
 *  rows it recorded; never rejects. */
export async function syncCodexPlugins(d: {
  profileDir: string
  homeDir: string
  accounts: Account[]
  run: CodexPluginCliRun
  hooks: CodexHooksList
  /** Accounts an Astera-started Codex session is alive in: their reconcile is busy (C5, C14). */
  liveAccountIds: Set<string>
  log: (line: string) => void
  now?: () => Date
}): Promise<CodexPluginAccountState[]> {
  try {
    return await sync(d)
  } catch (e) {
    d.log(`codex plugins: the sync failed (${messageOf(e)})`)
    return []
  }
}

/** A folder as the sweep compares it: resolved, and as Windows and macOS name folders, so two spellings count as one,
 *  which only ever keeps a folder. */
const sameFolder = (p: string): string => path.resolve(p).toLowerCase()

/** The real folders in `dir`, never a link to one. */
async function subfolders(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name))
}

let removals = 0

/** Removes a version folder whole or not at all as far as the version's name goes. Windows deletes the files nothing holds
 *  and fails on the rest, which would leave a half-removed folder under the version's name, and a copy is never rewritten
 *  while its folder is there. So it is renamed to a temporary sibling first: a folder a process holds fails the rename and
 *  stays as it was, and what the removal cannot finish is a `.tmp` folder, which the next sweep clears. A folder already
 *  named `.tmp` is such a leftover, or one a crashed copy left, and is removed where it is. Answers whether the version's
 *  name is free. */
async function removeVersionFolder(folder: string): Promise<boolean> {
  const leftover = folder.endsWith('.tmp')
  let doomed = folder
  if (!leftover) {
    doomed = `${folder}.${process.pid}.${++removals}.tmp`
    try {
      await renameRetrying(folder, doomed)
    } catch {
      return false
    }
  }
  try {
    await fs.rm(doomed, { recursive: true, force: true })
  } catch {
    // Left for the next sweep: it is a temporary folder now, so it is not mistaken for a copy
    return !leftover
  }
  return true
}

/** Deletes each folder `<codexPluginHome>/plugins/<name>/<folder>` that is not the current version of a shared plugin or
 *  dependency and that no account's recorded outcome shows installed: MCP servers run from a copy (C3), so it stays while
 *  any account has that version. That takes the temporary folders a crashed copy left, as nothing else names them, and it
 *  leaves the marketplace file. A plugin's folder that is left empty goes too. It walks real folders only, so it never
 *  follows a link and never deletes one, and it deletes nothing when the copies folder is not a real folder. Resolves to
 *  the folders it deleted. */
export async function sweepCodexCopies(
  profileDir: string,
  outcome: CodexPluginAccountState[],
  current: { name: string; version: string }[]
): Promise<string[]> {
  const home = extensionPaths(profileDir).codexPluginHome
  const plugins = path.join(home, 'plugins')
  for (const dir of [home, plugins]) {
    const st = await fs.lstat(dir).catch(() => null)
    if (!st?.isDirectory()) return []
  }
  const inUse = [...current, ...outcome.flatMap((o) => Object.entries(o.installed).map(([name, version]) => ({ name, version })))]
  const keep = new Set(inUse.map((p) => sameFolder(codexCopyFolder(profileDir, p.name, p.version))))
  const deleted: string[] = []
  for (const plugin of await subfolders(plugins)) {
    for (const version of await subfolders(plugin)) {
      if (keep.has(sameFolder(version))) continue
      if (await removeVersionFolder(version)) deleted.push(version)
    }
    // Not recursive: a folder that holds anything is left as it is
    await fs.rmdir(plugin).catch(() => {})
  }
  return deleted
}
