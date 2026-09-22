// A store-shaped object backed by the Host, so main's thirty-odd getState/setState call sites do not
// change (host control plane design §5, §6).
//
// **Why this shape rather than making every caller async-aware.** `deps.getState()` is synchronous in
// thirty-odd places and several of them read it twice around an await on purpose (the run-create
// comment in the command layer explains why). Turning it async would rewrite that reasoning at every
// site. The mirror keeps it synchronous by holding the last state the Host pushed.
import type { OrchState } from '../../core/orchestration/state'

export interface MirrorStore {
  getState(): OrchState
  setState(next: OrchState): Promise<void>
  /** Called on every `orch-state` push, and once with the state the Host answers `state-get` with. */
  accept(s: OrchState): void
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
      state = next
      const r = await a.call({ cmd: 'state-put', args: { state: next }, sessionId: '' })
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
        if (state === next) state = previous
        throw new Error(`the Host refused a state write: ${r.status}`)
      }
    },
    accept: (s) => {
      state = s
    },
    loaded: () => state !== null
  }
}
