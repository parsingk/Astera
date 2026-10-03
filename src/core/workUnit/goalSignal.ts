// Is this transcript record a person declaring a goal, or that goal finishing?
//
// **A goal is a declaration, not an inference.** The text comes from a command argument the person
// typed, which is the same footing `/astera-task` stands on — so this module reads a field and
// never interprets a message. Everything it returns is either the person's own words or a boundary.
//
// Both vendors are read here rather than in two modules because the collector asks the question
// once per record and does not know which vendor wrote it (`hasWriteEvidence`, humanRequest.ts,
// makes the same choice for the same reason).
//
// Note: This module has no imports because both main and core read it.

/** A goal boundary. `summary` is the claude evaluator's own reason for saying the condition holds;
 *  codex reports no equivalent, so it is absent there.
 *
 *  `declared` on a `start` says which of the two vendors sent it, because they do not mean the same
 *  thing (spec §4). Claude's `sentinel` fires once, at the moment the person types `/goal` — a
 *  *declaration*, so `declared` is `true`. Codex's `active` is re-sent at every turn boundary as
 *  well as on every status change — a *state broadcast* naming whatever goal is already attached,
 *  so `declared` is `false`. The collector treats the two differently: a declaration always counts
 *  as a new start, discarding whatever bookkeeping an earlier goal left behind; a broadcast that
 *  repeats the objective the session's goal was last opened with is ignored, whether or not that
 *  unit is still open — the alternative would let a re-sent broadcast undo the person's own
 *  `[complete]`/`[cancel]` on that unit by minting a duplicate. */
export type GoalSignal =
  | { kind: 'start'; objective: string; declared: boolean }
  | { kind: 'end'; summary?: string }

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** A non-empty objective, or null. Trimmed only for the emptiness test — the value returned is
 *  what the person typed, untouched. */
const objectiveOf = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null

/**
 * Classify one transcript record. `null` means "not a goal boundary", which is the answer for the
 * overwhelming majority of records and for every goal state that is neither a start nor an end.
 *
 * Measured 2026-09-01 (spec §3) — Claude Code 2.1.252, codex-cli 0.151.0.
 *
 * Measured 2026-10-03 — codex-cli 0.160.0. The start still arrives as `thread_goal_updated` with
 * `active`, but no `thread_goal_updated` with `complete` is written any more. The model ends the goal
 * by calling `update_goal` from its `exec` tool, and the new state is recorded only in that call's
 * output:
 *
 *   response_item / custom_tool_call         name: "exec", input: the script
 *                                            `text(await tools.update_goal({status:"complete"}));`
 *   response_item / custom_tool_call_output  same call_id, output: [
 *     { type: "input_text", text: <"Script completed", wall time, "Output:" on three lines> },
 *     { type: "input_text", text: '{"goal":{"threadId":…,"objective":…,"status":"complete",…},…}' } ]
 *
 * The output is read on its own, without the call that produced it. The goal object in it is a field
 * codex wrote, the same object `thread_goal_updated` carries; the call's `input` is a script, and
 * picking `update_goal` out of it would be interpreting text, which this module does not do. Pairing
 * the two would also need state across records, and the collector's rounds can split a call from its
 * output. What a lone output risks is another script printing the goal (`get_goal` after the goal
 * completed): that is an end for a goal that already ended, and the collector ignores an end with no
 * goal unit open.
 */
export function goalSignalOf(record: Record<string, unknown>): GoalSignal | null {
  // claude — a `goal_status` attachment. `sentinel` marks the moment the goal was set; `met` the
  // moment the evaluator cleared it. A `met: false` without `sentinel` is an evaluation that said
  // "not yet": it bumps an iteration counter and is not a boundary.
  if (record.type === 'attachment') {
    const a = record.attachment
    if (!isObj(a) || a.type !== 'goal_status') return null
    if (a.sentinel === true) {
      const objective = objectiveOf(a.condition)
      return objective === null ? null : { kind: 'start', objective, declared: true }
    }
    if (a.met === true)
      return { kind: 'end', ...(typeof a.reason === 'string' ? { summary: a.reason } : {}) }
    return null
  }

  // codex — a `thread_goal_updated` event, repeated for every status change. Only `active` and
  // `complete` are boundaries: `paused`, `blocked`, `usageLimited` and `budgetLimited` are all
  // states the person can come back from, and How It Works has none that can be come back from
  // (spec §5.3).
  if (record.type === 'event_msg') {
    const p = record.payload
    if (!isObj(p) || p.type !== 'thread_goal_updated') return null
    const g = p.goal
    if (!isObj(g)) return null
    if (g.status === 'complete') return { kind: 'end' }
    if (g.status === 'active') {
      const objective = objectiveOf(g.objective)
      return objective === null ? null : { kind: 'start', objective, declared: false }
    }
    return null
  }

  // codex 0.160 — the goal's end, from the output of the model's `update_goal` call (see above). Only
  // a whole `input_text` item that parses as exactly `{ goal: { status: 'complete', objective,
  // threadId } }` counts; the goal JSON quoted inside other text is a message and is not read.
  if (record.type === 'response_item') {
    const p = record.payload
    if (!isObj(p) || p.type !== 'custom_tool_call_output' || !Array.isArray(p.output)) return null
    for (const item of p.output) {
      if (!isObj(item) || item.type !== 'input_text' || typeof item.text !== 'string') continue
      // Every tool output passes through here, so text that cannot be the goal object is turned
      // away before it is parsed. codex writes the object compact, with `goal` as its first key.
      if (!item.text.trim().startsWith('{"goal"')) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(item.text)
      } catch {
        continue
      }
      if (!isObj(parsed) || !isObj(parsed.goal)) continue
      const g = parsed.goal
      if (g.status === 'complete' && objectiveOf(g.objective) !== null && typeof g.threadId === 'string' && g.threadId !== '')
        return { kind: 'end' }
    }
    return null
  }

  return null
}
