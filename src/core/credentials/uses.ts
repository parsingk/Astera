// Credential-use records (credentials design §6): their own day files beside the tool calls, written by the Host alone,
// kept as long and as large as the tool calls are (the audit store's own machinery, audit/store.ts).
import { randomBytes } from 'node:crypto'
import { profilePaths } from '../profile/paths'
import { appendDated, queryDatedIn, visitDaysIn, type AuditStoreOptions } from '../audit/store'
import type { CredentialUse } from '../audit/types'

export const newUseId = (): string => `cu_${randomBytes(8).toString('hex')}`

const STRINGS = ['id', 'at', 'actor', 'provider', 'action', 'resource', 'outcome', 'evidence', 'requestId'] as const
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A line the Host wrote, with its time parsed once; null for anything else. */
function useOf(line: string): { r: CredentialUse; at: number } | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(v) || !STRINGS.every((k) => typeof v[k] === 'string')) return null
  const at = Date.parse(v.at as string)
  return Number.isFinite(at) ? { r: v as unknown as CredentialUse, at } : null
}

/** Appends the uses to their days' files. Never throws. */
export function appendCredentialUses(profileDir: string, uses: readonly CredentialUse[], o: AuditStoreOptions = {}): Promise<void> {
  return appendDated(profilePaths(profileDir).credentialUses, uses, o, 'credential uses').then(() => {})
}

export interface CredentialUseFilter {
  entryId?: string
  provider?: CredentialUse['provider']
  sessionId?: string
  since?: string
  until?: string
  beforeId?: string
  limit?: number
}

/** The uses that pass the filter, newest first (then by id), at most `limit`. */
export function queryCredentialUses(
  profileDir: string,
  f: CredentialUseFilter,
  o: Pick<AuditStoreOptions, 'now' | 'keepDays'> = {}
): Promise<CredentialUse[]> {
  const test = (u: CredentialUse): boolean =>
    (f.entryId === undefined || u.entryId === f.entryId) &&
    (f.provider === undefined || u.provider === f.provider) &&
    (f.sessionId === undefined || u.sessionId === f.sessionId)
  return queryDatedIn(profilePaths(profileDir).credentialUses, useOf, test, f, o)
}

/** Each entry's latest use from `sinceMs` on (ISO), by entry id, read in one pass over every day of the period that keeps
 *  only the latest time of each (lifecycle design §4.9): never a list of uses, and no limit that could stop short. A use
 *  with no entry is not counted. `nowMs` is the read's clock, for the days kept. */
export async function latestUsesSince(profileDir: string, sinceMs: number, nowMs: number): Promise<Map<string, string>> {
  const latest = new Map<string, { at: string; ms: number }>()
  await visitDaysIn(
    profilePaths(profileDir).credentialUses,
    useOf,
    (u) => typeof u.entryId === 'string',
    { since: new Date(sinceMs).toISOString() },
    (u, at) => {
      const id = u.entryId as string
      const held = latest.get(id)
      if (held === undefined || at > held.ms) latest.set(id, { at: u.at, ms: at })
    },
    () => false,
    { now: () => nowMs }
  )
  return new Map([...latest].map(([id, l]) => [id, l.at]))
}

/** The newest use of each of these entries, in one newest-first pass that stops once each has one (final review M10): the
 *  list asks it for every shared server at every read, and an entry never used would otherwise read every kept day. */
export async function lastUses(profileDir: string, entryIds: readonly string[], o: Pick<AuditStoreOptions, 'now' | 'keepDays'> = {}): Promise<Map<string, string>> {
  const want = new Set(entryIds)
  const found = new Map<string, string>()
  if (want.size === 0) return found
  await visitDaysIn(
    profilePaths(profileDir).credentialUses,
    useOf,
    (u) => u.entryId !== undefined && want.has(u.entryId) && !found.has(u.entryId),
    {},
    (u) => {
      found.set(u.entryId as string, u.at)
      return found.size < want.size
    },
    () => found.size >= want.size,
    o
  )
  return found
}
