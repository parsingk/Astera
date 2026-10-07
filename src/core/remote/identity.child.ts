// Run by identity.test.ts in a second process: one Runtime's first start, printing the pin it ended with.
import path from 'node:path'
import { openSecretStore } from '../secrets/secretStore'
import { loadOrCreateIdentity } from './identity'

const main = async (): Promise<void> => {
  const profile = process.argv[2]
  const store = openSecretStore({ dir: path.join(profile, 'remote'), profileDir: profile, lockWaitMs: 30_000 })
  const id = await loadOrCreateIdentity(store, { displayName: 'race' })
  process.stdout.write(id.spkiSha256)
}
void main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
