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
import type { Account, SessionInfo } from '../../core/types'
import type { Provider } from '../../core/providers/meta'
import { providerOf } from '../../core/providers/meta'
import { descriptorOf, type ProviderDescriptor } from '../../core/providers/descriptor'
import type { ProcFactory, ProcLike } from '../../core/sessions/proc'
import { cliEnvFor } from '../../core/sessions/cliEnv'
import { buildCodexAppServerCommand, buildClaudeChatCommand } from '../../core/sessions/commands'
import type { PtyMeta } from '../../core/host/protocol'
import type { ChatAdapter, ChatAnswer, ChatEvent, ChatState } from '../../core/chat/types'
import type { ModelDescriptor } from '../../core/models/types'
import { createCodexAdapter, type AdapterMode } from './codexAdapter'
import { createClaudeAdapter } from './claudeAdapter'

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

interface LiveChatSession {
  info: SessionInfo
  proc: ProcLike
  adapter: ChatAdapter
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
  }): SessionInfo {
    const provider = providerOf(opts.account)
    const descriptor = descriptorOf(this.deps.descriptors, opts.account)

    const id = randomUUID()
    const title = opts.title ?? path.basename(opts.cwd)
    const bypassPermissions = opts.bypassPermissions
    const bypass = !!bypassPermissions
    const resumeThreadId = opts.resumeThreadId

    const env = cliEnvFor({ base: process.env, account: opts.account, descriptor, homeDir: this.deps.homeDir })
    // Codex resumes over the app-server protocol (thread/resume, sent by the adapter once the process is
    // up); Claude has no such call, so its resume id is argv (--resume=<id>) instead — buildClaudeChatCommand
    // takes it directly.
    const { file, args } =
      provider === 'claude'
        ? buildClaudeChatCommand(this.deps.platform, { resumeSessionId: resumeThreadId, bypass })
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
        ...(resumeThreadId ? { threadId: resumeThreadId } : {})
      }
    }
    const proc = this.deps.factory(file, args, { cwd: opts.cwd, env, meta })

    const info: SessionInfo = {
      id,
      accountId: opts.account.id,
      cwd: opts.cwd,
      status: 'running',
      title,
      kind: 'chat',
      bypassPermissions,
      resumeSessionId: resumeThreadId,
      threadId: resumeThreadId
    }

    const adapter = this.makeAdapter(proc, { mode: 'fresh' }, provider)
    this.track(id, info, proc, adapter)
    void adapter.start({ cwd: opts.cwd, resumeThreadId, bypass }).catch((err: unknown) => {
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
      ...(threadId ? { threadId, resumeSessionId: threadId } : {})
    }

    const adapter = this.makeAdapter(a.proc, { mode: 'adopt', threadId, rolloutPath, truncated: a.truncated, answered }, provider)
    this.track(a.id, info, a.proc, adapter)
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
   *  the process. Unknown id: no-op, the same convention SessionManager.kill uses. */
  kill(id: string): void {
    this.sessions.get(id)?.adapter.kill()
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

  /** Merges a patch into the note the process's Host entry keeps — fire-and-forget, same convention
   *  as SessionManager.remember. Unknown id: ignored. */
  remember(id: string, patch: Record<string, unknown>): void {
    this.sessions.get(id)?.proc.remember?.(patch)
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
    return live ? live.adapter.send(text) : Promise.resolve()
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
    return live ? live.adapter.setModel(model, effort) : Promise.resolve()
  }

  setPlanMode(id: string, on: boolean): Promise<void> {
    const live = this.sessions.get(id)
    return live ? live.adapter.setPlanMode(on) : Promise.resolve()
  }

  listModels(id: string): Promise<ModelDescriptor[]> {
    const live = this.sessions.get(id)
    return live ? live.adapter.listModels() : Promise.resolve([])
  }

  /** adapter.state() with outlivesApp forced to the proc's live value — the adapter's own state()
   *  already does this (see codexAdapter.ts), but the manager owns the contract, not the adapter. */
  state(id: string): ChatState | null {
    const live = this.sessions.get(id)
    if (!live) return null
    return { ...live.adapter.state(), outlivesApp: live.proc.outlivesApp === true }
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

  private track(id: string, info: SessionInfo, proc: ProcLike, adapter: ChatAdapter): void {
    adapter.on((e) => this.handleEvent(id, e))
    this.sessions.set(id, { info, proc, adapter })
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
      this.onExit?.({ sessionId: id, exitCode: e.code })
    }
    for (const fn of this.listeners) fn(id, e)
  }
}
