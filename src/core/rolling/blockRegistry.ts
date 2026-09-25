// Block records shared across rolling chains, keyed by account id.
//
// Why this exists: chain.recovery is indexed by a chain's own position, so three workers rolling
// through the same accounts each had to hit the limit on every account themselves before skipping it
// (SPEC §11.2/6 — the pile-up). The fact being shared is the reset time the provider itself reported,
// not a judgement, so one chain's discovery is usable by the others.
//
// What it deliberately does NOT replace: a chain's own recovery array. "Did *this* chain record a
// block on its current account" is a per-chain question (claudeCoordinator.ts's limitEvidence) and answering it
// from another chain's discovery would spread a false positive into a session that saw nothing.
//
// No timers, no I/O, no logging — the coordinators own those. `now` is passed in for the same reason
// the rest of core/rolling takes it: so tests can drive time.
import { blockedUntil, laterBlock, type BlockRecord } from './retry'

/** What onChange listeners receive: the account that changed, its new value (null on clear), and when
 *  the change happened. Also the shape of the client message Task 3 exchanges between app and Host. */
export type BlockChangeEvent = { accountId: string; rec: BlockRecord | null; at: number }

export class BlockRegistry {
  private byAccount = new Map<string, BlockRecord>()
  // Remembers when each account was last cleared, local or absorbed. Its only job is absorb()'s
  // staleness check below — a record() from this same process is never filtered by it, so a clear
  // followed by a fresh local record still works.
  private clearedAt = new Map<string, number>()
  private listeners = new Set<(e: BlockChangeEvent) => void>()

  /** How many records are held. Tests read it to prove expired entries do not pile up. */
  get size(): number {
    return this.byAccount.size
  }

  /** Subscribe to every record()/clear() (not absorb()/absorbClear() — those are echoes of a change
   *  this same registry already announced once, on the process that made it). Returns the unsubscribe. */
  onChange(fn: (e: BlockChangeEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: BlockChangeEvent): void {
    // A listener's own bug must never break record()/clear() for the caller, nor stop the other
    // listeners from being told.
    for (const fn of this.listeners) {
      try {
        fn(e)
      } catch {
        // swallowed — see above
      }
    }
  }

  private sweep(now: number): void {
    // Expired entries are dropped on write rather than on a timer: the map holds at most one entry per
    // registered account, so the sweep is trivial, and a timer here would be state this class must own.
    for (const [id, held] of this.byAccount)
      if (blockedUntil(held) <= now) this.byAccount.delete(id)
  }

  private merge(accountId: string, rec: BlockRecord, now: number): BlockRecord {
    this.sweep(now)
    const merged = laterBlock(this.byAccount.get(accountId) ?? null, rec) ?? rec
    this.byAccount.set(accountId, merged)
    return merged
  }

  /** Records that this account is blocked. An existing record is kept when it blocks for longer.
   *  Notifies onChange with the merged value. */
  record(accountId: string, rec: BlockRecord, now: number): void {
    const merged = this.merge(accountId, rec, now)
    this.emit({ accountId, rec: merged, at: now })
  }

  /** What is known about this account right now. An expired record answers null — the caller asks
   *  "is it blocked", and a record whose reset has passed is not a block any more. */
  get(accountId: string, now: number): BlockRecord | null {
    const rec = this.byAccount.get(accountId)
    if (!rec) return null
    return blockedUntil(rec) <= now ? null : rec
  }

  /** The account was observed working, so whatever was recorded about it is wrong or spent.
   *
   *  **Exactly how far this valve reaches.** The coordinators call it once per arrival on an account (a
   *  roll, or an in-place resume) and never again until the next arrival. For a pty chain that is the
   *  healthy timer, armed at the arrival and never re-armed. A chat chain has no such timer — it
   *  declares health off every turn that completes with no limit in it (spec §14.6) — so the same rule
   *  is kept by a latch at its consumption site: **a chat chain clears here on its first clean completed
   *  turn after a roll or an in-place resume, and its later turns release only its own state** (the
   *  cycle's streak, that chain's own record, its inPlaceUsed). Either way a false record is torn up
   *  only when it lands while some chain is in the window right after arriving on that account, which is
   *  the window in which a replayed or misread limit actually fires — which is why the valve is there.
   *
   *  **What "observed working" is worth at each caller.** codex's settleInPlace checks evidence of work
   *  (the rollout grew, so a turn ran) and a chat chain's completed turn is that same direct claim. The
   *  pty timers fire after 60 seconds in which no limit was detected, which is the weaker one — so a
   *  *true* record can be erased by a chain that arrived on the account and has not done anything on it
   *  yet, and the chains behind it each pay a respawn there.
   *
   *  **What it does not reach:** a chain that has been working on the account for an hour. Its healthy
   *  timer fired long ago, and once a false record stands, pickAvailable steers every chain away from the
   *  account — so nobody arrives on it, nobody's healthy timer covers it, and the record survives to its
   *  recorded reset time for *every* chain. Widening the valve (clearing on the 15-second tick, say) is a
   *  separate design decision, not an oversight: the same sweep would erase records that are legitimate
   *  and bring the pile-up back, so it needs its own measurement.
   *
   *  **What bounds the damage meanwhile.** Two things, both outside this class. A record whose reset time
   *  could not be parsed carries at=null and expires after RETRY_FALLBACK_MS (15 minutes, see
   *  blockedUntil) — the blind case is the short case. And this registry is memory only, so restarting
   *  the app drops every record. What is unbounded is a false record carrying a real weekly reset: days,
   *  for every chain, unless one of them happens to arrive on that account.
   *
   *  Remembers `now` as this account's clear time (see `clearedAt` above) and notifies onChange with
   *  null, so the other process learns to drop its own copy too (Task 3). `now` stays optional — the
   *  existing pty/chat callers above call this with no time in hand, and adding one to them is outside
   *  this class's remit — but a caller that has `now` should pass it for a deterministic clear time. */
  clear(accountId: string, now: number = Date.now()): void {
    this.byAccount.delete(accountId)
    this.clearedAt.set(accountId, now)
    this.emit({ accountId, rec: null, at: now })
  }

  /** Merges a record received from the other process the same way record() does (the longer block
   *  wins), but never fires onChange — the record is already known to whoever sent it, so notifying
   *  would just echo it back. A record whose `since` is at or before this account's remembered clear
   *  time is a stale observation from before that clear (the clear may not have reached the sender yet)
   *  and is ignored, so it cannot resurrect a block that is already known to be over. */
  absorb(accountId: string, rec: BlockRecord, now: number): void {
    const clearedAt = this.clearedAt.get(accountId)
    if (clearedAt !== undefined && rec.since <= clearedAt) return
    this.merge(accountId, rec, now)
  }

  /** Clears because the other process cleared, without firing onChange (same no-echo reasoning as
   *  absorb()). Remembers `at` as this account's clear time exactly like a local clear() does, so a
   *  remote record older than it is ignored by absorb() regardless of which side did the clearing. */
  absorbClear(accountId: string, at: number): void {
    this.byAccount.delete(accountId)
    this.clearedAt.set(accountId, at)
  }
}
