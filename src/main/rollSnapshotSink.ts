// Where a rolling chain's snapshot goes (S6 R4, chat takeover spec §3.3): into the note of the process
// the chain's session runs in, for the Host to carry on if this app goes away. A pty chain's snapshot
// goes into its pty note, a chat chain's into its chat proc note. Shared by both coordinators.
//
// The chat write is not gated on the Host's `chat-takeover` feature (plan ruling P9): a note key is
// storage, an older Host merges it and never reads it, and a fallback session has no Host note at all,
// so remember() does nothing there. What is gated is every call that asks the Host to act on it.
import type { RollSnapshot } from '../core/rolling/snapshot'

export function writeRollSnapshotTo(
  id: string,
  snap: RollSnapshot,
  d: {
    isChat(id: string): boolean
    rememberChat(id: string, patch: Record<string, unknown>): void
    rememberPty(id: string, patch: Record<string, unknown>): void
  }
): void {
  if (d.isChat(id)) d.rememberChat(id, { roll: snap })
  else d.rememberPty(id, { roll: snap })
}
