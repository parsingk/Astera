// A session's facts as the Host can source them (remote runtime design Phase 9, X1-06, C2 N13): its status, the prompt
// it waits on, its usage and its model, each from the source its provider and kind allow (host/sessions.ts
// `sourcesOf`). A fact with no source is `unknown`; a session is never reported idle for lack of a signal. Read on
// demand, so it runs whether or not Slack or Account Rolling is on.
//
// - Claude terminal: status and prompt from its hook events (`sessionTurn`), usage and model from its statusline.
// - Codex terminal: status from the end of its rollout (a turn started is working; a turn completed or interrupted is
//   waiting; input written after that is unknown, since a few keys are not a turn and the rollout has not said), no
//   prompt source, usage and model from the rollout.
// - Chat: status from the chat's turn, prompt from its open request, model from the chat, usage from the last usage
//   event it sent (Claude; Codex chats send none). Only events seen since these facts began count: a chat whose last
//   turn ended before (a Host restarted under it) has no usage until its next turn ends, rather than a stale figure.
import { stat } from 'node:fs/promises'
import type { HostSession, SessionSources } from '../core/orchestration/command'
import type { SessionUsage } from '../core/types'
import type { ChatContextUsage, ChatRequest } from '../core/chat/types'
import type { HostChats } from './hostChats'
import type { SessionTurn } from './sessions'
import { parseStatusLinePayload, extractStatusLineModel } from '../core/usage/statusline'
import { contextFromLines, sessionUsageOf } from '../core/usage/codex'
import { limitStateFromLines } from '../core/rolling/codexSignal'
import { extractCodexModel } from '../core/history/codexConversation'
import { chatSessionUsage } from '../core/usage/chatSession'
import { tailLines } from '../core/rolling/tailLines'

export interface SessionFacts {
  id: string
  alive: boolean
  status: 'working' | 'waiting' | 'idle' | 'unknown'
  prompt: 'permission' | 'question' | null | 'unknown'
  usage: SessionUsage | null
  model: string | null
  sources: SessionSources
  /** A chat's open approval or question cards, for a controller to show and answer (sessions-answer). */
  requests?: ChatRequest[]
}

export interface SessionFactsDeps {
  listSessions(): Promise<HostSession[]>
  sessionTurn(id: string): Promise<SessionTurn | null>
  statusLinePayload(sessionId: string): Promise<unknown | null>
  /** The rollout a Codex terminal writes, from its pty's note; null before it is known. */
  rolloutOf(ptyId: string): string | null
  /** When a person last wrote to this pty (registry `lastWrite`). */
  lastWrite(ptyId: string): number | null
  chats: Pick<HostChats, 'turnOf' | 'requests' | 'chosenModelOf' | 'subscribe'> | null
  /** The end of a file as whole lines, and its modification time; null when it cannot be read. Test seam. */
  readTail?(path: string): Promise<{ lines: string[]; mtimeMs: number } | null>
}

const NO_SOURCES: SessionSources = { status: 'none', prompt: 'none', usage: 'none', conversation: 'none' }

const readTailOf = async (path: string): Promise<{ lines: string[]; mtimeMs: number } | null> => {
  const [lines, st] = await Promise.all([tailLines(path), stat(path).catch(() => null)])
  return lines && st ? { lines, mtimeMs: st.mtimeMs } : null
}

/** The rollout's last turn mark: a start, an end, or nothing yet, with its time. */
function lastTurnMark(lines: string[]): { kind: 'started' | 'complete'; at: number } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj: unknown
    try {
      obj = JSON.parse(lines[i])
    } catch {
      continue
    }
    const o = obj as { type?: unknown; timestamp?: unknown; payload?: { type?: unknown } }
    if (o?.type !== 'event_msg') continue
    const t = o.payload?.type
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    // An interrupted turn (Esc) ends as surely as a finished one (review I1).
    if (t === 'task_complete' || t === 'turn_aborted') return { kind: 'complete', at }
    if (t === 'task_started' || t === 'user_message') return { kind: 'started', at }
  }
  return null
}

export function createSessionFacts(d: SessionFactsDeps): { factsOf(id: string): Promise<SessionFacts | null>; dispose(): void } {
  const readTail = d.readTail ?? readTailOf
  /** A Claude chat's last context figure, from its usage events. */
  const chatContext = new Map<string, ChatContextUsage>()
  const stop =
    d.chats?.subscribe((sid, e) => {
      if (e.type === 'usage') chatContext.set(sid, e.context)
      else if (e.type === 'exit') chatContext.delete(sid)
    }) ?? null

  const codex = async (s: HostSession, base: SessionFacts): Promise<SessionFacts> => {
    const path = s.ptyId ? d.rolloutOf(s.ptyId) : null
    const tail = path ? await readTail(path) : null
    if (!tail) return base
    const mark = lastTurnMark(tail.lines)
    const wrote = s.ptyId ? d.lastWrite(s.ptyId) : null
    let status: SessionFacts['status'] = 'unknown'
    if (mark?.kind === 'started') status = 'working'
    // Written to since the turn ended: a turn may have begun, or only a few keys were typed. Unknown, not a guess.
    else if (mark?.kind === 'complete') status = wrote !== null && Number.isFinite(mark.at) && wrote > mark.at ? 'unknown' : 'waiting'
    const usage = sessionUsageOf(contextFromLines(tail.lines), limitStateFromLines(tail.lines, Date.now()))
    return { ...base, status: s.alive ? status : 'unknown', usage, model: extractCodexModel(tail.lines).model }
  }

  const claudeTerminal = async (s: HostSession, base: SessionFacts): Promise<SessionFacts> => {
    const [turn, payload] = await Promise.all([d.sessionTurn(s.id), d.statusLinePayload(s.id).catch(() => null)])
    const status: SessionFacts['status'] = turn && turn.alive && turn.state !== 'unknown' ? turn.state : 'unknown'
    return {
      ...base,
      status,
      // The hooks answer the prompt only while the session waits; otherwise there is none.
      prompt: status === 'waiting' ? (turn?.prompt ?? null) : status === 'unknown' ? 'unknown' : null,
      usage: payload ? parseStatusLinePayload(payload) : null,
      model: payload ? extractStatusLineModel(payload).model : null
    }
  }

  const chat = (s: HostSession, base: SessionFacts): SessionFacts => {
    if (!d.chats) return base
    const turn = d.chats.turnOf(s.id)
    const requests = d.chats.requests(s.id)
    const open = requests[0] ?? null
    const model = d.chats.chosenModelOf(s.id)
    const context = s.provider === 'claude' ? (chatContext.get(s.id) ?? null) : null
    return {
      ...base,
      status: turn && turn.alive ? turn.status : 'unknown',
      prompt: turn && turn.alive ? (open ? (open.kind === 'approval' ? 'permission' : 'question') : null) : 'unknown',
      usage: context ? chatSessionUsage({ context, model, limits: null, account: null }) : null,
      model,
      requests
    }
  }

  return {
    factsOf: async (id) => {
      const s = (await d.listSessions()).find((x) => x.id === id)
      if (!s) return null
      const sources = s.sources ?? NO_SOURCES
      const base: SessionFacts = { id: s.id, alive: s.alive, status: 'unknown', prompt: 'unknown', usage: null, model: null, sources }
      if (sources.status === 'none') return base
      if (s.kind === 'chat') return chat(s, base)
      return s.provider === 'codex' ? codex(s, base) : claudeTerminal(s, base)
    },
    dispose: () => stop?.()
  }
}
