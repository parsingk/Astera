// Decides whether an exited worker Dispatch ended on an account limit and works out when it lifts.
// This is the implementation of the OrchServerDeps.probeLimit hole. The two runtimes get it from
// different places:
//   - codex: the rollout jsonl carries rate_limits.primary/secondary.resets_at as structured values.
//   - claude: the lift time sits inside the limit phrase text (the phrase is pulled out of a transcript
//     entry and parsed).
// Both reuse only pieces of the pure verdict modules (claudeSignal, codexSignal, resetTime,
// codexLocate) — RollingCoordinator, rolling.ts and codexRolling.ts are not used directly here.
// Worker sessions are attached to those coordinators now (ipc.ts's spawnSession passes
// rollAccountIds through), and the two do not collide: rolling owns the session's lifetime end to
// end, and orchestration only listens for session:rolled to move the Dispatch to follow the new
// session id (Phase 1a's OrchRollTap in ipc.ts) — it re-keys that Dispatch and nothing else, never
// the session itself, which is rolling's to re-key. probeLimit stays a separate, post-mortem verdict
// — it runs on a Dispatch exit that rolling did not turn into a roll (a real death, not a
// rolled-away one), to answer "did this end on a limit, and when does that lift" for the
// orchestrator's own retry/backoff decision.
import type { Dispatch } from '../../core/orchestration/types'
import { parseClaudeLimitLine, type ClaudeLimitHit } from '../../core/rolling/claudeSignal'
import { limitReached, limitStateFromLines, worstResetAt } from '../../core/rolling/codexSignal'
import { findRollout } from '../../core/rolling/codexLocate'
import { parseResetTime } from '../../core/rolling/resetTime'
import { tailLines } from '../../core/rolling/tailLines'
import { extractStatusLineSession } from '../../core/usage/statusline'

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
 *  (usage_limit_exceeded first — reachedType has never been observed non-null). */
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
  const since = Date.parse(d.startedAt)
  const read = limitStateFromLines(lines, deps.now?.() ?? Date.now())
  // A limit error older than this Dispatch belongs to an earlier turn of a conversation this worker
  // resumed — the same rule the claude path applies to hit.at above. Without it every worker that ever
  // resumed a conversation that once hit a limit would be judged to have died of one. The windows are
  // left alone: they describe the account, not this turn.
  const state = read && read.error && read.error.at <= since ? { ...read, error: null } : read
  // textHit is always false — that is the input of the PTY output scanner (CodexLimitScanner), and the
  // probe does not look at the PTY stream. So codex is decided from the structured signals alone
  // (usage_limit_exceeded, rate_limit_reached_type) — a limit that produces only the phrase is missed by
  // this probe. Widening that needs a separate decision.
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
      `limit probe (codex): reached but no window met gate dispatch=${d.id} reachedType=${state?.reachedType ?? 'null'} error=${state?.error ? 'usage_limit_exceeded' : 'null'} primaryPct=${state?.primary?.usedPercent ?? 'n/a'} secondaryPct=${state?.secondary?.usedPercent ?? 'n/a'}`
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
