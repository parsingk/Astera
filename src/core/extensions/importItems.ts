// Importing picked items from a default account into the shared registry (Agent Control Plane release 1 design §4.4,
// D5, D11). This is the one place a shared MCP server's environment values are read from an account's file: a value
// the person keeps as secret goes to the extension secret store, a plain one stays in the registry, a Codex
// `env_vars` name passes the session's own variable through. Skills, commands and agents are copied to the canonical
// folders with their hash. The source account is never changed.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { extensionPaths } from '../profile/paths'
import { providerOf } from '../providers/meta'
import { readTomlObject } from '../providers/configWrite'
import { claudeMcpFile, discoverIn, knownSessionIsolated } from './discover'
import { looksSecret, type NotShareableReason } from './envRules'
import { hashFile, hashTree } from './hash'
import { readExtensionRegistry, writeExtensionRegistry } from './registry'
import { extensionSecrets } from './secrets'
import type { Account, Provider } from '../types'
import type { ExtensionEntry, ExtensionKind, McpEnvValue } from './types'

export interface ImportPick {
  kind: ExtensionKind
  name: string
  /** Environment names to keep as secrets; default: the credential-looking ones. */
  secretNames?: string[]
}

export interface ImportResult {
  imported: string[]
  refused: { name: string; reason: NotShareableReason }[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const BOTH: Provider[] = ['claude', 'codex']

const shortHash = (text: string, n: number): string => createHash('sha256').update(text).digest('hex').slice(0, n)

/** A registry id from a kind and a name: the name itself when it is short and plain, else a readable part and a hash
 *  of the whole name, so `a.b` and `a_b`, or two long names that start alike, never share one (final review M1). */
export const entryId = (kind: ExtensionKind, name: string): string => {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '_')
  return safe === name && safe.length <= 40 ? `${kind}-${safe}` : `${kind}-${safe.slice(0, 32)}-${shortHash(name, 8)}`
}

/** The secret store's name for one environment value: readable when it fits the store's 80 characters, hashed when not. */
const SECRET_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$/
const secretRef = (id: string, env: string): string => {
  const plain = `mcp.${id}.${env}`
  return SECRET_NAME.test(plain) ? plain : `mcp.${shortHash(`${id}\0${env}`, 32)}`
}

async function serverDefinition(account: Account, homeDir: string, name: string): Promise<Obj | null> {
  if (providerOf(account) === 'claude') {
    const v: unknown = JSON.parse(await fs.readFile(claudeMcpFile(account, homeDir), 'utf8'))
    const def = isObj(v) && isObj(v.mcpServers) ? v.mcpServers[name] : undefined
    return isObj(def) ? def : null
  }
  const servers = readTomlObject(await fs.readFile(path.join(account.configDir, 'config.toml'), 'utf8')).mcp_servers
  const def = isObj(servers) ? servers[name] : undefined
  return isObj(def) ? def : null
}

async function copyTree(from: string, to: string): Promise<void> {
  await fs.rm(to, { recursive: true, force: true })
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.cp(from, to, { recursive: true })
}

export async function importItems(a: { profileDir: string; homeDir: string; account: Account; picks: ImportPick[] }): Promise<ImportResult> {
  const registry = await readExtensionRegistry(a.profileDir)
  const found = await discoverIn({ account: a.account, homeDir: a.homeDir, registry })
  const paths = extensionPaths(a.profileDir)
  const secrets = extensionSecrets(a.profileDir)
  const result: ImportResult = { imported: [], refused: [] }
  const entries = [...registry.entries]
  // When these were shared: the usage findings age an item from it, never from before it was here (lifecycle design §4.5)
  const addedAt = new Date().toISOString()

  for (const pick of a.picks) {
    const d = found.find((x) => x.kind === pick.kind && x.name === pick.name)
    if (!d) continue
    if (!d.shareable) {
      result.refused.push({ name: pick.name, reason: d.reason })
      continue
    }
    const id = entryId(pick.kind, pick.name)
    if (pick.kind === 'mcp' && d.mcp) {
      const def = await serverDefinition(a.account, a.homeDir, pick.name)
      if (!def) continue
      const values = isObj(def.env) ? def.env : {}
      const passed = Array.isArray(def.env_vars) ? def.env_vars.filter((x): x is string => typeof x === 'string') : []
      const secretNames = new Set(pick.secretNames ?? d.mcp.envNames.filter(looksSecret))
      const env: Record<string, McpEnvValue> = {}
      const toStore: [string, string][] = []
      let refused: NotShareableReason | null = null
      for (const n of d.mcp.envNames) {
        const raw = values[n]
        // `${NAME}` passes the variable of that name through; a reference to another name cannot be delivered under
        // this one (final review M4)
        const selfReference = typeof raw === 'string' && raw === `\${${n}}`
        if (typeof raw === 'string' && raw.includes('${') && !selfReference) {
          refused = refused ?? 'env-reference'
          continue
        }
        if (selfReference || (passed.includes(n) && raw === undefined)) {
          env[n] = { inherit: true }
          continue
        }
        const value = String(raw ?? '')
        if (secretNames.has(n)) {
          const ref = secretRef(id, n)
          env[n] = { secret: ref }
          toStore.push([ref, value])
        } else env[n] = { value }
      }
      if (refused) {
        result.refused.push({ name: pick.name, reason: refused })
        continue
      }
      for (const [ref, value] of toStore) await secrets.put(ref, value)
      const { envNames: _names, ...server } = d.mcp
      const isolation = knownSessionIsolated(d.mcp) ? { isolation: 'session' as const } : {}
      entries.push({ id, kind: 'mcp', name: pick.name, ...server, env, ...isolation, providers: BOTH, importedFrom: a.account.id, enabled: true, addedAt })
    } else {
      const canonical =
        pick.kind === 'skill' ? path.join(paths.skills, pick.name) : path.join(pick.kind === 'command' ? paths.commands : paths.agents, `${pick.name}.md`)
      await copyTree(d.source, canonical)
      const hash = pick.kind === 'skill' ? await hashTree(canonical) : await hashFile(canonical)
      const providers: Provider[] = pick.kind === 'skill' ? BOTH : ['claude']
      entries.push({ id, kind: pick.kind as 'skill' | 'command' | 'agent', name: pick.name, hash, providers, importedFrom: a.account.id, enabled: true, addedAt })
    }
    result.imported.push(pick.name)
  }
  if (result.imported.length > 0) await writeExtensionRegistry(a.profileDir, { version: 1, entries })
  return result
}

/** Removes an entry, its secrets and its canonical copy. */
export async function removeEntry(profileDir: string, id: string): Promise<void> {
  const registry = await readExtensionRegistry(profileDir)
  const e = registry.entries.find((x) => x.id === id)
  if (!e) return
  const paths = extensionPaths(profileDir)
  if (e.kind === 'mcp') {
    const secrets = extensionSecrets(profileDir)
    for (const v of Object.values(e.env)) if ('secret' in v) await secrets.remove(v.secret)
  } else {
    const canonical = e.kind === 'skill' ? path.join(paths.skills, e.name) : path.join(e.kind === 'command' ? paths.commands : paths.agents, `${e.name}.md`)
    await fs.rm(canonical, { recursive: true, force: true })
  }
  await writeExtensionRegistry(profileDir, { version: 1, entries: registry.entries.filter((x) => x.id !== id) })
}

export async function setEnabled(profileDir: string, id: string, enabled: boolean): Promise<void> {
  const registry = await readExtensionRegistry(profileDir)
  await writeExtensionRegistry(profileDir, { version: 1, entries: registry.entries.map((x) => (x.id === id ? { ...x, enabled } : x)) })
}

/** How the Gateway shares a server's process (Gateway design G8); sessions started after the change follow it. */
export async function setIsolation(profileDir: string, id: string, isolation: 'folder' | 'session'): Promise<void> {
  const registry = await readExtensionRegistry(profileDir)
  await writeExtensionRegistry(profileDir, {
    version: 1,
    entries: registry.entries.map((x) => (x.id === id && x.kind === 'mcp' ? { ...x, isolation } : x))
  })
}
