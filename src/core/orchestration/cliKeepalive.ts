// The line a waiting command prints on stderr while it is still waiting.
//
// **Why anything is printed at all.** `ask`, `check --wait`, `jobs wait` and `runs wait` block for
// human-minutes — that is the point of them, because the thing being waited for is a person. Until
// now they printed nothing for that whole time, which makes a wait that is working look exactly like
// the one failure this repo has already been bitten by: a Host that accepted the socket and then went
// quiet (docs/2026-09-22-host-unresponsive-recovery-design.md). Whoever is watching cannot tell the
// two apart, and neither can a CI log.
//
// **Only stderr, and never stdout.** stdout carries exactly one result and its envelope is the
// contract a script reads (cliOutput.ts). Because of that, a caller needs no filter to strip these
// lines: `astera runs wait --id r | jq .data` is unaffected by them. They are diagnostics, they have
// no contract, and their shape may change — the same footing as `logToStderr` (src/cli/host.ts),
// whose `astera: ` prefix they share.
//
// **The line is pure here and the timer is in run.ts**, the same split as cliHuman.ts: what to print
// is decided without a clock, a socket or a process.
import { HOST_UNRESPONSIVE_MS, PING_MS } from '../host/unresponsive'
import { spelledCommand } from './cliUsage'

/**
 * How often a waiting command says it is still waiting.
 *
 * **This is not a new number, and it must not become one.** `HOST_UNRESPONSIVE_MS` is this repo's
 * single answer to "how long may a Host that has said hello go silent before it is not merely slow"
 * — the app's heartbeat derives its miss count from it, and `astera host stop` times its wait for a
 * `retire` reply by it (core/host/unresponsive.ts). A keepalive exists to tell a live wait from a
 * wedged Host, which is the same question those two ask, so it asks it on the same clock. Two
 * independently chosen intervals would let the CLI and the app disagree about the same Host.
 *
 * The volume this implies was checked rather than assumed: the longest deadline in the program is
 * `jobs wait`'s one hour, which is 240 lines of stderr — a log a person scrolls, not a stream.
 * Doubling the interval would halve that and double how long a wedged Host goes unreported, and the
 * volume was never the problem.
 */
export const KEEPALIVE_MS = HOST_UNRESPONSIVE_MS

/**
 * How often the Host is asked whether its event loop is still turning while a wait is on.
 *
 * **It has to be shorter than the line, or the line cannot say anything true.** Asked once per line,
 * every healthy Host would report a last answer exactly one interval old — the same number an
 * unresponsive one reports — and the field would carry no information at all.
 *
 * **It is the app's own `PING_MS`, not a divisor written a second time.** This used to say
 * `HOST_UNRESPONSIVE_MS / 3`, which is the arithmetic `PING_MISSES` does in `main/host/client.ts`
 * (`HOST_UNRESPONSIVE_MS / PING_MS`) with the answer hardcoded — so a change to `PING_MS` would have
 * moved the app's heartbeat and left this one where it was, silently. The constant moved to
 * core/host/unresponsive.ts instead, beside the threshold it is paired with, and both processes now
 * ask the same Host at the same rate by construction.
 */
export const KEEPALIVE_PING_MS = PING_MS

/**
 * Is this call one that blocks for a person?
 *
 * The four that long-poll, and no others. `browser js` has a deadline too and is deliberately not
 * here: it waits for a script in a browser, which finishes in seconds and has no person in it, so a
 * keepalive would be noise on a command whose output is not a wait.
 */
export function waitingCommand(a: { cmd: string; args: Record<string, unknown> }): boolean {
  if (a.cmd === 'ask' || a.cmd === 'jobs-wait' || a.cmd === 'runs-wait') return true
  // `check` blocks only when asked to. Without --wait it answers at once, and a keepalive on it
  // would be a line about a wait that never happened.
  return a.cmd === 'check' && a.args.wait === true
}

/** `45s`, `3m 20s`. Seconds alone stop reading as a duration somewhere around a minute, and the
 *  longest wait here is an hour. */
export function elapsedWord(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m ${total % 60}s`
}

/**
 * One keepalive.
 *
 * **It says what the Host is doing, not only what this process is doing.** A timer that only proves
 * the CLI is alive answers the easy half of the question and leaves the half that matters: a CLI
 * happily printing keepalives at a Host whose event loop stopped turning is the exact picture this
 * feature exists to break. So when the Host announced the `ping` feature, each line carries how long
 * ago it last answered one. `silentMs` is `null` for a Host that does not have it, and then the line
 * says only what it can honestly say.
 */
export function keepaliveLine(a: {
  cmd: string
  elapsedMs: number
  /** Time since the Host's last `pong`, or `null` when this Host has no heartbeat to ask. */
  silentMs: number | null
}): string {
  const head = `waiting for ${spelledCommand(a.cmd)}, ${elapsedWord(a.elapsedMs)} so far`
  if (a.silentMs === null) return head
  if (a.silentMs < KEEPALIVE_MS) return `${head}; the Host answered ${elapsedWord(a.silentMs)} ago`
  // Past the threshold the app itself calls a Host unresponsive. The line stops reassuring and says
  // the number, because from here the honest reading is that this may no longer be a wait at all.
  return `${head}; the Host has not answered a ping for ${elapsedWord(a.silentMs)}`
}
