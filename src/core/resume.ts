import type { Account } from './types'
import { providerOf } from './providers/meta'

/**
 * Computes the candidate accounts for the history resume modal (pure function).
 * Keeps only logged-in accounts and puts the original (owning) account first — the rest keep their
 * original order. The original account is excluded if it is not logged in: the transcript file is on
 * disk, so the conversation can also be continued on another logged-in account (copy the transcript
 * into that account's configDir, then --resume), and being logged in only decides whether
 * authentication is possible.
 *
 * Only accounts on the same provider as the original are candidates — the session file format
 * differs per CLI, so cross-provider resume is impossible (codex cannot read a claude transcript,
 * and vice versa). If the original account is gone from the list, its provider is unknown, so claude
 * is assumed (preserving the existing behaviour).
 */
export function resumeAccountOptions(
  accounts: Account[],
  loggedInIds: Set<string>,
  ownerId: string
): Account[] {
  const owner0 = accounts.find((a) => a.id === ownerId)
  const ownerProvider = owner0 ? providerOf(owner0) : 'claude'
  const candidates = accounts.filter((a) => providerOf(a) === ownerProvider && loggedInIds.has(a.id))
  const owner = candidates.find((a) => a.id === ownerId)
  const others = candidates.filter((a) => a.id !== ownerId)
  return owner ? [owner, ...others] : others
}

/**
 * Computes the roll account order to restore on a history resume (pure function).
 * Removes accounts that no longer exist from the saved order and cyclically reorders it so the
 * resume target account comes first (because --resume has to run on the account that holds the
 * newest transcript). If no account is left, an empty array (nothing is restored).
 *
 * This moved here from rolling/config.ts — that file imports node:fs, so the renderer cannot import
 * it as a value, and the main-side use (the automatic restore in ipc.ts) is gone.
 */
export function restoreRollAccountIds(
  saved: string[],
  resumeAccountId: string,
  existingIds: string[]
): string[] {
  const exist = new Set(existingIds)
  const filtered = saved.filter((id) => exist.has(id))
  if (filtered.length === 0) return []
  const i = filtered.indexOf(resumeAccountId)
  if (i === -1) return [resumeAccountId, ...filtered] // a target account absent from the saved list goes first
  return [...filtered.slice(i), ...filtered.slice(0, i)] // cyclic reorder
}

/**
 * Computes the roll chain the resume modal passes to spawn (pure function).
 * It narrows the candidates to the same provider as the selected account before handing them to
 * restoreRollAccountIds — the manager rejects a mixed chain with ROLL_MIXED_PROVIDER
 * (core/sessions/manager.ts), so without filtering here the spawn itself fails whenever the saved
 * value has another provider mixed in.
 * If there is no saved value, or all of it is gone, [the selected account] — with the rolling
 * checkbox on, at least a single automatic resume is guaranteed (passing an empty array silently
 * registers no rolling at all).
 */
export function resumeRollAccountIds(
  savedIds: string[] | null,
  accounts: Account[],
  selectedId: string
): string[] {
  if (!savedIds || savedIds.length === 0) return [selectedId]
  const selected = accounts.find((a) => a.id === selectedId)
  const provider = selected ? providerOf(selected) : 'claude'
  const sameProvider = accounts.filter((a) => providerOf(a) === provider).map((a) => a.id)
  const chain = restoreRollAccountIds(savedIds, selectedId, sameProvider)
  return chain.length > 0 ? chain : [selectedId]
}
