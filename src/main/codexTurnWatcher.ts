// Detects turn completion in codex sessions from the rollout file.
//
// For Claude the Stop hook reports it, but codex has no hook system. Instead the rollout jsonl records
// event_msg/task_complete once per turn (verified across 59 files and 156 turns).
//
// Why this is independent of rolling: Slack-only sessions with rolling turned off have to be detected too.
// Bolting it onto CodexRollingCoordinator would create a responsibility mismatch — "the rolling coordinator tracks
// sessions that are not rolling" — and clash with the existing rolling design. When rolling is on, two tails run
// over the same file, which is negligible because reads are incremental by offset.
import type { Account, SessionInfo } from '../core/types'
import { JsonlTail } from '../core/rolling/jsonlTail'
import { findRollout } from '../core/rolling/codexLocate'

const POLL_MS = 1_000 // Same value as LOCATE_POLL_MS in codexRolling.ts (which is not exported there)

interface Entry {
  sessionId: string
  accountId: string
  cwd: string
  since: number // Spawn time — the cutoff findRollout uses to filter out earlier sessions' files
  excludePaths: string[] // Exclusion paths supplied by the register() caller (e.g. an old rollout copied over right after a roll)
  rolloutPath: string | null
  tail: JsonlTail | null
  disposed: boolean
}

export interface CodexTurnDeps {
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

export class CodexTurnWatcher {
  private entries = new Map<string, Entry>()
  private ticker: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  constructor(private deps: CodexTurnDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Registers only codex sessions that have Slack notifications enabled. The caller determines the provider and passes it in.
   *  excludePaths: on re-registration right after a rolling switch, this drops files from findRollout's candidates that
   *  look like legitimate candidates but are actually dead — such as the old rollout copied into the target account
   *  just before the roll (same reason as the startLocate exclude in codexRolling). */
  register(info: SessionInfo, excludePaths: string[] = []): void {
    if (!this.deps.getAccount(info.accountId)) {
      this.deps.log(`codex turn watch registration cancelled — no such account session=${info.id}`)
      return
    }
    this.entries.set(info.id, {
      sessionId: info.id,
      accountId: info.accountId,
      cwd: info.cwd,
      since: this.now(),
      excludePaths,
      rolloutPath: null,
      tail: null,
      disposed: false
    })
    this.ensureTicker()
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
          `codex turn watch error session=${entry.sessionId}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  private async step(entry: Entry): Promise<void> {
    if (entry.disposed) return
    if (!entry.tail) {
      const account = this.deps.getAccount(entry.accountId)
      if (!account) return
      const found = await findRollout({
        configDir: account.configDir,
        cwd: entry.cwd,
        since: entry.since,
        now: this.now,
        excludePaths: [...entry.excludePaths, ...this.claimed(entry)]
      })
      if (entry.disposed || !found) return
      // Another session can claim it first across the await — re-check so one rollout ends up owned by exactly one
      // session (mirroring codexRolling's re-check for the same reason). Both paths were built by findRollout, so the strings match.
      if (this.claimed(entry).includes(found.path)) return
      entry.rolloutPath = found.path
      entry.tail = new JsonlTail(found.path)
      this.deps.log(`codex turn watch mapped session=${entry.sessionId} path=${found.path}`)
      return // End this step() having only mapped, without reading — the next tick's read() is still that JsonlTail's
      // first call, so it reads the whole file from offset 0. Deferring does not narrow the range read, so it does not
      // filter out past turns — this delay has no practical effect.
    }
    const r = await entry.tail.read()
    if (!r || entry.disposed) return
    let hit = false
    for (const line of r.lines) if (isTaskComplete(line)) hit = true
    if (hit && entry.rolloutPath) this.deps.onTurnComplete(entry.sessionId, entry.rolloutPath)
  }
}
