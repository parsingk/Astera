// The chat adopter's decisions (chat takeover Task 9), pure so they are tested apart from ipc.ts: whether
// the sweep leaves a Host chat proc alone for now, who rolls it, and whether its tab is announced.

export interface ChatAdoptPlan {
  /** P5: the Host is still in the new proc's handshake and carry-on (`hostStarting` in its note). The
   *  sweep neither adopts nor kills it and sends no proc-attach, so the Host stays its writer; the
   *  `session-rolled` push, which comes only after the key is cleared, or the next sweep takes it. */
  defer: boolean
  /** Whether the adopter sends `session:created` (announcesAdopted's rule): not for the new half of a
   *  pushed Host roll whose old session the app holds, since the forwarded `session:rolled` re-points
   *  that tab (Review Focus 1). */
  announce: boolean
  /** `host`: the Host rolls this chain (R8), so the app registers none and drops one it still holds.
   *  `decide`: applyAdoptRolling over the account's coordinator, with `hostRolls` the chat-takeover
   *  feature. */
  rolling: 'host' | 'decide'
}

/** P5's rule on its own, for reattach's `deferProc` (ipc.ts): a note saying `hostStarting: true`, in front
 *  of a Host that takes chats over. An older Host never writes the key, and is never deferred to. */
export function hostStartingDefers(restore: Record<string, unknown>, hostSpeaksChatTakeover: boolean): boolean {
  return hostSpeaksChatTakeover && restore.hostStarting === true
}

export function chatAdoptPlan(a: {
  restore: Record<string, unknown>
  hostSpeaksChatTakeover: boolean
  rollAccounts: number
  adopting: boolean
  appHoldsOld: (sessionId: string) => boolean
  rolledFrom: string | null
}): ChatAdoptPlan {
  const defer = hostStartingDefers(a.restore, a.hostSpeaksChatTakeover)
  const rolling = a.hostSpeaksChatTakeover && a.restore.rolledBy === 'host' ? 'host' : 'decide'
  const announce = a.rolledFrom === null || !a.appHoldsOld(a.rolledFrom)
  return { defer, announce, rolling }
}
