// The session scheduler coordinator. Once a session starts, it periodically hands a command to the
// session through its driver according to the rule registered for it (4 modes). The pure decision (the
// next fire time) lives in core/scheduler/rule and every side effect is injected through deps — it does
// not depend on electron, so it is verified with vitest. The wiring is in ipc.ts and index.ts.
import type { SessionInfo, SchedStateEvent, ScheduleConfig, Provider, SessionKind } from '../core/types'
import { nextFireAt } from '../core/scheduler/rule'
import { extractStatusLineSession } from '../core/usage/statusline'
import { PROVIDER_META } from '../core/providers/meta'
import { sessionKindOf } from '../core/sessions/kind'

const TICK_MS = 15_000 // how often the fire time and metadata learning are checked (the same as rolling)

// A CLI that refuses a turn is usually mid-turn for a moment (a pty write racing a busy prompt, a chat
// adapter still finishing the previous send) and a short retry clears it. A CLI that refuses forever
// (a dead session, a permanent error) must not be spammed every tick, so the round is dropped after
// this many attempts and picked up fresh at the next scheduled time.
export const MAX_REJECTIONS_PER_ROUND = 3

export interface SchedulerDeps {
  /** One command to the session, through its driver (sessionDriver.ts) — a pty gets the text and an
   *  Enter, a chat session gets one send. Rejects when the CLI refused it or the session is gone. */
  deliver(sessionId: string, text: string): Promise<void>
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
  /** A chat session's protocol thread id, or null until the adapter has reported it. */
  chatThreadId?: (sessionId: string) => string | null
  now?: () => number
}

interface Entry {
  liveId: string // the app session id — changed by rekey on a rolling switch
  config: ScheduleConfig
  nextAt: number
  pending: boolean // the fire time has arrived and we are waiting for busy to clear — being a boolean, overlapping rounds collapse into one
  // Whether the session is in the middle of something. The two kinds report it from different places and
  // ipc.ts feeds both into handleBusy: a terminal session's comes from session:busy (the OSC scanner the
  // BusyScanner runs over the pty's output), a chat session's from the chat protocol's own `status` event
  // (anything but 'idle' is busy, a question card included).
  busy: boolean
  suppressed: boolean // suppresses firing during a rolling resume window (the trust prompt, waiting, switching) — handleRollState
  provider: Provider // decides where learnKey reads the session id from — claude's statusLine, codex's rollout watcher
  kind: SessionKind // decides where learnKey reads the session id from ahead of provider — a chat session always uses chatThreadId
  sessionKey: string | null // the conversation's own session id — the scheduler.json key. Null until learned (or supplied by a resume)
  learnable: boolean // whether this session's key can be learned at all — see register for what each provider needs
  learning: boolean // guards against overlapping readStatusPayload calls
  rejections: number // deliver refusals within the current pending round — reset when a new round comes due, on a successful fire, on a rekey, and on a round drop
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
    const kind = sessionKindOf(info)
    const entry: Entry = {
      liveId: info.id,
      config: info.schedule,
      nextAt,
      pending: false,
      busy: false,
      suppressed: false,
      provider,
      kind,
      sessionKey: info.resumeSessionId ?? null,
      // A chat session's key is its protocol thread id, whatever the provider — it is learnable exactly
      // when the adapter accessor was wired. A terminal session keeps the old rule: claude learns from
      // its statusLine payload, which is always there; codex has no statusLine but its rollout watcher
      // knows the id — it is learnable exactly when that accessor was wired.
      learnable:
        kind === 'chat'
          ? this.deps.chatThreadId !== undefined
          : PROVIDER_META[provider].usesStatusLine || (provider === 'codex' && this.deps.codexSessionId !== undefined),
      learning: false,
      rejections: 0,
      disposed: false
    }
    this.entries.set(info.id, entry)
    this.ensureTicker()
    this.pushState(entry)
    this.deps.log(
      `schedule registered session=${info.id} rule=${JSON.stringify(info.schedule.rule)} nextAt=${new Date(nextAt).toISOString()}`
    )
  }

  /** Taps the busy signal of either kind — a terminal session's session:busy, a chat session's protocol
   *  `status` — and on the transition to idle a backed-up round is sent immediately (without waiting for
   *  a tick). Unlike 'none' (handleRollState) this fires straight away, because for both kinds the clear
   *  names a moment that is safe to send into: on a pty the person has just finished typing, so nothing
   *  else is part-way down the same input line; on a chat session the CLI itself reported that it is idle,
   *  so no turn and no question card is in flight and a new turn is exactly what it is waiting for. */
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
    entry.rejections = 0 // the new session is judged on its own
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
          // A fresh round gets the full three-attempt budget. This branch runs exactly once per round, so
          // it is the one place that can make the counter mean what its name says. Without it a round that
          // ended part-refused (busy held it past the next due time, so its remaining attempts were never
          // spent) would lend its refusals to the round that follows, and the new one would be dropped
          // early for a CLI that has refused nothing since.
          entry.rejections = 0
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
   *  A chat session never touches the statusLine file either — stream-json writes none — its id comes
   *  from the adapter's `ready` instead (`chatThreadId` in SchedulerDeps), the same for every provider.
   *
   *  A null answer is "not yet", not "never": the rollout appears a moment after spawn and the statusLine
   *  payload lands on the first render, so tick() simply asks again next time. */
  private async learnKey(entry: Entry): Promise<void> {
    entry.learning = true
    try {
      const learned =
        entry.kind === 'chat'
          ? (this.deps.chatThreadId?.(entry.liveId) ?? null)
          : entry.provider === 'codex'
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
    // Captured: a rekey or dispose while the send is in flight must not touch the moved entry. Both
    // continuations below check it — a stale success is as much a hazard as a stale rejection, since it
    // would otherwise zero out rejections a newer round (under the new liveId) has since accumulated.
    const liveId = entry.liveId
    void this.deps.deliver(liveId, entry.config.command).then(
      () => {
        if (entry.disposed || entry.liveId !== liveId) return
        entry.rejections = 0
        this.deps.log(`schedule fired session=${liveId} nextAt=${new Date(entry.nextAt).toISOString()}`)
      },
      (err: unknown) => {
        if (entry.disposed || entry.liveId !== liveId) return
        entry.rejections += 1
        const reason = err instanceof Error ? err.message : String(err)
        if (entry.rejections < MAX_REJECTIONS_PER_ROUND) {
          entry.pending = true // the round is still owed; the next tick tries again
          this.deps.log(`schedule send refused session=${liveId} (${entry.rejections}/${MAX_REJECTIONS_PER_ROUND}): ${reason}`)
        } else {
          entry.rejections = 0
          this.deps.log(`schedule round dropped session=${liveId} after ${MAX_REJECTIONS_PER_ROUND} refusals: ${reason}`)
        }
      }
    )
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
