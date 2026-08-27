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

  /** The account was observed working, so whatever was recorded about it is wrong or spent.
   *
   *  **Exactly how far this valve reaches.** The coordinators call it from their healthy timers, and a
   *  healthy timer is armed once per arrival on an account (a roll, or an in-place resume) and never
   *  re-armed afterwards. So a false record is torn up only when it lands while some chain is inside its
   *  ~60-second window right after arriving on that account. That is the window in which a replayed or
   *  misread limit phrase actually fires, which is why the valve is placed there.
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
   *  for every chain, unless one of them happens to arrive on that account. */
  clear(accountId: string): void {
    this.byAccount.delete(accountId)
  }
}
