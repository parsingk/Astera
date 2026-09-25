// What a rolling chain is, written into the session's pty note so another process can carry it on
// (S6 plan R4, design §3A.2). The app writes it; the Host reads it when it takes the session over.
import type { BlockRecord } from './retry'
import type { CodexLimitState, CodexWindow } from './codexSignal'

export const ROLL_SNAPSHOT_VERSION = 1

/** The furthest past `writtenAt` a wait may be aimed. A real wait is at most a weekly reset away (seven
 *  days) plus planRetry's margin; anything later is corrupt — and past 2^31-1 ms (~24.8 days) setTimeout
 *  overflows and fires at once, which would resume a chain that is still blocked. */
export const MAX_WAIT_AHEAD_MS = 8 * 24 * 60 * 60_000

/** The longest stored briefing (claude `prompt`) a snapshot may carry. The briefing is a short pointer to
 *  a file, far under this; anything longer is not one any coordinator wrote. */
export const MAX_SNAPSHOT_PROMPT_CHARS = 16 * 1024

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
  claude?: {
    sessionId: string | null
    transcriptPath: string | null
    tailOffset: number | null
    tailSince: number | null
    /** Which carry-on prompt an `awaitingPrompt` respawn is owed (S6 Task 12, carry C-c): 'briefing' for a
     *  blank-slate (smart) roll, whose new session knows nothing and must be briefed, 'handover' — the
     *  meaning of an absent field — for an ordinary `--resume` roll. */
    promptKind?: 'handover' | 'briefing'
    /** The briefing text roll() typed, stored with promptKind 'briefing' (Task 12 fix round 1). It cannot
     *  be rebuilt after the handover: a tab briefing is read from the session's transcript, and the live
     *  session is the new, blank one. At most MAX_SNAPSHOT_PROMPT_CHARS. */
    prompt?: string
  }
  codex?: {
    sessionId: string | null
    rolloutPath: string | null
    tailOffset: number | null
    state: CodexLimitState | null
    /** When a blank-slate (smart) roll spawned this session, while its rollout is not found yet (S6 Task
     *  12, carry C-b). A restore with no rolloutPath looks for the file only when this is set, and only
     *  among files born from then on — never before it (preflight R6). */
    locateSince?: number | null
  }
  writtenAt: number
}

/** What a spawn may write into its new pty's note beside the manager's own keys (S6 R6, design §5):
 *  for a roll, where it came from and the chain on its new account; for any session the Host started,
 *  that the Host started it. A closed shape rather than a free record, so no caller can slip a manager
 *  key (resumeSessionId and the like) into the note through it. Every key is optional because a Host
 *  worker's spawn carries `rolledBy` alone; a roll's respawn carries at least `RollRespawnExtra`. */
export interface RollSpawnExtra {
  rolledFrom?: string
  roll?: RollSnapshot
  rolledBy?: 'host'
}

/** What a coordinator's respawn always writes: where it came from and the chain on its new account. */
export type RollRespawnExtra = RollSpawnExtra & { rolledFrom: string; roll: RollSnapshot }

// Each reader below answers a fresh value built from the known fields only, or FAIL. Building rather than
// casting is what makes the parse safe to hand on: extra fields are dropped, and nothing the caller
// holds can reach back into the chain through a shared reference.
const FAIL = Symbol('fail')
type R<T> = T | typeof FAIL

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const int = (v: unknown): v is number => num(v) && Number.isInteger(v)
const strOrNull = (v: unknown): R<string | null> => (v === null || typeof v === 'string' ? v : FAIL)
const numOrNull = (v: unknown): R<number | null> => (v === null || num(v) ? v : FAIL)
const offOrNull = (v: unknown): R<number | null> => (v === null || (int(v) && v >= 0) ? v : FAIL)
const readBlock = (v: unknown): R<BlockRecord> =>
  isObj(v) && (v.at === null || num(v.at)) && typeof v.weekly === 'boolean' && num(v.since)
    ? { at: v.at, weekly: v.weekly, since: v.since }
    : FAIL
const readWindow = (v: unknown): R<CodexWindow | null> => {
  if (v === null) return null
  return isObj(v) && num(v.usedPercent) && (v.resetsAt === null || num(v.resetsAt))
    ? { usedPercent: v.usedPercent, resetsAt: v.resetsAt }
    : FAIL
}
/** The whole CodexLimitState, field by field — the restored tail hands it to the limit verdicts as the
 *  chain's last reading, so a half-shaped one would be read as a real window or a real error. */
const readState = (v: unknown): R<CodexLimitState | null> => {
  if (v === null) return null
  if (!isObj(v) || !num(v.at)) return FAIL
  const primary = readWindow(v.primary)
  const secondary = readWindow(v.secondary)
  const reachedType = strOrNull(v.reachedType)
  if (primary === FAIL || secondary === FAIL || reachedType === FAIL) return FAIL
  let error: CodexLimitState['error'] = null
  if (v.error !== null) {
    if (!isObj(v.error) || typeof v.error.message !== 'string' || !num(v.error.at)) return FAIL
    error = { message: v.error.message, at: v.error.at }
  }
  let priorReset: CodexLimitState['priorReset'] = null
  if (v.priorReset !== null) {
    if (!isObj(v.priorReset) || !num(v.priorReset.at) || typeof v.priorReset.weekly !== 'boolean') return FAIL
    priorReset = { at: v.priorReset.at, weekly: v.priorReset.weekly }
  }
  return { primary, secondary, reachedType, error, priorReset, at: v.at }
}
const readClaude = (v: unknown): R<NonNullable<RollSnapshot['claude']>> => {
  if (!isObj(v)) return FAIL
  const sessionId = strOrNull(v.sessionId)
  const transcriptPath = strOrNull(v.transcriptPath)
  const tailOffset = offOrNull(v.tailOffset)
  const tailSince = numOrNull(v.tailSince)
  if (sessionId === FAIL || transcriptPath === FAIL || tailOffset === FAIL || tailSince === FAIL) return FAIL
  // Optional, and kept absent when absent (an older writer's note reads as it always did).
  const pk = v.promptKind
  if (pk !== undefined && pk !== 'handover' && pk !== 'briefing') return FAIL
  const pr = v.prompt
  if (pr !== undefined && (typeof pr !== 'string' || pr.length > MAX_SNAPSHOT_PROMPT_CHARS)) return FAIL
  return {
    sessionId,
    transcriptPath,
    tailOffset,
    tailSince,
    ...(pk !== undefined ? { promptKind: pk } : {}),
    ...(pr !== undefined ? { prompt: pr } : {})
  }
}
/** writtenAt bounds locateSince: a spawn time after the snapshot was written is not one any writer saw. */
const readCodex = (v: unknown, writtenAt: number): R<NonNullable<RollSnapshot['codex']>> => {
  if (!isObj(v)) return FAIL
  const sessionId = strOrNull(v.sessionId)
  const rolloutPath = strOrNull(v.rolloutPath)
  const tailOffset = offOrNull(v.tailOffset)
  const state = readState(v.state)
  if (sessionId === FAIL || rolloutPath === FAIL || tailOffset === FAIL || state === FAIL) return FAIL
  const ls = v.locateSince
  if (ls !== undefined && ls !== null && !(num(ls) && ls <= writtenAt)) return FAIL
  return { sessionId, rolloutPath, tailOffset, state, ...(ls !== undefined ? { locateSince: ls } : {}) }
}

/** Null for anything that is not a v1 snapshot every field of which has the right type. All or nothing:
 *  a restore is never handed half a snapshot, so a note that is partial or corrupt costs the takeover its
 *  memory (the caller registers from zero), never a wrong wait or a wrong account.
 *
 *  The answer is a fresh object of the known fields only — it shares no reference with the input. The
 *  provider's own block is required and the other provider's is refused: a claude snapshot carrying a
 *  codex block (or none) is not something any coordinator writes. */
export function parseRollSnapshot(v: unknown): RollSnapshot | null {
  if (!isObj(v) || v.v !== ROLL_SNAPSHOT_VERSION) return null
  const provider = v.provider
  if (provider !== 'claude' && provider !== 'codex') return null
  const rawIds = v.accountIds
  if (!Array.isArray(rawIds) || rawIds.length < 1 || !rawIds.every((x) => typeof x === 'string')) return null
  const accountIds = rawIds.slice() as string[]
  const currentIndex = v.currentIndex
  if (!int(currentIndex) || currentIndex < 0 || currentIndex >= accountIds.length) return null
  const streak = v.streak
  if (!int(streak) || streak < 0) return null
  if (!Array.isArray(v.recovery) || v.recovery.length !== accountIds.length) return null
  const recovery: (BlockRecord | null)[] = []
  for (const r of v.recovery) {
    const rec = r === null ? null : readBlock(r)
    if (rec === FAIL) return null
    recovery.push(rec)
  }
  if (!isObj(v.blocks)) return null
  const blocks: Record<string, BlockRecord> = {}
  for (const [id, b] of Object.entries(v.blocks)) {
    const rec = readBlock(b)
    if (rec === FAIL) return null
    Object.defineProperty(blocks, id, { value: rec, enumerable: true, writable: true, configurable: true })
  }
  const writtenAt = v.writtenAt
  if (!num(writtenAt)) return null
  let wait: RollSnapshot['wait'] = null
  if (v.wait !== null) {
    const w = v.wait
    if (!isObj(w) || !num(w.retryAt) || !int(w.target) || w.target < 0 || w.target >= accountIds.length) return null
    if (typeof w.weekly !== 'boolean') return null
    if (w.retryAt - writtenAt > MAX_WAIT_AHEAD_MS) return null
    wait = { retryAt: w.retryAt, target: w.target, weekly: w.weekly }
  }
  if (typeof v.inPlaceUsed !== 'boolean' || typeof v.awaitingPrompt !== 'boolean') return null
  const rolledAt = numOrNull(v.rolledAt)
  if (rolledAt === FAIL) return null
  const base = {
    v: ROLL_SNAPSHOT_VERSION,
    provider,
    accountIds,
    currentIndex,
    streak,
    recovery,
    blocks,
    wait,
    inPlaceUsed: v.inPlaceUsed,
    rolledAt,
    awaitingPrompt: v.awaitingPrompt
  } as const
  if (provider === 'claude') {
    if (v.codex !== undefined) return null
    const claude = readClaude(v.claude)
    if (claude === FAIL) return null
    return { ...base, claude, writtenAt }
  }
  if (v.claude !== undefined) return null
  const codex = readCodex(v.codex, writtenAt)
  if (codex === FAIL) return null
  return { ...base, codex, writtenAt }
}

/** The same snapshot with writtenAt dropped, as a string: equal when nothing a restore reads changed. */
export function snapshotKey(s: RollSnapshot): string {
  const { writtenAt: _w, ...rest } = s
  return JSON.stringify(rest)
}
