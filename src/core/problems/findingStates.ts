// Where the findings a person acted on stand (Phase 3 Part 1b, design §5 Part 1 item 5). A finding gets a record when a
// person asks it repaired or dismisses it; with none it is simply open. Every change no person makes is derived here,
// from what one commit moved: a repair Dispatch carrying the finding opened or ended, a check or review round written.
// The Host runs every commit through `stampFindings`, beside stampRunEnds, so validation, review, external reviewers,
// the CI lifecycle, recovery and the app's state-put all reach it without each writing states of its own.
import type { OrchState } from '../orchestration/state'
import {
  FINDING_HISTORY_MAX,
  FINDING_NOTE_MAX,
  TASK_FINDING_STATES_MAX,
  type ActorGroup,
  type CheckResult,
  type Dispatch,
  type FindingChange,
  type FindingRecord,
  type FindingState,
  type Task
} from '../orchestration/types'
import { taskFoldersOf } from './completionProblems'
import { findingRef } from './findingRef'

/** Control and format characters, and line and paragraph separators: what a one-line note must not carry (the rule the
 *  repair section quotes findings by, exec/coordinator.ts `seen`). */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * The commands a person changes a record by hand with. The app's commands run in main and reach the Host as a put, whose
 * records the Host does not take (stampFindings `fromApp`), so main sends these to the Host as the commands they are.
 */
export const hostWritesFinding = (cmd: string): boolean => cmd === 'tasks-dismiss' || cmd === 'tasks-undismiss'

/** A person's note as it is kept: one line, nothing unseen, at most FINDING_NOTE_MAX characters. */
export function cleanNote(text: string): string {
  const one = text.replace(UNSEEN, ' ').replace(/\s+/g, ' ').trim()
  return one.length > FINDING_NOTE_MAX ? `${one.slice(0, FINDING_NOTE_MAX - 1)}…` : one
}

/**
 * The record after a move to `to`: made when there is none (its kind from the reference, `source` as given), the same
 * record back when it is there already (a dismissal whose note changes is a change), the newest FINDING_HISTORY_MAX
 * changes kept. Only a dismissal carries a note.
 */
export function moveFinding(
  rec: FindingRecord | undefined,
  ref: string,
  to: FindingState,
  change: { at: string; by: ActorGroup; revision?: string; note?: string },
  source?: string
): FindingRecord {
  const note = to === 'dismissed' ? change.note : undefined
  if (rec && rec.state === to && (to !== 'dismissed' || rec.note === note)) return rec
  const entry: FindingChange = {
    at: change.at,
    by: change.by,
    from: rec?.state ?? null,
    to,
    ...(change.revision !== undefined ? { revision: change.revision } : {}),
    ...(note !== undefined ? { note } : {})
  }
  const kept = rec?.source ?? source
  return {
    kind: rec?.kind ?? (ref.startsWith('review:') ? 'review' : 'check'),
    ...(kept !== undefined ? { source: kept } : {}),
    state: to,
    ...(note !== undefined ? { note } : {}),
    history: [...(rec?.history ?? []), entry].slice(-FINDING_HISTORY_MAX)
  }
}

/** The head the Task's newest attempt recorded, the revision a change is made on. */
export function findingRevision(state: Pick<OrchState, 'dispatches'>, taskId: string): string | undefined {
  return state.dispatches
    .filter((d) => d.taskId === taskId && d.git?.head !== undefined)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.git?.head
}

/** What one check's round says: whether it ran over everything it counted, and the references it still has (its own,
 *  the check as a whole, while it fails). A check that did not run or could not run says nothing. */
interface CheckRound {
  complete: boolean
  refs: Set<string>
}
/** A check that ran to its end: not one that did not run, could not run, was let go without, or timed out. */
const ran = (c: CheckResult): boolean => c.status !== 'not-run' && c.status !== 'error' && c.status !== 'timed-out' && c.skipped !== true
function checkRound(task: Task, c: CheckResult, base: readonly string[]): CheckRound {
  const listed = c.diagnostics ?? []
  const refs = new Set(listed.map((d) => findingRef({ kind: 'check', taskId: task.id, source: c.configId, file: d.file, base, message: d.message })))
  if (c.status !== 'passed') refs.add(findingRef({ kind: 'check', taskId: task.id, source: c.configId, message: '' }))
  // A failed check proves a finding gone only by listing every finding it counted; one that listed none (CI whose
  // details could not be read, a tool that crashed) says nothing of them (final review I1)
  return { complete: c.status === 'passed' || (listed.length > 0 && (c.diagnosticsTotal ?? listed.length) <= listed.length), refs }
}

/** The check whose round carries this reference now, for a new record's `source`. */
export function findingSourceOf(task: Task, base: readonly string[], ref: string): string | undefined {
  return (task.checks ?? []).find((c) => checkRound(task, c, base).refs.has(ref))?.configId
}

const reviewIds = (t: Task | undefined): string => (t?.reviewIssues ?? []).map((i) => i.id).join(',')
const lastAt = (r: FindingRecord): string => r.history.at(-1)?.at ?? ''

/** Which records the bound drops first: verified ones, then the rest, a person's dismissal last (final review M2). */
const dropRank = (r: FindingRecord): number => (r.state === 'verified' ? 0 : r.state === 'dismissed' ? 2 : 1)

/** At most TASK_FINDING_STATES_MAX records: verified ones go first, then the oldest by their last change, dismissals last. */
function bounded(recs: Record<string, FindingRecord>): Record<string, FindingRecord> {
  const entries = Object.entries(recs)
  const over = entries.length - TASK_FINDING_STATES_MAX
  if (over <= 0) return recs
  const order = [...entries].sort(([, a], [, b]) => dropRank(a) - dropRank(b) || lastAt(a).localeCompare(lastAt(b)))
  const dropped = new Set(order.slice(0, over).map(([ref]) => ref))
  return Object.fromEntries(entries.filter(([ref]) => !dropped.has(ref)))
}

/**
 * `next` with each Task's finding records moved by what this commit moved, in this order:
 * 1. a repair Dispatch new in this commit and open carries findings: each to `repair-requested`, by `group`;
 * 2. one open before and ended now: each still `repair-requested` and carried by no open Dispatch to
 *    `resolved-pending-verification` when it succeeded, `open` otherwise; one open before and gone now (its worker never
 *    started, recovery took it back) as ended without success; and a `repair-requested` finding no attempt carries once
 *    its Task left `dispatched` (recovery gave up on the lost repair) goes `open` (final review I3);
 * 3. a check's new round (its `endedAt` moved) that ran: its findings present go `open`, absent ones `verified` only when
 *    it passed or listed every finding it counted (a record with no `source`: only when every check ran so); a new
 *    review round (other issue ids): present `open`, absent `verified` unless the round has a blocking issue with no
 *    file (a reviewer that rejected without listing its issues). Dismissed findings and findings still being repaired
 *    stay; recovery's replacement of a repair leaves a dismissal alone (final review M3). Never `verified` from a round that does not prove it (design §2: a disappearance is no verdict).
 * Steps 2 and 3 are Astera's (`by: 'astera'`). With `fromApp` (the app's state-put), the Host's records are the base
 * and whatever the app sent for them is ignored: only the Host's commands change them by hand. `next` itself back when
 * no Task's records moved.
 */
export function stampFindings(prev: OrchState, next: OrchState, group: ActorGroup, now: string, o: { fromApp?: boolean } = {}): OrchState {
  const prevTasks = new Map(prev.tasks.map((t) => [t.id, t]))
  const prevDispatches = new Map(prev.dispatches.map((d) => [d.id, d]))
  const byTask = (list: readonly Dispatch[]): Map<string, Dispatch[]> => {
    const out = new Map<string, Dispatch[]>()
    for (const d of list) {
      if (!d.askedFindings || d.askedFindings.length === 0) continue
      const had = out.get(d.taskId)
      if (had) had.push(d)
      else out.set(d.taskId, [d])
    }
    return out
  }
  const asked = byTask(next.dispatches)
  const askedBefore = byTask(prev.dispatches)
  const nextIds = new Set(next.dispatches.map((d) => d.id))
  let changed = false
  const tasks = next.tasks.map((task) => {
    const before = prevTasks.get(task.id)
    const start = o.fromApp ? before?.findingStates : task.findingStates
    let recs = start
    const carriers = asked.get(task.id) ?? []
    const beingRepaired = (ref: string): boolean => carriers.some((d) => d.endedAt === undefined && d.askedFindings!.some((f) => f.ref === ref))
    let revision: string | undefined | null = null
    let base: readonly string[] | null = null
    const folders = (): readonly string[] => (base ??= taskFoldersOf(next, task))
    const move = (ref: string, to: FindingState, by: ActorGroup, source?: string): void => {
      if (revision === null) revision = findingRevision(next, task.id)
      const cur = recs?.[ref]
      const moved = moveFinding(cur, ref, to, { at: now, by, ...(revision !== undefined ? { revision } : {}) }, source)
      if (moved !== cur) recs = { ...recs, [ref]: moved }
    }

    /** Whether a Dispatch, before or now, carried the reference: recovery's replacement names the attempt it replaces. */
    const carried = (id: string | undefined, ref: string): boolean =>
      id !== undefined && [prevDispatches.get(id), ...carriers.filter((x) => x.id === id)].some((x) => x?.askedFindings?.some((f) => f.ref === ref) === true)
    for (const d of carriers) {
      const was = prevDispatches.get(d.id)
      // 1. A person's repair opened (recovery's replacement finds them repair-requested already, and a dismissal made
      //    meanwhile stays: final review M3)
      if (!was && d.endedAt === undefined)
        for (const f of d.askedFindings!) {
          if (recs?.[f.ref]?.state === 'dismissed' && carried(d.retryOf, f.ref)) continue
          move(f.ref, 'repair-requested', group, findingSourceOf(task, folders(), f.ref))
        }
      // 2. It ended
      if (was && was.endedAt === undefined && d.endedAt !== undefined)
        for (const f of d.askedFindings!)
          if (recs?.[f.ref]?.state === 'repair-requested' && !beingRepaired(f.ref)) move(f.ref, d.outcome === 'succeeded' ? 'resolved-pending-verification' : 'open', 'astera')
    }
    // 2. A repair taken away before it ended (its worker never started, recovery took it back): not repaired (final
    //    review I3)
    for (const d of askedBefore.get(task.id) ?? [])
      if (d.endedAt === undefined && !nextIds.has(d.id))
        for (const f of d.askedFindings!) if (recs?.[f.ref]?.state === 'repair-requested' && !beingRepaired(f.ref)) move(f.ref, 'open', 'astera')
    // 2. Asked, carried by no attempt, and its Task no longer at work on it: recovery gave the lost repair up
    if (recs && task.status !== 'dispatched')
      for (const [ref, rec] of Object.entries(recs)) if (rec.state === 'repair-requested' && !beingRepaired(ref)) move(ref, 'open', 'astera')

    // 3. Rounds
    if (recs && before) {
      const ended = new Map((before.checks ?? []).map((c) => [c.configId, c.endedAt]))
      const fresh = new Map<string, CheckRound>()
      for (const c of task.checks ?? []) if (ran(c) && (!ended.has(c.configId) || ended.get(c.configId) !== c.endedAt)) fresh.set(c.configId, checkRound(task, c, folders()))
      const all = task.checks ?? []
      const whole = fresh.size > 0 && all.length > 0 && all.every((c) => ran(c) && checkRound(task, c, folders()).complete)
      const newReview = task.reviewIssues !== undefined && reviewIds(task) !== reviewIds(before)
      const reviewRefs = newReview
        ? new Set(task.reviewIssues!.filter((i) => i.file !== undefined).map((i) => findingRef({ kind: 'review', taskId: task.id, file: i.file, base: folders(), message: i.title })))
        : null
      // A reviewer that rejected without writing its issues leaves one blocking issue with no file: no list (I1)
      const reviewListed = newReview && !task.reviewIssues!.some((i) => i.file === undefined && i.blocking)
      if (fresh.size > 0 || reviewRefs) {
        for (const [ref, rec] of Object.entries(recs)) {
          if (rec.state === 'dismissed' || beingRepaired(ref)) continue
          if (rec.kind === 'review') {
            if (reviewRefs?.has(ref)) move(ref, 'open', 'astera')
            else if (reviewRefs && reviewListed) move(ref, 'verified', 'astera')
            continue
          }
          const round = rec.source !== undefined ? fresh.get(rec.source) : whole ? { complete: true, refs: new Set([...fresh.values()].flatMap((r) => [...r.refs])) } : undefined
          if (!round) continue
          if (round.refs.has(ref)) move(ref, 'open', 'astera')
          else if (round.complete) move(ref, 'verified', 'astera')
        }
      }
    }

    // The bound holds whatever moved, a command's own records included (final review M2)
    if (recs && Object.keys(recs).length > TASK_FINDING_STATES_MAX) recs = bounded(recs)
    if (recs === task.findingStates) return task
    changed = true
    const { findingStates: _replaced, ...rest } = task
    return recs && Object.keys(recs).length > 0 ? { ...rest, findingStates: recs } : rest
  })
  return changed ? { ...next, tasks } : next
}
