// A read-only look at the profile's accounts.json, for the one process that must never write it.
//
// **Why this exists beside AccountRegistry.** The Host answers `listAccounts` itself when the app is
// not there to ask (src/host/orchDeps.ts), so `accounts list`, `tasks add` and
// `jobs create --coordinator-account` work with Astera closed. `AccountRegistry.load()` cannot be that
// read: it is not read-only. It rewrites the file to resolve colour collisions, and on a corrupt file
// it copies it aside to `.bak` and starts empty. The app is the file's only writer, and a second
// process doing either would be a second writer.
//
// **No race to guard against.** The app writes by `writeFile(tmp)` then `rename`, so a reader sees
// the old file or the new one, never a torn one. And the Host only reads when the app is absent,
// which is exactly when nothing is writing.
import { promises as fs } from 'node:fs'
import type { Account, Provider } from '../types'
import { providerOf } from '../providers/meta'
import type { OrchAccount } from '../orchestration/command'
import { isValidAccount } from './registry'
import { RepairNeeded } from '../settings/repairNeeded'

/** One account as the orchestration layer sees it. **The one projection**: the app's `listAccounts`
 *  (ipc.ts) and this file's reader both go through it, so the two answers cannot drift apart —
 *  `configDir` never leaves either. */
export const orchAccountOf = (a: Account): OrchAccount => ({
  id: a.id,
  label: a.label,
  provider: providerOf(a)
})

/**
 * The accounts in `filePath`, narrowed to `provider` when given.
 *
 * - **Missing file: `[]`.** That is the app's own reading of it: a profile that has never registered
 *   an account.
 * - **Unreadable JSON or a misshaped entry: it throws**, with a message that says what to do. It does
 *   not answer `[]`, because "there are no accounts" would turn every `--account` into a 404 that is
 *   not true, and it does not repair anything: the app recovers a corrupt file with a backup, which
 *   is a write this reader must not make. The rule for what counts as misshaped is the registry's own
 *   (`isValidAccount`), so the two cannot disagree about which file is corrupt.
 */
export async function readAccountsFile(filePath: string, provider?: Provider): Promise<OrchAccount[]> {
  return (await readAccountEntries(filePath))
    .filter((a) => provider === undefined || providerOf(a) === provider)
    .map(orchAccountOf)
}

/** The same read, with every account whole — `configDir` included. For `astera skills`, which runs
 *  in the CLI process and plants files in each account's config folder; never for a reply, which is
 *  what `readAccountsFile`'s projection is for. */
export async function readAccountEntries(filePath: string): Promise<Account[]> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new RepairNeeded(`accounts.json could not be read (${String(err)}); open Astera to repair it`, 'accounts.json')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new RepairNeeded('accounts.json is not valid JSON; open Astera to repair it', 'accounts.json')
  }
  const list = (parsed as { accounts?: unknown } | null)?.accounts
  if (!Array.isArray(list) || !list.every(isValidAccount))
    throw new RepairNeeded('accounts.json has an entry Astera cannot read; open Astera to repair it', 'accounts.json')
  return list
}
