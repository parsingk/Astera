// `astera ext list` and `astera ext sync` — answered in the CLI process, like `skills` (Agent Control Plane release 1
// design §4.6). Everything they need is a file in the profile: the shared extension registry, the record of the copies
// Astera owns and accounts.json. `list` says what is shared and where its copies are, names only, never an
// environment value (D5); `sync` puts the shared skills, commands and agents into every account, the same sync the
// Host runs when the registry changes, and running it twice changes nothing the second time (AC-14).
import path from 'node:path'
import type { CliError } from '../core/orchestration/cliOutput'
import type { Account } from '../core/types'
import { readAccountEntries } from '../core/accounts/accountsFile'
import { publicEntry, readExtensionRegistry } from '../core/extensions/registry'
import { readState, syncMaterialized } from '../core/extensions/materialize'

type Outcome = { ok: true; body: Record<string, unknown> } | { ok: false; error: CliError }

const refusal = (err: unknown, file: string): Outcome => ({
  ok: false,
  // The same refusal `skills` gives for a damaged accounts.json: opening Astera repairs it
  error: { code: 'CONFLICT', message: err instanceof Error ? err.message : String(err), details: { repair: file } }
})

export async function extensionsCommand(a: { cmd: 'ext-list' | 'ext-sync'; profileDir: string }): Promise<Outcome> {
  if (a.cmd === 'ext-list') {
    try {
      const registry = await readExtensionRegistry(a.profileDir)
      const copies = (await readState(a.profileDir)).map((r) => ({ id: r.id, accountId: r.accountId, destination: r.destination, adopted: r.adopted }))
      return { ok: true, body: { entries: registry.entries.map(publicEntry), copies } }
    } catch (err) {
      return refusal(err, 'extensions/registry.json')
    }
  }
  let accounts: Account[]
  try {
    accounts = await readAccountEntries(path.join(a.profileDir, 'accounts.json'))
  } catch (err) {
    return refusal(err, 'accounts.json')
  }
  let items: Awaited<ReturnType<typeof syncMaterialized>>['items']
  try {
    items = (await syncMaterialized({ profileDir: a.profileDir, accounts })).items
  } catch (err) {
    return refusal(err, 'extensions/registry.json')
  }
  // A copy that could not be written is the command's failure (1), as in `skills install`: the whole answer goes in
  // error.details
  if (items.some((i) => i.outcome === 'failed'))
    return { ok: false, error: { code: 'FAILED', message: 'some shared items could not be synced into an account', details: { items } } }
  return { ok: true, body: { items } }
}
