// A Runtime's sessions as a controller reads and drives them (remote runtime design Phase 9a, C2 N13, N17). Answered by
// the Host itself in orch.ts, behind the controller gate: the reads above the receipt line beside `jobs-view`, the
// changes below it so a retried request replays its answer instead of typing twice.
//
// - `sessions-facts { id }`: status, the waiting prompt, usage and model with the source of each (sessionFacts.ts), and a
//   chat's open requests.
// - `sessions-conversation { id, before? }`: the conversation in the page shape the app's view takes (`turns`, `from`,
//   `more`), read from the end of its file and bounded there (core/history/conversationRead.ts): a Claude terminal's
//   transcript (its statusline names it), a Codex terminal's rollout, a chat's transcript or rollout.
// - `sessions-input { id, data }`: raw bytes to the session's live pty, as a person's write.
// - `sessions-resize { id, cols, rows }`: applied when no local app holds the pty, else answered `applied: false`
//   (N17: a controller's resize must not change the terminal under the person at that machine).
// - `sessions-stop { id }`: ends the session's pty or chat process.
// - `sessions-answer { id, request, answer }`: a chat's approval or question, answered as Slack answers it.
import type { PtyRegistry } from './registry'
import type { ProcRegistry } from './procRegistry'
import type { HostSessions } from './sessions'
import type { HostChats } from './hostChats'
import type { HostSession } from '../core/orchestration/command'
import type { ChatAnswer } from '../core/chat/types'
import { createSessionFacts, type SessionFactsDeps } from './sessionFacts'
import type { Account } from '../core/types'
import { readConversationWindow } from '../core/history/conversationRead'
import { reduceTranscript } from '../core/history/conversation'
import { reduceCodexRollout } from '../core/history/codexConversation'
import { extractStatusLineSession } from '../core/usage/statusline'
import { findClaudeTranscript } from '../core/history/strategies/claude'

/** The most one input carries: a paste, never a file. */
export const SESSION_INPUT_MAX = 64 * 1024

export const REMOTE_SESSION_READS: ReadonlySet<string> = new Set(['sessions-facts', 'sessions-conversation'])
export const REMOTE_SESSION_CHANGES: ReadonlySet<string> = new Set(['sessions-input', 'sessions-resize', 'sessions-stop', 'sessions-answer'])

type Reply = { status: number; body: unknown }
const bad = (error: string): Reply => ({ status: 400, body: { error } })
const notFound = (id: unknown): Reply => ({ status: 404, body: { error: `no session ${String(id)} on this Runtime` } })
const ended = (id: string): Reply => ({ status: 409, body: { error: `session ${id} has ended` } })

export interface RemoteSessionDeps {
  ptys: Pick<PtyRegistry, 'write' | 'resize' | 'kill' | 'metaOf' | 'lastWrite'>
  procs: Pick<ProcRegistry, 'list'>
  sessions: Pick<HostSessions, 'listSessions' | 'sessionTurn'>
  /** The local sockets that hold this pty (exits.ts `holdersOf`): a resize yields to them (N17). */
  holdersOf(ptyId: string): number[]
  statusLinePayload(sessionId: string): Promise<unknown | null>
  /** The profile's accounts: a Claude chat's transcript lives under its account's folder. */
  accounts(): Promise<Account[]>
  chats: (Pick<HostChats, 'turnOf' | 'requests' | 'chosenModelOf' | 'subscribe' | 'kill' | 'answerCard'>) | null
  readTail?: SessionFactsDeps['readTail']
}

export interface RemoteSessions {
  /** A read, or null when `cmd` is not one of REMOTE_SESSION_READS. */
  read(cmd: string, args: Record<string, unknown>): Promise<Reply> | null
  /** A change, marking an effect through `marked` when it acted; null when `cmd` is not one of REMOTE_SESSION_CHANGES. */
  change(cmd: string, args: Record<string, unknown>, marked: () => void): Promise<Reply> | null
  dispose(): void
}

export function createRemoteSessions(d: RemoteSessionDeps): RemoteSessions {
  const facts = createSessionFacts({
    listSessions: () => d.sessions.listSessions(),
    sessionTurn: async (id) => (d.sessions.sessionTurn ? d.sessions.sessionTurn(id) : null),
    statusLinePayload: d.statusLinePayload,
    rolloutOf: (ptyId) => {
      const p = d.ptys.metaOf(ptyId)?.restore?.rolloutPath
      return typeof p === 'string' && p !== '' ? p : null
    },
    lastWrite: (ptyId) => d.ptys.lastWrite(ptyId),
    chats: d.chats,
    ...(d.readTail ? { readTail: d.readTail } : {})
  })
  const find = async (id: unknown): Promise<HostSession | null> =>
    typeof id === 'string' && id !== '' ? ((await d.sessions.listSessions()).find((s) => s.id === id) ?? null) : null

  const noteOf = (s: HostSession): Record<string, unknown> => {
    if (s.ptyId) return (d.ptys.metaOf(s.ptyId)?.restore ?? {}) as Record<string, unknown>
    const proc = d.procs.list().find((e) => e.id === s.procId)
    return (proc?.meta?.restore ?? {}) as Record<string, unknown>
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  /** Where a session's conversation is written, and in which format; null when the Host cannot say. */
  const sourceOf = async (s: HostSession): Promise<{ path: string; format: 'claude' | 'codex' } | null> => {
    const note = noteOf(s)
    if (s.kind === 'terminal') {
      if (s.provider === 'codex') {
        const p = str(note.rolloutPath)
        return p ? { path: p, format: 'codex' } : null
      }
      if (s.provider !== 'claude') return null
      const payload = await d.statusLinePayload(s.id).catch(() => null)
      const p = payload ? extractStatusLineSession(payload).transcriptPath : null
      return p ? { path: p, format: 'claude' } : null
    }
    if (s.provider === 'codex') {
      const p = str(note.rolloutPath)
      return p ? { path: p, format: 'codex' } : null
    }
    const threadId = str(note.threadId)
    const account = (await d.accounts().catch(() => [] as Account[])).find((x) => x.id === s.accountId)
    if (!threadId || !account) return null
    const file = await findClaudeTranscript(account.configDir, threadId)
    return file ? { path: file, format: 'claude' } : null
  }

  const reads = async (cmd: string, args: Record<string, unknown>): Promise<Reply> => {
    if (typeof args.id !== 'string' || args.id === '') return bad(`${cmd} needs --id`)
    if (cmd === 'sessions-facts') {
      const f = await facts.factsOf(args.id)
      return f ? { status: 200, body: f } : notFound(args.id)
    }
    // sessions-conversation
    const s = await find(args.id)
    if (!s) return notFound(args.id)
    if (args.before !== undefined && (typeof args.before !== 'number' || !Number.isInteger(args.before) || args.before < 0))
      return bad('--before is a whole number from 0: an earlier page’s from')
    const source = await sourceOf(s)
    const empty = { status: 200, body: { turns: [], from: 0, more: false } }
    if (!source) return empty
    const window = await readConversationWindow(source.path, {
      reduce: source.format === 'codex' ? reduceCodexRollout : reduceTranscript,
      ...(args.before !== undefined ? { endAt: args.before as number } : {})
    })
    return window ? { status: 200, body: { turns: window.turns, from: window.from, more: window.more } } : empty
  }

  const changes = async (cmd: string, args: Record<string, unknown>, marked: () => void): Promise<Reply> => {
    if (cmd === 'sessions-answer') {
      if (typeof args.id !== 'string' || typeof args.request !== 'string') return bad('sessions-answer needs --id and --request')
      const answer = args.answer as ChatAnswer | undefined
      const okAnswer =
        (answer?.kind === 'approval' && ['accept', 'acceptForSession', 'decline'].includes(String((answer as { decision?: unknown }).decision))) ||
        (answer?.kind === 'question' && Array.isArray((answer as { answers?: unknown }).answers))
      if (!okAnswer) return bad('sessions-answer needs an approval decision or the question answers')
      if (!d.chats) return { status: 501, body: { error: 'this Runtime has no chat sessions' } }
      try {
        await d.chats.answerCard(args.id, args.request, answer as ChatAnswer)
      } catch (e) {
        return { status: 409, body: { error: e instanceof Error ? e.message : String(e) } }
      }
      marked()
      return { status: 200, body: { answered: true } }
    }
    const s = await find(args.id)
    if (typeof args.id !== 'string' || args.id === '') return bad(`${cmd} needs --id`)
    if (!s) return notFound(args.id)
    if (cmd === 'sessions-stop') {
      if (!s.alive) return ended(s.id)
      if (s.kind === 'chat') d.chats?.kill(s.id)
      else if (s.ptyId) d.ptys.kill(s.ptyId)
      marked()
      return { status: 200, body: { stopped: true } }
    }
    if (s.kind === 'chat') return bad(`${cmd} is for terminal sessions; a chat takes sessions-send`)
    if (!s.alive || !s.ptyId) return ended(s.id)
    if (cmd === 'sessions-input') {
      if (typeof args.data !== 'string' || args.data === '') return bad('sessions-input needs --data')
      if (args.data.length > SESSION_INPUT_MAX) return bad(`sessions-input takes at most ${SESSION_INPUT_MAX} characters at a time`)
      d.ptys.write(s.ptyId, args.data, { person: true })
      marked()
      return { status: 200, body: { written: args.data.length } }
    }
    // sessions-resize
    const size = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10_000
    if (!size(args.cols) || !size(args.rows)) return bad('sessions-resize needs whole --cols and --rows from 1')
    if (d.holdersOf(s.ptyId).length > 0) return { status: 200, body: { applied: false, reason: 'held' } }
    d.ptys.resize(s.ptyId, args.cols, args.rows)
    marked()
    return { status: 200, body: { applied: true } }
  }

  return {
    read: (cmd, args) => (REMOTE_SESSION_READS.has(cmd) ? reads(cmd, args) : null),
    change: (cmd, args, marked) => (REMOTE_SESSION_CHANGES.has(cmd) ? changes(cmd, args, marked) : null),
    dispose: () => facts.dispose()
  }
}
