// The shapes a call takes on its way to a Host or a paired Runtime, shared by run.ts and remote.ts (Phase 4 review M6:
// remote.ts used to import them from run.ts, which imports remote.ts). Pure but for `followRun`'s calls.
import { FOLLOW_WINDOW_MS } from '../core/orchestration/command'
import { eventKey, followLine } from '../core/orchestration/cliFollow'
import { okEnvelope } from '../core/orchestration/cliOutput'
import { MERGE_CLIENT_TIMEOUT_MS, mergeCommand } from '../core/orchestration/cliKeepalive'
import { publicEvent } from '../core/orchestration/cliPublic'
import { DEFAULT_ASK_TIMEOUT_MS, DEFAULT_CHECK_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS } from '../core/orchestration/types'
import { SCRIPT_TIMEOUT_MS } from '../core/agentBrowser/script'
import { LAUNCH_WAIT_MAX_MS } from '../core/workspace/script'
import type { JobEvent } from '../core/types'

export type OutputMode = 'json' | 'human' | 'quiet'

/** Headroom stacked on top of the Host's long-poll deadline so the client never gives up before the
 *  Host does. It absorbs the polling interval (POLL_MS) and event-loop delay the Host takes to send
 *  its response once the deadline is reached — with headroom narrower than the Host's deadline,
 *  `callHost`'s own `setTimeout` fires while the Host is still preparing its response, the command
 *  ends as `stuck`, and the contract that a timeout is information rather than an error breaks (this
 *  was the defect where ask's default was shorter than the server's default). */
export const TIMEOUT_HEADROOM_MS = 30_000

/** ask and check --wait are long-polled by the server, so the per-command default deadline has to
 *  come from the same constants the server uses (core/orchestration/types.ts) — split into two
 *  copies, the values drift apart. Other commands do not long-poll, so their default is effectively
 *  unused and they reuse check's value (there is no reason to add another constant). If
 *  --timeout-ms was given, that value is used as is. */
export function clientTimeoutMs(a: { cmd: string; args: Record<string, unknown> }): number {
  const defaultForCmd =
    a.cmd === 'ask'
      ? DEFAULT_ASK_TIMEOUT_MS
      : a.cmd === 'browser-js'
        ? SCRIPT_TIMEOUT_MS
        : // app js 의 60 초 마감은 앱이 뜨기를 기다리는 시간(launch 대기)을 세지 않고, 그 대기는
          // LAUNCH_WAIT_MAX_MS 까지 간다. 그 둘을 합친 것보다 먼저 끊으면 앱은 떴는데 CLI 만 끝난다.
          a.cmd === 'app-js'
          ? SCRIPT_TIMEOUT_MS + LAUNCH_WAIT_MAX_MS
          : // **기다리는 명령은 서버와 같은 마감을 써야 한다.** 짧은 값을 쓰면 서버가 답을
          // 준비하는 사이에 클라이언트가 연결을 끊고, "타임아웃은 정보다" 는 계약이 깨진다
          // (ask 의 기본값이 서버보다 짧아서 실제로 그러였다).
          a.cmd === 'jobs-wait' || a.cmd === 'runs-wait' || (a.cmd === 'sessions-send' && a.args.wait === true)
          ? DEFAULT_WAIT_TIMEOUT_MS
          : // 병합은 git 쓰기 하나가 10분까지 간다 — check 의 5분으로 끊으면 Host 가 병합을 끝내고
            // Run 까지 지우는 사이에 CLI 만 "답이 없다"로 끝난다(MERGE_CLIENT_TIMEOUT_MS).
            mergeCommand(a)
            ? MERGE_CLIENT_TIMEOUT_MS
            : DEFAULT_CHECK_TIMEOUT_MS
  const base = typeof a.args.timeoutMs === 'number' ? a.args.timeoutMs : defaultForCmd
  return base + TIMEOUT_HEADROOM_MS
}

/** One answer from the Host. `replayed` is there when this answer came out of a receipt rather than
 *  out of a run of the command (request receipts design §8) — the same word the Host puts on
 *  `orch-result`, carried to the envelope this program prints. */
export interface HostAnswer {
  status: number
  body: unknown
  replayed?: true
  observed?: true
}

/** How `followRun` ended. `ended` carries the body `runs wait` would have answered with (the Host's
 *  `waitEndingFor`, or a `timeout` built here), so the caller turns it into the same exit code. */
export type FollowEnd =
  | { ended: Record<string, unknown> }
  | { refused: HostAnswer }
  | { unreachable: string }
  | { stuck: string }

/**
 * `astera runs follow` (CLI spec §22): the timeline of a run, printed as it happens, until the run ends.
 *
 * **Why a loop of long polls and not a push.** The Host does push state, but only to the app: its
 * `orch-state` message goes to the attached app's connection, and a CLI client has no subscription to
 * ask for. Adding one would be a new message, a new feature flag and a new failure mode (a subscriber
 * that stops reading) on the Host. A `runs-follow` call is an ordinary `orch-call` instead, answered by
 * the same command layer as `runs wait` with the same `pollUntil`: it comes back as soon as there are
 * more events than this loop has printed, or the run reaches an ending, or its window passes. Every
 * Host that answers orchestration commands can answer it, a lost connection is the ordinary 3, and
 * there is nothing on the Host to clean up when this process goes away.
 *
 * **Each event is printed once**, keyed by `eventKey`, in the order the Host's timeline gives. When
 * there are new events the Host sends the whole timeline, so an event whose time is earlier than one
 * already printed is still printed when it appears. `seen` is how many this loop has printed.
 *
 * **Ctrl+C ends this process only.** Nothing here writes, and the Host's poll ends at its window.
 */
export async function followRun(a: {
  id: unknown
  mode: OutputMode
  /** The whole follow's deadline, `--timeout-ms`. */
  timeoutMs: number
  write: (line: string) => void
  /** One `runs-follow` call, with the client-side deadline for it. */
  call: (
    args: Record<string, unknown>,
    timeoutMs: number
  ) => Promise<HostAnswer | { unreachable: string } | { stuck: string }>
  /** How long one call may hold on the Host. Shorter in tests. */
  windowMs?: number
  now?: () => number
}): Promise<FollowEnd> {
  const now = a.now ?? Date.now
  const windowMs = a.windowMs ?? FOLLOW_WINDOW_MS
  const deadline = now() + a.timeoutMs
  const printed = new Set<string>()
  for (;;) {
    const waitMs = Math.max(0, Math.min(windowMs, deadline - now()))
    const r = await a.call({ id: a.id, seen: printed.size, waitMs }, waitMs + TIMEOUT_HEADROOM_MS)
    if ('unreachable' in r || 'stuck' in r) return r
    if (r.status < 200 || r.status >= 300) return { refused: r }
    const page = (r.body ?? {}) as {
      runId?: unknown
      jobId?: unknown
      progress?: unknown
      events?: JobEvent[]
      ending?: Record<string, unknown> | null
    }
    for (const e of page.events ?? []) {
      const key = eventKey(e)
      if (printed.has(key)) continue
      printed.add(key)
      // One envelope per line in JSON (NDJSON), one sentence per line for a person, and nothing for
      // `--quiet`, whose answer is the exit code.
      if (a.mode === 'json') a.write(okEnvelope('runs-follow', { event: publicEvent(e) }))
      else if (a.mode === 'human') a.write(followLine(e))
    }
    if (page.ending) return { ended: page.ending }
    if (now() >= deadline)
      return { ended: { state: 'timeout', runId: page.runId, jobId: page.jobId, progress: page.progress } }
  }
}

