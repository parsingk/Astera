// Stale replies from remote Runtimes (remote runtime design §2.7, X1-11): every request a view sends carries the
// runtime it was for and a token, and a reply is drawn only while that runtime is still the selected one and its token
// is the newest that view sent. A slow reply from runtime A, landing after the person picked runtime B, or after a
// newer request of the same view, is dropped instead of overwriting what the view shows.
export interface ReplyGate {
  /** Called when a view sends a request: the token its reply must bring back. */
  begin(view: string, runtimeId: string): number
  /** Whether a reply may be drawn: it is for the selected runtime and carries the view's newest token. */
  accept(view: string, runtimeId: string, token: number, selected: string): boolean
}

export function createReplyGate(): ReplyGate {
  let next = 0
  const newest = new Map<string, number>()
  return {
    begin: (view) => {
      const token = ++next
      newest.set(view, token)
      return token
    },
    accept: (view, runtimeId, token, selected) => runtimeId === selected && newest.get(view) === token
  }
}
