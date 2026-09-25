// The Host's chat sessions (chat takeover Task 3): one ChatSessionManager over the Host's own proc
// handles (hostProcs.ts), so the Host can carry a conversation-window session on once the app has quit.
//
// The one-writer rule (constraint 3, spec §3.2) is decided here: the Host is a session's writer while
// it holds an adapter for the session's live proc and no app socket holds that proc. Every handle asks
// the same holders before it writes or notes, so an adapter in the reader role decodes every line but
// never answers on the wire (Review Focus 5). A turn goes through whichever process is the writer.
//
// Imports nothing outside core and this folder: this bundles into the Host.
import type { PtyEntry } from '../core/host/protocol'
import type { SessionInfo } from '../core/types'
import { makeDescriptors } from '../core/providers/descriptor'
import { ChatSessionManager, type ChatManagerDeps } from '../core/chat/manager'
import { chatSpawnOptsOf, type ChatRollSpawn } from '../core/chat/respawn'
import { isUnattendedPermission, type ChatEvent, type ChatRequest, type UnattendedPermission } from '../core/chat/types'
import { chatPromptsOf, type ChatAnswerResult, type ChatPrompt } from '../core/sessions/chatRead'
import type { ProcRegistry } from './procRegistry'
import type { ProcHolders } from './procHolders'
import { createHostProcs, type HostProcHandle } from './hostProcs'

/** How long `started()` waits for a Host-spawned proc's handshake and carry-on (plan ruling P5). */
export const CHAT_START_PUSH_MS = 45_000

export interface HostChatsDeps {
  procs: Pick<ProcRegistry, 'open' | 'write' | 'kill' | 'note' | 'buffer' | 'onLine' | 'onExit' | 'list'>
  holders: Pick<ProcHolders, 'holdersOf' | 'onChange'>
  platform: NodeJS.Platform
  homeDir: string
  version: string
  baseEnv: NodeJS.ProcessEnv
  /** The app's chatSend (server.act), for a turn while the app is the writer. */
  askApp(name: 'chatSend', args: [string, string]): Promise<unknown>
  log(m: string): void
  /** Test seams. */
  createAdapter?: ChatManagerDeps['createAdapter']
  descriptors?: ChatManagerDeps['descriptors']
  after?(ms: number, fn: () => void): () => void
}

export interface HostChats {
  /** Takes a live chat proc under a Host adapter (the takeover). Null when its note does not read. */
  adopt(entry: PtyEntry): SessionInfo | null
  /** A roll's respawn, synchronous; the new note says hostStarting until started() settles. */
  spawn(o: ChatRollSpawn): SessionInfo
  /** Settles once the new proc's handshake and carry-on settled, or after CHAT_START_PUSH_MS; then
   *  hostStarting is cleared in the note. Never rejects. */
  started(sessionId: string): Promise<void>
  has(sessionId: string): boolean
  info(sessionId: string): SessionInfo | null
  procOf(sessionId: string): string | null
  /** The one-writer rule for this session: the Host holds an adapter and no socket holds the proc. */
  isWriter(sessionId: string): boolean
  kill(sessionId: string): void
  /** Drops the session's adapter without touching its proc; the adapter decodes no further line. */
  forget(sessionId: string): void
  /** A turn by whichever process is the writer: the Host adapter, or the app's chatSend. Never rejects. */
  deliver(sessionId: string, text: string): void
  /** A turn by the Host adapter; rejects when the Host is not the writer or the adapter refuses. */
  send(sessionId: string, text: string, beforeWrite?: () => void): Promise<void>
  requests(sessionId: string): ChatRequest[]
  hasOpenRequest(sessionId: string): boolean
  /** The open prompts of the sessions the Host is the writer of, minus the ids the note lists answered. */
  prompts(sessionId?: string): ChatPrompt[]
  answer(sessionId: string, requestId: string, decision: 'allow' | 'deny', beforeWrite?: () => void): Promise<ChatAnswerResult>
  unattendedOf(sessionId: string): UnattendedPermission
  /** The note's `answered` ids (the app writes them, claudeAdapter's rememberAnswered). */
  answeredOf(sessionId: string): string[]
  chosenModelOf(sessionId: string): string | null
  bypassedOf(sessionId: string): boolean
  subscribe(fn: (sessionId: string, e: ChatEvent) => void): () => void
  onWriterChange(fn: () => void): () => void
  dispose(): void
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createHostChats(d: HostChatsDeps): HostChats {
  const after =
    d.after ??
    ((ms: number, fn: () => void): (() => void) => {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    })

  /** The chat entries of a session, the live one first when an ended one shares the id (sessions.ts
   *  `chatOf`). */
  const entryOf = (id: string): PtyEntry | null => {
    const all = d.procs.list().filter((e) => e.meta?.kind === 'chat' && e.meta.id === id)
    return all.find((e) => e.alive) ?? all[0] ?? null
  }
  const procOf = (id: string): string | null => {
    const e = entryOf(id)
    return e && e.alive ? e.id : null
  }
  const held = (procId: string): boolean => d.holders.holdersOf(procId).length > 0

  const hostProcs = createHostProcs({ registry: d.procs, mayWrite: (procId) => !held(procId), log: d.log })
  /** sessionId → the handle its adapter reads, released when the Host drops the session. */
  const handles = new Map<string, HostProcHandle>()
  const keep = (sessionId: string, h: HostProcHandle): void => {
    const old = handles.get(sessionId)
    if (old && old !== h) old.release()
    handles.set(sessionId, h)
  }

  const manager = new ChatSessionManager({
    factory: (file, args, opts) => {
      const h = hostProcs.factory(file, args, opts)
      if (opts.meta?.kind === 'chat') keep(opts.meta.id, h)
      return h
    },
    descriptors: d.descriptors ?? makeDescriptors(d.platform),
    homeDir: d.homeDir,
    platform: d.platform,
    version: d.version,
    log: d.log,
    baseEnv: d.baseEnv,
    ...(d.createAdapter ? { createAdapter: d.createAdapter } : {})
  })

  const forget = (id: string): void => {
    manager.forget(id)
    handles.get(id)?.release()
    handles.delete(id)
  }
  // On a microtask, so every listener of the manager still hears the exit first.
  manager.onExit = ({ sessionId }) => {
    queueMicrotask(() => {
      try {
        forget(sessionId)
      } catch (err) {
        d.log(`chat ${sessionId}: forgetting after its exit failed: ${errText(err)}`)
      }
    })
  }

  const isWriter = (id: string): boolean => {
    if (!manager.has(id)) return false
    const procId = procOf(id)
    return procId !== null && !held(procId)
  }

  const noteOf = (id: string): Record<string, unknown> => entryOf(id)?.meta?.restore ?? {}
  const answeredOf = (id: string): string[] => {
    const a = noteOf(id).answered
    return Array.isArray(a) ? a.filter((v): v is string => typeof v === 'string') : []
  }

  const send = async (id: string, text: string, beforeWrite?: () => void): Promise<void> => {
    if (!isWriter(id)) throw new Error('not the writer')
    beforeWrite?.()
    await manager.send(id, text)
  }

  return {
    adopt(entry) {
      const meta = entry.meta
      if (meta?.kind !== 'chat') return null
      if (manager.has(meta.id)) return manager.info(meta.id)
      const h = hostProcs.attach({ procId: entry.id, pid: entry.pid })
      let info: SessionInfo | null
      try {
        info = manager.adopt({ id: meta.id, proc: h, restore: meta.restore, truncated: entry.truncated === true })
      } catch (err) {
        h.release()
        throw err
      }
      if (!info) {
        h.release()
        return null
      }
      keep(meta.id, h)
      h.replay()
      return info
    },
    spawn(o) {
      return manager.spawn(
        chatSpawnOptsOf(
          { ...o, restoreExtra: { ...o.restoreExtra, rolledBy: 'host' } },
          { unattendedOf: (x) => manager.unattendedOf(x), bypassSignal: null, hostStarting: true }
        )
      )
    },
    async started(id) {
      let cancel: () => void = () => {}
      const timedOut = new Promise<void>((resolve) => {
        cancel = after(CHAT_START_PUSH_MS, resolve)
      })
      try {
        await Promise.race([manager.started(id), timedOut])
      } catch (err) {
        d.log(`chat ${id}: waiting for its start failed: ${errText(err)}`)
      } finally {
        cancel()
      }
      try {
        const procId = procOf(id)
        if (procId !== null) d.procs.note(procId, { hostStarting: null })
      } catch (err) {
        d.log(`chat ${id}: clearing hostStarting failed: ${errText(err)}`)
      }
    },
    has: (id) => manager.has(id),
    info: (id) => manager.info(id),
    procOf,
    isWriter,
    kill: (id) => manager.kill(id),
    forget,
    deliver(id, text) {
      if (isWriter(id)) {
        void (async () => manager.send(id, text))().catch((err: unknown) => d.log(`chat ${id}: a turn failed: ${errText(err)}`))
        return
      }
      void (async () => d.askApp('chatSend', [id, text]))()
        .then((r) => {
          if ((r as { sent?: unknown } | null)?.sent !== true) d.log(`chat ${id}: the app's chatSend did not deliver the turn`)
        })
        .catch((err: unknown) => d.log(`chat ${id}: the app's chatSend failed: ${errText(err)}`))
    },
    send,
    requests: (id) => manager.pendingOf(id),
    hasOpenRequest: (id) => manager.pendingOf(id).length > 0,
    prompts(sid) {
      const out: ChatPrompt[] = []
      for (const s of manager.list()) {
        if (sid !== undefined && s.id !== sid) continue
        if (!isWriter(s.id)) continue
        const answered = new Set(answeredOf(s.id))
        for (const p of chatPromptsOf(s.id, manager.pendingOf(s.id))) if (!answered.has(p.id)) out.push(p)
      }
      return out
    },
    async answer(id, requestId, decision, beforeWrite) {
      if (!isWriter(id)) return { answered: false, reason: 'not-held' }
      const r = manager.pendingOf(id).find((x) => x.id === requestId)
      if (!r) return { answered: false, reason: 'not-open' }
      if (r.kind === 'question') return { answered: false, reason: 'question' }
      try {
        beforeWrite?.()
        await manager.answer(id, requestId, { kind: 'approval', decision: decision === 'allow' ? 'accept' : 'decline' })
        return { answered: true }
      } catch (err) {
        const m = errText(err)
        if (!m.startsWith('no open request')) d.log(`chat ${id}: answering ${requestId} failed: ${m}`)
        return { answered: false, reason: 'not-open' }
      }
    },
    unattendedOf(id) {
      const v = noteOf(id).unattendedPermission
      return isUnattendedPermission(v) ? v : manager.unattendedOf(id)
    },
    answeredOf,
    chosenModelOf: (id) => manager.chosenModelOf(id),
    bypassedOf: (id) => manager.bypassedOf(id),
    subscribe: (fn) => manager.subscribe(fn),
    onWriterChange: (fn) => d.holders.onChange(fn),
    dispose() {
      for (const s of manager.list()) forget(s.id)
      hostProcs.dispose()
    }
  }
}
