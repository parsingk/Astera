// Reads a codex session's rollout file and answers two questions from the one tail: has a turn just
// completed, and how much of the context and of the two limit windows is used.
//
// Turn completion: for Claude the Stop hook reports it, but codex has no hook system. Instead the
// rollout jsonl records event_msg/task_complete once per turn (verified across 59 files and 156 turns).
//
// Usage: codex has no statusLine mechanism either, so the rollout is also the only place the usage
// chips' three figures are written down (token_count records — see core/usage/codex.ts). That is why
// **every** codex session is registered here, not only the ones that asked for Slack notifications:
// the chips are drawn for whichever session is active. Only the turn callback stays gated (Entry
// .notifyTurns), so Slack traffic does not grow.
//
// Why this is independent of rolling: Slack-only sessions with rolling turned off have to be detected too.
// Bolting it onto CodexRollingCoordinator would create a responsibility mismatch — "the rolling coordinator tracks
// sessions that are not rolling" — and clash with the existing rolling design. When rolling is on, two tails run
// over the same file, which is negligible because reads are incremental by offset.
import type { Account, SessionInfo, SessionUsage } from '../core/types'
import { JsonlTail } from '../core/rolling/jsonlTail'
import { findRollout } from '../core/rolling/codexLocate'
import { limitStateFromLines, type CodexLimitState } from '../core/rolling/codexSignal'
import { tailLines } from '../core/rolling/tailLines'
import { contextFromLines, sessionUsageOf } from '../core/usage/codex'

const POLL_MS = 1_000 // Same value as LOCATE_POLL_MS in codexRolling.ts (which is not exported there)

interface Entry {
  sessionId: string
  accountId: string
  cwd: string
  since: number // Spawn time — the cutoff findRollout uses to filter out earlier sessions' files
  rolloutPath: string | null
  /** The codex session id of that rollout, or null until the scan maps it.
   *
   *  findRollout answers path and id together and this was throwing the id away. It is codex's
   *  counterpart to the claude `session_id` that arrives in the statusLine payload — the scheduler
   *  learns its scheduler.json key from it (SchedulerCoordinator.learnKey).
   *
   *  **Left null when the path was handed over at registration.** In that case the caller is resuming,
   *  so it already holds the id (`info.resumeSessionId`) and nothing here needs to answer it — filling
   *  it from that field would only add a second source of truth for a value its own caller supplied. */
  codexSessionId: string | null
  tail: JsonlTail | null
  disposed: boolean
  /** Whether turn completion is reported. Every codex session is watched (the usage chips need it);
   *  only the ones that asked for Slack notifications get the callback. */
  notifyTurns: boolean
  /** The two limit windows, carried forward across batches that hold none — see limitStateFromLines. */
  limits: CodexLimitState | null
  context: SessionUsage['context']
  /** Reads the context out of the file as it stood at attach time, for a resume or a post-roll respawn.
   *
   *  Only the context, never the windows. A resumed session attaches to a file whose usage figures were
   *  written by the previous account, and drawing those would report the wrong account's usage —
   *  whereas the context is still true, because it is the same conversation. (The mirror image of
   *  CodexRolloutTail's priorReset, which keeps the reset instant and drops the percentages.)
   *
   *  Started in register for the same reason CodexRolloutTail starts its own seed there: what we want
   *  is the file as it stood when we attached, and the first step() can be a whole tick later. */
  contextSeed: Promise<SessionUsage['context']> | null
}

/** The context figure the rollout already held when we attached, or null when the file cannot be read.
 *  A module-level function rather than a method, mirroring readPriorReset in codexSignal.ts. */
async function seedContext(filePath: string): Promise<SessionUsage['context']> {
  const lines = await tailLines(filePath)
  return lines ? contextFromLines(lines) : null
}

export interface CodexRolloutDeps {
  getAccount(id: string): Account | null
  onTurnComplete(sessionId: string, rolloutPath: string): void
  log(message: string): void
  now?: () => number
}

/** Whether a line is a task_complete event */
function isTaskComplete(line: string): boolean {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return false // Ignore a broken line
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false
  const o = obj as Record<string, unknown>
  if (o.type !== 'event_msg') return false
  const p = o.payload
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return false
  return (p as Record<string, unknown>).type === 'task_complete'
}

export class CodexRolloutWatcher {
  private entries = new Map<string, Entry>()
  private ticker: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  constructor(private deps: CodexRolloutDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Registers a codex session. The caller determines the provider and passes it in; every codex
   *  session belongs here, because the usage chips are drawn for whichever one is active. Whether turn
   *  completion is *reported* is decided per entry from info.slackNotify.
   *
   *  rolloutPath: the file a resumed session will write to, when the caller already knows it (ipc for a
   *  history resume, index.ts for the respawn after a roll). It is not an optimisation — `codex resume`
   *  appends to the existing rollout instead of creating one, so findRollout, which only accepts a file
   *  created after the spawn, can never find it and turn notifications simply stopped after any resume
   *  (the same defect as codexRolling's, see attachRollout there). The tail starts at the end of that
   *  file: it is full of turns that finished before this session existed, and reporting those is the
   *  misfire the old excludePaths argument was there to prevent. */
  register(info: SessionInfo, rolloutPath?: string): void {
    if (!this.deps.getAccount(info.accountId)) {
      this.deps.log(`codex rollout watch registration cancelled — no such account session=${info.id}`)
      return
    }
    this.entries.set(info.id, {
      sessionId: info.id,
      accountId: info.accountId,
      cwd: info.cwd,
      since: this.now(),
      rolloutPath: rolloutPath ?? null,
      codexSessionId: null,
      tail: rolloutPath ? new JsonlTail(rolloutPath, { startAtEnd: true }) : null,
      disposed: false,
      notifyTurns: info.slackNotify === true,
      limits: null,
      context: null,
      contextSeed: rolloutPath ? seedContext(rolloutPath) : null
    })
    this.ensureTicker()
  }

  /** The usage snapshot for the chips, or null when this session is unknown or nothing has been read
   *  yet. Synchronous on purpose — it is answered from what the poll already collected, the same way
   *  the claude side answers from the statusLine capture file. */
  usage(sessionId: string): SessionUsage | null {
    const e = this.entries.get(sessionId)
    if (!e) return null
    return sessionUsageOf(e.context, e.limits)
  }

  /** The rollout file this session writes to, or null before the scan has mapped it.
   *
   *  Work Unit detection reads this file, and this watcher is the only place that knows the path for
   *  **every** codex session: codexRolling.rolloutPathFor answers only for sessions the user put on
   *  account rolling (register is behind `rollAccountIds.length >= 1`), whereas every codex session is
   *  registered here because the usage chips need it. Same reason the chips read from here. */
  rolloutPathFor(sessionId: string): string | null {
    const e = this.entries.get(sessionId)
    return e && !e.disposed ? e.rolloutPath : null
  }

  /** The codex session id this session writes under, or null before the scan has mapped it.
   *
   *  **This is codex's answer to claude's statusLine `session_id`.** Anything that needs to key
   *  something by the conversation's own id — today the scheduler's scheduler.json key — reads it here,
   *  and only this watcher can answer for **every** codex session (codexRolling knows it too, but only
   *  for sessions the user put on account rolling). Synchronous for the same reason `usage` is: it is
   *  answered from what the poll already collected. */
  codexSessionIdFor(sessionId: string): string | null {
    const e = this.entries.get(sessionId)
    return e && !e.disposed ? e.codexSessionId : null
  }

  unregister(sessionId: string): void {
    const e = this.entries.get(sessionId)
    if (e) e.disposed = true
    this.entries.delete(sessionId)
    if (this.entries.size === 0 && this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  stop(): void {
    for (const e of this.entries.values()) e.disposed = true
    this.entries.clear()
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  /** The rollout paths already claimed — passed as findRollout's excludePaths so two sessions never claim the same file
   *  (the same device as rolling's claimedRollouts). self is left out so an entry does not exclude its own path. */
  private claimed(self: Entry): string[] {
    const out: string[] = []
    for (const e of this.entries.values())
      if (e !== self && e.rolloutPath) out.push(e.rolloutPath)
    return out
  }

  private ensureTicker(): void {
    if (this.ticker) return
    this.ticker = setInterval(() => void this.tick(), POLL_MS)
  }

  private async tick(): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      try {
        await this.step(entry)
      } catch (err) {
        // One session's failure must not stop the others
        this.deps.log(
          `codex rollout watch error session=${entry.sessionId}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  private async step(entry: Entry): Promise<void> {
    if (entry.disposed) return
    if (entry.contextSeed) {
      const seeded = await entry.contextSeed
      entry.contextSeed = null
      if (entry.disposed) return
      // Only fills a gap — a batch already read is newer than the file's state at attach time
      if (entry.context === null) entry.context = seeded
    }
    if (!entry.tail) {
      const account = this.deps.getAccount(entry.accountId)
      if (!account) return
      const found = await findRollout({
        configDir: account.configDir,
        cwd: entry.cwd,
        since: entry.since,
        now: this.now,
        excludePaths: this.claimed(entry)
      })
      if (entry.disposed || !found) return
      // Another session can claim it first across the await — re-check so one rollout ends up owned by exactly one
      // session (mirroring codexRolling's re-check for the same reason). Both paths were built by findRollout, so the strings match.
      if (this.claimed(entry).includes(found.path)) return
      entry.rolloutPath = found.path
      entry.codexSessionId = found.sessionId
      entry.tail = new JsonlTail(found.path)
      this.deps.log(`codex rollout watch mapped session=${entry.sessionId} path=${found.path}`)
      return // End this step() having only mapped, without reading — the next tick's read() is still that JsonlTail's
      // first call, so it reads the whole file from offset 0. Deferring does not narrow the range read, so it does not
      // filter out past turns — this delay has no practical effect.
    }
    const r = await entry.tail.read()
    if (!r || entry.disposed) return
    if (r.restarted) {
      // State read from a recreated file has nothing to do with the previous file (same rule as
      // CodexRolloutTail.read)
      entry.limits = null
      entry.context = null
    }
    // One read, three answers. entry.limits is handed in so the windows survive a batch that carries
    // none — the credit-balance token_count codex writes the moment a limit hits is exactly that case.
    const limits = limitStateFromLines(r.lines, this.now(), entry.limits)
    if (limits) entry.limits = limits
    entry.context = contextFromLines(r.lines, entry.context)
    let hit = false
    for (const line of r.lines) if (isTaskComplete(line)) hit = true
    if (hit && entry.notifyTurns && entry.rolloutPath)
      this.deps.onTurnComplete(entry.sessionId, entry.rolloutPath)
  }
}
