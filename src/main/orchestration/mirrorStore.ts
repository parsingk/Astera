// A store-shaped object backed by the Host, so main's thirty-odd getState/setState call sites do not
// change (host control plane design §5, §6).
//
// **Why this shape rather than making every caller async-aware.** `deps.getState()` is synchronous in
// thirty-odd places and several of them read it twice around an await on purpose (the run-create
// comment in the command layer explains why). Turning it async would rewrite that reasoning at every
// site. The mirror keeps it synchronous by holding the last state the Host pushed.
import { isValidState } from '../../core/orchestration/store'
import type { OrchState } from '../../core/orchestration/state'

/** A write the Host refused because the state had moved on under it (ruling F56). Named so the
 *  callers that can say something useful about it can tell it from a disk failure — this one means
 *  "your action did not happen and the screen you decided from was stale", which is a sentence for a
 *  person, not for a log. */
export class OrchStateConflict extends Error {
  constructor(
    readonly hostVersion: number | undefined,
    readonly sentVersion: number | undefined
  ) {
    super(
      `the orchestration state moved on before this write landed (Host at ${String(hostVersion)}, write built on ${String(sentVersion)})`
    )
    this.name = 'OrchStateConflict'
  }
}

export interface MirrorStore {
  getState(): OrchState
  setState(next: OrchState): Promise<void>
  /** Called on every `orch-state` push, and once with the state the Host answers `state-get` with.
   *  `version` is that commit's number — see `OrchStateConflict`. A push from a Host too old to send
   *  one leaves it undefined, which turns the check off rather than failing every write. */
  accept(s: OrchState, version?: number): void
  loaded(): boolean
}

export function createMirrorStore(a: {
  call(m: {
    cmd: string
    args: Record<string, unknown>
    sessionId: string
  }): Promise<{ status: number; body: unknown }>
}): MirrorStore {
  let state: OrchState | null = null
  /** The Host commit this mirror is holding — **or the one it will be holding once the writes already
   *  in flight have landed.**
   *
   *  Quoted on every write so a write built on a state the Host has since replaced is refused rather
   *  than landing on top of it. The "will be" half is what keeps that from refusing writes that are
   *  perfectly correct: `state` moves synchronously at the top of `setState`, so a second flow that
   *  reads the mirror during the first's await is reading the first's state and is right to be built
   *  on it — but the reply carrying the first's new version has not come back yet, so quoting the
   *  last *acknowledged* number would have the Host refuse a write that was never stale.
   *  `store.ts`'s own `save` comment records that overlapping flows happen; this is the same window.
   *
   *  So the count moves with the state, in the same synchronous step, and a reply only ever confirms
   *  what was already assumed. Anything the Host did in between still lands as a mismatch, which is
   *  the case this check exists for: that number came from somewhere this app did not predict. */
  let version: number | undefined
  return {
    getState: () => {
      // **Throws rather than answering an empty state.** Every caller here reads the state to decide
      // something — is this Dispatch open, does this Run exist — and an empty answer is a confident
      // "no" to all of them. The one that follows a read with a write would then commit that "no"
      // over the real state.
      if (!state) throw new Error('orchestration state is not loaded — the Host has not pushed it yet')
      return state
    },
    setState: async (next) => {
      // **빈 상태를 진짜 상태 위에 덮지 않는다.** 아직 아무것도 못 받았다는 것은 Host 와의 대화가
      // 시작되지 않았다는 뜻이고, 그때의 쓰기는 무엇을 덮는지 모르는 쓰기다.
      if (!state) throw new Error('orchestration state is not loaded — refusing to write')
      // **Memory moves now, not when the Host answers — exactly as `OrchestrationStore.save` did.**
      // That assignment order is the whole of what stops two overlapping flows from losing a commit,
      // and its reasoning is written down where it came from (store.ts's `save`): one flow yields
      // inside `await deps.setState`, the other reads the state in that window, builds its own next
      // state from what it read, and commits it — erasing the first. Waiting for the reply here would
      // widen that window from a synchronous assignment to a whole socket round trip, in the one
      // release where the state stops being local. What the caller's `await` is for is unchanged: it
      // still means "this is on disk", and a refusal still reaches it as a throw.
      const previous = state
      const sent = version
      const previousVersion = version
      state = next
      // Moved with the state, not when the reply lands — see `version`. Undefined stays undefined: a
      // Host too old to issue versions is one this check is off for, and inventing a number here
      // would start refusing every write against it.
      if (typeof version === 'number') version = version + 1
      const r = await a.call({ cmd: 'state-put', args: { state: next, version: sent }, sessionId: '' })
      if (r.status === 409) {
        // **The Host had moved on, so this write never landed and the mirror was wrong before it was
        // even built** (ruling F56). The refusal carries the state the Host actually holds, so the
        // mirror is put onto that rather than back onto `previous` — `previous` is the stale thing
        // that caused this. Going back to it would leave main reading a state the file does not have
        // until the next commit happened to correct it.
        const body = r.body as { state?: unknown; version?: number } | null
        if (body && isValidState(body.state)) {
          state = body.state
          version = body.version
        } else if (state === next) {
          state = previous
          version = previousVersion
        }
        throw new OrchStateConflict(body?.version, sent)
      }
      if (r.status < 200 || r.status >= 300) {
        // **A refused write is put back; a write that timed out is not.** The difference is what the
        // two say about the file. A non-2xx reply is the Host having decided not to write — its own
        // memory did not move either — so leaving the mirror ahead would have every later read in
        // main report a commit that does not exist, and nothing would correct it: a 500 from a
        // failed disk write does not drop the socket, and only a handshake re-mirrors. A call that
        // never came back says nothing at all about the file; the Host may have landed the write and
        // lost the reply, and putting the mirror back there would be a guess that erases it.
        //
        // Unless something has moved on in the meantime — a later write, or a push from the Host.
        // Then that is the newer truth and this reply has nothing to say about it.
        if (state === next) {
          state = previous
          version = previousVersion
        }
        throw new Error(`the Host refused a state write: ${r.status}`)
      }
      // The version this write really became — ordinarily the number already assumed above, and this
      // is where that assumption is confirmed rather than guessed at twice. **Only when nothing has
      // moved on since**: a push that landed while this call was in flight is newer than the reply,
      // and taking the reply's number would have the next write quote a version older than the state
      // it is built from.
      const ok = r.body as { version?: number } | null
      if (state === next && typeof ok?.version === 'number') version = ok.version
    },
    accept: (s, v) => {
      state = s
      version = v
    },
    loaded: () => state !== null
  }
}
