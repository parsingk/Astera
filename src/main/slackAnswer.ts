// The app's half of a Slack card answer (Slack in the Host Task 7, plan ruling P10). While the Host owns
// Slack and this app is a chat session's writer, the Host asks this app to answer the card through the
// orch-act `slackChatAnswer` (HOST_ACT_SLACK_ANSWER), with the whole answer: an approval's decision or a
// question's answers. ipc.ts answers that act here, beside `worktreePathInUse`, since it is not an
// OrchServerDeps name.
//
// Never rejects: the Host reads a refusal from the value, and an act that rejected would reach the Host as
// an error with no reason it can say in the thread.
import type { ChatAnswer } from '../core/chat/types'
import { chatAnswerFailureOf } from '../core/sessions/chatRead'

export type SlackCardAnswerResult = { answered: true } | { answered: false; reason: 'not-held' | 'not-open' | 'bad-args' }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** A well formed answer, or null. The payload crossed a socket, so its shape is checked, not trusted. */
function answerOf(v: unknown): ChatAnswer | null {
  if (!isRecord(v)) return null
  if (v.kind === 'approval' && typeof v.decision === 'string') return v as ChatAnswer
  if (v.kind === 'question' && Array.isArray(v.answers)) return v as ChatAnswer
  return null
}

export async function answerSlackCard(
  chat: { has(id: string): boolean; answer(id: string, requestId: string, a: ChatAnswer): Promise<void> },
  args: unknown
): Promise<SlackCardAnswerResult> {
  const [sid, rid, raw] = Array.isArray(args) ? (args as unknown[]) : []
  const answer = answerOf(raw)
  if (typeof sid !== 'string' || typeof rid !== 'string' || answer === null) return { answered: false, reason: 'bad-args' }
  try {
    if (!chat.has(sid)) return { answered: false, reason: 'not-held' }
    await chat.answer(sid, rid, answer)
    return { answered: true }
  } catch (err) {
    // The adapter's "no open request" (a card already answered or gone) is not-open; anything else (a
    // NotWriterError, a pipe that has gone) means this side could not answer.
    const failed = chatAnswerFailureOf(err)
    return failed.answered === false && failed.reason === 'not-open' ? { answered: false, reason: 'not-open' } : { answered: false, reason: 'not-held' }
  }
}
