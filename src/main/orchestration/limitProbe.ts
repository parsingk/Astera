// Decides whether an exited worker Dispatch ended on an account limit and works out when it lifts.
// This is the implementation of the OrchServerDeps.probeLimit hole. The two runtimes get it from
// different places:
//   - codex: the rollout jsonl carries rate_limits.primary/secondary.resets_at as structured values.
//   - claude: the lift time sits inside the limit phrase text (the phrase is pulled out of a transcript
//     entry and parsed).
// Both reuse only pieces of the pure verdict modules (claudeSignal, codexSignal, resetTime,
// codexLocate) — RollingCoordinator, rolling.ts and codexRolling.ts are not used (orchestration
// sessions are not rolling targets — two coordinators managing the same session lifetime differently
// would collide over re-keying the session id).
import { open } from 'node:fs/promises'
import type { Dispatch } from '../../core/orchestration/types'
import { parseClaudeLimitLine, type ClaudeLimitHit } from '../../core/rolling/claudeSignal'
import { limitReached, limitStateFromLines, worstResetAt } from '../../core/rolling/codexSignal'
import { findRollout } from '../../core/rolling/codexLocate'
import { parseResetTime } from '../../core/rolling/resetTime'
import { extractStatusLineSession } from '../../core/usage/statusline'

const TAIL_CAP = 512 * 1024 // the maximum number of bytes to read from the end

/** Reads at most cap bytes from the end of the file and returns the complete lines.
 *  The first line, which the cap boundary may have cut off at the front, is dropped — parsing half a
 *  JSON object is meaningless.
 *  A failure of **the read itself** (a missing file, a permission error and so on) gives `null` — kept
 *  distinct from the case where the file was read but has no complete lines ([]). This is the same
 *  convention as `JsonlTail.read()`: null means missing or errored, [] means no new lines.
 *  The caller has to log the null, otherwise failures disappear without a trace.
 *
 *  Why not read the whole thing: a claude transcript measured up to 37MB. Reading that on the Electron
 *  main thread and running split and JSON.parse over it freezes the UI for seconds (the same reason as in
 *  claudeSignal.ts). The limit entry that ended the session is by definition at the end of the file, so a
 *  bounded read from the end is enough. */
async function tailLines(filePath: string, cap = TAIL_CAP): Promise<string[] | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, 'r')
    const { size } = await handle.stat()
    const start = Math.max(0, size - cap)
    const length = size - start
    if (length <= 0) return [] // an empty file — the read succeeded, this is not a failure
    const buffer = Buffer.alloc(length)
    // bytesRead is honoured — on a short read (rare but possible) the tail of the buffer is left holding
    // uninitialised zero bytes, which breaks JSON.parse on the last line, the very line that may hold the
    // limit entry.
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    // If start === 0 (the file is smaller than cap) the first line is intact, so it is kept. If start > 0
    // it may have been cut at the cap boundary, so it is dropped — miss this branch and a small file's only
    // entry is lost.
    if (start > 0) lines.shift()
    return lines.filter((l) => l.trim() !== '')
  } catch {
    return null // open, stat or read failed — missing, permissions, EBUSY and so on. The caller has to log it.
  } finally {
    try {
      await handle?.close()
    } catch {
      /* a failure cleaning up the fd is ignored */
    }
  }
}

export interface LimitProbeDeps {
  /** The session's raw statusLine payload. The claude transcript path comes only from here */
  statusLinePayload: (sessionId: string) => Promise<unknown | null>
  /** Account id → configDir. Needed to find the codex rollout */
  configDirOf: (accountId: string) => string | null
  log: (msg: string) => void
  now?: () => number
}

/** The claude path: finds the limit entry in the tail of the transcript path obtained from the statusLine
 *  payload, and reads the lift time out of the phrase. */
async function probeClaudeLimit(d: Dispatch, deps: LimitProbeDeps): Promise<number | null> {
  const payload = await deps.statusLinePayload(d.sessionId)
  const { transcriptPath } = extractStatusLineSession(payload)
  // The one weak spot of this path: transcriptPath comes only from statusLine. Being blocked by a limit
  // stops statusLine updating at all, but transcriptPath is captured early in the session and never
  // changes afterwards, so even a frozen (stale) payload yields the correct path — "it is frozen, so it
  // cannot be used" is the misjudgement to avoid here.
  if (!transcriptPath) {
    deps.log(`limit probe (claude): no transcriptPath for session=${d.sessionId}`)
    return null
  }
  const lines = await tailLines(transcriptPath)
  if (lines === null) {
    // The read itself failed (missing, permissions, EBUSY and so on) — different from "no hit". Leave a trace.
    deps.log(`limit probe (claude): failed to read transcript tail dispatch=${d.id} path=${transcriptPath}`)
    return null
  }
  const since = Date.parse(d.startedAt)
  let latest: ClaudeLimitHit | null = null
  for (const line of lines) {
    const hit = parseClaudeLimitLine(line)
    // Hits earlier than d.startedAt are dropped — the file of a reused or resumed session holds old limit
    // errors that have nothing to do with this Dispatch (the same reason as the since comment in
    // claudeSignal.ts).
    if (!hit || hit.at <= since) continue
    if (!latest || hit.at > latest.at) latest = hit
  }
  if (!latest) return null
  // The second argument to parseResetTime is hit.at, not now — it has to be interpreted against the
  // record's own timestamp. Passing now misjudges it as "already past" and adds a whole day, which is a
  // critical bug (measured cases of a record written 7.2 and 9 seconds before its own reset time).
  const parsed = parseResetTime(latest.text, latest.at)
  if (!parsed) {
    // source (main/subagent) is recorded — which verdict rule fired is what calibration needs when the
    // phrase format changes. This information used to be thrown away.
    deps.log(
      `limit probe (claude): reset time not found in hit text (source=${latest.source}) dispatch=${d.id}`
    )
    return null
  }
  return parsed.at
}

/** The codex path: finds this worker's rollout in the account's configDir, assembles the last rate_limits
 *  snapshot from the tail, and decides the limit was hit from the structured signal
 *  (rate_limit_reached_type) alone. */
async function probeCodexLimit(d: Dispatch, deps: LimitProbeDeps): Promise<number | null> {
  const configDir = deps.configDirOf(d.accountId)
  if (!configDir) {
    deps.log(`limit probe (codex): no configDir for account=${d.accountId}`)
    return null
  }
  const found = await findRollout({ configDir, cwd: d.cwd, since: Date.parse(d.startedAt) })
  if (!found) {
    deps.log(`limit probe (codex): no rollout found dispatch=${d.id}`)
    return null
  }
  const lines = await tailLines(found.path)
  if (lines === null) {
    // The read itself failed — different from "no hit".
    deps.log(`limit probe (codex): failed to read rollout tail dispatch=${d.id} path=${found.path}`)
    return null
  }
  const state = limitStateFromLines(lines, deps.now?.() ?? Date.now())
  // textHit is always false — that is the input of the PTY output scanner (CodexLimitScanner), and the
  // probe does not look at the PTY stream. So codex is decided from the structured signal
  // (rate_limit_reached_type) alone — a limit that produces only the phrase without the structured field
  // is missed by this probe. Widening that needs a separate decision.
  if (!limitReached(state, { textHit: false })) return null
  const reset = worstResetAt(state)
  if (reset.at === null) {
    // A deliberate decision: when reachedType is definite (a limit) but neither window is at or above the
    // gate (90%), worstResetAt returns null — and GATE_PCT in codexSignal.ts is not lowered here. The very
    // reason limitReached decides without a gate (a request refused by a limit produces no new
    // token_count, so usage freezes at a low value, per codexSignal.ts's limitReached doc comment) is exactly what creates this
    // combination: a definite limit with a low usage snapshot. Removing the gate so worstResetAt simply
    // picks the max would let the reset of a weekly window at 5% usage (days away) get attached to a
    // 5-hour session limit, making the coordinator wait days for something that really lifts in a few
    // hours — a misleading time is worse than not knowing (null); the app carries only facts. This is
    // where the next person will want to "just lower the gate", so we only log it and return null as is —
    // whether this combination actually occurs in practice is what this log determines.
    deps.log(
      `limit probe (codex): reached but no window met gate dispatch=${d.id} reachedType=${state?.reachedType ?? 'null'} primaryPct=${state?.primary?.usedPercent ?? 'n/a'} secondaryPct=${state?.secondary?.usedPercent ?? 'n/a'}`
    )
    return null
  }
  return reset.at
}

/** Decides whether an exited worker Dispatch hit a limit and returns the lift time (epoch ms).
 *  null when it was not a limit or when no verdict could be reached — the two are deliberately not
 *  distinguished.
 *
 *  It does not gate on d.workerState, d.outcome or exitCode — there are two call sites (handleExit and
 *  worker_done --outcome failed), the state differs between them, and the probe runs on a clean exit
 *  (exitCode=0) too. The reason: a TUI that hit a limit can print the phrase and then be shut down
 *  cleanly by the user or by /exit, giving exitCode=0, so a gate would miss precisely the case it is
 *  needed for. The cost is at most a 512KB read per session exit, and session exit is a rare user action
 *  — cheaper than what a missed limit costs (the orchestrator retries for no reason and is blocked again
 *  immediately). This is where the next person will want to optimise with "we do not need it on a clean
 *  exit". */
export function makeLimitProbe(deps: LimitProbeDeps): (d: Dispatch) => Promise<number | null> {
  return async (d: Dispatch): Promise<number | null> => {
    // Never throws — handleExit and worker_done both wrap this in try/catch, but the contract is that the
    // probe itself absorbs every failure as null.
    try {
      return d.provider === 'claude' ? await probeClaudeLimit(d, deps) : await probeCodexLimit(d, deps)
    } catch (err) {
      deps.log(`limit probe threw dispatch=${d.id}: ${String(err)}`)
      return null
    }
  }
}
