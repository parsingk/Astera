// The chat session manager (chat-sessions design §6): owns one adapter per chat session, mirroring the
// parts of the pty SessionManager (core/sessions/manager.ts) the app relies on — a spawn/adopt pair that
// produces a SessionInfo, list/info/has lookups, rename/remember note-keeping, the running(outlivesApp)
// split, and a kill that never throws for an id it does not know.
//
// Unlike SessionManager, a chat session's process never talks lines of terminal output to the renderer —
// it talks its CLI's own line protocol (core/chat/codexProtocol.ts or core/chat/claudeProtocol.ts)
// through an adapter (./codexAdapter.ts, ./claudeAdapter.ts) picked by the account's provider (Task 4),
// and this manager's job is only to spawn/adopt that process, hold one adapter per session, keep
// SessionInfo in step with what the adapter reports, and fan the adapter's events out to whoever is
// watching (main/ipc.ts's chat:event bridge, in Task 6).
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Account, ScheduleConfig, SessionInfo } from '../../core/types'
import type { Provider } from '../../core/providers/meta'
import { providerOf } from '../../core/providers/meta'
import { descriptorOf, type ProviderDescriptor } from '../../core/providers/descriptor'
import type { ProcFactory, ProcLike } from '../../core/sessions/proc'
import { cliEnvFor } from '../../core/sessions/cliEnv'
import { buildCodexAppServerCommand, buildClaudeChatCommand } from '../../core/sessions/commands'
import type { PtyMeta } from '../../core/host/protocol'
import type { ChatAdapter, ChatAnswer, ChatEvent, ChatState, PermissionMode, PermissionModeChoice } from '../../core/chat/types'
import type { ModelDescriptor } from '../../core/models/types'
import { BYPASS_ENV, shouldRetryWithBypass, watchFirstLine } from '../../core/sessions/retryBypass'
import { STDERR_TAIL_MAX } from '../../core/sessions/stderrTail'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../../core/sessions/pty'
import { createCodexAdapter, type AdapterMode } from './codexAdapter'
import { createClaudeAdapter } from './claudeAdapter'

type ExitEvent = Extract<ChatEvent, { type: 'exit' }>

/** design F5's last line: a bypass retry that also dies with nothing said loses the *first* attempt's
 *  stderr the moment the second one's overwrites it, and the first is usually the one that actually
 *  names the refusal (a toolchain manager's own complaint) — the second is often just the same bare
 *  exit with no manager in front of it to say anything at all. Fix round 1 / C-review: both sides are
 *  labelled **even when one is empty** — the old join-only-if-both-present shape silently presented
 *  whichever side had content as if it were the *other* attempt's last words. `error` prefers the
 *  second attempt's one-line reason (the freshest), falling back to the first's. */
function mergeFailedRetry(first: ExitEvent, second: ExitEvent): ExitEvent {
  const error = second.error ?? first.error
  let errorDetail: string | null = null
  if (first.errorDetail !== null || second.errorDetail !== null) {
    // Each side keeps its own half of the one shared budget (S3: still the single number, just split,
    // not a second one invented for the joined case) rather than joining first and re-capping the
    // whole string — a whole-string cap, once both tails are near the max, can crop the *second*
    // label off entirely along with all of the first attempt's content: backwards, since the second
    // attempt is the fresher one and the one a reader has the least other context for.
    const perSide = Math.floor(STDERR_TAIL_MAX / 2)
    const label = (n: 1 | 2, tag: string, tail: string | null): string =>
      `[attempt ${n}, ${tag}] ${(tail ?? '(no output)').slice(-perSide)}`
    errorDetail = `${label(1, 'no bypass', first.errorDetail)}\n---\n${label(2, 'with bypass', second.errorDetail)}`
  }
  return {
    type: 'exit',
    code: second.code,
    errorDetail,
    ...(error !== undefined ? { error } : {})
  }
}

export interface ChatManagerDeps {
  factory: ProcFactory
  descriptors: Record<Provider, ProviderDescriptor>
  homeDir: string
  platform: NodeJS.Platform
  version: string
  log(m: string): void
  /** Test injection; default createClaudeAdapter / createCodexAdapter, picked by provider. */
  createAdapter?(a: { proc: ProcLike; mode: AdapterMode; version: string; log(m: string): void; provider: Provider }): ChatAdapter
}

/** What `respawnWithBypass` needs to spawn the exact same session again — everything `spawn()` built
 *  from its `opts` before those went out of scope, plus the arguments `adapter.start` was called with.
 *  Carried on the tracked session rather than recomputed, because the second attempt has no `opts` to
 *  recompute it from: by the time an `exit` event arrives, `spawn()` has long since returned. */
interface RetryMaterials {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  meta: PtyMeta
  provider: Provider
  startArgs: { cwd: string; resumeThreadId?: string; bypass: boolean }
  /** C1 / fix round 1: the handover briefing a rolling respawn carries — for a chat chain it is the
   *  *only* delivery channel (rolling.ts / codexRolling.ts both skip their own auto-prompt for chat,
   *  saying the spawn carries it). Attempt 0's own `spawn()` continuation only sends this once its
   *  `adapter.start` resolves; a silent death means that promise rejects instead, so the send never
   *  ran and the prompt would otherwise be lost, not merely deferred. Carried here so the retry's own
   *  success continuation can send it once, for the one attempt that actually gets a live thread. */
  initialPrompt?: string
}

interface LiveChatSession {
  info: SessionInfo
  proc: ProcLike
  adapter: ChatAdapter
  /** The model the *person* picked, or null while they have not. Deliberately not "the model in use":
   *  a CLI can move off a model on its own (Claude does, when a limit is reached mid-session), and
   *  carrying that onto the fresh account a roll switches to would pin a fallback on an account that
   *  never hit anything. What a roll has to carry is the choice. Claude needs it because its model is
   *  argv and nothing about it survives the process — `--resume` restores the conversation, not a
   *  mid-session `set_model`. codex does not: its model lives on the thread, and `thread/resume`
   *  reports it back (codexAdapter seeds its state from that same result). */
  chosenModel: string | null
  /** Task 7 (design F5) — the retry-once bookkeeping for a CLI a toolchain manager silently refused to
   *  run. `attempt`/`spawnAt`/`sawLine` are exactly what `shouldRetryWithBypass` asks for; `retry` is
   *  null for an adopted session (nothing to respawn with, and there is nothing to refuse — the process
   *  was already running when this app found it) and `attempt` starts at 1 for one, so the check never
   *  even asks. `firstFailure` is attempt 0's exit, held only so a second, still-bypassed failure can
   *  show both attempts' last words together (design F5's own last line) instead of losing the first's
   *  — and cleared the moment a retry actually succeeds (C2 / fix round 1), or it goes on sitting here
   *  and poisons whatever ordinary exit this session eventually has, hours later, with none of it. */
  attempt: number
  spawnAt: number
  sawLine: () => boolean
  retry: RetryMaterials | null
  firstFailure: ExitEvent | null
  /** C3 / fix round 1: "we asked for this" — set by `kill()` before `handleEvent` ever sees the exit it
   *  causes. Without it, closing a slow-starting tab within the five-second window reads exactly like a
   *  toolchain refusal: a fresh CLI spawns behind the closed tab, with the bypass on, and `info.status`
   *  stays `'running'` for a process nothing now holds a handle to. The quit sweep (`index.ts`'s
   *  `will-quit`) already calls this same `kill()`, so it needs no separate flag or wiring. */
  killRequested: boolean
  /** C4 / fix round 1: the unsubscribe `adapter.on(...)` returned, called when tearing this attempt
   *  down for a retry. Without it, attempt 0's own async tail — `doStart`'s catch calling `core.fail()`
   *  a microtask after the exit that already got swallowed — goes on reaching `handleEvent` under the
   *  id the *replacement* now owns, and `chatBannerFor` ranks that stray `error` over the retry's own
   *  `notice`, so the feature's happy path shows a live, healthy session as if its turn had failed. */
  off: () => void
  /** "Told once" needs a home besides the event stream, or a pane that mounts after the retry already
   *  succeeded — always true for a rolling respawn, where main emits while the renderer is still
   *  building the tab — never sees it (adapterCore's own `fail()` states the same rule: remembered, not
   *  just announced). Cleared on the next `send()`, mirroring the adapters' own `patch({ error: null })`
   *  on a fresh turn. */
  notice: 'bypassed' | null
  /** Fix round 2 (final review, finding 2): the exit `handleEvent` actually forwarded — after
   *  `mergeFailedRetry` when both attempts died, or the adapter's own raw event otherwise. `state()`
   *  reads straight off `live.adapter.state()`, and that adapter is attempt 1's alone: its own
   *  `core.onExit` only ever saw attempt 1's tail, never the merged one. The merge was applied to the
   *  *event* and forwarded once, so a pane open at that moment sees it — but `useChatState` re-pulls
   *  `state()` on every mount and every time the pane is re-enabled (a tab switch), and that re-pull
   *  used to hand back attempt 1's unmerged, often-empty tail, losing the one attempt that actually
   *  named the refusal. Held here and overlaid in `state()`, the same way `notice` already is, so a
   *  re-pull matches what the event already told an open pane. Null until this session's exit is
   *  actually reported (never for a still-running session, and untouched by a retry in flight). */
  finalExit: ExitEvent | null
}

export class ChatSessionManager {
  private sessions = new Map<string, LiveChatSession>()
  private listeners: Array<(sessionId: string, e: ChatEvent) => void> = []
  onExit?: (e: { sessionId: string; exitCode: number }) => void

  constructor(private deps: ChatManagerDeps) {}

  /** Picks the process command and the adapter by the account's provider. Returns at once; the
   *  adapter's start() runs in the background and its failure is an `error` event followed by `exit`
   *  (the adapter kills its own proc on a failed handshake — see codexAdapter.ts's / claudeAdapter.ts's
   *  doStart). */
  spawn(opts: {
    account: Account
    cwd: string
    resumeThreadId?: string
    bypassPermissions?: boolean
    title?: string
    schedule?: ScheduleConfig
    slackNotify?: boolean
    rollAccountIds?: string[]
    rollPrompt?: string
    initialPrompt?: string
    /** Claude only: start the CLI on this model (`--model`). A roll passes the chain's remembered
     *  choice here, which is the only way it survives — see LiveChatSession.chosenModel. */
    model?: string | null
  }): SessionInfo {
    const provider = providerOf(opts.account)
    const descriptor = descriptorOf(this.deps.descriptors, opts.account)

    const id = randomUUID()
    const title = opts.title ?? path.basename(opts.cwd)
    const bypassPermissions = opts.bypassPermissions
    const bypass = !!bypassPermissions
    const resumeThreadId = opts.resumeThreadId
    const { schedule, slackNotify, rollAccountIds, rollPrompt } = opts
    const initialPrompt = opts.initialPrompt

    const env = cliEnvFor({ base: process.env, account: opts.account, descriptor, homeDir: this.deps.homeDir })
    // Codex resumes over the app-server protocol (thread/resume, sent by the adapter once the process is
    // up); Claude has no such call, so its resume id is argv (--resume=<id>) instead — buildClaudeChatCommand
    // takes it directly.
    const { file, args } =
      provider === 'claude'
        ? buildClaudeChatCommand(this.deps.platform, { resumeSessionId: resumeThreadId, bypass, model: opts.model })
        : buildCodexAppServerCommand(this.deps.platform)
    const meta: PtyMeta = {
      kind: 'chat',
      id,
      restore: {
        accountId: opts.account.id,
        cwd: opts.cwd,
        title,
        provider,
        bypassPermissions: bypass,
        ...(resumeThreadId ? { threadId: resumeThreadId } : {}),
        // The three features that ride on the session and must come back after a restart — the same
        // three the pty note carries (core/sessions/manager.ts). The schedule is not here on purpose: the
        // scheduler's own store is the truth for it (chat-sessions slice 4 design §5.1).
        ...(slackNotify === undefined ? {} : { slackNotify }),
        ...(rollAccountIds === undefined ? {} : { rollAccountIds }),
        ...(rollPrompt === undefined ? {} : { rollPrompt })
      }
    }
    // Wrapped before the adapter ever sees it (design F5 / Task 7): `onLine` takes one subscriber, so
    // counting has to ride the adapter's own subscription rather than add a second one that would take
    // its place. `spawnAt` is taken here, not inside `track`, so it times the process's own life, not
    // however long `makeAdapter`/`track` below happen to take.
    const spawnAt = Date.now()
    const watched = watchFirstLine(this.deps.factory(file, args, { cwd: opts.cwd, env, meta }))
    const proc = watched.proc

    const info: SessionInfo = {
      id,
      accountId: opts.account.id,
      cwd: opts.cwd,
      status: 'running',
      title,
      kind: 'chat',
      bypassPermissions,
      resumeSessionId: resumeThreadId,
      threadId: resumeThreadId,
      ...(schedule === undefined ? {} : { schedule }),
      ...(slackNotify === undefined ? {} : { slackNotify }),
      ...(rollAccountIds === undefined ? {} : { rollAccountIds }),
      ...(rollPrompt === undefined ? {} : { rollPrompt })
    }

    const adapter = this.makeAdapter(proc, { mode: 'fresh' }, provider)
    const startArgs = { cwd: opts.cwd, resumeThreadId, bypass }
    this.track(id, info, proc, adapter, opts.model ?? null, {
      attempt: 0,
      spawnAt,
      sawLine: watched.sawLine,
      retry: { file, args, cwd: opts.cwd, env, meta, provider, startArgs, ...(initialPrompt === undefined ? {} : { initialPrompt }) }
    })
    void adapter
      .start(startArgs)
      .then(() => {
        // A rolling respawn's carry-on prompt (spec §8.2): the first turn, sent only once the handshake
        // has settled — Claude's `initialize`, Codex's `thread/start` or `thread/resume` — because
        // Codex refuses a turn before its thread exists and Claude would otherwise take the frame ahead
        // of the initialize it is still answering. Never on the note: a restart must not re-send it.
        if (initialPrompt === undefined) return
        return adapter.send(initialPrompt).catch((err: unknown) => {
          this.deps.log(`chat initial prompt failed session=${id}: ${err instanceof Error ? err.message : String(err)}`)
        })
      })
      .catch((err: unknown) => {
        this.deps.log(`chat adapter start failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    return { ...info }
  }

  /** From a Host note after a restart. null when the note is not a chat note this build can read —
   *  an invented session would be worse than one the app admits it lost (mirrors SessionManager.adopt's
   *  own reasoning). */
  adopt(a: { id: string; proc: ProcLike; restore: Record<string, unknown>; truncated: boolean }): SessionInfo | null {
    const r = a.restore
    const str = (k: string): string | undefined => (typeof r[k] === 'string' ? (r[k] as string) : undefined)
    const accountId = str('accountId')
    const cwd = str('cwd')
    const title = str('title')
    if (!accountId || !cwd || !title) return null
    const threadId = str('threadId') ?? null
    const rolloutPath = str('rolloutPath') ?? null
    // A note written before Claude support (slice 3) carries no `provider` at all — every one of those
    // is a Codex chat session, the only provider chat sessions could be at the time, so an absent or
    // unrecognized value defaults to 'codex' rather than guessing from the account. This manager (like
    // the pty SessionManager's own adopt) keeps no account registry to look one up in, so that guess
    // would need a new dependency for a case a plain default already answers correctly.
    const noteProvider = r.provider
    const provider: Provider = noteProvider === 'claude' || noteProvider === 'codex' ? noteProvider : 'codex'
    // The server requests the previous app answered (the Claude adapter writes them — see its `answered`
    // doc and ruling S3-7). Read defensively for the same reason every other field here is: the note is
    // whatever a Host wrote, possibly an older build's, and a shape this one cannot use is no ids at all
    // rather than a reason to lose the session.
    const answered = Array.isArray(r.answered) ? r.answered.filter((v): v is string => typeof v === 'string') : []

    const info: SessionInfo = {
      id: a.id,
      accountId,
      cwd,
      status: 'running',
      title,
      kind: 'chat',
      // The bypass box the session was started with. It is in the note (spawn writes it), and without
      // it a session taken back after a restart reads as "asks for permission" in every place that
      // shows the flag — a promise the running process is not keeping.
      ...(typeof r.bypassPermissions === 'boolean' ? { bypassPermissions: r.bypassPermissions } : {}),
      // resumeSessionId is the codex-side id the rest of the app keys on (the scheduler's store key,
      // the rollout watcher). `ready` sets both for a thread that is still starting; a note that
      // already names the thread must not have to wait for that to say what it is.
      ...(threadId ? { threadId, resumeSessionId: threadId } : {}),
      ...(typeof r.slackNotify === 'boolean' ? { slackNotify: r.slackNotify } : {}),
      // A chain with a non-string member is dropped whole rather than filtered — a chain is an ordered
      // promise, and half of one is a different promise.
      ...(Array.isArray(r.rollAccountIds) && r.rollAccountIds.every((x) => typeof x === 'string')
        ? { rollAccountIds: [...(r.rollAccountIds as string[])] }
        : {}),
      ...(typeof r.rollPrompt === 'string' ? { rollPrompt: r.rollPrompt } : {})
    }

    const adapter = this.makeAdapter(a.proc, { mode: 'adopt', threadId, rolloutPath, truncated: a.truncated, answered }, provider)
    // Null, not a guess: an adopted session is one the app found already running after a restart, and
    // nothing it left behind says which model a person picked in it. A roll from here starts the next
    // process on the CLI's default, which is what it did for every session before this existed.
    this.track(a.id, info, a.proc, adapter, null)
    // Adopt mode's start() resolves at once (see codexAdapter.ts's doStart) — bypass is meaningless
    // here (a running thread was not just started with a bypass flag) so a neutral false is passed.
    void adapter.start({ cwd, bypass: false }).catch((err: unknown) => {
      this.deps.log(`chat adapter adopt failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    return { ...info }
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  info(id: string): SessionInfo | null {
    const live = this.sessions.get(id)
    return live ? { ...live.info } : null
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }))
  }

  /** The exit event does the bookkeeping (status/exitCode/onExit) — this only asks the adapter to end
   *  the process. Unknown id: no-op, the same convention SessionManager.kill uses.
   *
   *  C3 / fix round 1: marks the exit this causes as requested *before* asking for it, so the death
   *  this produces is never read as the CLI having been refused — closing a slow-starting tab must not
   *  spawn a fresh, bypassed CLI behind the closed tab. The quit sweep (`index.ts`'s `will-quit`) calls
   *  this same method for every app-owned chat session, so it needs nothing of its own. */
  kill(id: string): void {
    const live = this.sessions.get(id)
    if (!live) return
    live.killRequested = true
    live.adapter.kill()
  }

  /** Writes info.title and the process's own note, returning the stored title — or null for an
   *  unknown id. Unlike the pty SessionManager's rename, there is no normalizeSessionTitle: the brief
   *  for chat sessions does not ask for one, so the title is stored exactly as given. */
  rename(id: string, title: string): string | null {
    const live = this.sessions.get(id)
    if (!live) return null
    live.info.title = title
    live.proc.remember?.({ title })
    return title
  }

  /** The running chat sessions this app has to end when it quits (mirrors SessionManager.runningAppOwned). */
  runningAppOwned(): SessionInfo[] {
    return this.running(false)
  }

  /** The running chat sessions that keep running after this app quits, because the Host owns their
   *  procs (mirrors SessionManager.runningOutlivingApp). */
  runningOutlivingApp(): SessionInfo[] {
    return this.running(true)
  }

  private running(outlivesApp: boolean): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((s) => s.info.status === 'running' && (s.proc.outlivesApp === true) === outlivesApp)
      .map((s) => ({ ...s.info }))
  }

  send(id: string, text: string): Promise<void> {
    const live = this.sessions.get(id)
    if (!live) return Promise.resolve()
    // A fresh turn starting is where the bypass notice (Task 7) has said what it had to say — mirrors
    // the adapters' own `patch({ error: null })` on send (codexAdapter.ts/claudeAdapter.ts), which is
    // the same "a new turn retires the last one's news" rule, one level up.
    live.notice = null
    return live.adapter.send(text)
  }

  interrupt(id: string): Promise<void> {
    const live = this.sessions.get(id)
    return live ? live.adapter.interrupt() : Promise.resolve()
  }

  answer(id: string, requestId: string, answer: ChatAnswer): Promise<void> {
    const live = this.sessions.get(id)
    return live ? live.adapter.answer(requestId, answer) : Promise.resolve()
  }

  setModel(id: string, model: string, effort: string | null): Promise<void> {
    const live = this.sessions.get(id)
    if (!live) return Promise.resolve()
    // Written before the adapter is asked, not after: the roll reads this, and a pick whose control
    // call is still in flight is still the person's choice. A refusal leaves it set, which is the
    // lesser wrong — the alternative loses a choice the CLI may well have taken.
    live.chosenModel = model
    return live.adapter.setModel(model, effort)
  }

  setPermissionMode(id: string, mode: PermissionMode): Promise<void> {
    const live = this.sessions.get(id)
    return live ? live.adapter.setPermissionMode(mode) : Promise.resolve()
  }

  listPermissionModes(id: string): Promise<PermissionModeChoice[]> {
    const live = this.sessions.get(id)
    return live ? live.adapter.listPermissionModes() : Promise.resolve([])
  }

  listModels(id: string): Promise<ModelDescriptor[]> {
    const live = this.sessions.get(id)
    return live ? live.adapter.listModels() : Promise.resolve([])
  }

  /** adapter.state() with outlivesApp forced to the proc's live value — the adapter's own state()
   *  already does this (see codexAdapter.ts), but the manager owns the contract, not the adapter.
   *  `notice` is forced the same way, for the same reason: the adapter's own state knows nothing
   *  about a bypass retry, so a pane that mounts after the notice already fired — always true for a
   *  rolling respawn, where main emits while the renderer is still building the tab — needs it from
   *  here, not just from the event stream.
   *
   *  `finalExit` overlays last, for the same reason again: `live.adapter` is whichever attempt
   *  actually ended the session, and its own `core.state` only ever held *that* attempt's raw
   *  code/error/errorDetail — `mergeFailedRetry`'s joined values live solely on the event
   *  `handleEvent` forwarded once. Without this overlay, a re-pull (every mount, every tab switch)
   *  hands back the unmerged attempt and the labelled tail that actually named the refusal is gone. */
  state(id: string): ChatState | null {
    const live = this.sessions.get(id)
    if (!live) return null
    const final = live.finalExit
    return {
      ...live.adapter.state(),
      outlivesApp: live.proc.outlivesApp === true,
      notice: live.notice,
      ...(final ? { exitCode: final.code, errorDetail: final.errorDetail, ...(final.error !== undefined ? { error: final.error } : {}) } : {})
    }
  }

  subscribe(fn: (sessionId: string, e: ChatEvent) => void): () => void {
    this.listeners.push(fn)
    return () => {
      const i = this.listeners.indexOf(fn)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }

  private makeAdapter(proc: ProcLike, mode: AdapterMode, provider: Provider): ChatAdapter {
    const args = { proc, mode, version: this.deps.version, log: this.deps.log, provider }
    if (this.deps.createAdapter) return this.deps.createAdapter(args)
    return provider === 'claude' ? createClaudeAdapter(args) : createCodexAdapter(args)
  }

  /** `retryState` is absent for `adopt()` — an adopted process was already running when this app found
   *  it, so there is nothing to refuse and nothing to retry; `attempt` then defaults to 1, which is
   *  past the one retry `shouldRetryWithBypass` allows, so the check downstream never has to know why. */
  private track(
    id: string,
    info: SessionInfo,
    proc: ProcLike,
    adapter: ChatAdapter,
    chosenModel: string | null,
    retryState?: { attempt: number; spawnAt: number; sawLine: () => boolean; retry: RetryMaterials | null; firstFailure?: ExitEvent | null }
  ): void {
    const off = adapter.on((e) => this.handleEvent(id, e))
    this.sessions.set(id, {
      info,
      proc,
      adapter,
      chosenModel,
      off,
      killRequested: false,
      notice: null,
      finalExit: null,
      attempt: retryState?.attempt ?? 1,
      spawnAt: retryState?.spawnAt ?? Date.now(),
      sawLine: retryState?.sawLine ?? (() => true),
      retry: retryState?.retry ?? null,
      firstFailure: retryState?.firstFailure ?? null
    })
  }

  /** The model the person picked for this session, for the roll that has to carry it. Null when they
   *  have picked none, and for a session that is not here. */
  chosenModelOf(id: string): string | null {
    return this.sessions.get(id)?.chosenModel ?? null
  }

  private handleEvent(id: string, e: ChatEvent): void {
    const live = this.sessions.get(id)
    if (!live) return
    if (e.type === 'ready') {
      live.info.threadId = e.threadId
      live.info.resumeSessionId = e.threadId
    } else if (e.type === 'exit') {
      // A process that never spoke a line of protocol and was gone this fast was not run at all —
      // something in front of it on PATH refused (design F5). Three more things must all be true
      // first, or the retry is either pointless or actively harmful (fix round 1):
      //  - not `killRequested` (C3) — a person closing a slow-starting tab, or the quit sweep, must
      //    not spawn a fresh, bypassed CLI behind a death they asked for themselves.
      //  - not `PTY_LOST_SIGHT_EXIT_CODE` — the app losing sight of a still-live Host process is not
      //    the process ending (procFactory.ts), and treating it as a refusal would spawn a second CLI
      //    while the first may still be running, under the same id.
      //  - `shouldRetryWithBypass` itself (attempt/line/timing).
      // On a match this event is swallowed rather than forwarded — from everything watching, the
      // session just took a moment longer to come up, not that it died and came back.
      const eligible =
        live.retry !== null &&
        !live.killRequested &&
        e.code !== PTY_LOST_SIGHT_EXIT_CODE &&
        shouldRetryWithBypass({ attempt: live.attempt, sawProtocolLine: live.sawLine(), elapsedMs: Date.now() - live.spawnAt })
      if (eligible) {
        try {
          this.respawnWithBypass(id, live, e)
          return
        } catch (err) {
          // The factory or makeAdapter threw before anything was tracked in place of attempt 0 — this
          // event, already about to be swallowed, is the only account of the process ending that will
          // ever exist; falling through and reporting it now is the difference between an honest exit
          // and a session stuck `'running'` forever with a dead process behind it.
          this.deps.log(`chat bypass retry failed to start, reporting the original exit instead: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      // The retry also died with nothing to show for it: both attempts' last words travel together, or
      // the one that actually explains the refusal (attempt 0's, usually) is lost behind attempt 1's.
      const final: ExitEvent = live.firstFailure ? mergeFailedRetry(live.firstFailure, e) : e
      live.info.status = 'exited'
      live.info.exitCode = final.code
      // Fix round 2 (finding 2): held on the session, not just forwarded, so state()'s later re-pulls
      // (every mount, every tab switch — useChatState.ts) see the same merged values this event just
      // carried, instead of falling back to live.adapter's own state, which only ever knew about
      // whichever single attempt it is.
      live.finalExit = final
      this.onExit?.({ sessionId: id, exitCode: final.code })
      for (const fn of this.listeners) fn(id, final)
      return
    } else if (e.type === 'status' && e.status === 'working') {
      // Fix round 2 (finding 7): mirrors the renderer's own fold (useChatState.ts's foldChatEvent),
      // which clears `notice` on the first `working` after it fires — a fresh turn is where the
      // bypass notice has said what it had to say. `manager.send()` already clears main's copy the
      // same way, but a rolling respawn's carry-on prompt goes straight through `adapter.send`
      // (`respawnWithBypass` below), never through `send()`, so that path left main's copy standing
      // forever: `state()` overlays it on every re-pull, so a pane that remounts hours later kept
      // re-showing "started with the toolchain skipped" for a session that has long since moved on.
      live.notice = null
    }
    for (const fn of this.listeners) fn(id, e)
  }

  /** design F5 / Task 7: the one bypass retry, after a CLI that spoke no protocol died at once. Same
   *  session id throughout — every one of its owners (the tab, the scheduler, Slack, the roll) holds
   *  it, and a fresh one would orphan them all — rebuilt from `live.retry`, the materials the first
   *  attempt used, since `spawn()`'s own `opts` is long gone by the time an `exit` event reaches here.
   *
   *  C4 / fix round 1: attempt 0 is torn down — its `adapter.on` subscription cut, its proc callbacks
   *  reset — *before* anything about the replacement exists. The exit that got us here already ran
   *  synchronously inside attempt 0's own `onExit`; a microtask later, `doStart`'s catch calls
   *  `core.fail()` on that same dead adapter (codexAdapter.ts / claudeAdapter.ts), and without cutting
   *  the subscription first, that stray `error` fans out under the id the replacement now owns. */
  private respawnWithBypass(id: string, live: LiveChatSession, firstExit: ExitEvent): void {
    const materials = live.retry
    if (!materials) return // narrowed by the caller; kept so this compiles as its own method
    live.off()
    live.proc.onExit(() => {})
    live.proc.onLine(() => {})

    const env = { ...materials.env, ...BYPASS_ENV }
    const spawnAt = Date.now()
    const watched = watchFirstLine(this.deps.factory(materials.file, materials.args, { cwd: materials.cwd, env, meta: materials.meta }))
    const proc = watched.proc
    let adapter: ChatAdapter
    try {
      adapter = this.makeAdapter(proc, { mode: 'fresh' }, materials.provider)
    } catch (err) {
      // Finding 4 (final review): the factory above already spawned the bypassed child — a real
      // process — before this threw. The caller's own try/catch (handleEvent) still reports the
      // original exit and marks the session exited, which is correct, but nothing about *this* child
      // ever reaches a map entry or a handle: it is the exact orphan the kill-detection work (C3)
      // exists to prevent, reached through a different door. Killed here, before the rethrow, so the
      // failure this produces is "the retry could not start" and not "a process nothing can reach any
      // more, still running".
      proc.kill()
      throw err
    }
    this.track(id, live.info, proc, adapter, live.chosenModel, {
      attempt: 1,
      spawnAt,
      sawLine: watched.sawLine,
      retry: materials,
      firstFailure: firstExit
    })
    void adapter
      .start(materials.startArgs)
      .then(() => {
        const now = this.sessions.get(id)
        if (now) {
          // C2 / fix round 1: a successful retry is not the reason some later, unrelated exit happens.
          // Left set, this would go on merging attempt 0's toolchain refusal into an ordinary close
          // hours from now, presenting it through `errorDetail` as if it explained *that* death — the
          // exact banner-poisoning constraint 4 forbids.
          now.firstFailure = null
          now.notice = 'bypassed'
        }
        // Not a failure — telling it through `ChatState.error` would have the exit banner (T4) read the
        // bypass as the reason the session died, when the session is in fact up. Told once, and only
        // because it worked: the bypass may have started a version other than the one pinned here (S7).
        this.handleEvent(id, { type: 'notice', key: 'bypassed' })
        if (materials.initialPrompt === undefined) return
        // C1 / fix round 1: the only delivery channel a chat chain's handover briefing has (rolling.ts /
        // codexRolling.ts both skip their own auto-prompt for chat, saying the spawn carries it).
        // Attempt 0's own `spawn()` continuation never ran this — its `adapter.start` rejected instead
        // of resolving — so this is not a re-send, it is the only send.
        return adapter.send(materials.initialPrompt).catch((err: unknown) => {
          this.deps.log(`chat initial prompt failed session=${id}: ${err instanceof Error ? err.message : String(err)}`)
        })
      })
      .catch((err: unknown) => {
        this.deps.log(`chat adapter bypass retry failed: ${err instanceof Error ? err.message : String(err)}`)
      })
  }
}
