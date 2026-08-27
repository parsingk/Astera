// Block records shared across rolling chains, keyed by account id.
//
// Why this exists: chain.recovery is indexed by a chain's own position, so three workers rolling
// through the same accounts each had to hit the limit on every account themselves before skipping it
// (SPEC §11.2/6 — the pile-up). The fact being shared is the reset time the provider itself reported,
// not a judgement, so one chain's discovery is usable by the others.
//
// What it deliberately does NOT replace: a chain's own recovery array. "Did *this* chain record a
// block on its current account" is a per-chain question (rolling.ts's limitEvidence) and answering it
// from another chain's discovery would spread a false positive into a session that saw nothing.
//
// No timers, no I/O, no logging — the coordinators own those. `now` is passed in for the same reason
// the rest of core/rolling takes it: so tests can drive time.
import { blockedUntil, laterBlock, type BlockRecord } from './retry'

export class BlockRegistry {
  private byAccount = new Map<string, BlockRecord>()

  /** How many records are held. Tests read it to prove expired entries do not pile up. */
  get size(): number {
    return this.byAccount.size
  }

  /** Records that this account is blocked. An existing record is kept when it blocks for longer. */
  record(accountId: string, rec: BlockRecord, now: number): void {
    // Expired entries are dropped on write rather than on a timer: the map holds at most one entry per
    // registered account, so the sweep is trivial, and a timer here would be state this class must own.
    for (const [id, held] of this.byAccount)
      if (blockedUntil(held) <= now) this.byAccount.delete(id)
    const merged = laterBlock(this.byAccount.get(accountId) ?? null, rec)
    if (merged) this.byAccount.set(accountId, merged)
  }

  /** What is known about this account right now. An expired record answers null — the caller asks
   *  "is it blocked", and a record whose reset has passed is not a block any more. */
  get(accountId: string, now: number): BlockRecord | null {
    const rec = this.byAccount.get(accountId)
    if (!rec) return null
    return blockedUntil(rec) <= now ? null : rec
  }

  /** The account was observed working, so whatever was recorded about it is wrong or spent. This is
   *  the safety valve for a false positive: without it, one bad reading would keep every other chain
   *  off an account that is demonstrably fine until its recorded reset time passed. */
  clear(accountId: string): void {
    this.byAccount.delete(accountId)
  }
}
