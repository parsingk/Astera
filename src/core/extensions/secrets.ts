// The secret environment values of shared MCP servers (Agent Control Plane release 1 design §4.3, D5): the
// profile's owner-only secret store under extensions/secrets. Values are read only by the Host when it starts a session
// (into that session's environment) and to redact logs; nothing here reaches the renderer, the CLI or MCP.
import { openSecretStore, type SecretStore } from '../secrets/secretStore'
import { extensionPaths } from '../profile/paths'

export interface ExtensionSecrets {
  put(name: string, value: string): Promise<void>
  get(name: string): Promise<string | null>
  remove(name: string): Promise<void>
  /** Every stored value, for redaction. */
  terms(): Promise<string[]>
}

const stores = new Map<string, SecretStore>()

export function extensionSecrets(profileDir: string): ExtensionSecrets {
  const dir = extensionPaths(profileDir).secrets
  let store = stores.get(dir)
  if (!store) {
    store = openSecretStore({ dir, profileDir })
    stores.set(dir, store)
  }
  const s = store
  return {
    put: (name, value) => s.withLock((tx) => tx.write(name, value)),
    get: (name) => s.read(name),
    remove: (name) => s.withLock((tx) => tx.remove(name)),
    terms: async () => {
      const names = await s.withLock((tx) => tx.list())
      const values = await Promise.all(names.map((n) => s.read(n)))
      return values.filter((v): v is string => v !== null)
    }
  }
}
