import type { AccountUsage, RateLimitWindow, SessionUsage } from '../types'
import type { ChatContextUsage } from '../chat/types'

/**
 * The status bar's three figures for a Claude chat session.
 *
 * A pty session reads all three off the statusLine capture, which the chat transport never plants
 * (`ASTERA_STATUSLINE_OUT` is set by the pty manager alone), so a chat session has to assemble the
 * same answer from what it does have: the context off its own turns, and the limits from whichever
 * source has spoken.
 *
 * Limits come from the session first and the account cache second. The session's figures are the
 * fresher of the two when they exist, but they only exist once a warning has arrived, which a
 * session nobody has pushed to its limit never sees. The account cache is the same pair of numbers
 * for the same account, already fetched for the sidebar's meters, and a 5-hour or weekly limit is an
 * account's to begin with. Each window falls back on its own: a warning about the weekly one says
 * nothing about the 5-hour, so it must not blank it.
 */
export function chatSessionUsage(v: {
  context: ChatContextUsage | null
  /** The model the session reports itself on, when it has said. */
  model: string | null
  /** What the session itself was told, off a rate-limit event. */
  limits: { session: RateLimitWindow | null; weekly: RateLimitWindow | null } | null
  /** The account's last-known pair. Narrowed to the two windows so both the live figure and the
   *  persisted one (AccountUsageStore's own entry) fit without a conversion in between. */
  account: Pick<AccountUsage, 'session' | 'weekly'> | null
}): SessionUsage | null {
  const context = contextOf(v.context, v.model)
  const session = v.limits?.session ?? v.account?.session ?? null
  const weekly = v.limits?.weekly ?? v.account?.weekly ?? null
  if (!context && !session && !weekly) return null
  return { context, session, weekly }
}

function contextOf(usage: ChatContextUsage | null, model: string | null): SessionUsage['context'] {
  if (!usage) return null
  const sizes = Object.values(usage.windowByModel)
  // The named model when the frame accounted for it. Otherwise the widest: the narrow entries belong
  // to sub-agent models, so the widest is the conversation's own far more often than not.
  const named = model === null ? undefined : Object.entries(usage.windowByModel).find(([m]) => m === model)?.[1]
  const widest = sizes.length > 0 ? Math.max(...sizes) : null
  const windowSize = named ?? widest
  if (windowSize === null || windowSize <= 0) return null
  return {
    usedPercent: Math.max(0, Math.min(100, Math.round((usage.usedTokens / windowSize) * 100))),
    usedTokens: usage.usedTokens,
    windowSize
  }
}
