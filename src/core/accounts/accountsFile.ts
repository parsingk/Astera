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
import { defaultAccountIdOf } from './defaultAccount'
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
export async function readAccountsFile(
  filePath: string,
  provider?: Provider,
  /** Given, each provider's default account is marked (`orchAccountsFor`). */
  loggedIn?: (a: Account) => Promise<boolean>
): Promise<OrchAccount[]> {
  return orchAccountsFor(await readAccountEntries(filePath), provider, loggedIn)
}

/**
 * `listAccounts`' answer from the whole list: narrowed to `provider`, projected, and, when `loggedIn`
 * is given, each provider's default (defaultAccountIdOf, the rule behind the app's default badge)
 * marked `default: true`. The app's `listAccounts` and the Host's file read both answer through this,
 * so the two cannot drift apart. A probe that fails counts as logged out.
 *
 * `provider` may be null: a call the Host forwards to the app crosses a socket as JSON, where an
 * omitted provider before the options (`listAccounts(undefined, { withDefault })`) becomes null.
 */
export function orchAccountsFor(
  all: readonly Account[],
  provider: Provider | null | undefined,
  loggedIn?: (a: Account) => Promise<boolean>
): OrchAccount[] | Promise<OrchAccount[]> {
  const accounts = all.filter((a) => provider == null || providerOf(a) === provider)
  return loggedIn ? withDefaultMarks(accounts, loggedIn) : accounts.map(orchAccountOf)
}

async function withDefaultMarks(
  accounts: readonly Account[],
  loggedIn: (a: Account) => Promise<boolean>
): Promise<OrchAccount[]> {
  const ids = new Set<string>()
  await Promise.all(
    accounts.map(async (a) => {
      if (await loggedIn(a).catch(() => false)) ids.add(a.id)
    })
  )
  return accounts.map((a) =>
    defaultAccountIdOf(providerOf(a), accounts, ids) === a.id ? { ...orchAccountOf(a), default: true as const } : orchAccountOf(a)
  )
}

/** The same read, with every account whole — `configDir` included. For `astera skills`, which runs
 *  in the CLI process and plants files in each account's config folder; never for a reply, which is
 *  what `readAccountsFile`'s projection is for. `read` is the file read, a plain readFile unless a
 *  caller rides out the app's save (the Host's How It Works: readFileRetrying). */
export async function readAccountEntries(
  filePath: string,
  read: (p: string) => Promise<string> = (p) => fs.readFile(p, 'utf8')
): Promise<Account[]> {
  let text: string
  try {
    text = await read(filePath)
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
