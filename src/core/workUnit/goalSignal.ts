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
 *  codex reports no equivalent, so it is absent there. */
export type GoalSignal = { kind: 'start'; objective: string } | { kind: 'end'; summary?: string }

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
      return objective === null ? null : { kind: 'start', objective }
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
      return objective === null ? null : { kind: 'start', objective }
    }
    return null
  }

  return null
}
