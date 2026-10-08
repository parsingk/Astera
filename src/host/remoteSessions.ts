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
// - `sessions-answer { id, request, answer }`: a chat's approval or question, answered as Slack answers it: by the Host
//   when it writes the chat, else by the Runtime's own app (review I2), which is the usual case under N17.
import type { PtyRegistry } from './registry'
import type { ProcRegistry } from './procRegistry'
import type { HostSessions } from './sessions'
import type { HostChats } from './hostChats'
import type { HostSession } from '../core/orchestration/command'
import type { ChatAnswer } from '../core/chat/types'
import { HOST_ACT_SLACK_ANSWER } from '../core/host/protocol'
import { createSessionFacts, type SessionFactsDeps } from './sessionFacts'
import type { Account } from '../core/types'
import { readConversationWindow } from '../core/history/conversationRead'
import { reduceTranscript } from '../core/history/conversation'
import { reduceCodexRollout } from '../core/history/codexConversation'
import { extractStatusLineSession } from '../core/usage/statusline'
import { findClaudeTranscript } from '../core/history/strategies/claude'

import { SESSION_INPUT_MAX, ANSWER_MESSAGE_MAX } from '../core/remote/sessions'
export { SESSION_INPUT_MAX, ANSWER_MESSAGE_MAX }

export const REMOTE_SESSION_READS: ReadonlySet<string> = new Set(['sessions-facts', 'sessions-conversation'])
export const REMOTE_SESSION_CHANGES: ReadonlySet<string> = new Set(['sessions-input', 'sessions-resize', 'sessions-stop', 'sessions-answer'])

type Reply = { status: number; body: unknown }
const bad = (error: string): Reply => ({ status: 400, body: { error } })
const notFound = (id: unknown): Reply => ({ status: 404, body: { error: `no session ${String(id)} on this Runtime` } })
const ended = (id: string): Reply => ({ status: 409, body: { error: `session ${id} has ended` } })

export interface RemoteSessionDeps {
  ptys: Pick<PtyRegistry, 'write' | 'resize' | 'kill' | 'metaOf' | 'lastWrite'>
  procs: Pick<ProcRegistry, 'list'>
  sessions: Pick<HostSessions, 'listSessions' | 'sessionTurn' | 'sessionById'>
  /** The local sockets that hold this pty (exits.ts `holdersOf`): a resize yields to them (N17). null when this Host
   *  cannot tell (it keeps no holders), and then a resize is not applied (review M1). */
  holdersOf(ptyId: string): number[] | null
  /** Whether an app is attached, and an action asked of it: a chat the app writes is answered there (review I2). */
  hasApp(): boolean
  askApp(act: string, args: unknown[]): Promise<unknown>
  statusLinePayload(sessionId: string): Promise<unknown | null>
  /** The profile's accounts: a Claude chat's transcript lives under its account's folder. */
  accounts(): Promise<Account[]>
  chats: (Pick<HostChats, 'turnOf' | 'requests' | 'chosenModelOf' | 'subscribe' | 'kill' | 'answerCard' | 'has' | 'isWriter'>) | null
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
  /** One session by id: computed for it alone where the registry can (performance audit H4), else from the list. */
  const byId = async (id: string): Promise<HostSession | null> =>
    d.sessions.sessionById ? d.sessions.sessionById(id) : ((await d.sessions.listSessions()).find((s) => s.id === id) ?? null)
  const facts = createSessionFacts({
    sessionById: byId,
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
  const find = async (id: unknown): Promise<HostSession | null> => (typeof id === 'string' && id !== '' ? byId(id) : null)

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
    // Not readable yet (no statusline, no rollout named, no transcript found) says so, apart from an empty
    // conversation (review M7).
    const unavailable = { status: 200, body: { turns: [], from: 0, more: false, available: false } }
    if (!source) return unavailable
    const window = await readConversationWindow(source.path, {
      reduce: source.format === 'codex' ? reduceCodexRollout : reduceTranscript,
      ...(args.before !== undefined ? { endAt: args.before as number } : {})
    })
    return window ? { status: 200, body: { turns: window.turns, from: window.from, more: window.more, available: true } } : unavailable
  }

  /** An answer of the right shape, or why not (review M4). */
  const answerProblem = (answer: unknown): string | null => {
    const a = answer as { kind?: unknown; decision?: unknown; message?: unknown; answers?: unknown } | null
    if (a?.kind === 'approval') {
      if (!['accept', 'acceptForSession', 'decline'].includes(String(a.decision))) return 'an approval needs a decision'
      if (a.message !== undefined && (typeof a.message !== 'string' || a.message.length > ANSWER_MESSAGE_MAX))
        return `a message is text of at most ${ANSWER_MESSAGE_MAX} characters`
      return null
    }
    if (a?.kind === 'question') {
      const ok =
        Array.isArray(a.answers) &&
        a.answers.every(
          (x) =>
            typeof x === 'object' &&
            x !== null &&
            Array.isArray((x as { picks?: unknown }).picks) &&
            (x as { picks: unknown[] }).picks.every((n) => Number.isInteger(n) && (n as number) >= 0) &&
            typeof (x as { other?: unknown }).other === 'string' &&
            (x as { other: string }).other.length <= ANSWER_MESSAGE_MAX
        )
      return ok ? null : 'a question needs one { picks, other } per question'
    }
    return 'sessions-answer needs an approval decision or the question answers'
  }

  const answerChat = async (s: HostSession, request: string, answer: ChatAnswer, marked: () => void): Promise<Reply> => {
    if (d.chats?.has(s.id) && d.chats.isWriter(s.id)) {
      const card = d.chats.requests(s.id).find((r) => r.id === request)
      if (!card) return { status: 409, body: { error: `no open card ${request} on session ${s.id}` } }
      if (card.kind !== answer.kind) return bad(`card ${request} is ${card.kind === 'approval' ? 'an approval' : 'a question'}`)
      if (card.kind === 'approval' && answer.kind === 'approval' && !card.decisions.includes(answer.decision))
        return bad(`card ${request} offers ${card.decisions.join(', ')}`)
      try {
        await d.chats.answerCard(s.id, request, answer)
      } catch (e) {
        return { status: 409, body: { error: e instanceof Error ? e.message : String(e) } }
      }
      marked()
      return { status: 200, body: { answered: true } }
    }
    // The Runtime's own app writes the chat: answered there, as Slack's answer goes (slackRoutes.ts answerChat).
    if (!d.hasApp()) return { status: 503, body: { error: `session ${s.id} is held by no one who can answer it now` } }
    const r = (await d.askApp(HOST_ACT_SLACK_ANSWER, [s.id, request, answer]).catch((e: unknown) => ({ reason: e instanceof Error ? e.message : String(e) }))) as {
      answered?: unknown
      reason?: unknown
    } | null
    if (r?.answered !== true) return { status: 409, body: { error: `Astera on that machine did not answer it (${String(r?.reason ?? 'unknown')})` } }
    marked()
    return { status: 200, body: { answered: true } }
  }

  const changes = async (cmd: string, args: Record<string, unknown>, marked: () => void): Promise<Reply> => {
    // The id is checked before the sessions are read (review M2).
    if (typeof args.id !== 'string' || args.id === '') return bad(`${cmd} needs --id`)
    if (cmd === 'sessions-answer' && (typeof args.request !== 'string' || args.request === '')) return bad('sessions-answer needs --request')
    if (cmd === 'sessions-answer') {
      const problem = answerProblem(args.answer)
      if (problem) return bad(problem)
    }
    const s = await find(args.id)
    if (!s) return notFound(args.id)
    if (cmd === 'sessions-answer') {
      if (s.kind !== 'chat') return bad('sessions-answer is for chat sessions')
      return answerChat(s, args.request as string, args.answer as ChatAnswer, marked)
    }
    if (cmd === 'sessions-stop') {
      if (!s.alive) return ended(s.id)
      if (s.kind === 'chat') {
        // Only a chat this Host holds is ended here. One the app holds is the app's to end: killing its process from
        // the Host would read as a crash there (review I3).
        if (!d.chats?.has(s.id)) return { status: 409, body: { error: `session ${s.id} is held by Astera on that machine; stop it there` } }
        d.chats.kill(s.id)
      } else if (s.ptyId) d.ptys.kill(s.ptyId)
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
    const holders = d.holdersOf(s.ptyId)
    if (holders === null) return { status: 200, body: { applied: false, reason: 'unknown' } }
    if (holders.length > 0) return { status: 200, body: { applied: false, reason: 'held' } }
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
