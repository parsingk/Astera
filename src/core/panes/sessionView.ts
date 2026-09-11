/** Task 10: which of the terminal or the conversation each session tab is showing, remembered per
 *  tab rather than globally (a session started as a quick check and one deep in a plan are not the
 *  same kind of thing, and one switch for both forces one answer on each).
 *
 *  Kept a pure module for the same reason place.ts is: PaneGrid.tsx has no component-rendering
 *  tests, so the only part of this that a test can see is the reducer, not the JSX that calls it.
 *  PaneGrid owns the actual `Record<string, SessionView>` and calls these against it — see the
 *  comment on the session slot there for why it lives there and not in ConversationPane. */

import type { SessionView } from '../types'

export type SessionViewMap = Record<string, SessionView>

/**
 * Seeds a session's remembered choice the moment its tab first appears, from whatever
 * `conversationDefault` reads at that moment. A no-op — the same reference back — when the session
 * already has an entry: that is what keeps a later change to the setting from reaching backward
 * into a tab that already exists (requirement 2 of Task 10's brief), and what keeps main
 * re-announcing a session it already told PaneGrid about (`session:created` firing again after a
 * Host reconnect) from re-stamping a choice the person already flipped away from that default.
 */
export function openSessionView(
  views: SessionViewMap,
  sessionId: string,
  defaultView: SessionView
): SessionViewMap {
  if (sessionId in views) return views
  return { ...views, [sessionId]: defaultView }
}

/** What a session tab is showing right now. 'terminal' for a session with no entry — the same
 *  default a fresh tab is seeded with, read here for the one render that can land before the
 *  seeding effect has run. */
export function sessionViewOf(views: SessionViewMap, sessionId: string): SessionView {
  return views[sessionId] ?? 'terminal'
}

/** The toggle's own write. Same reference back when the value does not actually change, so a click
 *  on the segment already showing costs nothing downstream — the same bailout ConversationPane's
 *  own reducers (mergeTurns and friends) use, for the same reason. */
export function setSessionView(
  views: SessionViewMap,
  sessionId: string,
  next: SessionView
): SessionViewMap {
  if (views[sessionId] === next) return views
  return { ...views, [sessionId]: next }
}

/**
 * Drops every entry whose session is no longer open. A tab closing and a session ending both reach
 * here through the same door: PaneGrid calls this with the ids it is currently holding a slot for,
 * so anything missing from that set — closed by the person, or gone before a slot was ever built
 * for it — is dropped. One function rather than two "on tab close" / "on session end" cleanups,
 * because from this map's own point of view those are the same fact: the id no longer has a tab.
 * Generic so PaneGrid's attention record (Task 10's tab-bar marker) can reuse the identical
 * reconciliation instead of a second, hand-written copy of it.
 */
export function withoutClosedSessions<T>(
  views: Record<string, T>,
  liveSessionIds: ReadonlySet<string>
): Record<string, T> {
  const stale = Object.keys(views).filter((id) => !liveSessionIds.has(id))
  if (stale.length === 0) return views
  const next = { ...views }
  for (const id of stale) delete next[id]
  return next
}
