// What the app and the Host say to each other (Astera Host slice 1 design §6). Shared so both sides
// compile against one definition rather than two that drift.
//
// Newline-delimited JSON, one object per line. Terminal data is not here yet — slice 2 adds it, and
// JSON string escaping is what will carry it, the same way the app already ships PTY output to the
// renderer.

/** Bumped whenever a message changes shape. A Host and an app that disagree do not talk (design §6). */
export const HOST_PROTOCOL = 1

export type ClientMessage =
  | { t: 'hello'; protocol: number; app: string }
  /** Leave. Sent when the app finds a Host on another protocol; in slice 1 the Host holds nothing,
   *  so leaving costs nothing. This message's meaning is revisited in slice 2. */
  | { t: 'retire' }

export type HostMessage =
  | { t: 'hello'; protocol: number; host: string; pid: number; startedAt: string }
  | { t: 'protocol-mismatch'; protocol: number }
