// The codex account rolling coordinator. Limit detection → rollout copy → kill → `codex resume <id>
// "<prompt>"` on the next account. The skeleton is the same as the claude coordinator (rolling.ts) but
// it is far shorter because none of the statusLine-specific problems (a stale snapshot, readiness
// polling, auto-accepting trust) apply. Every side effect is injected through deps — it does not depend
// on electron, so it is verified with vitest. The wiring is in ipc.ts and index.ts.
import type { Account, RollStateEvent, SessionInfo } from '../core/types'
import type { RollConfig } from '../core/rolling/config'
import { RollCycle } from '../core/rolling/cycle'
import {
  laterBlock,
  pickAvailable,
  planRetry,
  type BlockRecord,
  type RetryState
} from '../core/rolling/retry'
import { BlockRegistry } from '../core/rolling/blockRegistry'
import { copyTranscript } from '../core/rolling/transcript'
import { codexHistoryStrategy } from '../core/history/strategies/codex'
import { findRollout } from '../core/rolling/codexLocate'
import {
  CodexLimitScanner,
  CodexModelChoiceScanner,
  CodexRolloutTail,
  limitReached,
  maxedOut,
  priorBlockAt,
  priorLimitVerdict,
  rolloutSize,
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
 *  in the log would itself be news. `priorBlock` is the reopened-conversation case: the session has no
 *  snapshot of its own and the block came out of the rollout it attached to (measured 2026-08-27, three
 *  resumes of one conversation). Recording it separately is what keeps the next person from reading a
 *  structured hit as the file's own record. */
type LimitReason =
  | 'reachedType'
  | 'errorInfo'
  | 'maxed+silent'
  | 'priorBlock'
  | 'force'

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
  /** Block records shared with every other rolling chain, in both coordinators (SPEC §11.2/6).
   *
   *  **The wiring passes one instance to both.** That is the whole point: three workers rolling through
   *  the same accounts used to each rediscover every block themselves, wasting a kill+respawn per
   *  worker per account. It is **required, not optional**, because an optional field can be dropped
   *  from the wiring without a single test failing — and the failure mode is this feature silently
   *  reverting to per-chain isolation. The same reasoning made rollAccountIds required. */
  blocks: BlockRegistry
  persistConfig?: (codexSessionId: string, config: RollConfig) => void
  copy?: (src: string, dest: string) => Promise<void> // for test injection — defaults to copyTranscript
  /** The rollout's byte size, `null` when it cannot be read. Injected the same way `copy` is, and for
   *  the same reason: the default is the real thing (rolloutSize). The in-place resume deadline is the
   *  only caller — see settleInPlace. */
  rolloutSize?: (filePath: string) => Promise<number | null>
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
   *  **이 코디네이터는 두 모양을 다 묻는다.** 계정이 바뀌는 재개는 kill 하고 `--resume` 으로 다시
   *  띄우므로 'handover' 이고(roll), 같은 계정으로 이어가는 재개는 세션을 살려 두므로 'update' 다
   *  (resumeInPlace). 가르는 기준은 `SPEC §11.5` 하나 — 그 경로가 `--resume` 을 부르는가다. */
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
  /** The block this conversation already had on record when we attached, or null when it records none.
   *  Only consulted while `state` is still null — see priorLimitVerdict. `undefined` means the answer
   *  has not arrived yet, and is deliberately distinct from null: reading "not yet known" as "no block
   *  on record" would let a phrase fire without the evidence that decides whether it is a replay.
   *  Only register()'s resume branch ever fills it — attachRollout clears it back to undefined for all
   *  three of its callers, and that comment is where the reasons are. */
  priorReset: { at: number; weekly: boolean } | null | undefined
  /** Whether the file has been asked at all. It exists for the log: "the answer has not arrived yet"
   *  and "there was never a question" both leave priorReset undefined, and the first is the line the
   *  incident log of 2026-08-27 was full of, indistinguishable from an ordinary missing snapshot (why). */
  priorAsked: boolean
  scanner: CodexLimitScanner // detects the limit phrase in PTY output (corrects for chunk boundaries)
  modelChoice: CodexModelChoiceScanner // detects codex's approaching-limit model-switch prompt in the same stream
  textHit: boolean // whether the limit phrase was seen in this window — read only by judgedByPriorBlock and the ignored-phrase log now that the phrase-only verdict is retired
  unmappedWarned: boolean // whether the rollout-unmapped skip has already been logged (suppresses repeats of the same line)
  preemptWarned: boolean // whether the preemption has already been logged — keeps it from piling up on every 1-second poll
  lastOutputAt: number
  rolling: boolean
  locateTimer: ReturnType<typeof setTimeout> | null
  waitTimer: ReturnType<typeof setTimeout> | null
  healthyTimer: ReturnType<typeof setTimeout> | null
  disposed: boolean
  recovery: (BlockRecord | null)[]
  inPlaceUsed: boolean // whether an in-place resume was already used for this blocked episode (cleared by healthyTimer)
  // The state-publication generation counter, incremented on every pushState. The deferred 'none' of
  // resumeInPlace (its 150ms Enter timer) captures the generation at scheduling time; on firing it
  // publishes only if the generation is unchanged, and skips as stale if a 'waiting' or 'switching'
  // has published something more recent in the meantime. Same mechanism and same reason as the claude
  // side (rolling.ts) — codex got its first deferred publish with the in-place resume.
  stateSeq: number
}

/** Extracts just the part of a Chain the retry verdict needs (the input of core/rolling/retry.ts).
 *
 *  The recovery array is the chain's own record **merged with what other chains found** — a block on
 *  an account is a fact about the account, so a chain that has not hit it yet should still skip it
 *  (SPEC §11.2/6). laterBlock keeps whichever side justifies the longer block. `chain.recovery` is left
 *  untouched: it still answers the per-chain question this coordinator asks it.
 *
 *  **This feeds planRetry as well as pickAvailable, and that is the expensive half.** planRetry walks
 *  every index including currentIndex, so a record another chain wrote about the account this chain is
 *  sitting on does not only steer this chain away from an account — it can extend and relabel this
 *  chain's own wait on the account it currently holds (measured on the claude side, same merge: a
 *  single-account chain whose own evidence said "session window resets in 2 minutes" published
 *  t0+3min/session alone and t0+61min/weekly once another chain had recorded that account
 *  weekly-exhausted first; a real weekly reset is days). That is correct when the record is right — a
 *  weekly-exhausted account is unusable whatever its session window says — and it is where a wrong
 *  record costs the most: the chain is now waiting rather than arriving, and only an arrival arms the
 *  healthy timer that would tear the record up (blockRegistry.clear). */
const retryState = (chain: Chain, blocks: BlockRegistry, now: number): RetryState => ({
  accountIds: chain.accountIds,
  currentIndex: chain.cycle.currentIndex,
  recovery: chain.accountIds.map((id, i) =>
    laterBlock(chain.recovery[i] ?? null, blocks.get(id, now))
  )
})

export class CodexRollingCoordinator {
  private chains = new Map<string, Chain>() // liveId → chain
  private ticker: ReturnType<typeof setInterval> | null = null
  private readonly copy: (src: string, dest: string) => Promise<void>
  private readonly rolloutSize: (filePath: string) => Promise<number | null>
  private readonly now: () => number

  constructor(private deps: CodexRollingDeps) {
    this.copy = deps.copy ?? copyTranscript
    this.rolloutSize = deps.rolloutSize ?? rolloutSize
    this.now = deps.now ?? Date.now
  }

  /** Called by ipc right after spawning a codex session that has rollAccountIds. One id means single-account auto-resume.
   *
   *  rolloutPath is the file the resumed codex will write to — ipc knows it because it is the target of
   *  the transcript copy it just made. Passing it skips the locate poll entirely, which is not an
   *  optimisation but the only way a resumed session gets mapped at all: see attachRollout. It is
   *  ignored unless the session really is a resume (info.resumeSessionId), because a fresh spawn's
   *  rollout does not exist yet and has to be found.
   *
   *  `sameAccount` says whether that file was written by the account this session is spawning under.
   *  ipc is the only side that can answer it — it holds both ends of the copy, and the target it built
   *  from the target account's own configDir equals the source exactly when the resume did not cross
   *  accounts. It gates one thing, the recovery read below; everything else here is account-independent.
   *  The default is the conservative answer, so a caller that cannot tell gets the behaviour this
   *  coordinator had before the recovery existed. */
  register(info: SessionInfo, rolloutPath?: string, sameAccount = false): void {
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
      priorReset: undefined,
      priorAsked: false,
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
      recovery: ids.map(() => null),
      inPlaceUsed: false,
      stateSeq: 0
    }
    this.chains.set(info.id, chain)
    if (info.resumeSessionId && rolloutPath) {
      this.attachRollout(chain, info.resumeSessionId, rolloutPath)
      // **This is the one attach site that gets to recover the reset from the file — and only when the
      // account matches.** The user reopened a conversation, so whatever block it ended on is still the
      // block it is under, and the tail starts at the end — so the file's own record is the only
      // evidence this session will ever have.
      //
      // **Why the account has to match.** The resume picker offers every logged-in account of the same
      // provider and picking a different one is an ordinary thing to do. The wiring then copies the
      // rollout into *that* account's folder and this chain starts on it, while the records inside the
      // copy belong to the account that was refused. Recovering them would attribute the block to an
      // account that is perfectly healthy, and onLimit broadcasts whatever it finds in chain.recovery to
      // the shared registry — so every other chain is steered off that account too, until a reset that
      // can be a week away. A two-account chain also kills the fresh session and respawns on the
      // exhausted one. None of it needs a limit phrase, and none of it happened before the recovery
      // existed. So for a cross-account reopen nothing is asked and the verdict is never consulted.
      if (sameAccount) this.askPriorReset(chain)
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
    // **Attaching never recovers the block; only register()'s resume branch asks for it.** The other
    // two callers attach to a file whose limit record must not be believed. resumeInPlace re-anchors on
    // the very file whose record produced the wait we have just served, so recovering it would judge
    // the session limited again the instant it resumes; roll() attaches to the copy, which holds the
    // *previous account's* record — the reason the tail starts at the end in the first place.
    //
    // **It clears to `undefined`, not to null, and the difference is the whole point.** null is a value
    // in this design — "no block on record" — and that is precisely the input that makes a phrase alone
    // sufficient (see priorLimitVerdict's last branch). Clearing to null would therefore mean that one
    // redrawn phrase after a roll produces a wait *and* writes a block against the freshly switched,
    // perfectly healthy account into the shared registry, where every other chain then honours it.
    // `undefined` leaves the verdict unconsulted, which is exactly the previous behaviour of both paths.
    chain.priorReset = undefined
    chain.priorAsked = false
  }

  /** Asks the rollout what block this conversation already ended on, and hands the answer to the chain.
   *  Called from the history-resume path alone, and there only when the file's records were written by
   *  the account we are resuming under (see register for that gate, and attachRollout for why the other
   *  two attach sites must not ask at all).
   *
   *  priorBlockAt, not the looser readPriorReset the tail seeds itself with: deciding *whether* the
   *  file records a block needs the structured limit signal, because a reset on its own is reported for
   *  any window at or above 90% — a merely busy conversation. The reasoning is on priorBlockAt.
   *
   *  Fire-and-forget: a failed read leaves it null, which reads as "no block on record" — the
   *  conservative side, since the verdict then needs a confirmed phrase before it acts. Until the answer
   *  lands the field stays undefined and the verdict is not consulted at all (judgedByPriorBlock).
   *
   *  Both callbacks are gated on the tail still being this chain's tail, the same across-await guard as
   *  `chain.liveId !== liveId` elsewhere in this file. Without it a read still in flight when the chain
   *  rolls or re-anchors would write the old file's block over the value attachRollout had just
   *  cleared — the trap above, arriving by race. Every re-attach builds a new tail, so identity of the
   *  object is identity of the attachment. */
  private askPriorReset(chain: Chain): void {
    const tail = chain.tail
    const rolloutPath = chain.rolloutPath
    if (!tail || !rolloutPath) return
    chain.priorReset = undefined
    chain.priorAsked = true
    void priorBlockAt(rolloutPath)
      .then((r) => {
        if (chain.tail === tail) chain.priorReset = r
      })
      .catch(() => {
        if (chain.tail === tail) chain.priorReset = null
      })
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

  /** Refreshes the state and applies the verdict `limitReached` sees from the structured signal — or,
   *  while this session has no snapshot of its own, priorLimitVerdict's reading of what the rollout
   *  already recorded (judgedByPriorBlock) */
  private async evaluate(chain: Chain): Promise<void> {
    if (chain.rolling || chain.waitTimer || chain.disposed) return
    await this.refresh(chain)
    if (chain.rolling || chain.waitTimer || chain.disposed) return // the across-await state guard
    if (this.judgedByPriorBlock(chain)) return
    if (!limitReached(chain.state)) {
      // Record exactly why it was ignored — logging an unmapped rollout as "usage below the gate" (the old
      // log printed undefined%) destroys the evidence for calibrating the phrase regex on the first real
      // limit hit
      if (chain.textHit)
        this.deps.log(`codex limit-text ignored (${this.why(chain)}) session=${chain.liveId}`)
      return
    }
    this.recordRecovery(chain)
    this.onLimit(chain, this.reasonOf(chain))
  }

  /** Which of the two structured signals carried the verdict.
   *
   *  **It no longer takes a fallback.** Both callers reach it only after `limitReached` has returned
   *  true, and that now requires `reachedType` or `error` — the same two this function tests. So the
   *  third branch was unreachable, and a parameter that can never be used is a parameter the next
   *  reader has to disprove. `reachedType` is checked first because it is the more specific claim; in
   *  practice it has never been observed non-null (see limitErrorOf), so the last line is what runs. */
  private reasonOf(chain: Chain): LimitReason {
    if (chain.state?.reachedType) return 'reachedType'
    return 'errorInfo'
  }

  /** Why the phrase failed to carry a verdict — distinguishes four branches: rollout unmapped, the
   *  file's own record not read yet, no snapshot received, and the snapshot's usage numbers when neither
   *  structured signal fired.
   *
   *  The in-flight case gets its own name because it is a different situation with the same symptom: on
   *  a history resume the verdict is waiting on the file's own record (askPriorReset), and the phrase
   *  that arrives before that read lands is not being ignored for lack of a snapshot — it will be judged
   *  a moment later. Reporting both as "rate_limits not received" is what made the 2026-08-27 log
   *  unreadable. Once the answer is in, priorReset is null or a value and this falls through. */
  private why(chain: Chain): string {
    if (!chain.tail) return 'rollout unmapped'
    if (!chain.state && chain.priorAsked && chain.priorReset === undefined)
      return 'prior block not read yet'
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

  /** The verdict for a session that has not written a rate_limits record of its own yet. Returns true
   *  when it has handled the chain and the caller must stop.
   *
   *  The state is still null: no rate_limits record has been written since we attached. That is the
   *  normal shape right after a resume, and a session already at its limit can never leave it — those
   *  records ride on turn completion, and a blocked turn never completes. So the file's own record is
   *  the only evidence available, and both directions matter: it lets a limit fire with no phrase at
   *  all, and it lets a phrase be dismissed as the redraw of a block that has already cleared. See
   *  priorLimitVerdict for the reasoning; the moment the session writes its own record this stops
   *  answering and the ordinary verdicts take over unchanged.
   *
   *  Called from both the phrase path (evaluate) and the tick — the firing-without-a-phrase case can
   *  only arrive on the tick, so one copy per caller would drift. */
  private judgedByPriorBlock(chain: Chain): boolean {
    if (chain.state !== null || chain.priorReset === undefined) return false
    const now = this.now()
    const v = priorLimitVerdict(chain.priorReset, { textHit: chain.textHit }, now)
    if (v.kind === 'limited') {
      // recordRecovery cannot be reused here — it reads worstResetAt(chain.state) and that state is
      // null. The verdict already carries the reset, so it is recorded as it stands. Writing it into
      // chain.recovery *before* onLimit is what hands it to the shared registry too (SPEC §11.2/6):
      // onLimit re-reads this slot and broadcasts it, but only once its own guards have passed.
      //
      // **Known imprecision, and nothing tears it up.** register only asks the file when the reopen
      // stays on the account that wrote it, so the slot (currentIndex, always 0 on a fresh register)
      // is that account. The shape that still slips through is a rollout a *roll* copied into this
      // account's folder: the copy carries the previous account's records, yet reopening it here is a
      // same-account resume by every test we have — not because the two cases cannot be told apart,
      // but because nothing here currently tries. RollConfigStore is already keyed by the codex
      // session id and written on every attach, so recording which account last ran that session would
      // answer it, and would survive a restart; the copy's own file creation time is the roll instant,
      // so a record predating it was written elsewhere — with the caveat this repo already knows, that
      // creation time is unreliable on some filesystems. Neither is wired up, which is why this stays
      // documented rather than restructured. Do not expect the healthy timer to cover it: that timer
      // is armed by an *arrival* on an account (blockRegistry.clear), and this session is already
      // sitting on it, going straight into a wait — so a wrong reset here holds for its full length,
      // for every chain.
      //
      // **The reset is recorded only when the file supplied one.** at === null is priorLimitVerdict's
      // phrase-only branch — the weakest evidence in the design: no record in the file, so the screen
      // text is all there is, and the scanner reads the whole redraw, so an agent's own output, a quoted
      // log or a pasted document carrying a limit-shaped sentence reaches it too. Leaving the slot empty
      // keeps that evidence inside this chain. planRetry reads an empty slot as now + RETRY_FALLBACK_MS,
      // the very value blockedUntil computes from { at: null, since: now }, so this wait is unchanged —
      // while onLimit, which broadcasts whatever this slot holds, then has nothing to say and no other
      // chain is steered off a healthy account by one line of text. The one further effect is wanted
      // too: with the slot empty, a later pass of this chain does not skip the account either.
      if (v.at !== null)
        chain.recovery[chain.cycle.currentIndex] = { at: v.at, weekly: v.weekly, since: now }
      chain.textHit = false // spent either way — the next tick must not fire on the same phrase again
      this.onLimit(chain, 'priorBlock')
      return true
    }
    if (v.kind === 'replay') {
      chain.textHit = false
      this.deps.log(
        `codex limit-text ignored (replay of a block that already cleared) session=${chain.liveId}`
      )
      return true
    }
    return false
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
    // One clock reading for the whole verdict. pickAvailable and planRetry below have to judge the same
    // instant — if time moves between them, an account pickAvailable called unusable can look usable to
    // planRetry microseconds later, and the wait would target an account it had just refused.
    const now = this.now()
    // The shared write is here rather than in recordRecovery because recordRecovery runs at three call
    // sites and every one of them is ahead of the guards above (the rollout-unmapped one especially) —
    // writing there would broadcast to every other chain a verdict this coordinator has just declined to
    // act on. It re-reads the record recordRecovery stored instead of building a second one, so the two
    // stores hold the same object and cannot drift (SPEC §11.2/6). forceRoll reaches here without a
    // record; there is then nothing to say.
    const record = chain.recovery[chain.cycle.currentIndex]
    if (record) this.deps.blocks.record(chain.accountIds[chain.cycle.currentIndex], record, now)
    const target =
      action.type === 'roll'
        ? pickAvailable(retryState(chain, this.deps.blocks, now), action.toIndex, now)
        : null
    // The detour, in the same shape as the claude side. 'shared' marks a skip around an account **this
    // chain never touched** — the block came from another chain's record. Without it the log cannot answer
    // "why did this worker skip an account it had no history with", which is the first question an
    // incident asks now that a block can arrive from elsewhere (SPEC §11.2/6).
    const skipShared =
      action.type === 'roll' &&
      !chain.recovery[action.toIndex] &&
      this.deps.blocks.get(chain.accountIds[action.toIndex], now) !== null
    const detour =
      action.type === 'roll' && target !== action.toIndex
        ? ` blocked(${action.toIndex}${skipShared ? ',shared' : ''})→${target === null ? 'wait' : target}`
        : ''
    // reason and the raw reachedType are the only evidence for calibrating the assumptions we have not
    // measured yet (the limit phrase, the reachedType values, replay behaviour) on the first real hit — so
    // what fired and the raw value are recorded together
    this.deps.log(
      `codex limit detected session=${chain.liveId} reason=${reason} ` +
        `reachedType=${chain.state?.reachedType ?? 'null'} ${this.why(chain)} ` +
        `action=${JSON.stringify(action)}${detour}`
    )
    if (target === null) {
      const plan = planRetry(retryState(chain, this.deps.blocks, now), now)
      this.pushState(chain, 'waiting', {
        nextRetryAt: new Date(plan.retryAt).toISOString(),
        scope: plan.weekly ? 'weekly' : 'session'
      })
      chain.waitTimer = setTimeout(
        () => {
          chain.waitTimer = null
          void this.resumeAfterWait(chain, plan.target)
        },
        Math.max(0, plan.retryAt - this.now())
      )
    } else {
      void this.roll(chain, target)
    }
  }

  /** 재개 자리에 실을 텍스트를 정한다. **어느 모양을 물을지는 이 함수를 부르는 자리가 정한다** —
   *  가르는 기준은 `SPEC §11.5` 하나다: 그 경로가 `--resume` 을 부르는가.
   *   - 'handover'(전체 인계): `roll()`. kill 하고 `--resume` 으로 다시 띄우므로 프로세스가 새것이고,
   *     작업을 이어 주는 것은 rollout 파일 하나다.
   *   - 'update'(덧붙일 한 줄): `resumeInPlace`. **세션이 살아 있다** — 떨어뜨린 것이 없으니 인계할
   *     것도 없고, 대화가 온전한 에이전트에게 Task 지시문을 다시 읽히는 것은 방금 리셋된 할당량을
   *     이미 아는 것에 쓰는 일이다. 그래서 기다리는 동안 무엇이 바뀌었는지만 덧붙인다.
   *
   *  'update' 를 **덧붙이는** 이유: 이 경로에서 `chain.prompt` 는 잃을 것이 없는 값이고, 사용자가
   *  직접 지정한 문구일 수도 있다(register 의 prompt). 대체하면 그것을 버린다.
   *
   *  **try/catch 가 여기 있는 이유는 `roll()` 의 catch 가 있는 자리다.** 그 호출은 roll() 바깥 try
   *  안에 있고 그 catch 는 kill·respawn **앞에서** 돈다 — 즉 깨진 packet 계약이 인계 문장을 얇게
   *  만드는 것이 아니라 **롤 자체를 중단시킨다.** 그 catch 는 이제 'none' 으로 끝내지 않고 다음
   *  시도를 예약하므로(rescheduleAbortedRoll) 워커가 영구히 멈추지는 않는다. 그래도 이 가드는
   *  그대로 필요하다: 깨진 packet 계약이 **이번 롤이 일어나는지를 결정해서는 안 된다.** 그것이
   *  결정해도 되는 것은 인계 문장의 내용까지고, 가드가 없으면 대신 소진된 계정에 앉은 채 재시도
   *  간격(리셋 시각, 모르면 15분)을 한 번 더 기다린다 — 그것이 이 함수가 막는 실제 대가다.
   *  resumeText 는 던지지 않는다는 계약이지만(resumePacket.ts) 그 계약이 깨질 때 잃는 것이 이만큼
   *  크므로 로그를 남기고 기존 고정 문장으로 저하한다. rolling.ts 의 같은 이름 함수와 같은 모양이다. */
  private async resumePromptFor(
    chain: Chain,
    liveId: string,
    form: 'handover' | 'update'
  ): Promise<string> {
    try {
      const text = await this.deps.resumeText?.(liveId, form)
      if (text === null || text === undefined) return chain.prompt
      return form === 'update' ? `${chain.prompt} ${text}` : text
    } catch (err) {
      this.deps.log(
        `resume packet hook failed session=${liveId}: ${err instanceof Error ? err.message : String(err)}`
      )
      return chain.prompt
    }
  }

  /** What to resume with once the wait ends — the codex counterpart of the claude side's
   *  `resumeAfterWait` (rolling.ts).
   *
   *  If the account changes, a new process is unavoidable. If it does not change, there is no reason
   *  to kill — the session id is kept, so moving the schedule, Slack, turn notifications and
   *  orchestration Dispatch onto a new id all become unnecessary, and no rollout copy is needed
   *  either.
   *
   *  **It deliberately does not ask "is the session working right now".** This wait only happens
   *  once the limit verdict has passed, so at this moment the session is necessarily halted, and
   *  codex does not carry on by itself once the limit lifts (the measured screen tells it to retry
   *  at that point — docs/codex_usage_limit2.png). This is the spot where the claude-side design
   *  tried to stack that verdict three ways and produced a fresh defect every time. */
  private resumeAfterWait(chain: Chain, toIndex: number): Promise<void> {
    if (chain.disposed || chain.rolling) return Promise.resolve()
    if (toIndex !== chain.cycle.currentIndex) return this.roll(chain, toIndex) // the account changes
    if (chain.inPlaceUsed) {
      // The last in-place resume never reached the healthy window — that means the reset input line
      // did not actually recover the session, so this time a fresh process is spawned instead. This
      // guards the one premise in this plan that has never been measured: whether codex's composer
      // really accepts a new turn after the reset. onLimit clears healthyTimer before it decides, so
      // this flag survives a second limit that lands inside the healthy window. The case where the
      // composer swallows the line and *no* second limit ever arrives cannot reach this branch at all
      // — settleInPlace is what covers that one.
      this.deps.log(
        `codex resume in place did not recover — falling back to respawn session=${chain.liveId}`
      )
      return this.roll(chain, toIndex)
    }
    if (chain.modelChoice.pending()) {
      // If the list is still open, Enter would approve the highlighted item. kill wipes the whole
      // screen, so that path is safe — the same judgment as the claude side's choicePending.
      this.deps.log(
        `codex resume in place skipped — model prompt still on screen session=${chain.liveId}`
      )
      return this.roll(chain, toIndex)
    }
    return this.resumeInPlace(chain)
  }

  /** Continuing on the same account — no kill, no spawn, no copy; only one line plus Enter go into
   *  the live PTY. This is the same channel `answerModelChoice` already uses, and the same constant
   *  (ENTER_DELAY_MS).
   *
   *  What this function actually does is undo three things.
   *   ① **Re-attach the tail at the end of the file.** Through the wait, tick skipped this chain
   *      (the waitTimer guard), so the tail still holds the position it last read from, and the
   *      first tick after the resume would **read that very record that caused this wait again**
   *      and raise the same limit immediately. Same reason roll() uses startAtEnd on the copy, and
   *      it writes the same function (attachRollout) to the same file again.
   *   ② **Clear state.** The last snapshot is 100% — leaving it would fire the maxed+silent fallback
   *      again right after the resume. roll() does the same thing at the respawn point.
   *   ③ **Reset the textHit latch and the phrase scanner.** Once the same reason as ①·②; since the
   *      phrase-only verdict was retired the latch can no longer re-raise a verdict, so clearing it now
   *      only keeps the ignored-phrase log honest about which episode a phrase belongs to.
   *
   *  The timer it arms last is not a plain healthy timer — it is a deadline that has to decide whether
   *  the typed line started a turn at all. See settleInPlace.
   *
   *  **The try/catch is here for the same reason roll() has one.** This function is void-called (the
   *  wait timer in onLimit), so a rejection escaping it would be an unhandled rejection and the chain
   *  would be left published as 'nudged' with the scheduler's suppression still on. The realistic case
   *  is deps.write throwing on a PTY that died during the wait. */
  private async resumeInPlace(chain: Chain): Promise<void> {
    try {
      if (chain.rolloutPath && chain.codexSessionId)
        this.attachRollout(chain, chain.codexSessionId, chain.rolloutPath) // ①
      chain.state = null // ②
      chain.textHit = false // ③
      chain.scanner = new CodexLimitScanner()
      chain.lastOutputAt = this.now()
      chain.inPlaceUsed = true
      // 'nudged' is the right state — this is a reset resume, not an account switch, the renderer
      // treats it as a momentary event, and the Slack mapping (slack.limitReset) already exists. Same
      // choice as the claude-side resumeInPlace.
      this.pushState(chain, 'nudged')
      const liveId = chain.liveId
      this.deps.log(`codex limit reset → resume in place session=${liveId}`)
      // The baseline the deadline compares against, read **before** anything is submitted. An earlier
      // version only *started* this read here and let settleInPlace await it, to keep a file-system
      // round trip out of the way of the 150ms Enter. That is not safe: if the stat resolved after
      // codex had already appended the record for the line we submitted, the baseline would contain
      // that record, the deadline would see no growth against it — and a swallowed line would look
      // like a session that is working, which is exactly the eternal stall settleInPlace exists to
      // end. One late append is enough. So it is awaited, and it is read before the prompt build so
      // that the single across-await guard below covers both awaits. Delaying the submission costs
      // nothing here: the line above already awaits resumePromptFor, which reads git.
      const sizeBefore = chain.rolloutPath
        ? await this.rolloutSize(chain.rolloutPath).catch(() => null)
        : null
      const prompt = await this.resumePromptFor(chain, liveId, 'update')
      if (chain.disposed || chain.liveId !== liveId) return // the across-await state guard
      const stateSeq = chain.stateSeq // captures the generation at scheduling time — the same convention as the claude side
      this.deps.write(liveId, prompt)
      setTimeout(() => {
        if (chain.disposed || chain.liveId !== liveId) return
        this.deps.write(liveId, '\r')
        // 'none' has to be published after Enter for the scheduler's suppression to lift (same order
        // as the claude side). If a more recent state was published in between, ours is stale and is
        // skipped — publishing it anyway would lift the suppression and clear the orchestration stop
        // marker while the chain is in fact waiting or switching again.
        if (chain.stateSeq === stateSeq) this.pushState(chain, 'none')
      }, ENTER_DELAY_MS)
      chain.healthyTimer = setTimeout(() => {
        void this.settleInPlace(chain, liveId, sizeBefore)
      }, HEALTHY_MS)
    } catch (err) {
      this.deps.log(
        `codex resume in place failed: ${err instanceof Error ? err.message : String(err)}`
      )
      this.pushState(chain, 'none')
    }
  }

  /** The deadline of an in-place resume: HEALTHY_MS after the line went in, did a turn actually run?
   *
   *  **Why this exists.** If the composer ignores the line we typed, the session prints nothing and
   *  writes nothing. Nothing printed means no limit is ever detected again, so onLimit and therefore
   *  resumeAfterWait are never reached again, and nothing respawns: the worker sits idle forever with
   *  no notification. The 15-second tick cannot catch it either — resumeInPlace just nulled the state,
   *  so both limitReached and maxedOut are false and there is no idle detector on this side. So the
   *  timer that used to only reset the block count now also has to answer the question, and roll when
   *  the answer is no. That respawn is the one this chain should have had.
   *
   *  **Why the rollout file and not PTY output.** The TUI echoes our own keystrokes back through
   *  handleData, so chain.lastOutputAt advances even when the input was swallowed — output cannot tell
   *  the two apart. The rollout can: codex appends a record for the submitted message as soon as it
   *  accepts it (see rolloutSize).
   *
   *  **A size we cannot read counts as no growth.** A spurious respawn is recoverable — `codex resume`
   *  reconstructs the conversation — while an eternal stall is not. rolloutSize swallows its own errors
   *  for that reason, and the `.catch(() => null)` on both reads (the baseline resumeInPlace awaits and
   *  the one here) covers an injected implementation that does not — nothing here may throw out of the
   *  timer callback. */
  private async settleInPlace(
    chain: Chain,
    liveId: string,
    sizeBefore: number | null
  ): Promise<void> {
    chain.healthyTimer = null
    if (chain.disposed || chain.liveId !== liveId) return
    const sizeAfter = chain.rolloutPath
      ? await this.rolloutSize(chain.rolloutPath).catch(() => null)
      : null
    if (chain.disposed || chain.liveId !== liveId) return
    if (sizeBefore === null || sizeAfter === null || sizeAfter <= sizeBefore) {
      // roll() arms the healthy timer itself and has its own `rolling` guard, so there is nothing to
      // clear or coordinate here beyond having nulled healthyTimer above.
      this.deps.log(
        `codex resume in place produced no turn (rollout ${sizeBefore ?? 'unreadable'} → ` +
          `${sizeAfter ?? 'unreadable'} bytes) — respawning session=${liveId}`
      )
      await this.roll(chain, chain.cycle.currentIndex)
      return
    }
    // A turn ran — what the plain healthy timer always did. Without this, recovery[current] stays set
    // and the next limit is misread as a whole lap being blocked.
    chain.cycle.onHealthy()
    chain.recovery[chain.cycle.currentIndex] = null
    // The rollout grew, so a turn actually ran on this account — of the four clear sites this is the only
    // one holding evidence of work rather than 60 seconds of silence. So the account demonstrably works and
    // the shared record must go too: otherwise one bad reading keeps every other chain off it until its
    // recorded reset time passes (blockRegistry.clear).
    this.deps.blocks.clear(chain.accountIds[chain.cycle.currentIndex])
    chain.inPlaceUsed = false
  }

  /** A roll gave up. Schedule the next attempt instead of leaving the chain idle.
   *
   *  **Why this exists.** These abort paths used to publish 'none' and return, which schedules nothing:
   *  the session is still blocked by its limit, nothing else will detect it (the limit was already
   *  consumed), and the worker sits idle until a human notices. It surfaced twice — an account removed
   *  from the chain while it ran (pickAvailable sees ids only, so it hands roll() an account that cannot
   *  be resolved), and a conversation reopened from history whose session metadata was never learned
   *  because the limit stops the statusLine from being called at all.
   *
   *  **Why the wait machinery and not a new timer.** onLimit's "no usable account" branch already
   *  publishes 'waiting' with a retry time and arms waitTimer. Reusing it means the renderer's waiting
   *  row, the scheduler's suppression and the Slack mapping all keep working here — a new state or a
   *  private timer would have to be taught to each of them.
   *
   *  **Why 'waiting' replaces the 'none' rather than following it.** Publishing 'none' first lifts the
   *  scheduler's suppression and clears the banner, and then puts it straight back.
   *
   *  **Why retrying an abort that will abort again is right, and what the loop costs.** If the account
   *  is gone for good this repeats at the interval planRetry computes — the recorded reset plus the
   *  margin, or the 15-minute fallback when no reset is known. (The 60-second floor only applies when
   *  that time has already passed, so it is not the loop's normal period.) Each round logs. And a round
   *  is not always only a log line: when planRetry's target resolves to the account this chain is
   *  already on, resumeAfterWait resumes in place, which types the prompt and Enter into the live PTY.
   *  That is the same loop shape the ordinary wait path has always had, so none of it is new behaviour
   *  — and it is still better than silence, because the log is the only thing that can tell someone to
   *  re-add the account or close the session.
   *
   *  This is a second copy of the claude side's function of the same name, deliberately — lifting timer
   *  lifetimes into a common parent is the axis of this app that has produced the most bugs
   *  (core/rolling/retry.ts's header records that decision). */
  private rescheduleAbortedRoll(chain: Chain, why: string): void {
    // Defensive. No caller can actually reach here with a wait already armed — onLimit's wait branch
    // does not call roll() — but it is checked because being wrong once costs a second timer on the
    // same chain: one of the two leaks with nothing left holding its handle, and the session resumes
    // twice.
    if (chain.waitTimer || chain.disposed) return
    // One clock reading, for the same reason onLimit takes one: the block records retryState merges and
    // the instant planRetry judges them against have to be the same moment.
    const now = this.now()
    const plan = planRetry(retryState(chain, this.deps.blocks, now), now)
    this.deps.log(
      `codex roll retry scheduled after abort (${why}) at=${new Date(plan.retryAt).toISOString()} session=${chain.liveId}`
    )
    this.pushState(chain, 'waiting', {
      nextRetryAt: new Date(plan.retryAt).toISOString(),
      scope: plan.weekly ? 'weekly' : 'session'
    })
    chain.waitTimer = setTimeout(
      () => {
        chain.waitTimer = null
        void this.resumeAfterWait(chain, plan.target)
      },
      Math.max(0, plan.retryAt - this.now())
    )
  }

  /** Runs the roll: copy the rollout → kill → respawn in the same slot with codex resume */
  private async roll(chain: Chain, toIndex: number): Promise<void> {
    if (chain.rolling || chain.disposed) return
    chain.rolling = true
    try {
      const target = this.deps.getAccount(chain.accountIds[toIndex])
      if (!target) {
        this.deps.log(`codex roll aborted — no such account id=${chain.accountIds[toIndex]}`)
        this.rescheduleAbortedRoll(chain, 'no such account')
        return
      }
      if (!chain.codexSessionId || !chain.rolloutPath) {
        this.deps.log(`codex roll aborted — rollout unmapped session=${chain.liveId}`)
        chain.unmappedWarned = false // let a still-unmapped state report itself again on the next retry round
        this.rescheduleAbortedRoll(chain, 'rollout unmapped')
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
      const prompt = await this.resumePromptFor(chain, chain.liveId, 'handover')
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
      // dest is sent along too, so the CodexRolloutWatcher re-registration (index.ts) can drop this copy from
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
        // What this timer observed is 60 seconds with **no limit detected** — not that a turn actually ran
        // (settleInPlace is the only site with that evidence). The shared record goes with it because a
        // false one keeps every other chain off the account until its recorded reset time passes; the price
        // is that a *true* record another chain wrote inside this window is erased by a session that has
        // not produced any work of its own yet (blockRegistry.clear).
        this.deps.blocks.clear(chain.accountIds[chain.cycle.currentIndex])
        chain.inPlaceUsed = false
      }, HEALTHY_MS)
      this.pushState(chain, 'none')
    } catch (err) {
      this.deps.log(`codex roll failed: ${err instanceof Error ? err.message : String(err)}`)
      // **The state published here can be optimistic.** If the throw landed between the kill and the
      // re-key, this 'waiting' — and the resume the timer eventually fires — is addressed to a session
      // id that no longer exists; 'none' was the more honest state for that one window. The session was
      // already lost at that point and that fatality is pre-existing, not something the reschedule adds.
      // It is deliberately not distinguished: a flag saying "the kill already happened" would have to be
      // threaded through the whole kill→spawn→re-key sequence to be correct, and a wrong flag would
      // silence the reschedule on the aborts that need it.
      this.rescheduleAbortedRoll(chain, 'roll failed')
    } finally {
      chain.rolling = false
    }
  }

  /** The 15-second tick — refreshes the state, applies verdict ① (reachedType with no phrase), the
   *  recovered block of a session that has no snapshot yet (judgedByPriorBlock — the only place that
   *  verdict can fire without a phrase) and fallback ③ (100% plus 30 seconds of no output) */
  private tick(): void {
    for (const chain of this.chains.values()) {
      if (chain.disposed || chain.rolling || chain.waitTimer || !chain.tail) continue
      void this.refresh(chain).then(() => {
        if (chain.disposed || chain.rolling || chain.waitTimer) return
        if (this.judgedByPriorBlock(chain)) return
        if (limitReached(chain.state)) {
          this.recordRecovery(chain)
          this.onLimit(chain, this.reasonOf(chain))
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
    chain.stateSeq++ // the generation advances on every publication — the basis for deciding whether a deferred publication is stale
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
