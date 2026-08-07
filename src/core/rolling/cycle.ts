// State machine that makes only the rolling-cycle decisions. No timers, no side effects — main owns those.

export type CycleAction =
  | { type: 'roll'; toIndex: number }
  | { type: 'wait'; retryAt: number }

export class RollCycle {
  private idx = 0
  private streak = 0

  constructor(
    private count: number, // number of rolling accounts (>= 1: 1 means single-account auto-resume)
    private waitMs: number = 15 * 60_000,
    private now: () => number = Date.now
  ) {}

  get currentIndex(): number {
    return this.idx
  }

  /** Limit detected -> roll to the next account, unless the consecutive-block streak is a multiple of the account count (a whole cycle blocked), in which case instruct a wait */
  onLimit(): CycleAction {
    this.streak++
    if (this.streak % this.count === 0) return { type: 'wait', retryAt: this.now() + this.waitMs }
    return { type: 'roll', toIndex: (this.idx + 1) % this.count }
  }

  /** Wait finished -> roll to the next account (the streak is kept — if it keeps getting blocked after
   *  this, it waits again at the next multiple).
   *  Note: the coordinator now decides the target and the time itself via planRetry, based on the reset
   *  time, so this method and the retryAt/waitMs arguments of the wait action are not called from
   *  rolling.ts. They are kept to document and test the unit contract (the streak cycling rule). */
  onWaitElapsed(): CycleAction {
    return { type: 'roll', toIndex: (this.idx + 1) % this.count }
  }

  /** Pin the current index after a successful roll (spawn complete) */
  advanceTo(index: number): void {
    this.idx = index
  }

  /** No limit detected for 60s after the switch (working normally) — reset the consecutive-block streak (the timer is owned by the caller) */
  onHealthy(): void {
    this.streak = 0
  }
}
