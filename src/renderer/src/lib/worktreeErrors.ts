import type { Message, MessageKey } from '../../../core/i18n'

/** Turns a worktree IPC error (code: detail) into an untranslated Message. Coming through IPC it gets an
 *  Electron prefix in front, so the check is done with includes. The caller does the translation with
 *  useI18n().t. */
const MESSAGES: Array<[string, MessageKey]> = [
  ['NOT_GIT_REPO', 'worktree.error.notGitRepo'],
  ['NO_BASE', 'worktree.error.noBase'],
  ['FETCH_FAILED', 'worktree.error.fetchFailed'],
  ['NAME_EXHAUSTED', 'worktree.error.nameExhausted'],
  ['INVALID_NAME', 'worktree.error.invalidName'],
  ['NOT_MANAGED', 'worktree.error.notManaged'],
  ['DANGEROUS_PATH', 'worktree.error.dangerousPath'],
  // Fallback for a general failure that was not routed to the force-removal reconfirmation — the count is read by the reconfirm modal through dirtyCount(), not by this function
  ['DIRTY', 'worktree.error.dirty'],
  ['ORPHAN_UNPROVEN', 'worktree.error.orphanUnproven'],
  // ORPHAN_UNVERIFIABLE is routed to the force-removal reconfirmation, so it is detected by isOrphanUnverifiable() alongside dirtyCount
  ['ORPHAN_UNVERIFIABLE', 'worktree.error.orphanUnverifiable'],
  ['GIT_ADD_FAILED', 'worktree.error.gitAddFailed'],
  ['GIT_REMOVE_FAILED', 'worktree.error.gitRemoveFailed'],
  // Not a worktree code but a session rolling constraint (sessions/manager.ts) — App.tsx's spawn catch
  // handles it through this function, so it is mapped here. It gets its own slot at the end of the array
  // so it is not confused with the worktree codes
  ['ROLL_MIXED_PROVIDER', 'session.roll.mixedProvider']
]

// For IN_USE, main passes the reason as a tag plus a value. A session title is a user message and can
// contain ':' and newlines, so split(':') is not used and the entire remainder is taken as the value.
// remove.ts assembles it as `IN_USE: ${inUse}`, which puts one space after the colon (before the tag, not
// before the value), so \s* absorbs that space — it matches without it too (a direct 'IN_USE:SESSION:x').
const IN_USE = /IN_USE:\s*(SESSION|RUN):([\s\S]+)$/

export function worktreeErrorMessage(raw: string): Message {
  const inUse = IN_USE.exec(raw)
  if (inUse) {
    const value = inUse[2].trim()
    if (value !== '')
      return inUse[1] === 'SESSION'
        ? { key: 'worktree.inUse.session', params: { title: value } }
        : { key: 'worktree.inUse.run', params: { name: value } }
  }
  for (const [code, key] of MESSAGES) if (raw.includes(code)) return { key }
  if (raw.includes('IN_USE')) return { key: 'worktree.inUse.unknown' }
  return { key: 'worktree.error.raw', params: { detail: raw } }
}

/** Extracts the number of changed files from a DIRTY error (null when there is none) */
export function dirtyCount(raw: string): number | null {
  const m = /DIRTY:\s*(\d+)/.exec(raw)
  return m ? Number(m[1]) : null
}

/** The case where the folder is orphaned so whether it has changes cannot be checked — routed to the
 *  force-removal reconfirmation alongside DIRTY. It must not be confused with ORPHAN_UNPROVEN (which has
 *  no force escape hatch), so the suffix boundary is checked. */
export function isOrphanUnverifiable(raw: string): boolean {
  return raw.includes('ORPHAN_UNVERIFIABLE')
}
