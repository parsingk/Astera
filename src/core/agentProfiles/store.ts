// Reading and writing the Agent Profile store (design §4). The Host writes it; the app and the CLI read it. Same shape
// as the extension registry: a file that is there but cannot be read or parsed is kept aside and reported, never taken
// for "no profiles", since the next write would erase them.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { profilePaths } from '../profile/paths'
import { keepDamaged, readStoreFile } from '../storeFile'
import { writeThroughTmp } from '../accounts/fileQueue'
import { RepairNeeded } from '../settings/repairNeeded'
import { providerOf } from '../providers/meta'
import type { Account } from '../types'
import type { AgentProfile, AgentProfileStore, ProfilePermission } from './types'

const FILE = 'agent-profiles.json'
const NAME_MAX = 60

const empty = (): AgentProfileStore => ({ version: 1, profiles: [] })

/** The hash of the damaged text this process last kept aside, by file. The store is read on every profiled spawn (up to
 *  three times), every use stamp and every dialog open, and each read of the same damage kept another stamped copy: one
 *  per distinct damage is enough, and the read still refuses every time. */
const keptDamage = new Map<string, string>()

/** The profile's store; empty when there is none. Throws RepairNeeded when the file is damaged or unreadable. */
export async function readAgentProfiles(profileDir: string): Promise<AgentProfileStore> {
  const file = profilePaths(profileDir).agentProfiles
  const read = await readStoreFile(file)
  if (read.kind === 'missing') return empty()
  if (read.kind === 'unreadable') throw new RepairNeeded(`${FILE} could not be read (${String(read.error)})`, FILE)
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    parsed = null
  }
  const s = parsed as AgentProfileStore | null
  if (!s || s.version !== 1 || !Array.isArray(s.profiles)) {
    const hash = createHash('sha256').update(read.text).digest('hex')
    if (keptDamage.get(file) !== hash) {
      // Remembered before the copy is awaited, so reads racing this one (a spawn reads it up to three times) skip it
      keptDamage.set(file, hash)
      await keepDamaged(file, read.text)
    }
    throw new RepairNeeded(`${FILE} is damaged; a copy was kept beside it`, FILE)
  }
  // A profile written before the sandbox switch has none, and reads as off; so does any value but `true`, since only the
  // person's own switch turns it on (sandbox design §6)
  return { ...s, profiles: s.profiles.map((p) => ({ ...p, sandbox: p.sandbox === true })) }
}

/** Writes the store atomically. */
export async function writeAgentProfiles(profileDir: string, s: AgentProfileStore): Promise<void> {
  const file = profilePaths(profileDir).agentProfiles
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeThroughTmp(file, JSON.stringify(s, null, 2) + '\n')
}

export const newProfileId = (): string => `ap_${randomBytes(6).toString('hex')}`

export type ProfileRejection = 'name-empty' | 'name-too-long' | 'name-taken' | 'no-account' | 'unknown-account' | 'mixed-provider'

export interface ProfileInput {
  id?: string
  name: string
  description?: string
  status?: AgentProfile['status']
  accountIds: string[]
  mcpExclude?: string[]
  permission?: ProfilePermission
  sandbox?: boolean
  createdAt?: string
  updatedAt?: string
  lastUsedAt?: string
}

/** Checks a profile against the accounts and the other profiles, and returns it whole (trimmed name, defaults filled).
 *  `others` are the profiles it must not share a name with: pass the store without the one being updated. */
export function validateProfile(
  input: ProfileInput,
  accounts: Account[],
  others: AgentProfile[]
): { ok: true; profile: AgentProfile } | { ok: false; reason: ProfileRejection } {
  const name = input.name.trim()
  if (name.length < 1) return { ok: false, reason: 'name-empty' }
  if (name.length > NAME_MAX) return { ok: false, reason: 'name-too-long' }
  const lower = name.toLowerCase()
  if (others.some((o) => o.name.toLowerCase() === lower)) return { ok: false, reason: 'name-taken' }
  if (input.accountIds.length === 0) return { ok: false, reason: 'no-account' }
  const found = input.accountIds.map((id) => accounts.find((a) => a.id === id))
  if (found.some((a) => !a)) return { ok: false, reason: 'unknown-account' }
  if (new Set(found.map((a) => providerOf(a!))).size > 1) return { ok: false, reason: 'mixed-provider' }
  const now = new Date().toISOString()
  const { lastUsedAt, description } = input
  return {
    ok: true,
    profile: {
      id: input.id ?? newProfileId(),
      name,
      ...(description !== undefined ? { description } : {}),
      status: input.status ?? 'active',
      accountIds: [...input.accountIds],
      mcpExclude: [...(input.mcpExclude ?? [])],
      permission: input.permission ?? 'inherit',
      sandbox: input.sandbox ?? false,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      ...(lastUsedAt !== undefined ? { lastUsedAt } : {})
    }
  }
}

/** The profile's accounts that still exist, in order: a removed account is dropped when read (design §4). */
export function liveAccounts(p: AgentProfile, accounts: Pick<Account, 'id'>[]): string[] {
  const ids = new Set(accounts.map((a) => a.id))
  return p.accountIds.filter((id) => ids.has(id))
}

/** By id exactly, else by name in any case. */
export function findProfile(s: AgentProfileStore, idOrName: string): AgentProfile | null {
  const byId = s.profiles.find((p) => p.id === idOrName)
  if (byId) return byId
  const lower = idOrName.trim().toLowerCase()
  return s.profiles.find((p) => p.name.toLowerCase() === lower) ?? null
}
