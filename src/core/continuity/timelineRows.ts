// The journal rows the Timeline shows (design §9), as pure functions over rows already read: the app's
// recorder and the Host's runs-follow (Host journal J7) turn the same rows into the same lines.
import { CATALOGS, t, type Lang, type MessageKey, type MessageParams } from '../i18n'
import type { JobEvent } from '../types'
import type { OrchState } from '../orchestration/state'
import type { ContinuityEventType } from './events'
import type { JournalEventRow } from './journal'

/** One journal event type read back as one kind of Timeline line. The readers below differ only in the
 *  type they keep, the kind they emit and how they word the summary, so the fold lives here once. */
function timelineRows(
  rows: readonly JournalEventRow[],
  state: OrchState,
  type: ContinuityEventType,
  kind: JobEvent['kind'],
  summary: (e: JournalEventRow) => string,
  body?: (e: JournalEventRow) => string
): JobEvent[] {
  const titleOf = new Map(state.tasks.map((task) => [task.id, task.title]))
  return rows
    .filter((e) => e.type === type)
    .map((e) => ({
      at: e.at,
      kind,
      sourceId: e.eventId,
      ...(e.taskId ? { taskId: e.taskId, taskTitle: titleOf.get(e.taskId) } : {}),
      summary: summary(e),
      ...(body ? { body: body(e) } : {})
    }))
}

/** The reason in the reader's language. The journal holds both halves the decision wrote: an English
 *  sentence for the file and the key it was written under. A key this build does not have (a row from
 *  another version, or one written before the keys existed) falls back to the English sentence, worse
 *  to read and far better than a bare key. */
function reasonText(e: JournalEventRow, lang: Lang): string {
  const key = e.payload?.reasonKey
  const english = String(e.payload?.reason ?? '')
  if (typeof key !== 'string' || !(key in CATALOGS.ko.messages)) return english
  const params = e.payload?.reasonParams
  return t(lang, key as MessageKey, params && typeof params === 'object' ? (params as MessageParams) : undefined)
}

/** Each ATTEMPT_LOST as a 'runtime-lost' line. */
export function lostRowsOf(rows: readonly JournalEventRow[], state: OrchState): JobEvent[] {
  return timelineRows(rows, state, 'ATTEMPT_LOST', 'runtime-lost', () => '')
}

/** Each RECOVERY_STRATEGY_SELECTED as a 'recovery' line. The summary is the strategy as journaled and
 *  the renderer words it (RunDetail's RECOVERY_LABEL); the body is why that strategy was chosen, which
 *  is the half a person cannot get anywhere else. */
export function recoveryRowsOf(rows: readonly JournalEventRow[], state: OrchState, lang: Lang): JobEvent[] {
  return timelineRows(
    rows,
    state,
    'RECOVERY_STRATEGY_SELECTED',
    'recovery',
    (e) => String(e.payload?.strategy ?? ''),
    (e) => reasonText(e, lang)
  )
}

/** Both kinds of line: the lost attempts, then the recovery decisions. */
export function journalTimeline(rows: readonly JournalEventRow[], state: OrchState, lang: Lang): JobEvent[] {
  return [...lostRowsOf(rows, state), ...recoveryRowsOf(rows, state, lang)]
}
