// A chat session's conversation as `astera sessions read` shows it (CLI phase D4), and the card it
// may be holding open, each reduced to what a shell can print.
//
// **The source is the conversation view's own**: the transcript (Claude) or rollout (Codex) file the
// agent CLI writes, reduced by the same reducers (core/history/conversation.ts, codexConversation.ts)
// through the same window reader (conversationRead.ts). Not the line process's output, which the Host
// also holds: Claude's stream never echoes the person's own text, so a read of it would show answers
// with no questions.
//
// Imports only core, and the file reads are the window reader's, so the Host bundle can carry it.
import type { ChatRequest } from '../chat/types'
import type { ConvTurn } from '../history/convTypes'
import { reduceTranscript } from '../history/conversation'
import { reduceCodexRollout } from '../history/codexConversation'
import { readConversationWindow } from '../history/conversationRead'

/** One turn of a chat session, oldest first in `sessions read`'s `turns`. `text` is the turn's text
 *  parts joined by a blank line (empty for a turn that only called tools); `tools` is one line per
 *  tool call, in order: the tool, what it acted on, and how it went when that is known. */
export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  tools: string[]
}

/** The card a chat session is holding open: an approval (a tool waiting to be allowed) or a question
 *  the agent asked. Only the app holds it — see `sessions read`'s `pending`. */
export interface ChatPending {
  kind: 'approval' | 'question'
  summary: string
}

/** How many turns `--turns` gives by default, and at most. */
export const CHAT_TURNS_DEFAULT = 20
export const CHAT_TURNS_MAX = 200

/** How many windows one read walks back through at most. Each is 256KB (wider only around a single
 *  line bigger than that), so this is several megabytes of conversation: far more than 200 turns in
 *  any transcript measured, and a bound on what one read can cost the Host. */
const MAX_WINDOWS = 32

/** A tool's target is often a command, and a heredoc makes it many lines. One line per tool. */
const oneLine = (s: string): string => {
  const lines = s.split(/\r?\n/)
  return lines.length > 1 ? `${lines[0]} …` : s
}

export function chatTurnOf(t: ConvTurn): ChatTurn {
  const text: string[] = []
  const tools: string[] = []
  for (const p of t.parts) {
    if (p.kind === 'text') {
      text.push(p.text)
      continue
    }
    const head = p.target === '' ? p.name : `${p.name} ${oneLine(p.target)}`
    // null is "no result in the window": still running, or answered where this read did not reach.
    const tail =
      p.outcome === null
        ? ''
        : ` (${p.outcome.ok ? 'ok' : 'failed'}${p.outcome.detail === '' ? '' : `: ${p.outcome.detail}`})`
    tools.push(head + tail)
  }
  return { role: t.role, text: text.join('\n\n'), tools }
}

/** The one line a person needs to know what the session is waiting on. The card itself (its options,
 *  its full command) stays in the app, which is where it is answered. */
export function chatPendingOf(request: ChatRequest | null): ChatPending | null {
  if (request === null) return null
  if (request.kind === 'approval') {
    const first = request.about.lines[0]
    return { kind: 'approval', summary: first === undefined ? request.about.tool : `${request.about.tool}: ${oneLine(first)}` }
  }
  const [first, ...rest] = request.form.questions
  const head = first === undefined ? '' : oneLine(first.question)
  return { kind: 'question', summary: rest.length === 0 ? head : `${head} (+${rest.length} more)` }
}

/**
 * The last `n` turns of the file, oldest first. A missing file is `[]`: a Claude conversation's
 * transcript is written with its first turn, so a brand-new session has none yet.
 *
 * Walks back one window at a time until it has `n` turns or reaches the start of the file. Two
 * limits come from reading in windows, the same two the conversation view has when it pages back:
 * an assistant reply that straddles a window boundary reads as two turns, and a tool whose result is
 * in a later window than its call shows no result.
 */
export async function readChatTurns(filePath: string, format: 'claude' | 'codex', n: number): Promise<ChatTurn[]> {
  const reduce = format === 'claude' ? reduceTranscript : reduceCodexRollout
  let turns: ConvTurn[] = []
  let endAt: number | undefined
  for (let i = 0; i < MAX_WINDOWS; i++) {
    const w = await readConversationWindow(filePath, { reduce, ...(endAt === undefined ? {} : { endAt }) })
    if (w === null) break
    turns = [...w.turns, ...turns]
    if (turns.length >= n || !w.more) break
    endAt = w.from
  }
  return turns.slice(-n).map(chatTurnOf)
}
