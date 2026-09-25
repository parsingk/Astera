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
  /** Fix round 1, M1: the old session id whose tab the adopter re-points (hostRollView.repointed) rather
   *  than announcing this one. A Host-marked note names the session this proc replaced (`rolledFrom`);
   *  when the app holds that session and no push is adopting this one, the sweep's proc list beat the
   *  `session-rolled` push, or no push is coming (the app was disconnected through the roll). Null
   *  otherwise. */
  repoint: string | null
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
  /** Whether the app already had a record of this session before this adoption (a reconnect taking it
   *  back again): its tab was re-pointed or created back then. */
  appHeldNew?: boolean
}): ChatAdoptPlan {
  const defer = hostStartingDefers(a.restore, a.hostSpeaksChatTakeover)
  const rolling = a.hostSpeaksChatTakeover && a.restore.rolledBy === 'host' ? 'host' : 'decide'
  const noted = a.restore.rolledBy === 'host' && typeof a.restore.rolledFrom === 'string' ? a.restore.rolledFrom : null
  const repoint =
    noted !== null && !a.adopting && a.rolledFrom === null && a.appHeldNew !== true && a.appHoldsOld(noted) ? noted : null
  const announce = repoint === null && (a.rolledFrom === null || !a.appHoldsOld(a.rolledFrom))
  return { defer, announce, rolling, repoint }
}
