// The session scheduler coordinator. Once a session starts, it periodically types a command into the
// PTY according to the rule registered for it (4 modes). The pure decision (the next fire time) lives
// in core/scheduler/rule and every side effect is injected through deps — it does not depend on
// electron, so it is verified with vitest. The wiring is in ipc.ts and index.ts.
import type { SessionInfo, SchedStateEvent, ScheduleConfig, Provider } from '../core/types'
import { nextFireAt } from '../core/scheduler/rule'
import { extractStatusLineSession } from '../core/usage/statusline'
import { PROVIDER_META } from '../core/providers/meta'

const TICK_MS = 15_000 // how often the fire time and metadata learning are checked (the same as rolling)
const ENTER_DELAY_MS = 150 // the gap between the command text and Enter (the rolling convention — time for the TUI to digest the paste)

export interface SchedulerDeps {
  write(sessionId: string, data: string): void
  readStatusPayload(sessionId: string): Promise<unknown | null>
  send(channel: 'session:schedState', payload: unknown): void
  log(message: string): void
  persistConfig?: (sessionKey: string, config: ScheduleConfig) => void // saved once, when the session id is learned
  deleteConfig?: (sessionKey: string) => void // deletes the persisted entry when the schedule is turned off
  /** The codex session id of a live session, or null while the scan has not mapped its rollout yet.
   *
   *  **codex's counterpart to readStatusPayload.** codex has no statusLine, but its rollout watcher
   *  scans for the rollout file of every codex session and that scan (findRollout) answers path and
   *  session id together — CodexRolloutWatcher.codexSessionIdFor is that value. Without it a codex
   *  schedule only lives as long as its session: nothing is ever written under a key, so the next
   *  resume of that conversation cannot pre-fill it.
   *
   *  Synchronous, unlike readStatusPayload, because the watcher answers from what its poll already
   *  collected. Absent (no watcher wired) codex keeps the old behaviour — no learning, no persistence. */
  codexSessionId?: (sessionId: string) => string | null
  now?: () => number
}

interface Entry {
  liveId: string // the app session id — changed by rekey on a rolling switch
  config: ScheduleConfig
  nextAt: number
  pending: boolean // the fire time has arrived and we are waiting for busy to clear — being a boolean, overlapping rounds collapse into one
  busy: boolean // taps ipc's session:busy (BusyScanner)
  suppressed: boolean // suppresses firing during a rolling resume window (the trust prompt, waiting, switching) — handleRollState
  provider: Provider // decides where learnKey reads the session id from — claude's statusLine, codex's rollout watcher
  sessionKey: string | null // the conversation's own session id — the scheduler.json key. Null until learned (or supplied by a resume)
  learnable: boolean // whether this session's key can be learned at all — see register for what each provider needs
  learning: boolean // guards against overlapping readStatusPayload calls
  enterTimer: ReturnType<typeof setTimeout> | null
  disposed: boolean
}

export class SchedulerCoordinator {
  private entries = new Map<string, Entry>() // liveId → entry
  private ticker: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  constructor(private deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Called by ipc right after a spawn that carries a schedule — computes the next fire time and starts
   *  tracking. On the resume-restore path resumeSessionId *is* the claude session id, so the key is
   *  known immediately (no re-persisting needed).
   *  The provider default of 'claude' is for compatibility with existing call sites and tests — for codex
   *  ipc.ts passes providerOf(account) explicitly. A provider that does not use statusLine is
   *  learnable=false: it works only while the session is alive, and this coordinator never learns its
   *  key. The resume modal path is the exception — ipc.ts persists straight into schedulerConfig.set
   *  keyed by resumeSessionId (ipc.ts's spawnSession), so codex gets pre-filled there too. "No resume restore" is a
   *  statement about the inside of this coordinator only. */
  register(info: SessionInfo, provider: Provider = 'claude'): void {
    if (!info.schedule) return
    const nextAt = nextFireAt(info.schedule.rule, this.now())
    if (!Number.isFinite(nextAt)) return // a rule isValidRule should have rejected — do not register it
    const entry: Entry = {
      liveId: info.id,
      config: info.schedule,
      nextAt,
      pending: false,
      busy: false,
      suppressed: false,
      provider,
      sessionKey: info.resumeSessionId ?? null,
      // claude learns from its statusLine payload, which is always there. codex has no statusLine but
      // its rollout watcher knows the id — it is learnable exactly when that accessor was wired.
      learnable:
        PROVIDER_META[provider].usesStatusLine ||
        (provider === 'codex' && this.deps.codexSessionId !== undefined),
      learning: false,
      enterTimer: null,
      disposed: false
    }
    this.entries.set(info.id, entry)
    this.ensureTicker()
    this.pushState(entry)
    this.deps.log(
      `schedule registered session=${info.id} rule=${JSON.stringify(info.schedule.rule)} nextAt=${new Date(nextAt).toISOString()}`
    )
  }

  /** Taps ipc's session:busy changes — on the transition to idle a backed-up round is sent immediately
   *  (without waiting for a tick). Unlike 'none' (handleRollState) this fires straight away: busy
   *  clearing means the user has just finished typing, so there is no risk of the PTY being in the middle
   *  of receiving some other automated input. */
  handleBusy(sessionId: string, busy: boolean): void {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.disposed) return
    entry.busy = busy
    if (!busy && entry.pending && !entry.suppressed) this.fire(entry)
  }

  /** Taps the rolling resume window (session:rollState) — the firing-suppression policy is owned here, in
   *  the coordinator (this method is the test target, not the wiring). Dropping pending on re-key (the
   *  minimal fix) is not enough on its own: it cannot stop a new round coming due during the resume
   *  window, which lasts up to 120 seconds after a respawn (auto-accepting the trust prompt plus
   *  statusline polling) — so firing is deferred for the whole of that window here. */
  handleRollState(ev: { sessionId: string; state: string }): void {
    const entry = this.entries.get(ev.sessionId)
    if (!entry || entry.disposed) return
    switch (ev.state) {
      case 'switching':
      case 'trust':
      case 'waiting':
      case 'nudged':
        // nudged is suppressed too now. It used to be excluded because rolling's reset-anchor verdict
        // (resetAnchorCheck) did not publish pushState('none') after a nudge: suppressing here would then
        // latch forever, because the signal that releases it would never arrive. resetAnchorCheck has
        // since been fixed to publish 'none' right after sending Enter, following the same pattern as
        // sendPrompt, so that risk is gone — and the remaining risk, a schedule firing inside the window
        // where a nudge writes its prompt to the PTY and sends Enter 150ms later, is now suppressed just
        // like every other resume window.
        entry.suppressed = true
        return
      case 'none':
        // Only lift the suppression — do not fire immediately. rolling.sendPrompt() and
        // resetAnchorCheck() were fixed to publish 'none' *after* actually sending the Enter for the
        // resume prompt or the nudge prompt, but if that prompt is still being submitted to the PTY (the
        // same input line) and we write here immediately, the two inputs merge into one line. A backed-up
        // round is handled by the next tick (≤15 seconds), which sees pending and suppressed —
        // deliberately different from handleBusy's immediate fire on the transition to idle (which is
        // both safe and needs to be responsive).
        // A side benefit: on session exit, ipc.ts's exit order (rolling/codexRolling.handleExit →
        // scheduler.handleExit) has the first two synchronously emit disposeChain → pushState('none')
        // first. With no immediate firing here, the problem where scheduler.handleExit ran in between and
        // fired uselessly at an entry that had not been disposed yet goes away with it.
        entry.suppressed = false
        return
      default:
        return // unknown state values are ignored
    }
  }

  handleExit(e: { sessionId: string }): void {
    const entry = this.entries.get(e.sessionId)
    if (entry) this.dispose(entry)
  }

  /** A rolling switch (session:rolled) — moves the entry to the new session id. The claude session id is
   *  the same throughout the relay, so the persistence key stays valid. */
  rekey(oldId: string, newId: string): void {
    const entry = this.entries.get(oldId)
    if (!entry || entry.disposed) return
    this.entries.delete(oldId)
    entry.liveId = newId
    entry.busy = false // the new PTY is judged again by its own OSC (the same reason as the busy drop in App.tsx)
    // A round backed up across the roll is dropped — the fire time passing while busy (hence pending) and
    // then a roll happening is a common combination, and keeping it alive would let a schedule firing
    // overlap the awaitingReady resume window right after the respawn (auto-accepting the trust prompt
    // plus injecting the prompt) and scramble the input. This is consistent with the "a missed round is
    // ignored" policy.
    entry.pending = false
    // suppressed is not reset — the order is: the 'switching' event arrives under the old id and turns
    // suppression on, then this rekey comes, then roll() re-publishes (reattaches) the same state under
    // the new id. So suppression has to hold across the roll. Setting it back to false here would leave a
    // sliver of time, before the re-published event arrives, in which suppression is off and a tick could
    // fire.
    this.entries.set(newId, entry)
    this.deps.send('session:schedState', { sessionId: oldId, state: 'off' } satisfies SchedStateEvent)
    this.pushState(entry)
    this.deps.log(`schedule rekeyed ${oldId} → ${newId}`)
  }

  /** The banner's off button (the scheduler.disable IPC) — disposes the entry and deletes the persisted config */
  disable(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    if (entry.sessionKey) this.deps.deleteConfig?.(entry.sessionKey)
    this.dispose(entry)
    this.deps.log(`schedule disabled session=${sessionId}`)
  }

  /** App-shutdown cleanup (will-quit) */
  stop(): void {
    for (const entry of [...this.entries.values()]) this.dispose(entry)
  }

  // ---- internals -------------------------------------------------------

  private tick(): void {
    for (const entry of this.entries.values()) {
      if (entry.disposed) continue
      try {
        if (!entry.sessionKey && !entry.learning && entry.learnable) void this.learnKey(entry)
        if (this.now() >= entry.nextAt) {
          // Interval mode is recomputed from the current time too — the simple rule is that however late
          // we are, the next round just slides back by that much. register() has already let through only
          // valid rules and nobody mutates this object afterwards, so there is no path to NaN here — the
          // recomputation itself needs no defending. Even so, if an unexpected exception does come out,
          // the catch below isolates this entry alone and does not starve the rest of the tick.
          entry.nextAt = nextFireAt(entry.config.rule, this.now())
          entry.pending = true // set even while suppressed — the round is not lost and is sent once after suppression lifts
          this.pushState(entry)
        }
        if (entry.pending && !entry.busy && !entry.suppressed) this.fire(entry)
      } catch (err) {
        // Per-entry isolation — one entry's exception must not starve the remaining entries on this tick,
        // nor escape the setInterval callback and shake the main process. The entry is not disposed — the
        // failure may be transient, so it is tried again on the next tick.
        this.deps.log(
          `schedule tick error session=${entry.liveId}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  /** Learns the conversation's own session id and persists it once. Which file that id comes out of is
   *  the only thing that differs per provider.
   *
   *  claude reads its statusLine payload. **codex never touches that file** — it has no statusLine, so
   *  readStatusPayload would return null forever, and before this branch existed every scheduled codex
   *  session wasted every 15-second tick reading a file that does not exist and swallowing the ENOENT.
   *  Its id comes from the rollout watcher instead, which scans for the rollout of every codex session
   *  and gets the id together with the path (`codexSessionId` in SchedulerDeps).
   *
   *  A null answer is "not yet", not "never": the rollout appears a moment after spawn and the statusLine
   *  payload lands on the first render, so tick() simply asks again next time. */
  private async learnKey(entry: Entry): Promise<void> {
    entry.learning = true
    try {
      const learned =
        entry.provider === 'codex'
          ? (this.deps.codexSessionId?.(entry.liveId) ?? null)
          : extractStatusLineSession(await this.deps.readStatusPayload(entry.liveId)).sessionId
      // disposed/sessionKey are re-checked because the claude branch above awaits — a dispose or a
      // competing learn can land in that window. The codex branch is synchronous and cannot, but the
      // check costs nothing and the two branches are better off answering to the same rule.
      if (!learned || entry.disposed || entry.sessionKey) return
      entry.sessionKey = learned
      this.deps.persistConfig?.(learned, entry.config)
    } finally {
      entry.learning = false
    }
  }

  private fire(entry: Entry): void {
    entry.pending = false
    const liveId = entry.liveId // captured so a rekey or dispose before Enter does not make us write to a stale session
    this.deps.write(liveId, entry.config.command)
    entry.enterTimer = setTimeout(() => {
      entry.enterTimer = null
      if (!entry.disposed && entry.liveId === liveId) this.deps.write(liveId, '\r')
    }, ENTER_DELAY_MS)
    this.deps.log(`schedule fired session=${liveId} nextAt=${new Date(entry.nextAt).toISOString()}`)
  }

  private pushState(entry: Entry): void {
    this.deps.send('session:schedState', {
      sessionId: entry.liveId,
      state: 'active',
      nextAt: new Date(entry.nextAt).toISOString(),
      rule: entry.config.rule
    } satisfies SchedStateEvent)
  }

  private dispose(entry: Entry): void {
    if (entry.disposed) return
    entry.disposed = true
    if (entry.enterTimer) clearTimeout(entry.enterTimer)
    this.entries.delete(entry.liveId)
    this.deps.send('session:schedState', { sessionId: entry.liveId, state: 'off' } satisfies SchedStateEvent)
    if (this.entries.size === 0 && this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  private ensureTicker(): void {
    if (!this.ticker) this.ticker = setInterval(() => this.tick(), TICK_MS)
  }
}
