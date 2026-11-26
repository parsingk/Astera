import type { MessageKey } from '../../../core/i18n'
import type { RepairRefusal } from '../../../core/orchestration/types'
import type { Diagnostic } from '../../../core/problems/diagnostic'
import { problemLine } from './contextSources'

/** What `tasks-repair` is sent for the chosen rows (Phase 3 Part 1): `texts` holds each reference's words as the
 *  person saw them, the Host's to put in the repair. */
export type RepairRequest = { task: string; finding: string[]; texts: Record<string, string> }

/**
 * The chosen rows as a repair request to their one Task, or null when they are not all rows of one Task with a reference
 * (those go to a new Job draft). Each reference once, with the words of every row that carries it: one rule hit on two
 * lines of one file is one reference, and the worker must hear of both lines (final review M6).
 */
export function repairRequestOf(rows: readonly Diagnostic[], root: string): RepairRequest | null {
  const origin = rows[0]?.origin
  if (!origin || rows.some((d) => d.origin?.taskId !== origin.taskId || d.ref === undefined)) return null
  const texts: Record<string, string> = {}
  for (const d of rows) {
    const ref = d.ref as string
    const line = problemLine(d, root)
    texts[ref] = texts[ref] === undefined ? line : `${texts[ref]}; ${line}`
  }
  return { task: origin.taskId, finding: Object.keys(texts), texts }
}

/** Each refusal the Host gives (taskRepair.ts), as the app says it: a new one does not compile until it has its sentence
 *  (final review M14). */
const REFUSAL_SENTENCE: Record<RepairRefusal, MessageKey> = {
  'unknown-task': 'problems.fix.refused.unknown-task',
  busy: 'problems.fix.refused.busy',
  'run-ended': 'problems.fix.refused.run-ended',
  'dependents-started': 'problems.fix.refused.dependents-started',
  'folder-gone': 'problems.fix.refused.folder-gone',
  'folder-in-use': 'problems.fix.refused.folder-in-use',
  'blocked-by-gate': 'problems.fix.refused.blocked-by-gate',
  'not-repairable': 'problems.fix.refused.not-repairable'
}
export const REPAIR_REFUSALS = Object.keys(REFUSAL_SENTENCE) as RepairRefusal[]

export type RepairAnswer = { kind: 'ok'; asked?: number } | { kind: 'refused'; key: MessageKey } | { kind: 'failed'; error: string }

/**
 * The Host's answer to `tasks-repair`, dry run or not, as the app says it. A refusal with a reason (409), a Task gone
 * since the list was drawn (404) and a Runtime that does not let this app ask (403) are each a sentence the app follows
 * with the draft offer, whenever they come (final review M10); a reason this build does not know reads as not
 * repairable. Anything else, a 409 without a reason included (the repair could not be opened), is a failure in its own
 * words.
 */
export function repairAnswer(a: { status: number; body: unknown }): RepairAnswer {
  const body = (a.body ?? {}) as { reason?: unknown; asked?: unknown; error?: unknown }
  if (a.status === 200) return typeof body.asked === 'number' ? { kind: 'ok', asked: body.asked } : { kind: 'ok' }
  if (a.status === 409 && typeof body.reason === 'string')
    return { kind: 'refused', key: REFUSAL_SENTENCE[body.reason as RepairRefusal] ?? REFUSAL_SENTENCE['not-repairable'] }
  if (a.status === 404) return { kind: 'refused', key: REFUSAL_SENTENCE['unknown-task'] }
  if (a.status === 403) return { kind: 'refused', key: 'problems.fix.refused.here' }
  return { kind: 'failed', error: typeof body.error === 'string' ? body.error : String(a.status) }
}
