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
// Lives in core/chat since the chat takeover (Task 1), so the Host runs the same adapters the app does.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Account, ScheduleConfig, SessionInfo } from '../types'
import type { Provider } from '../providers/meta'
import { providerOf } from '../providers/meta'
import { descriptorOf, type ProviderDescriptor } from '../providers/descriptor'
import type { ProcFactory, ProcLike } from '../sessions/proc'
import { cliEnvFor } from '../sessions/cliEnv'
import { buildCodexAppServerCommand, buildClaudeChatCommand } from '../sessions/commands'
import type { PtyMeta } from '../host/protocol'
import type { ChatAdapter, ChatAnswer, ChatEvent, ChatState, PermissionMode, PermissionModeChoice } from './types'
import type { ModelDescriptor } from '../models/types'
import { BYPASS_ENV, looksLikeRefusal, watchFirstLine, type BypassSignal } from '../sessions/retryBypass'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../sessions/pty'
import { createCodexAdapter, type AdapterMode } from './codexAdapter'
import { createClaudeAdapter } from './claudeAdapter'

type ExitEvent = Extract<ChatEvent, { type: 'exit' }>

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
 *  Carried on the tracked session rather than recomputed, because a manual retry has no `opts` to
 *  recompute it from: by the time the person presses the button, `spawn()` has long since returned. */
interface RetryMaterials {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  meta: PtyMeta
  provider: Provider
  startArgs: { cwd: string; resumeThreadId?: string; bypass: boolean }
  /** The handover briefing a rolling respawn carries — for a chat chain it is the *only* delivery
   *  channel (claudeCoordinator.ts / codexCoordinator.ts both skip their own auto-prompt for chat, saying the spawn
   *  carries it). The original `spawn()` continuation only sends this once its `adapter.start`
   *  resolves; a silent death means that promise rejects instead, so the send never ran and the
   *  prompt would otherwise be lost, not merely deferred. Carried here so a later, confirmed retry's
   *  own success continuation can send it once, for the one attempt that actually gets a live thread. */
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
  /** design F5 — what `looksLikeRefusal` needs to judge this attempt's own death, once it happens.
   *  `retry` is null for an adopted session: nothing to respawn with, and there is nothing to refuse —
   *  the process was already running when this app found it. */
  spawnAt: number
  sawLine: () => boolean
  retry: RetryMaterials | null
  /** design F5, detection signal: positive evidence (`core.bypassSignalFor`, checked once at startup —
   *  see core.ts) that a bypassable toolchain manager is in the way of this CLI, and *which* of the
   *  two signals matched (fix round 1 / Important 4 — `VOLTA_HOME` alone proves Volta is installed,
   *  not that it gated *this* CLI, so a caller has to know which one it is to soften what it says).
   *  Carried alongside `retry` rather than recomputed at exit time for the same reason `retry` itself
   *  is: the probe this comes from is not free, and running it on every exit (most of which are not
   *  refusals at all) would be work spent on sessions that never needed it. `null` for an adopted
   *  session, same as `retry` being null — nothing was checked for one. */
  managerSignal: BypassSignal
  /** design F5 fix round 1 (Critical 2): durable, unlike `notice` — set the moment a bypassed process
   *  is spawned (`spawn()`'s own `startWithBypass`, or `respawnWithBypass`) and never cleared by
   *  anything afterward, so `state()`'s overlay and `ChatState.bypassed` still read `true` after a
   *  remount and after however many turns follow. `notice` alone disappeared at the exact moment the
   *  off-pin harm began (both main and the renderer clear it on the first `status: 'working'`, which
   *  for a retry carrying an `initialPrompt` can be within a second) — this is the fact that has to
   *  survive past that, for someone reading this session's results later. Also doubles as the guard
   *  against offering the button a second time (fix round 1 / Important 1, `handleEvent`'s own
   *  comment): a session that already started under the bypass dying again in silence is not a
   *  Volta refusal any more — the bypass is already on — and offering the same fix again would be
   *  lying about what pressing it would do. */
  bypassed: boolean
  /** C3 / fix round 1: "we asked for this" — set by `kill()` before `handleEvent` ever sees the exit it
   *  causes. Without it, closing a slow-starting tab within the five-second window reads exactly like a
   *  toolchain refusal and offers a bypass button for a death nobody refused — the person asked for it
   *  themselves. The quit sweep (`index.ts`'s `will-quit`) already calls this same `kill()`, so it
   *  needs no separate flag or wiring. */
  killRequested: boolean
  /** The unsubscribe `adapter.on(...)` returned, called when tearing this attempt down for a confirmed
   *  retry (`retryWithBypass`). Without it, this attempt's own async tail — `doStart`'s catch calling
   *  `core.fail()` a microtask after its own exit — could still reach `handleEvent` under the id the
   *  *replacement* now owns, and `chatBannerFor` ranks that stray `error` over the retry's own
   *  `notice`, so the feature's happy path would show a live, healthy session as if its turn had failed. */
  off: () => void
  /** "Told once" needs a home besides the event stream, or a pane that mounts after the retry already
   *  succeeded never sees it (adapterCore's own `fail()` states the same rule: remembered, not just
   *  announced). Cleared on the next `send()`, mirroring the adapters' own `patch({ error: null })` on
   *  a fresh turn — and on the `notice` event itself (useChatState.ts's fold), which is the one this
   *  session actually gets since `respawnWithBypass` calls `adapter.send` directly, never `send()`. */
  notice: 'bypassed' | null
  /** design F5: whether this session's exit may be offered the "skip the toolchain and retry" button
   *  — set once, when the exit happens, from `looksLikeRefusal` and `managerDetected` together (never
   *  from either alone: see `handleEvent`'s own comment). `state()` overlays this the same way it
   *  overlays `notice`, so a re-pull (every mount, every tab switch) sees the same verdict the `exit`
   *  event already carried. Reset to `false` by every fresh `track()` — a session that is running
   *  again (whether from a confirmed retry or a plain new spawn) has nothing to offer a button about. */
  bypassOffer: boolean
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
    /** design F5: which detection signal main found for this CLI (`core.bypassSignalFor`, checked once
     *  at startup — never here, this method has to stay synchronous). `null`/absent is the honest
     *  default for a test fixture that does not care and for every call site that has not checked —
     *  the offer button only ever appears when this was explicitly found non-null. */
    bypassSignal?: BypassSignal
    /** design F5 fix round 1 (Important 3, the roll-inheritance fix): start this process with the
     *  toolchain bypass already applied. Never set by a fresh, first-time spawn — S7 still holds for
     *  that case. The one caller that ever passes `true` is a rolling respawn whose *chain* had
     *  already been granted the bypass by a person's confirmed click on an earlier session in it
     *  (index.ts's roll spawn callbacks, reading `bypassedOf(oldId)` before the kill) — dropping that
     *  consent at the roll boundary is the same silent-override harm S7 forbids, just at a different
     *  door, and the person already said yes once for this chain. */
    startWithBypass?: boolean
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

    // design F5 fix round 1: BYPASS_ENV rides here, not just on a manual retry's respawn — a rolling
    // respawn whose chain was already granted the bypass has to keep it (opts.startWithBypass, set by
    // index.ts's roll callbacks from `bypassedOf(oldId)`). Still never on a fresh, first spawn: that
    // path never passes `startWithBypass` at all, so S7's default holds exactly as before.
    const env = {
      ...cliEnvFor({ base: process.env, account: opts.account, descriptor, homeDir: this.deps.homeDir }),
      ...(opts.startWithBypass ? BYPASS_ENV : {})
    }
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
        ...(rollPrompt === undefined ? {} : { rollPrompt }),
        // design F5 fix round 1 (Critical 2): the durable mark, written into the note itself so an
        // app restart's `adopt()` can restore it too, not only `state()`'s in-memory overlay.
        ...(opts.startWithBypass ? { bypassedToolchain: true } : {})
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
      spawnAt,
      sawLine: watched.sawLine,
      retry: { file, args, cwd: opts.cwd, env, meta, provider, startArgs, ...(initialPrompt === undefined ? {} : { initialPrompt }) },
      managerSignal: opts.bypassSignal ?? null,
      bypassed: opts.startWithBypass === true
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
    //
    // design F5 fix round 1 (Critical 2): `bypassedToolchain` is read back the same defensive way
    // every other note field on this method is — a note is whatever a Host wrote, possibly an older
    // build's that never had this key at all, and an absent key must read as `false`, never a guess.
    // `managerSignal` stays `null` and `retry` stays absent regardless: an adopted process was already
    // running when this app found it, so the offer's own preconditions (§ its own doc) can never hold
    // for it either way — there is nothing here for the durable mark to interact with beyond staying
    // visible to someone reading this session's results later.
    this.track(a.id, info, a.proc, adapter, null, {
      spawnAt: Date.now(),
      sawLine: () => true,
      retry: null,
      managerSignal: null,
      bypassed: r.bypassedToolchain === true
    })
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
   *  `bypassOffer`/`bypassSignal` are overlaid the same way, for the same reason: they are
   *  `handleEvent`'s own verdict about *this* exit, not something `live.adapter`'s own state carries —
   *  a fresh adapter after a confirmed retry starts `bypassOffer` back at `false` (see `track()`),
   *  which is exactly what a re-pull should see once the session is running again.
   *
   *  `bypassed` (fix round 1 / Critical 2) is overlaid unconditionally, never gated on `bypassOffer` —
   *  it is the durable fact, set once at the moment a bypassed process spawned and never cleared, so a
   *  re-pull sees it for as long as this session's own `LiveChatSession` does (which outlives the
   *  process itself: nothing removes the map entry on exit). */
  state(id: string): ChatState | null {
    const live = this.sessions.get(id)
    if (!live) return null
    return {
      ...live.adapter.state(),
      outlivesApp: live.proc.outlivesApp === true,
      notice: live.notice,
      ...(live.bypassed ? { bypassed: true } : {}),
      ...(live.bypassOffer ? { bypassOffer: true, ...(live.managerSignal ? { bypassSignal: live.managerSignal } : {}) } : {})
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

  /** `retryState` is absent only for a call this file no longer makes on its own — every caller now
   *  passes one, `adopt()` included (fix round 1 / Critical 2: it has a durable `bypassed` fact of its
   *  own to seed from the note). Kept optional anyway, defaulting exactly the way an absent one always
   *  did — `sawLine` to "assume it spoke", `retry`/`managerSignal` to "nothing here" — so a test
   *  fixture that builds a `LiveChatSession` for something else entirely need not learn every field. */
  private track(
    id: string,
    info: SessionInfo,
    proc: ProcLike,
    adapter: ChatAdapter,
    chosenModel: string | null,
    retryState?: {
      spawnAt: number
      sawLine: () => boolean
      retry: RetryMaterials | null
      managerSignal: BypassSignal
      bypassed: boolean
    }
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
      bypassOffer: false,
      spawnAt: retryState?.spawnAt ?? Date.now(),
      sawLine: retryState?.sawLine ?? (() => true),
      retry: retryState?.retry ?? null,
      managerSignal: retryState?.managerSignal ?? null,
      bypassed: retryState?.bypassed ?? false
    })
  }

  /** The model the person picked for this session, for the roll that has to carry it. Null when they
   *  have picked none, and for a session that is not here. */
  chosenModelOf(id: string): string | null {
    return this.sessions.get(id)?.chosenModel ?? null
  }

  /** design F5 fix round 1 (Important 3): whether this session's chain was already granted the
   *  toolchain bypass — read by a roll (index.ts's spawn callbacks) *before* it kills this session, the
   *  same "read before the kill" rule `chosenModelOf` above follows and for the same reason: the
   *  manager drops the session together with its process, and the fact lives only here. False for a
   *  session that is not here, mirroring `chosenModelOf`'s own null. */
  bypassedOf(id: string): boolean {
    return this.sessions.get(id)?.bypassed ?? false
  }

  private handleEvent(id: string, e: ChatEvent): void {
    const live = this.sessions.get(id)
    if (!live) return
    if (e.type === 'ready') {
      live.info.threadId = e.threadId
      live.info.resumeSessionId = e.threadId
    } else if (e.type === 'exit') {
      live.info.status = 'exited'
      live.info.exitCode = e.code
      // design F5: whether this exit may offer the "skip the toolchain and retry" button — **never**
      // decided from the death shape alone. Every condition has to hold:
      //  - `live.retry !== null` — nothing to rebuild a respawn from (an adopted session).
      //  - not `killRequested` (C3) — a person closing a slow-starting tab, or the quit sweep, asked
      //    for exactly this death themselves; offering to bypass it as if a manager had refused it
      //    would be a button for a story that never happened.
      //  - not `PTY_LOST_SIGHT_EXIT_CODE` — the app losing sight of a still-live Host process is not
      //    the process ending (procFactory.ts), and a respawn here would run a second CLI while the
      //    first may still be alive, under the same id.
      //  - not `live.bypassed` (fix round 1 / Important 1) — a process that started *with* the bypass
      //    already on and still died this way was not refused by anything the bypass could have
      //    fixed. Without this, `respawnWithBypass`'s fresh `sawLine`/`spawnAt` would let the dialog
      //    come back after the bypassed attempt itself dies in silence, now claiming that skipping
      //    will let it start — when skipping demonstrably did not. This is also what bounds the offer
      //    to at most once per session: the deleted `두 번은 없다` test used to be the only thing that
      //    did, via an attempt counter this rewrite dropped along with the automatic retry it gated.
      //  - `looksLikeRefusal` — the death shape a toolchain refusal actually has (no protocol line,
      //    immediate).
      //  - `managerSignal !== null` — positive evidence, checked once at startup (core.ts), that a
      //    bypassable manager is actually in the way. Without this alone, a DLL that is missing, an
      //    antivirus block, an ordinary crash all look exactly like a refusal from here, and the
      //    confirm dialog would name Volta with no basis and a press would do nothing at all (design
      //    F5's own reasoning for requiring both signals).
      const bypassOffer =
        live.retry !== null &&
        !live.killRequested &&
        !live.bypassed &&
        e.code !== PTY_LOST_SIGHT_EXIT_CODE &&
        live.managerSignal !== null &&
        looksLikeRefusal({ sawProtocolLine: live.sawLine(), elapsedMs: Date.now() - live.spawnAt })
      live.bypassOffer = bypassOffer
      // Rides the event itself, not just `state()` — a pane already open when the process dies never
      // re-reads main's state, it only hears this (ChatEvent's own doc on the `exit` variant).
      // `bypassSignal` rides with it (fix round 1 / Important 4): the dialog needs to know *which*
      // signal matched to soften what it says when only the weaker one (`VOLTA_HOME`) did.
      const final: ExitEvent = bypassOffer
        ? { ...e, bypassOffer: true, ...(live.managerSignal ? { bypassSignal: live.managerSignal } : {}) }
        : e
      this.onExit?.({ sessionId: id, exitCode: e.code })
      for (const fn of this.listeners) fn(id, final)
      return
    } else if (e.type === 'status' && e.status === 'working') {
      // Mirrors the renderer's own fold (useChatState.ts's foldChatEvent), which clears `notice` on the
      // first `working` after it fires — a fresh turn is where the bypass notice has said what it had
      // to say. `manager.send()` already clears main's copy the same way, but a confirmed retry's
      // carry-on prompt goes straight through `adapter.send` (`respawnWithBypass` below), never through
      // `send()`, so that path left main's copy standing forever: `state()` overlays it on every
      // re-pull, so a pane that remounts hours later kept re-showing "started with the toolchain
      // skipped" for a session that has long since moved on.
      live.notice = null
    }
    for (const fn of this.listeners) fn(id, e)
  }

  /** design F5: the person pressed the offered button and confirmed, in the renderer's own dialog,
   *  what skipping the toolchain gives up — main never chooses this on its own (S7's whole point).
   *  A no-op, returning null, for a session that is not currently offering the button: an unknown id,
   *  one whose offer a second exit already re-decided, or a stale second click racing the first — none
   *  of those should spawn a second bypassed CLI under one id. Returns the session's fresh info once
   *  the retry actually starts (status back to `'running'`), so the caller (ipc.ts) can put the tab
   *  back the same way a Host reconnect does — a `session:created` with this. */
  retryWithBypass(id: string): SessionInfo | null {
    const live = this.sessions.get(id)
    if (!live || !live.bypassOffer || !live.retry) return null
    try {
      this.respawnWithBypass(id, live)
    } catch (err) {
      // The factory threw before anything about the replacement existed. Unlike the automatic retry
      // this replaces, there is no swallowed exit to fall back to reporting — the original exit was
      // already reported in full, immediately, when this session actually died (F1/F2) — so there is
      // only this attempt's own failure to log; the session stays exited.
      this.deps.log(`chat bypass retry failed to start: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    const now = this.sessions.get(id)
    return now ? { ...now.info } : null
  }

  /** design F5: the confirmed bypass respawn. Same session id throughout — every one of its owners
   *  (the tab, the scheduler, Slack, the roll) holds it, and a fresh one would orphan them all —
   *  rebuilt from `live.retry`, the materials the original attempt used, since `spawn()`'s own `opts`
   *  is long gone by the time the person presses the button.
   *
   *  The old adapter's subscription is cut before anything about the replacement exists, mirroring
   *  what the automatic retry this replaces used to guard against: `doStart`'s catch can still call
   *  `core.fail()` on the dead adapter a microtask after its own exit, and without cutting the
   *  subscription first that stray `error` would fan out under the id the replacement now owns. */
  private respawnWithBypass(id: string, live: LiveChatSession): void {
    const materials = live.retry
    if (!materials) return // narrowed by the caller; kept so this compiles as its own method
    live.off()
    live.proc.onExit(() => {})
    live.proc.onLine(() => {})

    const env = { ...materials.env, ...BYPASS_ENV }
    // design F5 fix round 1 (Critical 2): the durable mark goes into the note itself, not only the
    // in-memory `bypassed` flag `track()` sets below — the same reasoning `spawn()`'s own
    // `startWithBypass` branch gives. `materials.meta` is the *original* attempt's meta, built before
    // the bypass was ever a question, so it is copied here rather than mutated in place.
    const meta: PtyMeta = { ...materials.meta, restore: { ...materials.meta.restore, bypassedToolchain: true } }
    const spawnAt = Date.now()
    const watched = watchFirstLine(this.deps.factory(materials.file, materials.args, { cwd: materials.cwd, env, meta }))
    const proc = watched.proc
    let adapter: ChatAdapter
    try {
      adapter = this.makeAdapter(proc, { mode: 'fresh' }, materials.provider)
    } catch (err) {
      // The factory above already spawned the bypassed child — a real process — before this threw.
      // Nothing about it reaches a map entry or a handle otherwise: killed here, before the rethrow
      // (caught by `retryWithBypass`'s own try/catch, which logs it once), so the failure this produces
      // is "the retry could not start" and not "a process nothing can reach any more, still running".
      proc.kill()
      throw err
    }
    // The session is live again — the same flip `spawn()` does for a brand-new one. Left at `'exited'`
    // here, the tab would keep showing the old exit banner under a process that is, in fact, running.
    live.info.status = 'running'
    delete live.info.exitCode
    this.track(id, live.info, proc, adapter, live.chosenModel, {
      spawnAt,
      sawLine: watched.sawLine,
      retry: materials,
      managerSignal: live.managerSignal,
      // design F5 fix round 1 (Critical 2 / Important 1): set the instant this process is spawned,
      // not once `adapter.start()` resolves below — `bypassedOf()` and a remount both have to see it
      // immediately, and it is what stops this same attempt from offering the button again if it too
      // dies in silence (`handleEvent`'s own comment on the `bypassOffer` computation).
      bypassed: true
    })
    void adapter
      .start(materials.startArgs)
      .then(() => {
        const now = this.sessions.get(id)
        if (now) now.notice = 'bypassed'
        // Not a failure — telling it through `ChatState.error` would have the exit banner (T4) read the
        // bypass as the reason the session died, when the session is in fact up. Told once, and only
        // because it worked: the bypass may have started a version other than the one pinned here (S7).
        this.handleEvent(id, { type: 'notice', key: 'bypassed' })
        if (materials.initialPrompt === undefined) return
        // The only delivery channel a chat chain's handover briefing has (claudeCoordinator.ts / codexCoordinator.ts
        // both skip their own auto-prompt for chat, saying the spawn carries it). The original
        // `spawn()` continuation never ran this — its `adapter.start` rejected instead of resolving —
        // so this is not a re-send, it is the only send.
        return adapter.send(materials.initialPrompt).catch((err: unknown) => {
          this.deps.log(`chat initial prompt failed session=${id}: ${err instanceof Error ? err.message : String(err)}`)
        })
      })
      .catch((err: unknown) => {
        this.deps.log(`chat adapter bypass retry failed: ${err instanceof Error ? err.message : String(err)}`)
      })
  }
}
