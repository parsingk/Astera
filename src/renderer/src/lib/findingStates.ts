import type { MessageKey } from '../../../core/i18n'
import type { ActorGroup, FindingState } from '../../../core/orchestration/types'
import type { Diagnostic } from '../../../core/problems/diagnostic'

/** Each finding state as the Problems row says it (Phase 3 Part 1b): a new state does not compile until it has words. */
const STATE_KEY: Record<FindingState, MessageKey> = {
  open: 'problems.finding.open',
  'repair-requested': 'problems.finding.repair-requested',
  'resolved-pending-verification': 'problems.finding.resolved-pending-verification',
  verified: 'problems.finding.verified',
  dismissed: 'problems.finding.dismissed'
}

/** Who made a change, as a history line says it. */
const WHO_KEY: Record<ActorGroup, MessageKey> = {
  person: 'problems.finding.by.person',
  coordinator: 'problems.finding.by.coordinator',
  astera: 'problems.finding.by.astera',
  unknown: 'problems.finding.by.unknown'
}

export const findingStateKey = (state: FindingState): MessageKey => STATE_KEY[state]
export const findingWhoKey = (by: ActorGroup): MessageKey => WHO_KEY[by]

/** The chip a row shows: its finding's state when a person acted on it, else none. */
export const findingChipKey = (d: Diagnostic): MessageKey | null => (d.finding ? STATE_KEY[d.finding.state] : null)

/**
 * The chosen rows as dismissals, one per Task in the rows' order, each reference once; null when there are none, or when
 * a row is not a Task's finding (it has no reference or no Task), since only a Task's findings are kept.
 */
export function dismissGroups(rows: readonly Diagnostic[]): Array<{ task: string; finding: string[] }> | null {
  if (rows.length === 0 || rows.some((d) => d.ref === undefined || d.origin === undefined)) return null
  const byTask = new Map<string, Set<string>>()
  for (const d of rows) {
    const refs = byTask.get(d.origin!.taskId) ?? new Set<string>()
    refs.add(d.ref!)
    byTask.set(d.origin!.taskId, refs)
  }
  return [...byTask].map(([task, refs]) => ({ task, finding: [...refs] }))
}
