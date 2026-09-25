// What a rolling chain is, written into the session's pty note so another process can carry it on
// (S6 plan R4, design §3A.2). The app writes it; the Host reads it when it takes the session over.
import type { BlockRecord } from './retry'
import type { CodexLimitState } from './codexSignal'

export const ROLL_SNAPSHOT_VERSION = 1

export interface RollSnapshot {
  v: 1
  provider: 'claude' | 'codex'
  accountIds: string[]
  currentIndex: number
  streak: number
  recovery: (BlockRecord | null)[]
  /** The shared registry's records for this chain's accounts when it was written. */
  blocks: Record<string, BlockRecord>
  /** An armed wait: when it fires, which account it aims at, and which limit it waits out. */
  wait: { retryAt: number; target: number; weekly: boolean } | null
  inPlaceUsed: boolean
  rolledAt: number | null
  /** A respawn whose carry-on prompt has not gone out yet (claude pty chains). */
  awaitingPrompt: boolean
  claude?: { sessionId: string | null; transcriptPath: string | null; tailOffset: number | null; tailSince: number | null }
  codex?: { sessionId: string | null; rolloutPath: string | null; tailOffset: number | null; state: CodexLimitState | null }
  writtenAt: number
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const strOrNull = (v: unknown): boolean => v === null || typeof v === 'string'
const offOrNull = (v: unknown): boolean => v === null || (num(v) && Number.isInteger(v) && v >= 0)
const block = (v: unknown): v is BlockRecord =>
  isObj(v) && (v.at === null || num(v.at)) && typeof v.weekly === 'boolean' && num(v.since)
const windowOrNull = (v: unknown): boolean =>
  v === null || (isObj(v) && num(v.usedPercent) && (v.resetsAt === null || num(v.resetsAt)))
/** The whole CodexLimitState, field by field — the restored tail hands it to the limit verdicts as the
 *  chain's last reading, so a half-shaped one would be read as a real window or a real error. */
const limitState = (v: unknown): v is CodexLimitState =>
  isObj(v) &&
  windowOrNull(v.primary) &&
  windowOrNull(v.secondary) &&
  strOrNull(v.reachedType) &&
  (v.error === null || (isObj(v.error) && typeof v.error.message === 'string' && num(v.error.at))) &&
  (v.priorReset === null || (isObj(v.priorReset) && num(v.priorReset.at) && typeof v.priorReset.weekly === 'boolean')) &&
  num(v.at)

/** Null for anything that is not a v1 snapshot every field of which has the right type. All or nothing:
 *  a restore is never handed half a snapshot, so a note that is partial or corrupt costs the takeover its
 *  memory (the caller registers from zero), never a wrong wait or a wrong account. */
export function parseRollSnapshot(v: unknown): RollSnapshot | null {
  if (!isObj(v) || v.v !== ROLL_SNAPSHOT_VERSION) return null
  if (v.provider !== 'claude' && v.provider !== 'codex') return null
  const ids = v.accountIds
  if (!Array.isArray(ids) || ids.length < 1 || !ids.every((x) => typeof x === 'string')) return null
  if (!num(v.currentIndex) || !Number.isInteger(v.currentIndex) || v.currentIndex < 0 || v.currentIndex >= ids.length) return null
  if (!num(v.streak) || !Number.isInteger(v.streak) || v.streak < 0) return null
  if (!Array.isArray(v.recovery) || v.recovery.length !== ids.length || !v.recovery.every((r) => r === null || block(r))) return null
  if (!isObj(v.blocks) || !Object.values(v.blocks).every(block)) return null
  if (
    v.wait !== null &&
    !(
      isObj(v.wait) &&
      num(v.wait.retryAt) &&
      num(v.wait.target) &&
      Number.isInteger(v.wait.target) &&
      v.wait.target >= 0 &&
      v.wait.target < ids.length &&
      typeof v.wait.weekly === 'boolean'
    )
  )
    return null
  if (typeof v.inPlaceUsed !== 'boolean' || typeof v.awaitingPrompt !== 'boolean') return null
  if (!(v.rolledAt === null || num(v.rolledAt)) || !num(v.writtenAt)) return null
  if (v.claude !== undefined) {
    const c = v.claude
    if (!isObj(c) || !strOrNull(c.sessionId) || !strOrNull(c.transcriptPath) || !offOrNull(c.tailOffset) || !(c.tailSince === null || num(c.tailSince))) return null
  }
  if (v.codex !== undefined) {
    const c = v.codex
    if (!isObj(c) || !strOrNull(c.sessionId) || !strOrNull(c.rolloutPath) || !offOrNull(c.tailOffset) || !(c.state === null || limitState(c.state))) return null
  }
  return v as unknown as RollSnapshot
}

/** The same snapshot with writtenAt dropped, as a string: equal when nothing a restore reads changed. */
export function snapshotKey(s: RollSnapshot): string {
  const { writtenAt: _w, ...rest } = s
  return JSON.stringify(rest)
}
