// The codex account rolling coordinator. Limit detection → rollout copy → kill → `codex resume <id>
// "<prompt>"` on the next account. The skeleton is the same as the claude coordinator (rolling.ts) but
// it is far shorter because none of the statusLine-specific problems (a stale snapshot, readiness
// polling, auto-accepting trust) apply. Every side effect is injected through deps — it does not depend
// on electron, so it is verified with vitest. The wiring is in ipc.ts and index.ts.
import type { Account, RollStateEvent, SessionInfo } from '../core/types'
import type { RollConfig } from '../core/rolling/config'
import { RollCycle } from '../core/rolling/cycle'
import { pickAvailable, planRetry, type BlockRecord, type RetryState } from '../core/rolling/retry'
import { copyTranscript } from '../core/rolling/transcript'
import { codexHistoryStrategy } from '../core/history/strategies/codex'
import { findRollout } from '../core/rolling/codexLocate'
import {
  CodexLimitScanner,
  CodexModelChoiceScanner,
  CodexRolloutTail,
  limitReached,
  maxedOut,
  worstResetAt,
  type CodexLimitState
} from '../core/rolling/codexSignal'
import { t, type Lang } from '../core/i18n'

const TICK_MS = 15_000 // how often state is refreshed and the fallback trigger checked (mirrors rolling.ts)
const LOCATE_POLL_MS = 1_000 // how often we poll to map the rollout
const LOCATE_TIMEOUT_MS = 60_000 // the deadline for giving up on mapping — after this the chain has rolling disabled
const FALLBACK_SILENCE_MS = 30_000 // the fallback verdict ③: 100% plus this long with no output
const ENTER_DELAY_MS = 150 // the gap between the choice number and Enter (same as rolling.ts)
const HEALTHY_MS = 60_000 // no limit detected for this long after a switch → reset the consecutive block count

/** Which grounds the limit verdict fired on — a log label. `errorInfo` is the one that actually fires
 *  on codex 0.14x (usage_limit_exceeded); `reachedType` has never been observed non-null, so seeing it
 *  in the log would itself be news. Recording the two separately is what keeps the next person from
 *  reading a structured hit as a screen-text hit. */
type LimitReason = 'reachedType' | 'errorInfo' | 'text+gate' | 'maxed+silent' | 'force'

export interface CodexRollingDeps {
  spawn(opts: {
    account: Account
    cwd: string
    resumeSessionId?: string
    resumePrompt?: string
    rollAccountIds?: string[]
    slackNotify?: boolean
    bypassPermissions?: boolean
    /** astera CLI 환경. 배선이 넘긴다 — 없으면 세션은 CLI 없이 뜬다 */
    orchEnv?: { cliPath: string; infoPath: string; skillsPath: string }
  }): SessionInfo
  kill(sessionId: string): void
  /** Writes into a live session's PTY. Used only to dismiss the model-switch prompt (answerModelChoice). */
  write(sessionId: string, data: string): void
  getAccount(id: string): Account | null
  send(channel: 'session:rolled' | 'session:rollState', payload: unknown): void
  log(message: string): void
  lang: () => Lang // taken as a getter rather than a value so the latest language is used even after setLang
  persistConfig?: (codexSessionId: string, config: RollConfig) => void
  copy?: (src: string, dest: string) => Promise<void> // for test injection — defaults to copyTranscript
  now?: () => number
  /** 롤로 띄우는 세션에 실을 astera CLI 환경.
   *
   *  **왜 dep 이고 왜 getter 인가.** 롤링 코디네이터는 `ipc.ts` 의 `spawnSession` 을 우회해
   *  `core.sessions.spawn` 을 직접 부른다(index.ts 의 배선). 그 우회로에는 `ASTERA_CLI`·`ASTERA_INFO`·
   *  `ASTERA_SKILLS` 와 PATH 주입이 붙지 않아서, **롤 뒤의 워커는 `astera` 로 아무것도 보고할 수
   *  없었다** — 조용히 끝나지 않는 Task 가 된다. `ipc.ts` 의 그 함수를 그대로 넘길 수는 없다: 그것이
   *  롤링 등록까지 하므로 재귀한다. 그래서 값만 따로 받는다.
   *
   *  getter 인 이유는 값이 앱 수명 중간에 생기고 사라지기 때문이다 — 오케스트레이션은 설정으로
   *  켜지고 꺼지며, 롤링 코디네이터는 그보다 먼저 만들어진다.
   *
   *  주입되지 않으면 아무것도 실리지 않는다(기존 동작) — now?/log? 와 같은 관례다. */
  orchEnv?(): { cliPath: string; infoPath: string; skillsPath: string } | undefined
  /** 재개 직전에 쓸 프롬프트를 물어본다. rolling.ts 의 같은 필드와 동일한 계약 — `chain.prompt` 가
   *  register 시점에 고정되는 정적 값이라서 필요하다. sessionId 로 열린 Job Dispatch 를 찾을 수
   *  없으면(사용자 탭 세션) `null` 을 돌린다. `null` 이면 `chain.prompt` 를 그대로 쓴다. codex 는
   *  이 프롬프트를 spawn 인자로 넘기므로 **kill·spawn 전에** 물어야 한다(roll() 의 호출 자리 참고).
   *  구현은 `main/orchestration/resumePacket.ts`.
   *
   *  **이 코디네이터는 언제나 'handover' 를 묻는다.** 여기에는 `resumeInPlace` 가 없다 — codex 롤은
   *  계정 수와 무관하게 항상 kill 하고 `--resume` 으로 다시 띄우므로, `SPEC §11.5` 의 기준
   *  ("`--resume` 을 부르는가")에 늘 걸린다. form 인자를 그래도 받는 것은 rolling.ts 의 dep 과 같은
   *  계약을 유지하려는 것이다(배선이 한 함수를 두 코디네이터에 넘긴다). */
  resumeText?(sessionId: string, form: 'handover' | 'update'): Promise<string | null>
}

interface Chain {
  accountIds: string[]
  prompt: string
  cycle: RollCycle
  liveId: string
  liveInfo: SessionInfo
  cwd: string
  codexSessionId: string | null // the rollout's session_id — the same throughout the relay
  rolloutPath: string | null
  tail: CodexRolloutTail | null
  state: CodexLimitState | null // the last rate_limits read
  scanner: CodexLimitScanner // detects the limit phrase in PTY output (corrects for chunk boundaries)
  modelChoice: CodexModelChoiceScanner // detects codex's approaching-limit model-switch prompt in the same stream
  textHit: boolean // whether the limit phrase was seen in this window (the tick combines it with the state to decide)
  unmappedWarned: boolean // whether the rollout-unmapped skip has already been logged (suppresses repeats of the same line)
  preemptWarned: boolean // whether the preemption has already been logged — keeps it from piling up on every 1-second poll
  lastOutputAt: number
  rolling: boolean
  locateTimer: ReturnType<typeof setTimeout> | null
  waitTimer: ReturnType<typeof setTimeout> | null
  healthyTimer: ReturnType<typeof setTimeout> | null
  disposed: boolean
  recovery: (BlockRecord | null)[]
}

/** Extracts just the part of a Chain the retry verdict needs (the input of core/rolling/retry.ts) */
const retryState = (chain: Chain): RetryState => ({
  accountIds: chain.accountIds,
  currentIndex: chain.cycle.currentIndex,
  recovery: chain.recovery
})

export class CodexRollingCoordinator {
  private chains = new Map<string, Chain>() // liveId → chain
  private ticker: ReturnType<typeof setInterval> | null = null
  private readonly copy: (src: string, dest: string) => Promise<void>
  private readonly now: () => number

  constructor(private deps: CodexRollingDeps) {
    this.copy = deps.copy ?? copyTranscript
    this.now = deps.now ?? Date.now
  }

  /** Called by ipc right after spawning a codex session that has rollAccountIds. One id means single-account auto-resume.
   *
   *  rolloutPath is the file the resumed codex will write to — ipc knows it because it is the target of
   *  the transcript copy it just made. Passing it skips the locate poll entirely, which is not an
   *  optimisation but the only way a resumed session gets mapped at all: see attachRollout. It is
   *  ignored unless the session really is a resume (info.resumeSessionId), because a fresh spawn's
   *  rollout does not exist yet and has to be found. */
  register(info: SessionInfo, rolloutPath?: string): void {
    const ids = info.rollAccountIds ?? []
    if (ids.length < 1) return
    const chain: Chain = {
      accountIds: ids,
      prompt: info.rollPrompt?.trim() || t(this.deps.lang(), 'rolling.continuePrompt'),
      cycle: new RollCycle(ids.length),
      liveId: info.id,
      liveInfo: info,
      cwd: info.cwd,
      codexSessionId: null,
      rolloutPath: null,
      tail: null,
      state: null,
      scanner: new CodexLimitScanner(),
      modelChoice: new CodexModelChoiceScanner(),
      textHit: false,
      unmappedWarned: false,
      preemptWarned: false,
      lastOutputAt: this.now(),
      rolling: false,
      locateTimer: null,
      waitTimer: null,
      healthyTimer: null,
      disposed: false,
      recovery: ids.map(() => null)
    }
    this.chains.set(info.id, chain)
    if (info.resumeSessionId && rolloutPath) {
      this.attachRollout(chain, info.resumeSessionId, rolloutPath)
      // The locate path persists the config on success; the resume path knows the id up front, so it
      // does the same here — otherwise resuming a chain would never refresh its stored roll config.
      this.deps.persistConfig?.(info.resumeSessionId, {
        accountIds: chain.accountIds,
        prompt: chain.prompt
      })
      this.deps.log(`codex rollout attached on resume session=${info.id} id=${info.resumeSessionId}`)
    } else {
      this.startLocate(chain, this.deps.getAccount(ids[this.cycleIndexOf(chain)]))
    }
    this.ensureTicker()
    this.deps.log(`codex chain registered session=${info.id} accounts=${ids.join(',')}`)
  }

  /** Whether this conversation belongs to an active rolling chain — the history resume guard (mirrors findLiveByClaudeSession in rolling.ts) */
  findLiveByCodexSession(codexSessionId: string): SessionInfo | null {
    for (const chain of this.chains.values())
      if (!chain.disposed && chain.codexSessionId === codexSessionId) return chain.liveInfo
    return null
  }

  handleData(e: { sessionId: string; data: string }): void {
    const chain = this.chains.get(e.sessionId)
    if (!chain || chain.disposed) return
    chain.lastOutputAt = this.now()
    // The model-switch prompt is a *warning*, not a limit — it has its own scanner and its own answer,
    // and it must be handled even when no limit ever arrives (an unanswered prompt stops the session)
    const keep = chain.modelChoice.push(e.data)
    if (keep !== null) this.answerModelChoice(chain, keep)
    if (chain.scanner.push(e.data)) {
      chain.textHit = true
      void this.evaluate(chain)
    }
  }

  /** Presses "keep current model" on codex's approaching-limit prompt, so the session does not sit at an
   *  input prompt forever. Which item and why: see the comment above findKeepModelChoice. */
  private answerModelChoice(chain: Chain, n: number): void {
    const liveId = chain.liveId // captured so a roll finishing within the delay cannot redirect the Enter
    this.deps.log(`codex model-switch prompt → keep(${n}) session=${liveId}`)
    this.deps.write(liveId, String(n))
    setTimeout(() => {
      if (!chain.disposed) this.deps.write(liveId, '\r')
    }, ENTER_DELAY_MS)
  }

  handleExit(e: { sessionId: string }): void {
    const chain = this.chains.get(e.sessionId)
    if (chain && !chain.rolling) this.disposeChain(chain)
  }

  /** 세션은 살려 둔 채 그 세션의 체인만 버린다 — **kill 하지 않는다.** rolling.ts 의 같은 이름과
   *  같은 계약이다(그 JSDoc 이 이유를 적고 있다). codex 쪽 위험은 더 넓다: 여기서 닫힌 Dispatch 의
   *  세션을 집어 가는 것은 유휴 알림이 필요 없는 tick 의 폴백 판정(maxed+silent — 100% 로 굳은
   *  스냅숏과 30초 침묵만으로 충분하다)이고, 그 끝은 프롬프트 한 줄이 아니라 kill + 재spawn 이다.
   *
   *  등록되지 않은 id 는 아무 일도 하지 않는다 — 배선은 두 코디네이터 모두에게 부른다. */
  unregister(sessionId: string): void {
    const chain = this.chains.get(sessionId)
    if (chain) this.disposeChain(chain)
  }

  /** A dev hook — forces a roll as if a real limit had hit, bypassing the gates (mirrors forceRoll in rolling.ts) */
  async forceRoll(sessionId?: string): Promise<void> {
    const chain = sessionId ? this.chains.get(sessionId) : [...this.chains.values()][0]
    if (!chain || chain.disposed) throw new Error('no active codex rolling chain')
    await this.refresh(chain)
    this.onLimit(chain, 'force')
  }

  /** App shutdown and test cleanup — clears every timer */
  stop(): void {
    for (const chain of [...this.chains.values()]) this.disposeChain(chain)
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  // ---- internals -------------------------------------------------------

  private cycleIndexOf(chain: Chain): number {
    return chain.cycle.currentIndex
  }

  /** The rollout paths other active chains have already claimed. Open two rolling tabs on the same folder
   *  with the same account and both chains see the same rollout as a legitimate candidate; if two of them
   *  bite on one conversation, both of them roll. */
  private claimedRollouts(self: Chain): string[] {
    const out: string[] = []
    for (const c of this.chains.values())
      if (c !== self && !c.disposed && c.rolloutPath) out.push(c.rolloutPath)
    return out
  }

  /** Attaches the tail to a rollout path we already know, instead of searching for one.
   *
   *  **Why the search cannot find a resumed session's rollout.** findRollout only accepts a file
   *  *created* after the spawn, because mtime would let a different session that is already running in
   *  the same folder become a candidate. That rule holds for a fresh spawn, where codex really does
   *  create the file. But `codex resume <id>` creates nothing — it appends to the existing rollout
   *  (measured on 0.149.1), whose creation time is by definition older than the spawn. So every resumed
   *  session — the user reopening a conversation, and the respawn at the end of a roll — searched until
   *  the 60-second deadline and then had rolling disabled. The measured log reads: `limit-text ignored
   *  (rollout unmapped)` … `rollout not found within 60000ms — rolling disabled`.
   *
   *  Both resume paths know the file up front (ipc: the transcript copy target; roll: the copy it just
   *  made), so there is nothing to search for. startAtEnd is what keeps the file's existing content —
   *  the previous conversation's rate_limits, and after a roll the *other account's* — from being read
   *  as this session's verdict. */
  private attachRollout(chain: Chain, codexSessionId: string, rolloutPath: string): void {
    chain.rolloutPath = rolloutPath
    chain.codexSessionId = codexSessionId
    chain.tail = new CodexRolloutTail(rolloutPath, this.now, { startAtEnd: true })
    chain.unmappedWarned = false // it is mapped now — a future unmapped state gets to report itself again
  }

  /** Polls until the rollout file appears. On finding it, tailing starts; past the deadline rolling is
   *  disabled. This is the fresh-spawn path only — a resume knows its file already (attachRollout), and
   *  the exclude list the re-locate after a roll used to need went away with it. */
  private startLocate(chain: Chain, account: Account | null): void {
    if (!account) {
      this.deps.log(`codex locate aborted — no such account session=${chain.liveId}`)
      return
    }
    const since = this.now()
    const liveId = chain.liveId
    const tick = async (): Promise<void> => {
      if (chain.disposed || chain.liveId !== liveId) return
      const found = await findRollout({
        configDir: account.configDir,
        cwd: chain.cwd,
        since,
        now: this.now,
        excludePaths: this.claimedRollouts(chain)
      })
      if (chain.disposed || chain.liveId !== liveId) return
      // When two chains poll side by side, the other one can bite first while the findRollout above is in
      // flight — re-checking after the await keeps one rollout to one chain. Both paths were produced by
      // findRollout, so the strings are identical.
      if (found && this.claimedRollouts(chain).includes(found.path)) {
        // Logged once per chain so the same line does not pile up on every 1-second poll
        if (!chain.preemptWarned) {
          chain.preemptWarned = true
          this.deps.log(
            `codex rollout preempted — waiting for the next candidate session=${liveId} path=${found.path}`
          )
        }
      } else if (found) {
        chain.rolloutPath = found.path
        chain.codexSessionId = found.sessionId
        chain.tail = new CodexRolloutTail(found.path, this.now)
        chain.unmappedWarned = false
        chain.preemptWarned = false
        this.deps.persistConfig?.(found.sessionId, {
          accountIds: chain.accountIds,
          prompt: chain.prompt
        })
        this.deps.log(`codex rollout located session=${liveId} id=${found.sessionId}`)
        return
      }
      if (this.now() - since >= LOCATE_TIMEOUT_MS) {
        this.deps.log(
          `codex rollout not found within ${LOCATE_TIMEOUT_MS}ms — rolling disabled session=${liveId}`
        )
        return
      }
      chain.locateTimer = setTimeout(() => void tick(), LOCATE_POLL_MS)
    }
    chain.locateTimer = setTimeout(() => void tick(), LOCATE_POLL_MS)
  }

  private async refresh(chain: Chain): Promise<void> {
    if (!chain.tail) return
    const s = await chain.tail.read()
    if (s) chain.state = s
  }

  /** Refreshes the state and applies verdicts ① and ② */
  private async evaluate(chain: Chain): Promise<void> {
    if (chain.rolling || chain.waitTimer || chain.disposed) return
    await this.refresh(chain)
    if (chain.rolling || chain.waitTimer || chain.disposed) return // the across-await state guard
    if (!limitReached(chain.state, { textHit: chain.textHit })) {
      // Record exactly why it was ignored — logging an unmapped rollout as "usage below the gate" (the old
      // log printed undefined%) destroys the evidence for calibrating the phrase regex on the first real
      // limit hit
      if (chain.textHit)
        this.deps.log(`codex limit-text ignored (${this.why(chain)}) session=${chain.liveId}`)
      return
    }
    this.recordRecovery(chain)
    this.onLimit(chain, this.reasonOf(chain, 'text+gate'))
  }

  /** Which signal carried the verdict. `fallback` is what to report when neither structured signal is
   *  present — the phrase on the caller's path, reachedType on the tick's (where no phrase is possible). */
  private reasonOf(chain: Chain, fallback: LimitReason): LimitReason {
    if (chain.state?.reachedType) return 'reachedType'
    if (chain.state?.error) return 'errorInfo'
    return fallback
  }

  /** Why the phrase was ignored — distinguishes unmapped, no state received, and usage below the gate */
  private why(chain: Chain): string {
    if (!chain.tail) return 'rollout unmapped'
    if (!chain.state) return 'rate_limits not received'
    const { primary, secondary } = chain.state
    return `primary=${primary?.usedPercent ?? 'n/a'}%, secondary=${secondary?.usedPercent ?? 'n/a'}%`
  }

  /** The block record for the current account — the latest reset among the windows at or above the gate (mirrors recordRecovery in rolling.ts) */
  private recordRecovery(chain: Chain): void {
    const worst = worstResetAt(chain.state)
    chain.recovery[chain.cycle.currentIndex] = {
      at: worst.at,
      weekly: worst.weekly,
      since: this.now()
    }
  }

  private onLimit(chain: Chain, reason: LimitReason): void {
    if (chain.rolling || chain.waitTimer || chain.disposed) return
    if (!chain.codexSessionId || !chain.rolloutPath) {
      // An unmapped state does not resolve itself — logging on every repeat detection fills the log with the same line
      if (!chain.unmappedWarned) {
        chain.unmappedWarned = true
        this.deps.log(`codex roll skipped — rollout unmapped session=${chain.liveId} reason=${reason}`)
      }
      return
    }
    if (chain.healthyTimer) {
      clearTimeout(chain.healthyTimer)
      chain.healthyTimer = null
    }
    chain.textHit = false
    const action = chain.cycle.onLimit()
    const target =
      action.type === 'roll' ? pickAvailable(retryState(chain), action.toIndex, this.now()) : null
    // reason and the raw reachedType are the only evidence for calibrating the assumptions we have not
    // measured yet (the limit phrase, the reachedType values, replay behaviour) on the first real hit — so
    // what fired and the raw value are recorded together
    this.deps.log(
      `codex limit detected session=${chain.liveId} reason=${reason} ` +
        `reachedType=${chain.state?.reachedType ?? 'null'} ${this.why(chain)} ` +
        `action=${JSON.stringify(action)}`
    )
    if (target === null) {
      const plan = planRetry(retryState(chain), this.now())
      this.pushState(chain, 'waiting', {
        nextRetryAt: new Date(plan.retryAt).toISOString(),
        scope: plan.weekly ? 'weekly' : 'session'
      })
      chain.waitTimer = setTimeout(
        () => {
          chain.waitTimer = null
          void this.roll(chain, plan.target)
        },
        Math.max(0, plan.retryAt - this.now())
      )
    } else {
      void this.roll(chain, target)
    }
  }

  /** Runs the roll: copy the rollout → kill → respawn in the same slot with codex resume */
  private async roll(chain: Chain, toIndex: number): Promise<void> {
    if (chain.rolling || chain.disposed) return
    chain.rolling = true
    try {
      const target = this.deps.getAccount(chain.accountIds[toIndex])
      if (!target) {
        this.deps.log(`codex roll aborted — no such account id=${chain.accountIds[toIndex]}`)
        this.pushState(chain, 'none')
        return
      }
      if (!chain.codexSessionId || !chain.rolloutPath) {
        this.deps.log(`codex roll aborted — rollout unmapped session=${chain.liveId}`)
        this.pushState(chain, 'none')
        return
      }
      const codexSessionId = chain.codexSessionId // pinned before the awaits below — attachRollout needs it non-null
      this.pushState(chain, 'switching', { accountLabel: target.label })
      // ① The copy — a codex blocked by a limit is idle, so there is no write contention
      const dest = codexHistoryStrategy.mapTargetPath(chain.rolloutPath, target.configDir)
      await this.copy(chain.rolloutPath, dest)
      // If the app shut down (stop) or the tab was closed (handleExit) while we waited on the copy, stop
      // here — what follows is kill+spawn, and going on with a disposed chain leaves a zombie codex process
      // and resurrected timers behind
      if (chain.disposed) {
        this.deps.log(`codex roll aborted — chain disposed during the copy session=${chain.liveId}`)
        return
      }
      // resumeText 는 spec 파일에 쓰는 부수 효과가 있는 await 이므로, kill 과 재키잉 사이에는 두지
      // 않는다 — 그 구간에 await 를 두지 않는다는 것이 아래 kill/spawn 의 불변이다(exit 가 옛 id 로
      // 도착해도 disposeChain 이 오작동하지 않는 이유). 그래서 kill 앞에서, 세션이 아직 살아 있을
      // 때 물어 둔다.
      // **이 자리에 try/catch 가 필요한 이유는 이 roll() 의 catch 가 있는 자리다.** 이 호출은
      // roll() 바깥 try 안에 있고, 그 catch 는 kill·respawn **앞에서** 돌아 'none' 을 게시하고
      // 끝난다 — 즉 깨진 packet 계약이 인계를 얇게 만드는 것이 아니라 **롤 자체를 중단시켜 워커를
      // 한도에 멈춘 채로 남긴다.** resumeText 는 던지지 않는다는 계약이지만(resumePacket.ts) 그
      // 계약이 깨질 때 잃는 것이 이만큼 크므로, rolling.ts 가 자기 네 자리에 두른 것과 같은 모양을
      // 여기에도 둔다: 로그를 남기고 기존 고정 문장으로 저하한다.
      let prompt = chain.prompt
      try {
        prompt = (await this.deps.resumeText?.(chain.liveId, 'handover')) ?? chain.prompt
      } catch (err) {
        this.deps.log(
          `resume packet hook failed session=${chain.liveId}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      if (chain.disposed) {
        this.deps.log(
          `codex roll aborted — chain disposed while building the resume prompt session=${chain.liveId}`
        )
        return
      }
      // ② kill → ③ respawn in the same slot. The prompt is a CLI argument, so there is no PTY typing
      this.deps.kill(chain.liveId)
      const oldId = chain.liveId
      const info = this.deps.spawn({
        account: target,
        cwd: chain.cwd,
        resumeSessionId: chain.codexSessionId,
        resumePrompt: prompt,
        rollAccountIds: chain.accountIds,
        slackNotify: chain.liveInfo.slackNotify, // the Slack notification is kept per chain (mirrors rolling.ts)
        bypassPermissions: chain.liveInfo.bypassPermissions,
        orchEnv: this.deps.orchEnv?.()
      })
      this.chains.delete(oldId)
      chain.liveId = info.id
      chain.liveInfo = info
      chain.lastOutputAt = this.now()
      chain.state = null
      chain.textHit = false
      chain.scanner = new CodexLimitScanner() // so the dead session's tail does not get glued onto the new session's output
      chain.modelChoice = new CodexModelChoiceScanner() // same reason — a half-drawn prompt must not join the new session's output
      chain.cycle.advanceTo(toIndex)
      this.chains.set(info.id, chain)
      // The respawned codex resumes, so it appends to dest rather than creating a new rollout — there is
      // nothing to search for, and searching was exactly what broke here (see attachRollout). dest holds
      // the old account's rate_limits, which is why attachRollout starts the tail at the end.
      this.attachRollout(chain, codexSessionId, dest)
      // dest is sent along too, so the CodexTurnWatcher re-registration (index.ts) can drop this copy from
      // its candidates. CoreEvents['session:rolled'] does not declare this field, but send()'s payload is
      // unknown so the extra field rides along safely — the renderer just ignores it.
      this.deps.send('session:rolled', { oldSessionId: oldId, info, dest })
      this.pushState(chain, 'switching', { accountLabel: target.label, reattach: true })
      this.deps.log(`codex rolled ${oldId} → ${info.id} account=${target.label}`)
      // No limit detected for 60 seconds after the switch → reset the consecutive block count
      chain.healthyTimer = setTimeout(() => {
        chain.healthyTimer = null
        chain.cycle.onHealthy()
        chain.recovery[chain.cycle.currentIndex] = null
      }, HEALTHY_MS)
      this.pushState(chain, 'none')
    } catch (err) {
      this.deps.log(`codex roll failed: ${err instanceof Error ? err.message : String(err)}`)
      this.pushState(chain, 'none')
    } finally {
      chain.rolling = false
    }
  }

  /** The 15-second tick — refreshes the state, applies verdict ① (reachedType with no phrase) and fallback ③ (100% plus 30 seconds of no output) */
  private tick(): void {
    for (const chain of this.chains.values()) {
      if (chain.disposed || chain.rolling || chain.waitTimer || !chain.tail) continue
      void this.refresh(chain).then(() => {
        if (chain.disposed || chain.rolling || chain.waitTimer) return
        if (limitReached(chain.state, { textHit: false })) {
          this.recordRecovery(chain)
          // No phrase was involved, so this can only be one of the two structured signals
          this.onLimit(chain, this.reasonOf(chain, 'reachedType'))
          return
        }
        if (maxedOut(chain.state) && this.now() - chain.lastOutputAt > FALLBACK_SILENCE_MS) {
          this.recordRecovery(chain)
          this.onLimit(chain, 'maxed+silent')
        }
      })
    }
  }

  private pushState(
    chain: Chain,
    state: RollStateEvent['state'],
    extra?: Partial<RollStateEvent>
  ): void {
    this.deps.send('session:rollState', { sessionId: chain.liveId, state, ...extra })
  }

  private disposeChain(chain: Chain): void {
    if (chain.disposed) return
    chain.disposed = true
    for (const t of [chain.locateTimer, chain.waitTimer, chain.healthyTimer]) if (t) clearTimeout(t)
    this.chains.delete(chain.liveId)
    this.pushState(chain, 'none')
    this.deps.log(`codex chain disposed session=${chain.liveId}`)
    if (this.chains.size === 0 && this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  private ensureTicker(): void {
    if (!this.ticker) this.ticker = setInterval(() => this.tick(), TICK_MS)
  }
}
