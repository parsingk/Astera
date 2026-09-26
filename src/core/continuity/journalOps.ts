// What `journal-append` carries (Host journal J3): the app's reconciler rows, sent to the Host that
// writes the journal. Checked field by field here so the Host writes only what it could have written
// itself; an event's actor is never taken from the sender (the Host stamps its own, P5).
import { isContinuityEventType, type ContinuityEvent } from './events'
import type { NewRecoveryActionRow } from './journal'

/** Ops in one call. The reconciler sends one op per call; this bounds what a bad sender can queue. */
export const JOURNAL_OPS_MAX = 64
/** Events in one call, all its `events` ops together (and so in any one op). */
export const JOURNAL_EVENTS_MAX = 64
/** The JSON of one event's payload, or of one recovery finish's details, in UTF-8 bytes. */
export const JOURNAL_PAYLOAD_MAX_BYTES = 64 * 1024
/** What the Host puts in front of every key the app sends (review 4-5 M-2): the app's rows live in a
 *  namespace no Host key begins with (a Host key begins with its event type), so an app row can never
 *  take a key a later Host row needs. */
export const APP_KEY_PREFIX = 'app:'

/** Why this value is too big to journal, or null. Measured as the journal stores it: JSON, in bytes. */
const tooBig = (what: string, v: unknown): string | null => {
  const bytes = new TextEncoder().encode(JSON.stringify(v)).length
  return bytes > JOURNAL_PAYLOAD_MAX_BYTES ? `${what} is ${bytes} bytes of JSON, over the ${JOURNAL_PAYLOAD_MAX_BYTES} a row may carry` : null
}

export type JournalOp =
  | { op: 'events'; events: ContinuityEvent[] }
  | { op: 'recovery-start'; row: NewRecoveryActionRow & { recoveryActionId: string } }
  | { op: 'recovery-finish'; id: string; status: 'completed' | 'failed'; at: string; details?: Record<string, unknown> }

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** One event, rebuilt so nothing the sender added (an actor included) survives; or why not. */
function eventOf(v: unknown, i: number): ContinuityEvent | string {
  if (!isObj(v)) return `event ${i} is not an object`
  if (!isNonEmpty(v.runId)) return `event ${i}: runId must be a non-empty string`
  if (!isContinuityEventType(v.type)) return `event ${i}: unknown type ${JSON.stringify(v.type)}`
  if (!isStr(v.at)) return `event ${i}: at must be a string`
  if (!isNonEmpty(v.idempotencyKey)) return `event ${i}: idempotencyKey must be a non-empty string`
  if (!isObj(v.payload)) return `event ${i}: payload must be an object`
  const big = tooBig(`event ${i}: payload`, v.payload)
  if (big) return big
  if (v.taskId !== undefined && !isStr(v.taskId)) return `event ${i}: taskId must be a string`
  if (v.dispatchId !== undefined && !isStr(v.dispatchId)) return `event ${i}: dispatchId must be a string`
  return {
    runId: v.runId,
    ...(v.taskId !== undefined ? { taskId: v.taskId } : {}),
    ...(v.dispatchId !== undefined ? { dispatchId: v.dispatchId } : {}),
    type: v.type,
    at: v.at,
    idempotencyKey: v.idempotencyKey,
    payload: v.payload
  }
}

const RECOVERY_START_FIELDS = ['runId', 'taskId', 'dispatchId', 'strategy', 'class', 'reason', 'at'] as const

function opOf(v: unknown): JournalOp | string {
  if (!isObj(v)) return 'not an object'
  if (v.op === 'events') {
    if (!Array.isArray(v.events) || v.events.length === 0 || v.events.length > JOURNAL_EVENTS_MAX)
      return `events must be an array of 1 to ${JOURNAL_EVENTS_MAX}`
    const events: ContinuityEvent[] = []
    for (let i = 0; i < v.events.length; i++) {
      const e = eventOf(v.events[i], i)
      if (typeof e === 'string') return e
      events.push(e)
    }
    return { op: 'events', events }
  }
  if (v.op === 'recovery-start') {
    const r = v.row
    if (!isObj(r)) return 'row must be an object'
    if (!isNonEmpty(r.recoveryActionId)) return 'row.recoveryActionId must be a non-empty string'
    for (const f of RECOVERY_START_FIELDS) if (!isStr(r[f])) return `row.${f} must be a string`
    return {
      op: 'recovery-start',
      row: {
        recoveryActionId: r.recoveryActionId,
        runId: r.runId as string,
        taskId: r.taskId as string,
        dispatchId: r.dispatchId as string,
        strategy: r.strategy as string,
        class: r.class as string,
        reason: r.reason as string,
        at: r.at as string
      }
    }
  }
  if (v.op === 'recovery-finish') {
    if (!isStr(v.id)) return 'id must be a string'
    if (!isStr(v.at)) return 'at must be a string'
    if (v.status !== 'completed' && v.status !== 'failed') return 'status must be completed or failed'
    if (v.details !== undefined && !isObj(v.details)) return 'details must be an object'
    const big = v.details !== undefined ? tooBig('details', v.details) : null
    if (big) return big
    return {
      op: 'recovery-finish',
      id: v.id,
      status: v.status,
      at: v.at,
      ...(v.details !== undefined ? { details: v.details } : {})
    }
  }
  return `unknown op ${JSON.stringify(v.op)}`
}

/** `journal-append`'s `ops`, checked, or the first reason it cannot be written, naming the op. */
export function parseJournalOps(v: unknown): { ops: JournalOp[] } | { error: string } {
  if (!Array.isArray(v) || v.length === 0 || v.length > JOURNAL_OPS_MAX)
    return { error: `journal-append: ops must be an array of 1 to ${JOURNAL_OPS_MAX}` }
  const ops: JournalOp[] = []
  let events = 0
  for (let i = 0; i < v.length; i++) {
    const op = opOf(v[i])
    if (typeof op === 'string') return { error: `journal-append op ${i}: ${op}` }
    if (op.op === 'events') events += op.events.length
    if (events > JOURNAL_EVENTS_MAX) return { error: `journal-append: at most ${JOURNAL_EVENTS_MAX} events in one call` }
    ops.push(op)
  }
  return { ops }
}
