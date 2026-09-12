import type { ConvTurn } from './convTypes'

/** A message this app has put on the pty and not yet seen come back in the transcript. */
export interface PendingSend {
  id: string
  text: string
  /** When it was sent, so one the CLI never records does not sit there for the rest of the session. */
  at: number
  /** How many user turns already said exactly this when it was sent. What settles it is the count
   *  going **above** this, not a match — otherwise saying the same thing twice would settle the second
   *  one against the first one's turn and the bubble would blink out and back. */
  seen: number
}

function userTextCount(turns: readonly ConvTurn[], text: string): number {
  let n = 0
  for (const turn of turns) {
    if (turn.role !== 'user') continue
    const first = turn.parts[0]
    if (first && first.kind === 'text' && first.text === text) n++
  }
  return n
}

/**
 * A message just sent, recorded so it can be shown before the CLI writes it down.
 *
 * The transcript is the only place a turn really exists, and it is written by the CLI at its own
 * pace: Claude flushes within a moment, codex not until the turn it starts produces something. Until
 * then the person's own words were nowhere on screen, which reads as a message that did not send.
 */
export function sendPending(
  pending: readonly PendingSend[],
  turns: readonly ConvTurn[],
  text: string,
  id: string,
  at: number
): PendingSend[] {
  const sameAlreadyWaiting = pending.filter((p) => p.text === text).length
  return [...pending, { id, text, at, seen: userTextCount(turns, text) + sameAlreadyWaiting }]
}

/**
 * Which of these the transcript still has not shown.
 *
 * Two ways one leaves. The transcript grew a user turn saying exactly this, which is the message
 * arriving where it belongs — and the local copy has to go in the same breath, or it is on screen
 * twice. Or it got old: a message can be swallowed by a dialog the CLI had open and never recorded at
 * all, and a bubble that stays forever would be a worse lie than the delay this exists to hide.
 */
export function unsettledSends(
  pending: readonly PendingSend[],
  turns: readonly ConvTurn[],
  now: number,
  maxAgeMs: number
): PendingSend[] {
  return pending.filter(
    (p) => now - p.at < maxAgeMs && userTextCount(turns, p.text) <= p.seen
  )
}

/**
 * Whether the person's last word is still unanswered.
 *
 * True from the moment something is sent until an assistant turn follows it. What it is for is a
 * sign that the CLI is thinking — without one, a message sits there with nothing after it and the
 * only honest reading is "this did not work", which is what someone watching a codex session
 * actually concluded.
 *
 * Read off the transcript rather than from a busy flag so it means the same thing for both CLIs:
 * codex reports no hooks at all, and its own screen is not a place a turn's shape can be read from.
 * A streaming answer ends it as soon as its first words are written down — by then the answer itself
 * is what says something is happening.
 */
export function isAwaitingReply(turns: readonly ConvTurn[], pendingCount: number): boolean {
  if (pendingCount > 0) return true
  const last = turns[turns.length - 1]
  return last !== undefined && last.role === 'user'
}
