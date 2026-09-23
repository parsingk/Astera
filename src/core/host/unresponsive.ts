// How long a Host that has completed the handshake may go silent — no reply to anything it is asked,
// including its own heartbeat — before it is treated as unresponsive rather than merely slow this one
// time (docs/2026-09-22-host-unresponsive-recovery-design.md: a node-pty call can wedge the Host's
// single event loop synchronously, and from that moment it cannot run the code that would answer
// anything at all, including a `retire`).
//
// One constant, not two independently chosen numbers that could drift apart: `main/host/client.ts`'s
// heartbeat derives its `PING_MISSES` from this divided by `PING_MS`, and `cli/host.ts`'s `host stop`
// times its wait for a `retire` reply by this directly. Both are asking the same question — has this
// Host's event loop stopped turning — from the two different processes that ever have to ask it.
export const HOST_UNRESPONSIVE_MS = 15_000

/**
 * How often that question is actually asked of a Host that answers pings.
 *
 * **It lives beside the threshold for the reason the threshold lives here at all.** It used to sit in
 * `main/host/client.ts`, which is main-only, so a second process that wanted to ask the same question
 * could not read it: `core/orchestration/cliKeepalive.ts` had to write `HOST_UNRESPONSIVE_MS / 3`
 * instead, and that `3` was a copy of `PING_MISSES`'s arithmetic that nothing kept honest. Move this
 * number and `PING_MISSES` follows it; leave it there and the CLI would have gone on pinging every
 * 5s while the app had moved on.
 *
 * The pair is the contract: ask this often, and call it unresponsive after `HOST_UNRESPONSIVE_MS` of
 * silence — which is three unanswered pings.
 */
export const PING_MS = 5_000
