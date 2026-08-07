// The account rolling coordinator. Limit detection → transcript copy → kill → --resume on the next
// account → auto-accepting the trust prompt → automatically sending "carry on with the work". The pure
// decisions live in core/rolling and every side effect is injected through deps — it does not depend on
// electron, so it is verified with vitest. The wiring is in ipc.ts and index.ts.
import type { Account, SessionInfo, RollStateEvent, SessionUsage } from '../core/types'
import type { RollConfig } from '../core/rolling/config'
import {
  OutputScanner,
  findWaitChoice,
  hasWaitChoiceLabel,
  maskLimitPhrase
} from '../core/rolling/detect'
import { RollCycle } from '../core/rolling/cycle'
import { pickAvailable, planRetry, type BlockRecord, type RetryState } from '../core/rolling/retry'
import { copyTranscript } from '../core/rolling/transcript'
import { claudeHistoryStrategy } from '../core/history/strategies/claude'
import { parseStatusLinePayload, extractStatusLineSession } from '../core/usage/statusline'
import { lastActivityAt, readPendingWorkflowCount } from '../core/rolling/activity'
import {
  isIdleNotification,
  isUnknownNotificationType,
  type NotificationPayload
} from '../core/hooks/notification'
import { t, type Lang } from '../core/i18n'
import { ClaudeTranscriptTail } from '../core/rolling/claudeSignal'
import { parseResetTime } from '../core/rolling/resetTime'

const GATE_PCT = 90 // The bar for choosing which window goes into a block record — only the reset of a window exhausted at or above this is kept by recordRecovery (it is no longer used as a gate for accepting a limit phrase)
const FALLBACK_SILENCE_MS = 30_000 // the fallback trigger: five_hour at 100% plus this long with no output
const TICK_MS = 15_000 // how often metadata is refreshed and the fallback trigger checked
const READY_POLL_MS = 1_000 // how often statusline is polled after a respawn
const READY_FALLBACK_MS = 30_000 // the fallback that sends the prompt even without statusline (only when no trust prompt was detected)
const READY_TIMEOUT_MS = 120_000 // the deadline for giving up on the automatic prompt
const HEALTHY_MS = 60_000 // no limit detected for this long after a switch → reset the consecutive block count
const ENTER_DELAY_MS = 150 // the gap between the prompt text and Enter
const TRUST_ENTER_DELAY_MS = 400 // the gap between detecting the trust prompt and Enter
// Blind-spot detection: only the retrospective single-account reset-anchor verdict (3-b) remains. The
// multi-account real-time stall (3-a) was removed once the transcript began recording subagent limit
// errors directly, which achieved the same purpose — BLIND_PROBE_MIN_MS survives as the file-tree stat
// throttle for idleNudgeCheck.
const BLIND_PROBE_MIN_MS = 60_000 // the file-tree stat throttle
const RESET_GRACE_MS = 5 * 60_000 // how long to wait for the harness to resume itself after a reset — one prompt is harmless even if this misjudges
const IDLE_STALL_MS = 10 * 60_000 // a stall persisting this long after an (idle) Notification → nudge
const NUDGE_ECHO_GRACE_MS = 2_000 // the grace period that keeps the echo of a nudge's own prompt from being read as resumed activity
// The window in which a PTY limit phrase is ignored right after a roll. A --resume replays the whole
// conversation onto the screen, and that conversation contains the limit phrase that caused the roll.
// The awaitingReady cooldown cannot stop it — that flag is released the moment the automatic prompt is
// sent, and the prompt goes out as soon as the first statusline appears (measured: 4 seconds after the
// roll), while the replay is still streaming. Delaying the release of awaitingReady is not the answer
// because that flag also blocks tick, limitTailCheck and the fallback trigger — delaying it would
// equally delay catching "the account we just switched to is already exhausted" (measured: weekly=100
// detected 45 seconds after a switch). Holding back only the PTY path leaves transcript detection and
// the fallback trigger as the safety net.
const REPLAY_GRACE_MS = 60_000
// After matching a limit phrase without finding the choice number, keep looking in later chunks for this long
const CHOICE_WATCH_MS = 30_000

export interface RollingDeps {
  spawn(opts: {
    account: Account
    cwd: string
    resumeSessionId?: string
    rollAccountIds?: string[]
    slackNotify?: boolean
    bypassPermissions?: boolean
  }): SessionInfo
  write(sessionId: string, data: string): void
  kill(sessionId: string): void
  getAccount(id: string): Account | null
  readStatusPayload(sessionId: string): Promise<unknown | null>
  send(channel: 'session:rolled' | 'session:rollState', payload: unknown): void
  log(message: string): void
  lang: () => Lang // taken as a getter rather than a value so the latest language is used even after setLang
  persistConfig?: (claudeSessionId: string, config: RollConfig) => void // saves the rolling config
  copy?: (src: string, dest: string) => Promise<void> // for test injection — defaults to copyTranscript
  now?: () => number
  probeActivity?: (transcriptPath: string) => Promise<number | null> // for test injection — defaults to lastActivityAt
  readPending?: (transcriptPath: string) => Promise<number | null> // for test injection — defaults to readPendingWorkflowCount
}

interface Chain {
  accountIds: string[]
  prompt: string // the text sent on a rolling resume (user-specified, or the default t('rolling.continuePrompt'))
  cycle: RollCycle
  liveId: string // the app session id (changes on every roll)
  liveInfo: SessionInfo
  cwd: string
  scanner: OutputScanner
  claudeSessionId: string | null // the statusline session_id — the same throughout the relay
  transcriptPath: string | null // the path of the current live transcript
  lastOutputAt: number
  rolling: boolean // the re-trigger guard while a roll is running
  awaitingReady: boolean // true from a respawn until the automatic prompt (auto-accepting trust is limited to this window too)
  trustSeen: boolean
  waitTimer: ReturnType<typeof setTimeout> | null
  healthyTimer: ReturnType<typeof setTimeout> | null
  promptTimer: ReturnType<typeof setTimeout> | null
  trustTimer: ReturnType<typeof setTimeout> | null
  disposed: boolean
  // Per-account block records: index → a record, or none (null). Whenever we get blocked on an account,
  // the latest reset among that account's over-limit windows is kept. Expiry is decided by time — wiping
  // the lot per lap would forget a weekly exhaustion (valid for days) after one 60-second healthy period
  // or one wait firing, and switch back to that account.
  recovery: (BlockRecord | null)[]
  lastBlindProbeAt: number // the file-tree stat throttle — used by idleNudgeCheck (it survived the removal of 3-a)
  resetCheckAt: number | null // the scheduled time (ms) of the single-account reset anchor — prevents rescheduling the same time (3-b)
  resetTimer: ReturnType<typeof setTimeout> | null
  // The state-publication generation counter, incremented on every pushState. A deferred 'none' (the
  // 150ms Enter timers in sendPrompt and resetAnchorCheck) captures the generation at scheduling time; on
  // firing it publishes if the generation is unchanged, and skips as stale if it has already advanced
  // (i.e. a 'waiting' or 'switching' has published something more recent in the meantime).
  stateSeq: number
  // idle nudge: when the (idle) Notification arrived, when the nudge was sent, and whether the
  // intervention is over. All three are cleared once activity resumes, so the next stall gets one go again.
  idleSince: number | null // when the idle Notification arrived — null means this is not a stall candidate
  idleNudgedAt: number | null // when the nudge was sent in this stall — null means not yet
  idleHandled: boolean // true once both the one nudge and the one stalled have been used — blocks repeat intervention in the same stall
  // When the last roll finished — the reference point of the PTY replay grace. null on the first session (no grace).
  rolledAt: number | null
  // Throttles the "ignored by replay grace" log to once per roll — the same convention as limitTailReadFailWarned
  replayGraceWarned: boolean
  // The deadline (ms) for continuing to look for a choice number after failing to find one — null means not watching
  choiceWatchUntil: number | null
  // The usage percentage last observed (the higher of session and weekly) — the input of the
  // limit-evidence gate (limitEvidence). It is null when the snapshot could not be read, and that counts
  // as no evidence, so nothing intervenes.
  lastUsagePct: number | null
  // Transcript limit detection. It is created after the path has been learned, so it starts as null.
  // When the path changes (a roll) it is rebuilt with a new since — so it does not bite on old errors in the copy.
  limitTail: ClaudeTranscriptTail | null
  // Throttles the limitTail read-failure log to once per chain — the same convention as unmappedWarned
  // (codexRolling.ts). A path that fails keeps failing, so there is no reason to log it again every 15-second tick.
  limitTailReadFailWarned: boolean
}

/** Extracts just the part of a Chain the retry verdict needs (the input of core/rolling/retry.ts) */
const retryState = (chain: Chain): RetryState => ({
  accountIds: chain.accountIds,
  currentIndex: chain.cycle.currentIndex,
  recovery: chain.recovery
})

export class RollingCoordinator {
  private chains = new Map<string, Chain>() // liveId → chain
  private ticker: ReturnType<typeof setInterval> | null = null
  private readonly copy: (src: string, dest: string) => Promise<void>
  private readonly now: () => number
  private readonly probeActivity: (transcriptPath: string) => Promise<number | null>
  private readonly readPending: (transcriptPath: string) => Promise<number | null>

  constructor(private deps: RollingDeps) {
    this.copy = deps.copy ?? copyTranscript
    this.now = deps.now ?? Date.now
    this.probeActivity = deps.probeActivity ?? lastActivityAt
    this.readPending = deps.readPending ?? readPendingWorkflowCount
  }

  /** Called by ipc right after a spawn that has rollAccountIds (rolling active) — starts tracking the
   *  chain. One account means single-account auto-resume (count=1: on detecting a limit, wait until the
   *  reset and resume on the same account); two or more means switching accounts. */
  register(info: SessionInfo): void {
    const ids = info.rollAccountIds ?? []
    if (ids.length < 1) return
    this.chains.set(info.id, {
      accountIds: ids,
      prompt: info.rollPrompt?.trim() || t(this.deps.lang(), 'rolling.continuePrompt'), // user-specified text, or the default when empty
      cycle: new RollCycle(ids.length),
      liveId: info.id,
      liveInfo: info,
      cwd: info.cwd,
      scanner: new OutputScanner(),
      claudeSessionId: null,
      transcriptPath: null,
      lastOutputAt: this.now(),
      rolling: false,
      awaitingReady: false, // the first session — the user answers the trust prompt themselves
      trustSeen: false,
      waitTimer: null,
      healthyTimer: null,
      promptTimer: null,
      trustTimer: null,
      disposed: false,
      recovery: ids.map(() => null),
      lastBlindProbeAt: 0,
      resetCheckAt: null,
      resetTimer: null,
      stateSeq: 0,
      idleSince: null,
      idleNudgedAt: null,
      idleHandled: false,
      rolledAt: null,
      replayGraceWarned: false,
      choiceWatchUntil: null,
      lastUsagePct: null,
      limitTail: null,
      limitTailReadFailWarned: false
    })
    this.ensureTicker()
    this.deps.log(`chain registered session=${info.id} accounts=${ids.join(',')}`)
  }

  /** Whether this is the conversation of an active rolling chain — the history resume guard */
  findLiveByClaudeSession(claudeSessionId: string): SessionInfo | null {
    for (const chain of this.chains.values())
      if (!chain.disposed && chain.claudeSessionId === claudeSessionId) return chain.liveInfo
    return null
  }

  /** Taps hook events. The idle Notification that Claude Code fires after a turn has been left alone for
   *  60 seconds is used as the stall signal. It is unrelated to statusLine, so it is unaffected by a
   *  frozen snapshot. Nothing intervenes immediately — only the time is recorded, because a notice raised
   *  after 60 idle seconds may catch the user just as they start typing. The actual verdict is made by
   *  idleNudgeCheck on the tick. */
  onHookEvent(sessionId: string, payload: unknown): void {
    const chain = this.chains.get(sessionId)
    if (!chain || chain.disposed) return
    if (typeof payload !== 'object' || payload === null) return
    const p = payload as { hook_event_name?: unknown } & NotificationPayload
    if (p.hook_event_name !== 'Notification') return
    // A Notification that is not idle (a permission request and the like) means a choice is on screen —
    // sending text to that screen would have Enter approve the highlighted item, so nothing intervenes.
    if (!isIdleNotification(p)) {
      // An unfamiliar type is logged. If Claude Code renames the idle type, it would be filtered out
      // silently here and neither the nudge nor 'stalled' would ever fire again — the same failure this
      // feature already had with a phrase regex, reproduced through a renamed field. This line would be
      // the only clue when that happens (the same role as 'limit choice not found' in answerLimitChoice).
      if (isUnknownNotificationType(p))
        this.deps.log(`unknown notification_type=${String(p.notification_type)} session=${sessionId}`)
      return
    }
    // Once this is already a stall candidate (idleSince !== null) the time is not refreshed; the first
    // value is pinned. The first gate in idleNudgeCheck is now - idleSince < IDLE_STALL_MS (10 minutes) —
    // allowing a refresh would restart that 10-minute clock every time the Notification re-fired within
    // the same stall, and the nudge and the promotion to 'stalled' would never fire.
    // Measured: "Claude is waiting for your input" fired once at +61s after the turn ended and then went
    // quiet for 347s — the observation window (408s) was shorter than the 10-minute (600s) threshold, so
    // re-firing itself was never seen, but there is no guarantee it does not happen. The costs are
    // asymmetric: pinning is harmless if there is no repeat, while refreshing kills the whole feature
    // silently if there is. Semantically too, this field has to answer "when did the stall begin", not
    // "when did the most recent notice arrive", so pinning is correct.
    if (chain.idleSince === null) chain.idleSince = this.now()
    // idleNudgedAt and idleHandled are deliberately untouched here — the only thing that closes a stall is
    // activity resuming (handleData). An idle notice arriving again with no response after a nudge is not a
    // new stall but a continuation of the same one, so the next verdict has to go to 'stalled' rather than
    // to another nudge.
    this.deps.log(`idle notification session=${sessionId}`)
  }

  handleData(e: { sessionId: string; data: string }): void {
    const chain = this.chains.get(e.sessionId)
    if (!chain || chain.disposed) return
    chain.lastOutputAt = this.now()
    // Output arriving means the stall has broken — the state is cleared so the next stall gets one nudge
    // again. The user typing also lands here as an echo, so the verdict cannot hold while a human is at
    // the keyboard.
    //
    // A grace period right after a nudge is required: the nudge itself writes a prompt into the PTY, so
    // its echo comes straight back here. Mistaking that for resumed activity and clearing the state would
    // break the "once only" rule and repeat the nudge every cycle. Locking it forever after a nudge
    // instead would miss the next stall even once the session resumes normally. The echo arrives
    // immediately (within ENTER_DELAY_MS) and Claude's real response later, so the two are separated by time.
    if (
      chain.idleSince !== null &&
      (chain.idleNudgedAt === null || this.now() - chain.idleNudgedAt > NUDGE_ECHO_GRACE_MS)
    ) {
      chain.idleSince = null
      chain.idleNudgedAt = null
      chain.idleHandled = false
    }
    const hit = chain.scanner.push(e.data)
    if (hit.trust && chain.awaitingReady && !chain.trustSeen) {
      // The trust prompt on a rolling respawn — the first account already approved this folder, so it is accepted automatically
      chain.trustSeen = true
      this.pushState(chain, 'trust')
      this.deps.log(`trust dialog → auto-accept session=${chain.liveId}`)
      const liveId = chain.liveId // captured so nothing is written to a stale session even if a re-roll finishes within 400ms
      chain.trustTimer = setTimeout(() => {
        chain.trustTimer = null
        if (!chain.disposed && chain.liveId === liveId) this.deps.write(liveId, '\r')
      }, TRUST_ENTER_DELAY_MS)
    }
    // If the choice list was not yet on screen when the limit phrase matched, keep looking in later chunks.
    // A hit.limit chunk is excluded because the branch below handles it directly — the same text is not tried twice.
    if (!hit.limit && chain.choiceWatchUntil !== null) this.watchLimitChoice(chain, hit.text)
    // The cooldown right after a switch: limit phrases are ignored while awaitingReady (i.e. the window
    // where statusLine is absent and the resume replays), preventing a replay false positive from re-rolling
    if (hit.limit && !chain.awaitingReady) {
      // The replay grace is not decided here — onLimitCandidate decides it after re-reading the statusline,
      // so that the verdict is made on the latest usage figure. Dismissing the choice is attempted
      // regardless of the grace: input is only sent once a number has definitely been found, so nothing
      // happens during a replay, whereas missing a genuine limit that raised a choice inside that window
      // would stop the session at an input wait, freeze statusLine, and kill every later detection.
      //
      // A limit choice on screen is cleared first. Leaving that prompt up stops the session at an input
      // wait, and in that state statusLine freezes and every subsequent detection dies.
      // No prompt is sent — sending one before the reset would just hit the limit again. Waiting and
      // resuming are planRetry's job.
      this.answerLimitChoice(chain, hit.text)
      void this.onLimitCandidate(chain, hit.text)
    }
  }

  /** Session exit — the chain is not disposed while a roll is in progress (roll() owns the old→new
   *  lifecycle).
   *  RollingDeps.kill() does not force an asynchronous exit, so this guard stops a synchronous exit
   *  arriving between kill and the map swap from disposing the chain before re-keying completes, which
   *  would leave the new session permanently inert.
   *  Reaching here while not rolling means the user closed the tab or claude died on its own (or a normal
   *  exit arriving after a failed spawn set rolling=false) → dispose the chain. */
  handleExit(e: { sessionId: string }): void {
    const chain = this.chains.get(e.sessionId)
    if (chain && !chain.rolling) this.disposeChain(chain)
  }

  /** A dev hook — forces a roll as if a real limit had hit, bypassing the gates (for manual end-to-end checks) */
  async forceRoll(sessionId?: string): Promise<void> {
    const chain = sessionId ? this.chains.get(sessionId) : [...this.chains.values()][0]
    if (!chain || chain.disposed) throw new Error('no active rolling chain')
    await this.refreshMeta(chain)
    this.onLimit(chain)
  }

  // ---- internals -------------------------------------------------------

  /** Dismisses the limit choice dialog by pressing the number of the "Wait for limit to reset" item.
   *  If the item cannot be found, nothing is written — pressing Enter on an unknown choice approves
   *  whatever is highlighted, and the default may be adjust (raising the spend limit).
   *  The input is the accumulated text the scanner returned at match time — the choice list and the limit
   *  phrase can arrive split across different chunks, so looking at the current chunk alone misses the number. */
  private answerLimitChoice(chain: Chain, matchedText: string): void {
    const n = findWaitChoice(matchedText)
    if (n === null) {
      // The list may simply not be on screen yet — this is the order actually observed in the field: the
      // limit phrase is printed first and the list is rendered after it. The scanner clears its buffer on a
      // match and the choice text alone does not match LIMIT_RE, so without opening a watch window there is
      // never a second chance to find the number. Leaving the window open is harmless — input is only sent
      // once a number has definitely been found.
      chain.choiceWatchUntil = this.now() + CHOICE_WATCH_MS
      // The choice number could not be found — the screen may be rendering without numbers.
      // roll() is about to clear the screen, so not recording it now loses the evidence for the next fix.
      // The limit phrase is masked (maskLimitPhrase) — this log was about to carry the limit phrase and
      // the reset time verbatim, and keeping that text would make rolling.log itself a new trigger source
      // (answerLimitChoice is entered on hit.limit, so matchedText always contains that phrase). The
      // diagnostic value of the tail itself (the choice list and so on) is kept — only the trigger is removed.
      //
      // waitPhrase and textLen go alongside it. The tail keeps only the last 300 characters, so the previous
      // form of this log could not separate "the list was on screen but the numbering differs" from "the
      // list had not arrived yet" — a distinction that could not be settled during the investigation.
      this.deps.log(
        `limit choice not found session=${chain.liveId} ` +
          `waitPhrase=${hasWaitChoiceLabel(matchedText)} textLen=${matchedText.length} ` +
          `tail=${maskLimitPhrase(matchedText).slice(-300)}`
      )
      return
    }
    chain.choiceWatchUntil = null // found, so no watch is needed
    this.deps.log(`limit choice → wait(${n}) session=${chain.liveId}`)
    this.sendChoice(chain, n)
  }

  /** The choice watch. When the list was not yet on screen at the moment the limit phrase matched, press
   *  the number once the list arrives in a later chunk. No separate buffer is needed — the text
   *  OutputScanner returns when there is no match is the current accumulated tail as it stands, so a list
   *  split across several chunks is already joined there. */
  private watchLimitChoice(chain: Chain, text: string): void {
    if (chain.choiceWatchUntil === null) return
    if (this.now() > chain.choiceWatchUntil) {
      chain.choiceWatchUntil = null
      // The window passing means either the list never came or it renders without numbers. Which one is
      // answered by waitPhrase in the "not found" log above — separating those two is what this pair of logs is for.
      this.deps.log(`limit choice watch expired session=${chain.liveId}`)
      return
    }
    const n = findWaitChoice(text)
    if (n === null) return
    chain.choiceWatchUntil = null
    this.deps.log(`limit choice → wait(${n}) (late) session=${chain.liveId}`)
    this.sendChoice(chain, n)
  }

  /** Sends the choice number plus Enter. Shared by answerLimitChoice and watchLimitChoice. */
  private sendChoice(chain: Chain, n: number): void {
    const liveId = chain.liveId // captured so nothing is written to a stale session even if a roll finishes within 150ms
    this.deps.write(liveId, String(n))
    setTimeout(() => {
      // No liveId guard here: a roll following immediately is the normal path in this case (with multiple
      // accounts, detection is followed straight away by kill and respawn). A guard would block Enter on
      // that normal path and dismissing the choice would only work on the single-account wait path — half
      // a feature. A '\r' that reaches the old session late is absorbed by the exited guard in
      // SessionManager.write, and what was captured is only the old id, so it cannot end up in the new
      // session either. The trust prompt and the automatic prompt use a stricter guard because on those
      // paths a re-roll is the exceptional case.
      if (!chain.disposed) this.deps.write(liveId, '\r')
    }, ENTER_DELAY_MS)
  }

  /** The entry point once a limit phrase has been matched. There is deliberately no usage-percentage gate.
   *
   *  It used to accept the phrase only when five or seven was at or above GATE_PCT, but by the moment a
   *  limit blocks the session and the choice appears, statusLine has already stopped updating (measured: 0
   *  updates across 88 idle seconds), so what the gate sees is a stale snapshot from just before the limit.
   *  In other words the gate was filtering out legitimate limit phrases, not false positives.
   *  codexSignal.ts reached the same conclusion for codex first, and its comment assumed "Claude keeps
   *  statusLine updating, so the gate is safe" — which this measurement disproved. */
  private async onLimitCandidate(chain: Chain, text?: string): Promise<void> {
    if (chain.rolling || chain.waitTimer) return // ignore a re-trigger while rolling or waiting
    const payload = await this.deps.readStatusPayload(chain.liveId)
    if (payload) this.applyMeta(chain, payload, parseStatusLinePayload(payload))
    // An old phrase echoed back by the replay right after a roll is cut off here. The verdict is made at
    // this point rather than in handleData because the readStatusPayload just above fetches the latest
    // snapshot of the account we have just resumed on, and that is the value inReplayGrace has to see for
    // "is this account already exhausted" to be answered correctly. The value at handleData time is the
    // snapshot the ready polling read right after the resume, which is one step stale.
    if (this.inReplayGrace(chain)) {
      if (!chain.replayGraceWarned) {
        chain.replayGraceWarned = true
        this.deps.log(
          `limit phrase ignored — replay grace (usage=${chain.lastUsagePct ?? 'unknown'}) session=${chain.liveId}`
        )
      }
      return
    }
    // Called even with no payload — when the phrase itself carries the time, an accurate wait can be
    // recorded regardless of a missing capture file. With payload=null the snapshot candidates are empty
    // and at becomes null, which is the same outcome as previously skipping the record entirely.
    this.recordRecovery(chain, payload, text)
    this.onLimit(chain)
  }

  /** The block record for the current account (currentIndex). Priority order:
   *
   *    1. the reset time carried in the limit phrase — independent of the snapshot
   *    2. the latest reset among the snapshot's over-limit (≥GATE) windows
   *    3. otherwise at=null (unknown) → blockedUntil falls back to since + 15 minutes
   *
   *  If 1 succeeds, 2 is not consulted. The cost is clear — the phrase names only the one window that just
   *  blocked us, so being blocked on session while weekly is also at 95% means retrying right after the
   *  session reset and getting blocked again. Even so, that retry takes a fresh 429 and records the weekly
   *  phrase this time, so it self-corrects after one wasted attempt. Combining the two with max instead
   *  would let a stale weekly value in a frozen snapshot (already reset but frozen at 91%) produce a wait
   *  of several days. A value that can freeze is not allowed to intervene in the direction of a longer
   *  wait — not trusting the snapshot is the whole point here.
   *
   *  refAt: the reference time for interpreting the phrase (the now argument of parseResetTime). The PTY
   *  path (where a hit has no timestamp of its own) omits it and this.now() is used — that path is a live
   *  scan, so the moment of detection is the reference. The transcript path (limitTailCheck) passes hit.at
   *  (the record's own timestamp) — using a this.now() that is only reached after a 15-second tick plus a
   *  readStatusPayload await would misjudge a record written a few seconds before its own reset time
   *  (measured at 7.2s and 9s) as "already past" and add a whole day. since (when the record was made) is
   *  always this.now() regardless of this argument — retry.ts depends on that field for the separate
   *  meaning of "when was this record written". */
  private recordRecovery(chain: Chain, payload: unknown, text?: string, refAt?: number): void {
    const now = this.now()
    const fromText = text ? parseResetTime(text, refAt ?? now) : null
    if (fromText) {
      this.deps.log(
        `reset from text: at=${new Date(fromText.at).toISOString()} ` +
          `weekly=${fromText.weekly} session=${chain.liveId}`
      )
    }
    // The snapshot path — the fallback when the phrase is missing or malformed. The code already exists, so it costs nothing extra.
    const u = fromText ? null : parseStatusLinePayload(payload)
    const cand: { at: number; weekly: boolean }[] = []
    const five = u?.session?.usedPercent
    if (typeof five === 'number' && five >= GATE_PCT) {
      const at = u?.session?.resetsAt ? Date.parse(u.session.resetsAt) : NaN
      if (Number.isFinite(at)) cand.push({ at, weekly: false })
    }
    const seven = u?.weekly?.usedPercent
    if (typeof seven === 'number' && seven >= GATE_PCT) {
      const at = u?.weekly?.resetsAt ? Date.parse(u.weekly.resetsAt) : NaN
      if (Number.isFinite(at)) cand.push({ at, weekly: true })
    }
    const worst = fromText ?? (cand.length ? cand.reduce((a, b) => (b.at > a.at ? b : a)) : null)
    chain.recovery[chain.cycle.currentIndex] = {
      at: worst ? worst.at : null,
      weekly: worst ? worst.weekly : false,
      since: now
    }
  }

  private onLimit(chain: Chain): void {
    // The awaitingReady (post-switch cooldown) guard — onLimitCandidate, the tick's fallback .then, and
    // forceRoll all come through here, so this one line protects all three at once. Without it, within a
    // single tick limitTailCheck could finish a roll first (setting awaitingReady=true) and then the
    // fallback's readStatusPayload, dispatched concurrently in the same tick, would come back late holding
    // the old session's stale payload; onLimit would pass unguarded with that payload and re-roll
    // immediately (a2→a3) — replacing a healthy account we had just switched to, for no reason. This
    // mirrors the same cooldown the PTY path in handleData already applies (the !chain.awaitingReady in
    // the hit.limit branch above).
    if (chain.rolling || chain.waitTimer || chain.disposed || chain.awaitingReady) return
    if (chain.healthyTimer) {
      clearTimeout(chain.healthyTimer)
      chain.healthyTimer = null
    }
    const action = chain.cycle.onLimit()
    // Skips an account the round robin suggests if it is already exhausted (weekly at 100%, say). With
    // nowhere to go, it waits — switching to an exhausted account only blocks again immediately and wastes
    // a transcript copy and a respawn.
    const target =
      action.type === 'roll' ? pickAvailable(retryState(chain), action.toIndex, this.now()) : null
    const detour =
      action.type === 'roll' && target !== action.toIndex
        ? ` blocked(${action.toIndex})→${target === null ? 'wait' : target}`
        : ''
    this.deps.log(`limit detected session=${chain.liveId} action=${JSON.stringify(action)}${detour}`)
    if (target === null) {
      // Reset-time-based targeted retry: schedules the account that recovers soonest at that time, and on
      // firing rolls straight to that account rather than to the next in the round robin. RollCycle's
      // retryAt and onWaitElapsed are unused.
      const plan = planRetry(retryState(chain), this.now())
      this.pushState(chain, 'waiting', {
        nextRetryAt: new Date(plan.retryAt).toISOString(),
        scope: plan.weekly ? 'weekly' : 'session'
      })
      chain.waitTimer = setTimeout(
        () => {
          chain.waitTimer = null
          // The records are not cleared — the target account's record expires naturally once its reset
          // passes, and the blocks still standing on other accounts (weekly and so on) have to stay valid.
          void this.roll(chain, plan.target)
        },
        Math.max(0, plan.retryAt - this.now())
      )
    } else {
      void this.roll(chain, target)
    }
  }

  /** Executing a roll: copy → kill → respawn under the same ID → schedule the automatic prompt (the order is fixed) */
  private async roll(chain: Chain, toIndex: number): Promise<void> {
    if (chain.rolling || chain.disposed) return
    chain.rolling = true
    if (chain.promptTimer) {
      clearTimeout(chain.promptTimer)
      chain.promptTimer = null
    }
    try {
      const target = this.deps.getAccount(chain.accountIds[toIndex])
      if (!target) {
        this.deps.log(`roll aborted — no such account id=${chain.accountIds[toIndex]}`)
        this.pushState(chain, 'none')
        return
      }
      this.pushState(chain, 'switching', { accountLabel: target.label })
      if (!chain.claudeSessionId || !chain.transcriptPath) await this.refreshMeta(chain)
      if (!chain.claudeSessionId || !chain.transcriptPath) {
        this.deps.log(`roll aborted — no session metadata (statusline never recorded) session=${chain.liveId}`)
        this.pushState(chain, 'none')
        return
      }
      // ① copy — a claude blocked by a limit is idle, so there is no write contention
      const dest = claudeHistoryStrategy.mapTargetPath(chain.transcriptPath, target.configDir)
      await this.copy(chain.transcriptPath, dest)
      // ② kill the existing PTY → ③ respawn under the same ID. There is no await from here until
      // re-keying — even if the exit event arrives under the old key, the chain has already moved to the
      // new one, so disposeChain does not misfire.
      this.deps.kill(chain.liveId)
      const oldId = chain.liveId
      const info = this.deps.spawn({
        account: target,
        cwd: chain.cwd,
        resumeSessionId: chain.claudeSessionId,
        rollAccountIds: chain.accountIds,
        slackNotify: chain.liveInfo.slackNotify, // Slack notifications are kept per chain
        bypassPermissions: chain.liveInfo.bypassPermissions // bypass is kept per chain
      })
      this.chains.delete(oldId)
      chain.liveId = info.id
      chain.liveInfo = info
      chain.scanner = new OutputScanner()
      chain.transcriptPath = dest // the live transcript now lives on the target account's side
      // The copy still contains the limit error we just detected — since is set to now to exclude it.
      // Leaving this to applyMeta alone would have it decide "the path has not changed" when the new
      // account's statusLine reports the same path, and keep the old tail — and that tail is looking at
      // the old account's file, so it reads nothing.
      chain.limitTail = new ClaudeTranscriptTail(dest, this.now())
      chain.limitTailReadFailWarned = false // a failure on the new path is reported again
      chain.lastOutputAt = this.now()
      chain.trustSeen = false
      chain.awaitingReady = true
      // The reference point of the replay grace. A new roll has to be able to report its grace again, so
      // the throttle is released too. The choice watch is dropped — kill removed the old screen, so that
      // watch has nothing to do with the new session.
      chain.rolledAt = this.now()
      chain.replayGraceWarned = false
      chain.choiceWatchUntil = null
      // The old account's usage must not be used to judge the new one — the replay grace reads this value
      // to answer "is this account already exhausted", so leaving the 100% of the account we just left
      // behind would make the grace permanently ineffective.
      chain.lastUsagePct = null
      chain.cycle.advanceTo(toIndex)
      this.chains.set(info.id, chain)
      this.deps.send('session:rolled', { oldSessionId: oldId, info })
      // A re-publish that reattaches the banner to the new sessionId — not a new switch, so Slack does not announce it
      this.pushState(chain, 'switching', { accountLabel: target.label, reattach: true })
      this.deps.log(`rolled ${oldId} → ${info.id} account=${target.label}`)
      this.scheduleAutoPrompt(chain)
    } catch (err) {
      this.deps.log(`roll failed: ${err instanceof Error ? err.message : String(err)}`)
      this.pushState(chain, 'none')
    } finally {
      chain.rolling = false
    }
  }

  /** Polls for the ready signal after a respawn (the first statusline record) and then sends the carry-on prompt */
  private scheduleAutoPrompt(chain: Chain): void {
    const liveId = chain.liveId
    const startedAt = this.now()
    const sendPrompt = (): void => {
      if (chain.disposed || chain.liveId !== liveId) return
      this.deps.write(liveId, chain.prompt)
      const stateSeq = chain.stateSeq // captures the generation at scheduling time — the same place and convention as liveId
      setTimeout(() => {
        if (!chain.disposed && chain.liveId === liveId) {
          this.deps.write(liveId, '\r')
          // Publishing 'none' is deferred until after Enter is sent — this stops the scheduler's
          // handleRollState('none') from lifting its suppression and slipping a scheduled command into the
          // same input line before the prompt is actually submitted. The scheduler-side
          // do-not-fire-immediately alone leaves a residual chance (~1%) of the ticker happening to run
          // inside this 150ms window, so it is closed here as well.
          // A more recent state may have been published by onLimitCandidate or roll() during these 150ms —
          // for 'waiting' the chain really is waiting, so the banner and the suppression have to stay and
          // rolling will publish its own terminal state later; for 'switching' the liveId has changed and
          // the liveId guard above already blocks it. So if the generation has advanced, our 'none' is
          // stale and publishing is skipped.
          if (chain.stateSeq === stateSeq) this.pushState(chain, 'none')
        }
      }, ENTER_DELAY_MS)
      chain.awaitingReady = false
      this.deps.log(`auto-prompt sent session=${liveId}`)
      // No limit detected for 60 seconds after the switch → reset the consecutive block count (the timer is cleared if onLimit arrives first)
      chain.healthyTimer = setTimeout(() => {
        chain.healthyTimer = null
        chain.cycle.onHealthy()
        // The only account confirmed to be working is the current one — the block records of other accounts (a weekly exhaustion, say) are kept
        chain.recovery[chain.cycle.currentIndex] = null
      }, HEALTHY_MS)
    }
    const tick = async (): Promise<void> => {
      if (chain.disposed || chain.liveId !== liveId || chain.rolling) return
      const payload = await this.deps.readStatusPayload(liveId)
      if (payload) {
        this.applyMeta(chain, payload)
        sendPrompt()
        return
      }
      const elapsed = this.now() - startedAt
      if (elapsed >= READY_TIMEOUT_MS) {
        // awaitingReady must be cleared. The flag is a post-switch cooldown, but every path of limit
        // detection passes through it — onLimit, handleData, limitTailCheck, and the tick's fallback
        // trigger too, by way of onLimit. Returning without clearing it means this chain never detects a
        // limit again: quietly, with the state published so the UI looks normal, and with no recovery path
        // short of closing the session and making a new one.
        //
        // The trade-off points one way. Clearing it means, at worst, a resume replay echoing an old limit
        // phrase and one false-positive re-roll; not clearing it means detection is dead for good. And by
        // this point 120 seconds have passed, so the replay is most likely already over and even that
        // false positive is unlikely.
        chain.awaitingReady = false
        this.deps.log(`auto-prompt timeout session=${liveId}`)
        // Published as 'stalled' rather than 'none' — auto-resume having finally failed is an event a
        // person has to see, and 'none' is indistinguishable from normal in the UI. That is exactly what
        // 'stalled' was introduced for (the machine calls a person instead of repeating the same attempt),
        // and the Slack path was widened at the same time. The tick returns here without rescheduling, so
        // it fires only once.
        this.pushState(chain, 'stalled')
        return
      }
      if (elapsed >= READY_FALLBACK_MS && !chain.trustSeen) {
        // If statusline never appears and no trust prompt showed either, send the fallback
        sendPrompt()
        return
      }
      chain.promptTimer = setTimeout(() => void tick(), READY_POLL_MS)
    }
    chain.promptTimer = setTimeout(() => void tick(), READY_POLL_MS)
  }

  /** The 15-second tick — refreshes session metadata, evaluates the fallback trigger (five_hour or
   *  seven_day at 100% plus 30 seconds of no output), makes the idle nudge verdict, and runs transcript
   *  limit detection.
   *
   *  tickChain is thrown fire-and-forget per chain — independence between chains is preserved (one chain's
   *  slow I/O does not delay another's tick). The ordering *within* a chain is enforced by tickChain. */
  private tick(): void {
    for (const chain of this.chains.values()) {
      if (chain.disposed || chain.rolling || chain.waitTimer || chain.awaitingReady) continue
      void this.tickChain(chain)
    }
  }

  /** The processing order for a single chain's tick. It used to throw limitTailCheck (①) and the fallback
   *  (②) side by side as fire-and-forget — `void limitTailCheck(...); void readStatusPayload(...).then(...)`.
   *  ① comes first in the text, but since neither is awaited, call order does not guarantee completion
   *  order. ② reaches onLimit through a single readStatusPayload and an unconditional log, whereas ① has to
   *  go through real file I/O (open/stat/read/close, jsonlTail.ts) and its own readStatusPayload first — so
   *  in practice ② almost always started the roll and ① arrived late, was blocked by the chain.rolling
   *  guard, and ended quietly. The design intent of ① being the primary signal (the one that survives a
   *  frozen snapshot) was never realised.
   *
   *  await pins the order inside a chain: the idle nudge and the fallback are evaluated only after ① has
   *  completed. Chains remain independent of each other — tick()'s for loop calls each chain's tickChain
   *  fire-and-forget, so one chain's slow I/O does not hold up another's tick. */
  private async tickChain(chain: Chain): Promise<void> {
    await this.limitTailCheck(chain) // independent of statusLine — completes ① before the fallback
    // The across-await state guard — ① may have caught a hit and already started a roll (rolling) or set a
    // wait (waitTimer). onLimit sets those fields synchronously on that path, so if ① fired we skip the
    // fallback and the idle nudge here — which is precisely the point of this restructuring.
    if (chain.disposed || chain.rolling || chain.waitTimer || chain.awaitingReady) return
    void this.idleNudgeCheck(chain) // independent of statusLine — does not wait for a payload
    const payload = await this.deps.readStatusPayload(chain.liveId)
    if (!payload || chain.disposed) return
    const u = parseStatusLinePayload(payload)
    // The tail state is read *before* applyMeta. applyMeta creates a fresh limitTail when it first learns
    // the transcript path, and that object has never had read() called on it while readFailed starts as
    // false — logging that state would make 'ok' mean "not checked yet" rather than "checked and no hit",
    // defeating the field's purpose. What the await above completed is the limitTail as it stands at this
    // moment, so that value is pinned here: if the path was learned for the first time on this tick, ① read
    // nothing on this tick, and that is exactly what 'none' means.
    const tailState = chain.limitTail ? (chain.limitTail.readFailed ? 'readFailed' : 'ok') : 'none'
    this.applyMeta(chain, payload, u)
    const five = u?.session?.usedPercent
    const seven = u?.weekly?.usedPercent
    const maxed =
      (typeof five === 'number' && five >= 100) || (typeof seven === 'number' && seven >= 100)
    if (maxed && this.now() - chain.lastOutputAt > FALLBACK_SILENCE_MS) {
      // claudeSession and tail exist to measure ①'s (the transcript's) coverage after the fact.
      // ① (limitTailCheck) was already awaited to completion above, and if ① had caught a hit we would have
      // returned at the guard — so this log surviving now genuinely guarantees that ① did not catch
      // anything on this tick (previously only the call order claimed that, not the completion order).
      // Telling whether that miss was something missed (a record existed but could not be read) or
      // something not yet there (the record is written a few seconds later) requires knowing which
      // transcript the chain was watching, and session= is an internal app id from which the transcript
      // file cannot be found.
      //   claudeSession — the transcript filename. Cross-reference that file's rate_limit record time
      //                   against this log's time.
      //   tail          — the value pinned before applyMeta above (tailState). none means ① had no tail to
      //                   read on this tick (the path was not learned yet), readFailed means ① was dead,
      //                   and ok means the read() of this tick, completed by the await above, succeeded
      //                   with no hit — it cannot be confused with "not checked yet".
      // The limit phrase is deliberately not included (it stopped a loop in which the log itself became a trigger).
      this.deps.log(
        `fallback trigger (five=${five}, weekly=${seven}, silent>30s) session=${chain.liveId} ` +
          `claudeSession=${chain.claudeSessionId ?? 'unknown'} tail=${tailState}`
      )
      this.recordRecovery(chain, payload)
      this.onLimit(chain)
    }
  }

  /** Transcript limit detection. This is the primary signal, independent of the statusLine snapshot —
   *  that snapshot stops updating once the session halts at an input wait and its usage figures freeze at
   *  a stale value, whereas the transcript is append-only and cannot freeze. */
  private async limitTailCheck(chain: Chain): Promise<void> {
    if (!chain.limitTail) return
    const hit = await chain.limitTail.read()
    if (!hit) {
      // "No hit" and "the read itself failed" are different — the latter is what happens when the learned
      // path is wrong or becomes inaccessible, and it used to be logged only when there was a hit, so
      // rolling.log could never report this death (exactly the silent failure shape this line of work set
      // out to eliminate). A path that fails once keeps failing (unless the file reappears), so it is
      // recorded once per chain — the same convention as unmappedWarned in codexRolling.ts. Filling it in
      // every 15 seconds would render the log meaningless.
      if (chain.limitTail.readFailed && !chain.limitTailReadFailWarned) {
        chain.limitTailReadFailWarned = true
        this.deps.log(`transcript tail read failed — detection may have stopped session=${chain.liveId}`)
      }
      return
    }
    // The across-await state guard — a roll may have started or a wait been set while probing
    if (chain.disposed || chain.rolling || chain.waitTimer || chain.awaitingReady) return
    // hit.text (the excerpt of the original) is not put in the log — with source=main that excerpt is the
    // user-facing limit phrase verbatim. Writing that phrase into the log makes rolling.log itself a new
    // trigger source: once a real limit fires, the phrase is embedded in this file, and from then on merely
    // cat-ing, grep-ing, or tail-ing this log (especially inside a rolling session) can re-fire the
    // terminal scanner and the subagent rule. The source, timestamp, and length are enough for calibration
    // (which rule actually fired, and whether the excerpt is abnormally long).
    this.deps.log(
      `limit detected via transcript source=${hit.source} session=${chain.liveId} ` +
        `at=${new Date(hit.at).toISOString()} textLen=${hit.text.length}`
    )
    const payload = await this.deps.readStatusPayload(chain.liveId)
    if (chain.disposed || chain.rolling || chain.waitTimer || chain.awaitingReady) return
    // hit.at (the record's own timestamp) is passed as the reference time — using this.now() (the moment of
    // detection) comes after a 15-second tick plus the await above, and would misjudge a record written a
    // few seconds before its own reset time as "already past" and add a whole day.
    this.recordRecovery(chain, payload, hit.text, hit.at)
    this.onLimit(chain)
  }

  /** Is the limit phrase we just matched an old one echoed back by the replay right after a roll?
   *
   *  Being inside the window (REPLAY_GRACE_MS) is not enough on its own — switching to an account that is
   *  already exhausted and getting a genuine limit straight after the resume does happen (measured: a
   *  `fallback trigger (five=1, weekly=100)` 45 seconds after a switch), and that case has to re-roll
   *  immediately. So when the snapshot of the account we have just resumed on is already near the limit,
   *  it is taken as genuine rather than a replay. The measured value on the false-positive side was the
   *  opposite — `Usage 0%` right after the resume.
   *
   *  The snapshot is filled in within seconds of a roll: the ready polling in scheduleAutoPrompt reads the
   *  first statusline and hands it to applyMeta, and that value is the answer to "is the new account
   *  already exhausted". When there is still no value (null) the grace applies — in that case a genuine
   *  limit is still caught by transcript detection and the fallback trigger on the 15-second tick. */
  private inReplayGrace(chain: Chain): boolean {
    if (chain.rolledAt === null || this.now() - chain.rolledAt >= REPLAY_GRACE_MS) return false
    return !(chain.lastUsagePct !== null && chain.lastUsagePct >= GATE_PCT)
  }

  /** Is there ground to believe this chain is blocked by a limit — the shared precondition of the idle
   *  nudge and the reset anchor.
   *
   *  Those two are inference paths: with no direct evidence such as a limit phrase or a transcript error,
   *  they push a prompt into a live PTY on nothing more than "the halt is continuing". Without a gate, a
   *  perfectly normal session whose user has stepped away becomes a target for intervention — and that is
   *  an observed incident, not a hypothetical: in a session with no limit detection on record at all, a
   *  nudge fired 10 minutes after an idle_prompt Notification (which means the turn ended normally and it
   *  is the user's turn, core/hooks/notification.ts) and resumed work the user had not asked for.
   *
   *  This does not contradict the earlier removal of the usage gate from the detection paths. What was
   *  removed there guarded a path that has direct evidence (handleData, limitTailCheck), and the harm was
   *  a snapshot frozen at the moment of blocking rejecting a legitimate phrase. Here there is no direct
   *  evidence at all, so the snapshot is the only ground available — and the same freezing now works in
   *  our favour: a blocked session's frozen value is the high one from just before the limit, whereas a
   *  merely idle session's is low.
   *
   *  Either of the two is enough:
   *
   *    ① A block record on the current account — a history of actually detecting a limit. The combination
   *       where the snapshot is frozen at a low value rather than just below the limit does occur in
   *       practice, so ② alone would block that session entirely. The record is cleared by healthyTimer 60
   *       seconds after a successful switch — that is, it survives only when the roll or the wait failed
   *       and the session is left stuck.
   *    ② The last snapshot's usage >= GATE_PCT — for the blind spot where the detection itself was missed.
   *       That blind spot (a single account that never caught the limit phrase) is the entire reason
   *       resetAnchorCheck exists, so requiring ① alone would leave that path unable to do its job. */
  private limitEvidence(chain: Chain): boolean {
    if (chain.recovery[chain.cycle.currentIndex]) return true
    return chain.lastUsagePct !== null && chain.lastUsagePct >= GATE_PCT
  }

  /** The idle nudge verdict. When there has been neither PTY output nor file activity for IDLE_STALL_MS
   *  after a Notification, the prompt is re-sent once. If the stall continues after that, it publishes
   *  'stalled' to call a person and intervenes no further in that stall — the machine does not repeat the
   *  same attempt.
   *
   *  Unlike blind spot 3-a (removed), there is no pendingWorkflowCount gate: that one was about isolating a
   *  "limit stall" whereas this is an "input-wait stall", and pendingWorkflowCount is a conditional field
   *  recorded only when a background workflow exists, so in this scenario it is always null. A usage gate
   *  is a different matter and this path does have one — see limitEvidence for why an input-wait stall
   *  still has to prove it is a limit before anything is sent. */
  private async idleNudgeCheck(chain: Chain): Promise<void> {
    if (chain.idleSince === null || chain.idleHandled) return
    const now = this.now()
    if (now - chain.idleSince < IDLE_STALL_MS) return
    if (now - chain.lastOutputAt < IDLE_STALL_MS) return
    if (!this.limitEvidence(chain)) {
      // No trace of a limit block — this is a normal session whose user stepped away, so we do not
      // intervene. Tracking of this stall ends here (idleSince = null) so the log does not repeat every 15
      // seconds. While halted the statusLine does not refresh, so usage cannot climb later and there is
      // nothing to re-evaluate — if a limit really does arrive, the direct detection paths (handleData,
      // limitTailCheck) catch it.
      chain.idleSince = null
      this.deps.log(
        `idle stall but no limit evidence (usage=${chain.lastUsagePct ?? 'unknown'}) — no action session=${chain.liveId}`
      )
      return
    }
    if (!chain.transcriptPath) return
    if (now - chain.lastBlindProbeAt < BLIND_PROBE_MIN_MS) return // shares the file-tree stat throttle
    chain.lastBlindProbeAt = now
    const probed = await this.probeActivity(chain.transcriptPath)
    if (probed !== null && now - probed < IDLE_STALL_MS) return // a subagent is active
    // The across-await state guard — a roll may have started or activity resumed while probing
    if (chain.disposed || chain.rolling || chain.waitTimer || chain.awaitingReady) return
    if (chain.idleSince === null || chain.idleHandled) return
    const nudged = chain.idleNudgedAt !== null
    if (nudged) {
      chain.idleHandled = true
      this.deps.log(`idle stall persists after nudge → stalled session=${chain.liveId}`)
      this.pushState(chain, 'stalled')
      return
    }
    chain.idleNudgedAt = now
    chain.idleSince = now // counts another IDLE_STALL_MS until the next verdict
    this.deps.log(`idle stall → nudge session=${chain.liveId}`)
    this.pushState(chain, 'nudged')
    const liveId = chain.liveId
    const stateSeq = chain.stateSeq // captures the generation at scheduling time
    this.deps.write(liveId, chain.prompt)
    setTimeout(() => {
      if (!chain.disposed && chain.liveId === liveId) {
        this.deps.write(liveId, '\r')
        // The same pattern as resetAnchorCheck — 'none' has to be published after Enter for the
        // scheduler's nudged suppression to lift. If a more recent state was published in between, it is skipped.
        if (chain.stateSeq === stateSeq) this.pushState(chain, 'none')
      }
    }, ENTER_DELAY_MS)
  }

  private refreshMeta(chain: Chain): Promise<void> {
    return this.deps.readStatusPayload(chain.liveId).then((payload) => {
      if (payload) this.applyMeta(chain, payload)
    })
  }

  /** parsed: if the caller already has a parseStatusLinePayload result, passing it avoids re-parsing.
   *  Without it (undefined), parsing happens only on the single-account path. */
  private applyMeta(chain: Chain, payload: unknown, parsed?: SessionUsage | null): void {
    const meta = extractStatusLineSession(payload)
    if (meta.sessionId) {
      // On first learning claudeSessionId (null→value), save the rolling config once — for restoring it after a disable-and-resume
      if (!chain.claudeSessionId)
        this.deps.persistConfig?.(meta.sessionId, { accountIds: chain.accountIds, prompt: chain.prompt })
      chain.claudeSessionId = meta.sessionId
    }
    if (meta.transcriptPath) {
      // Create one when the path has just been settled or there is no tail yet. since is now — entries
      // before this point were already there before this chain saw them, and in a copy they include the old limit error.
      if (chain.transcriptPath !== meta.transcriptPath || chain.limitTail === null) {
        chain.limitTail = new ClaudeTranscriptTail(meta.transcriptPath, this.now())
        chain.limitTailReadFailWarned = false // a failure on the new path is reported again
      }
      chain.transcriptPath = meta.transcriptPath
    }
    const u = parsed !== undefined ? parsed : parseStatusLinePayload(payload)
    // Refreshes the observed usage — the input of both the limit-evidence gate and the replay grace.
    // It is updated here rather than on the 15-second tick because the value has to exist right after a
    // roll for the replay grace to answer "is the new account already exhausted", and what fetches that
    // first snapshot is not tick but the ready polling in scheduleAutoPrompt (a few seconds after the
    // roll). When no window is carried at all it is null — treated as no evidence.
    const pcts = [u?.session?.usedPercent, u?.weekly?.usedPercent].filter(
      (p): p is number => typeof p === 'number'
    )
    chain.lastUsagePct = pcts.length ? Math.max(...pcts) : null
    // The single-account blind spot (3-b): schedules a retrospective verdict at the snapshot's resets_at
    if (chain.accountIds.length === 1 && u) this.armResetCheck(chain, u)
  }

  /** Schedules the verdict timer at the earliest future resets_at (+GRACE). The same time is not
   *  rescheduled. After the verdict, resets_at is in the past and nothing is scheduled — it is rescheduled
   *  when the next window's snapshot arrives. */
  private armResetCheck(chain: Chain, u: SessionUsage): void {
    const now = this.now()
    const cands = [u.session?.resetsAt, u.weekly?.resetsAt]
      .map((s) => (s ? Date.parse(s) : NaN))
      .filter((t) => Number.isFinite(t) && t > now)
    if (!cands.length) return
    const at = Math.min(...cands)
    if (chain.resetCheckAt === at) return
    if (chain.resetTimer) clearTimeout(chain.resetTimer)
    chain.resetCheckAt = at
    chain.resetTimer = setTimeout(
      () => {
        chain.resetTimer = null
        void this.resetAnchorCheck(chain, at)
      },
      at + RESET_GRACE_MS - now
    )
  }

  /** The retrospective reset-anchor verdict: ① activity resumed after the reset → self-recovered, no
   *  intervention. ② nothing pending → simply idle, no intervention. ③ anything else = a limit stall plus a
   *  failed self-recovery → send only a prompt to the live PTY (no kill, no resume, no transcript copy — non-destructive). */
  private async resetAnchorCheck(chain: Chain, resetAt: number): Promise<void> {
    if (chain.disposed || chain.rolling || chain.waitTimer || chain.awaitingReady) return
    if (!chain.transcriptPath) return
    if (!this.limitEvidence(chain)) {
      // This path fires on reaching the reset time and nothing else. With no trace of a limit block that
      // time means nothing, and all that is left is pushing a prompt into a session whose user stepped
      // away. The timer is one-shot, so simply returning here is enough — armResetCheck schedules it again
      // when the next window's snapshot arrives.
      this.deps.log(
        `reset-anchor: no limit evidence (usage=${chain.lastUsagePct ?? 'unknown'}) — no action session=${chain.liveId}`
      )
      return
    }
    const probed = await this.probeActivity(chain.transcriptPath)
    const lastActivity = Math.max(chain.lastOutputAt, probed ?? 0)
    if (lastActivity >= resetAt) {
      this.deps.log(`reset-anchor: activity resumed — no action session=${chain.liveId}`)
      return
    }
    const pending = await this.readPending(chain.transcriptPath)
    if (!pending || pending < 1) {
      this.deps.log(`reset-anchor: idle session (pending=${pending}) — no action session=${chain.liveId}`)
      return
    }
    if (chain.disposed || chain.rolling || chain.waitTimer || chain.awaitingReady) return // the across-await state guard
    this.deps.log(`reset-anchor: limit stall + no self-recovery → nudge session=${chain.liveId}`)
    this.pushState(chain, 'nudged') // a momentary event for the Slack notification — the renderer leaves it out of the banner
    const liveId = chain.liveId
    const stateSeq = chain.stateSeq // captures the generation at scheduling time — the same place and convention as liveId
    this.deps.write(liveId, chain.prompt)
    setTimeout(() => {
      if (!chain.disposed && chain.liveId === liveId) {
        this.deps.write(liveId, '\r')
        // The same pattern as sendPrompt — 'none' is published after Enter is sent so that the scheduler's
        // handleRollState('none') cannot lift its suppression and slip a scheduled command into the same
        // input line before the prompt is actually submitted. nudged is now suppressed in scheduler.ts as
        // well, which makes this 'none' the only signal that lifts that suppression — without it the
        // suppression latches permanently.
        // As in sendPrompt, if a more recent state ('waiting' or 'switching') was published in between the
        // generation has advanced — in which case our 'none' is stale and is skipped.
        if (chain.stateSeq === stateSeq) this.pushState(chain, 'none')
      }
    }, ENTER_DELAY_MS)
  }

  private pushState(
    chain: Chain,
    state: RollStateEvent['state'],
    extra?: Partial<RollStateEvent>
  ): void {
    chain.stateSeq++ // the generation advances on every publication — the basis for deciding whether a deferred publication is stale
    this.deps.send('session:rollState', { sessionId: chain.liveId, state, ...extra })
  }

  private disposeChain(chain: Chain): void {
    if (chain.disposed) return
    chain.disposed = true
    for (const t of [chain.waitTimer, chain.healthyTimer, chain.promptTimer, chain.trustTimer, chain.resetTimer])
      if (t) clearTimeout(t)
    this.chains.delete(chain.liveId)
    this.pushState(chain, 'none')
    this.deps.log(`chain disposed session=${chain.liveId}`)
    if (this.chains.size === 0 && this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  private ensureTicker(): void {
    if (!this.ticker) this.ticker = setInterval(() => this.tick(), TICK_MS)
  }
}
