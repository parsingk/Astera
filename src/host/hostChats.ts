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
import { isUnattendedPermission, type ChatAnswer, type ChatEvent, type ChatRequest, type UnattendedPermission } from '../core/chat/types'
import { chatAnswerFailureOf, chatPromptsOf, type ChatAnswerResult, type ChatPrompt } from '../core/sessions/chatRead'
import type { ProcRegistry } from './procRegistry'
import type { ProcHolders } from './procHolders'
import { createHostProcs, type HostProcHandle, type HostProcsDeps } from './hostProcs'
import { createChatPolicy, UNATTENDED_DENY_MESSAGE } from './chatPolicy'
import { CHAT_REQUEST_TIMEOUT_MS } from '../core/chat/adapterCore'

/** How long `started()` waits for a Host-spawned proc's handshake and carry-on (plan ruling P5). A bound,
 *  not a guess at a normal start: every step has its own deadline, so the start always settles on its
 *  own, and this only catches one that did not. It sits above the worst chain of those deadlines (final
 *  review I1): codex's `initialize`, `collaborationMode/list`, `model/list`, `thread/resume` and the
 *  carry-on's `turn/start`, each `CHAT_REQUEST_TIMEOUT_MS`, counted as if none overlapped, plus one more
 *  as margin. Claude's handshake is one request. */
export const CHAT_START_PUSH_MS = 6 * CHAT_REQUEST_TIMEOUT_MS

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
  /** True once the new proc's handshake and carry-on settled; hostStarting is then cleared in the note.
   *  False when they did not settle within CHAT_START_PUSH_MS: the session is killed and the mark stays,
   *  so no app takes over a start still under way (final review I1). Never rejects. */
  started(sessionId: string): Promise<boolean>
  has(sessionId: string): boolean
  info(sessionId: string): SessionInfo | null
  procOf(sessionId: string): string | null
  /** Merges `patch` into the note of the session's live proc; nothing for a session with none. CT-16: a
   *  codex chat roll's `dest` goes here (`rollDest`), for an app that re-points the tab from the note. */
  note(sessionId: string, patch: Record<string, unknown>): void
  /** The one-writer rule for this session: the Host holds an adapter and no socket holds the proc. */
  isWriter(sessionId: string): boolean
  kill(sessionId: string): void
  /** Drops the session's adapter without touching its proc; the adapter decodes no further line. */
  forget(sessionId: string): void
  /** A turn by whichever process is the writer: the Host adapter, or the app's chatSend. Never rejects. */
  deliver(sessionId: string, text: string): void
  /** A turn by the Host adapter; rejects when the Host is not the writer or the adapter refuses.
   *  `wrote` runs once a line of the turn reached the proc, in the same synchronous step as the write
   *  (Task 8 fix round 1, D4 I1): a send refused before the wire marks nothing. */
  send(sessionId: string, text: string, wrote?: () => void): Promise<void>
  requests(sessionId: string): ChatRequest[]
  hasOpenRequest(sessionId: string): boolean
  /** Where the session's turn is, as this Host's adapter decodes it (writer or reader): `status` and the
   *  last turn's error, and whether its proc still runs. null for a session the Host holds no adapter
   *  for. `sessions send --wait` reads it (CLI spec §15). */
  turnOf(sessionId: string): { alive: boolean; status: 'idle' | 'working' | 'waiting'; error: string | null } | null
  /** The open prompts of the sessions the Host is the writer of, minus the ids the note lists answered. */
  prompts(sessionId?: string): ChatPrompt[]
  /** `wrote` as for `send`: only once the answer's line reached the proc. A failure other than "no open
   *  request" (a NotWriterError, a pipe that has gone) is `not-held`: this side could not answer. */
  answer(sessionId: string, requestId: string, decision: 'allow' | 'deny', wrote?: () => void): Promise<ChatAnswerResult>
  /** A Slack card answer, questions included (Slack in the Host P10). Rejects when the Host is not the
   *  writer (nothing is written), when the note lists the card answered (the app answered it and its echo
   *  has not reached this adapter: never applied twice), or when the adapter refuses (`no open request`
   *  for a card already closed). The unattended policy's timer re-reads the open list when it fires, so
   *  an answer that landed first wins. */
  answerCard(sessionId: string, requestId: string, answer: ChatAnswer): Promise<void>
  unattendedOf(sessionId: string): UnattendedPermission
  /** The note's `answered` ids (the app writes them, both adapters on every answer). */
  answeredOf(sessionId: string): string[]
  chosenModelOf(sessionId: string): string | null
  bypassedOf(sessionId: string): boolean
  subscribe(fn: (sessionId: string, e: ChatEvent) => void): () => void
  onWriterChange(fn: () => void): () => void
  /** How many proc handles the Host keeps for its sessions. For tests and diagnostics. */
  handleCount(): number
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

  // Fix round 1 (Important 2): every line that reached a proc is counted, so the carry-on on adopt can
  // tell a send the adapter refused before the wire (codex with no thread, a NotWriterError) from one
  // whose line went out. Only a registry write that returned counts.
  const writes = new Map<string, number>()
  const counted: HostProcsDeps['registry'] = {
    open: (o) => d.procs.open(o),
    write: (procId, line) => {
      d.procs.write(procId, line)
      writes.set(procId, (writes.get(procId) ?? 0) + 1)
    },
    kill: (procId) => d.procs.kill(procId),
    note: (procId, patch) => d.procs.note(procId, patch),
    buffer: (procId) => d.procs.buffer(procId),
    onLine: (cb) => d.procs.onLine(cb),
    onExit: (cb) =>
      d.procs.onExit((procId, code, tail) => {
        writes.delete(procId)
        cb(procId, code, tail)
      })
  }
  const writesTo = (procId: string): number => writes.get(procId) ?? 0

  const hostProcs = createHostProcs({ registry: counted, mayWrite: (procId) => !held(procId), log: d.log })
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

  // Task 7: the unattended permission policy, built before anything can call forget. Its callbacks read
  // the functions below only when a review or a fire runs, never at build time.
  const policy = createChatPolicy({
    policyOf: (id) => unattendedOf(id),
    isWriter: (id) => isWriter(id),
    open: (id) => manager.pendingOf(id),
    answered: (id) => answeredOf(id),
    // Through the adapter's normal answer path, so its state stays honest; a NotWriterError (an app took
    // the proc between the check and the write) rejects here and the policy logs it.
    deny: (sid, rid) => manager.answer(sid, rid, { kind: 'approval', decision: 'decline', message: UNATTENDED_DENY_MESSAGE }),
    log: d.log,
    ...(d.after ? { after: d.after } : {})
  })

  const forget = (id: string): void => {
    policy.forget(id)
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
  /** The note's policy (the app's setUnattendedPermission lands there), else the manager's. A roll's
   *  respawn asks this too, never the manager's copy from the adopt (final review I2). */
  const unattendedOf = (id: string): UnattendedPermission => {
    const v = noteOf(id).unattendedPermission
    return isUnattendedPermission(v) ? v : manager.unattendedOf(id)
  }
  /** The note's model pick first, as for the policy (final review I2): while the app is the writer, its
   *  setModel lands only in the note, and the manager's copy is the one read at adopt. */
  const chosenModelOf = (id: string): string | null => {
    const v = noteOf(id).chosenModel
    return typeof v === 'string' ? v : manager.chosenModelOf(id)
  }
  const answeredOf = (id: string): string[] => {
    const a = noteOf(id).answered
    return Array.isArray(a) ? a.filter((v): v is string => typeof v === 'string') : []
  }
  /** The session's open requests less the ids the note lists answered (final review M2): the app answered
   *  them and their echo has not reached this adapter yet. The one filter prompts() applies too. */
  const openOf = (id: string): ChatRequest[] => {
    const open = manager.pendingOf(id)
    if (open.length === 0) return open
    const answered = new Set(answeredOf(id))
    return answered.size === 0 ? open : open.filter((r) => !answered.has(r.id))
  }

  /** P4 (Review Focus 3): a roll's carry-on the note says was never sent is sent once, by the writer only,
   *  and marked sent before the write, so a later writer change never types it twice. A second adopt of
   *  the same session returns before this and sends nothing. The path from `manager.send` to the wire is
   *  synchronous for both adapters (claude writes first thing; codex checks its thread, then its core's
   *  request writes inside the promise executor), so the count read right after the call says whether a
   *  line went out. None did: the mark goes back to false, for the next writer. One did: it stays true
   *  whatever the request does later (at most once; a lost reply is the P4 known limit). */
  const carryOnAfterAdopt = (procId: string, id: string, restore: Record<string, unknown>): void => {
    if (typeof restore.carryOn !== 'string' || restore.carrySent === true || !isWriter(id)) return
    const text = restore.carryOn
    d.procs.note(procId, { carrySent: true })
    const before = writesTo(procId)
    let sent: Promise<void>
    try {
      sent = manager.send(id, text)
    } catch (err) {
      sent = Promise.reject(err)
    }
    if (writesTo(procId) === before) {
      d.procs.note(procId, { carrySent: false })
      const left = `chat ${id}: the carry-on was left for the next writer, nothing reached the proc`
      sent.then(
        () => d.log(left),
        (err: unknown) => d.log(`${left}: ${errText(err)}`)
      )
      return
    }
    sent.catch((err: unknown) => d.log(`chat ${id}: the carry-on could not be sent after the takeover: ${errText(err)}`))
  }

  // Task 7: every request and status event reviews its session, every writer change reviews them all
  // (P12), and an exit forgets it. A throw here must not reach the adapter that emitted the event.
  const offEvents = manager.subscribe((id, e) => {
    try {
      if (e.type === 'exit') policy.forget(id)
      else if (e.type === 'request' || e.type === 'status') policy.review(id)
    } catch (err) {
      d.log(`chat ${id}: the unattended policy failed on a ${e.type} event: ${errText(err)}`)
    }
  })
  const offWriter = d.holders.onChange(() => {
    try {
      policy.reviewAll(manager.list().map((i) => i.id))
    } catch (err) {
      d.log(`the unattended policy failed on a writer change: ${errText(err)}`)
    }
  })

  /** Runs `act` and calls `wrote` if a line reached the proc during its synchronous part, which is where
   *  both adapters write a turn or an answer (see carryOnAfterAdopt). A throw is turned into a rejection,
   *  after the count was read. */
  const markIfWritten = <T>(procId: string | null, act: () => Promise<T>, wrote?: () => void): Promise<T> => {
    const before = procId === null ? 0 : writesTo(procId)
    let done: Promise<T>
    try {
      done = act()
    } catch (err) {
      done = Promise.reject(err)
    }
    if (procId !== null && writesTo(procId) > before) wrote?.()
    return done
  }

  const send = async (id: string, text: string, wrote?: () => void): Promise<void> => {
    if (!isWriter(id)) throw new Error('not the writer')
    await markIfWritten(procOf(id), () => manager.send(id, text), wrote)
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
      // Fix round 1 (Minor 2): a throw from here on would leave an adapter in the manager for a session
      // the caller is told was not adopted, so the session is forgotten before the throw goes on.
      try {
        h.replay()
        carryOnAfterAdopt(entry.id, meta.id, meta.restore)
        // A prompt the replay opened is covered at once.
        policy.review(meta.id)
      } catch (err) {
        forget(meta.id)
        throw err
      }
      return info
    },
    spawn(o) {
      const before = new Set(handles.keys())
      try {
        return manager.spawn(
          chatSpawnOptsOf(
            { ...o, restoreExtra: { ...o.restoreExtra, rolledBy: 'host' } },
            { unattendedOf: (x) => (x === undefined ? 'hold' : unattendedOf(x)), bypassSignal: null, hostStarting: true }
          )
        )
      } catch (err) {
        // The factory opened a proc and kept its handle before the manager threw (an adapter that could
        // not be made): the session never existed, so its handle must not go on hearing lines.
        for (const [id, h] of handles) {
          if (before.has(id) || manager.has(id)) continue
          h.release()
          handles.delete(id)
        }
        throw err
      }
    },
    async started(id) {
      let cancel: () => void = () => {}
      const timedOut = new Promise<'timeout'>((resolve) => {
        cancel = after(CHAT_START_PUSH_MS, () => resolve('timeout'))
      })
      let outcome: 'settled' | 'timeout' = 'settled'
      try {
        outcome = await Promise.race([manager.started(id).then(() => 'settled' as const), timedOut])
      } catch (err) {
        d.log(`chat ${id}: waiting for its start failed: ${errText(err)}`)
      } finally {
        cancel()
      }
      if (outcome === 'timeout') {
        // Handing it over now would make an app its writer in the middle of the handshake, and the
        // carry-on after it would be sent by nobody. Every step has a deadline, so this is a start that
        // hangs past all of them: ended here, with the mark left, so nothing adopts it meanwhile.
        d.log(`chat ${id}: its start did not settle within ${CHAT_START_PUSH_MS} ms, so it is ended and not handed over`)
        try {
          manager.kill(id)
        } catch (err) {
          d.log(`chat ${id}: ending a start that did not settle failed: ${errText(err)}`)
        }
        return false
      }
      try {
        const procId = procOf(id)
        if (procId !== null) d.procs.note(procId, { hostStarting: null })
      } catch (err) {
        d.log(`chat ${id}: clearing hostStarting failed: ${errText(err)}`)
      }
      return true
    },
    has: (id) => manager.has(id),
    turnOf: (id) => {
      if (!manager.has(id)) return null
      const st = manager.state(id)
      if (!st) return null
      return { alive: manager.info(id)?.status === 'running', status: st.status, error: st.error }
    },
    info: (id) => manager.info(id),
    procOf,
    note(id, patch) {
      const procId = procOf(id)
      if (procId !== null) d.procs.note(procId, patch)
    },
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
    requests: (id) => openOf(id),
    hasOpenRequest: (id) => openOf(id).length > 0,
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
    async answer(id, requestId, decision, wrote) {
      if (!isWriter(id)) return { answered: false, reason: 'not-held' }
      const r = manager.pendingOf(id).find((x) => x.id === requestId)
      if (!r) return { answered: false, reason: 'not-open' }
      if (r.kind === 'question') return { answered: false, reason: 'question' }
      const procId = procOf(id)
      let written = false
      try {
        await markIfWritten(
          procId,
          () => manager.answer(id, requestId, { kind: 'approval', decision: decision === 'allow' ? 'accept' : 'decline' }),
          () => {
            written = true
            wrote?.()
          }
        )
        return written ? { answered: true } : { answered: false, reason: 'not-open' }
      } catch (err) {
        const m = errText(err)
        // The answer's line went out and something after it failed: it was answered all the same.
        if (written) {
          d.log(`chat ${id}: ${requestId} was answered, then: ${m}`)
          return { answered: true }
        }
        const failed = chatAnswerFailureOf(err)
        if (failed.answered === false && failed.reason === 'not-held') d.log(`chat ${id}: answering ${requestId} failed: ${m}`)
        return failed
      }
    },
    async answerCard(id, requestId, answer) {
      if (!isWriter(id)) throw new Error('not the writer')
      if (answeredOf(id).includes(requestId)) throw new Error(`no open request: ${requestId} (answered already)`)
      await manager.answer(id, requestId, answer)
    },
    unattendedOf,
    answeredOf,
    chosenModelOf,
    bypassedOf: (id) => manager.bypassedOf(id),
    subscribe: (fn) => manager.subscribe(fn),
    onWriterChange: (fn) => d.holders.onChange(fn),
    handleCount: () => handles.size,
    dispose() {
      offEvents()
      offWriter()
      for (const s of manager.list()) forget(s.id)
      policy.dispose()
      hostProcs.dispose()
    }
  }
}
