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

/** What a session tab is showing right now. `defaultView` for a session with no entry yet — a
 *  literal 'terminal' here, rather than the caller's actual `conversationDefault`, was fix round
 *  1's bug: PaneGrid's seeding effect runs after the first render, so a brand-new tab's very first
 *  paint read this fallback before the effect ever ran. With `conversationDefault` set to
 *  'conversation', that first paint mounted the terminal as `active` (it focuses itself), and the
 *  very next commit tore that down for the conversation pane instead — a focus grab nobody asked
 *  for, gone before anyone could act on it. Taking the same default the seeding effect will settle
 *  on as a parameter, rather than a hardcoded stand-in for it, is what makes the first paint already
 *  correct. */
export function sessionViewOf(
  views: SessionViewMap,
  sessionId: string,
  defaultView: SessionView
): SessionView {
  return views[sessionId] ?? defaultView
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
 * Carries a session's remembered view across a roll (`session:rolled` — the same tab, kept in
 * place, given a new session id when its account rolls). Unlike `rollStates`/`busy`/`attention`,
 * which App drops on a roll on purpose because those are verdicts about the process that starts
 * over, the view choice is a property of the *tab*, and the tab visibly does not change — a person
 * reading the conversation when the account rolls must not be snapped back to the terminal for
 * having done nothing. PaneGrid otherwise has no way to know `newSessionId` is not a brand new
 * tab: its seeding effect sees a `sessions` array where the old id vanished and a new one appeared,
 * indistinguishable from the old tab closing and an unrelated new one opening, unless told
 * otherwise.
 *
 * A no-op — the same reference back — when there is nothing to carry (the old id already has no
 * entry, e.g. this is applied a second time after the first already moved it) or the new id already
 * has one of its own (never overwrites an existing choice).
 */
export function carryRolledView(
  views: SessionViewMap,
  oldSessionId: string,
  newSessionId: string
): SessionViewMap {
  if (!(oldSessionId in views) || newSessionId in views) return views
  const next = { ...views }
  next[newSessionId] = next[oldSessionId]
  delete next[oldSessionId]
  return next
}

/**
 * Drops every entry whose session is no longer open. A tab closing and a session ending both reach
 * here through the same door: PaneGrid calls this with the ids it is currently holding a slot for,
 * so anything missing from that set — closed by the person, or gone before a slot was ever built
 * for it — is dropped. One function rather than two "on tab close" / "on session end" cleanups,
 * because from this map's own point of view those are the same fact: the id no longer has a tab.
 *
 * Generic on the value type rather than fixed to SessionViewMap, on the chance another per-session
 * record ever needs the identical reconciliation. App's `attention` record (Task 10's tab-bar
 * marker) does not: App drops that record's stale entries only on `session:rolled` (an id swap, the
 * same event `carryRolledView` above answers, not a close), and otherwise leaves them, matching
 * `rollStates`/`busy`'s own established choice not to clean up on a session's end either. One caller
 * today (PaneGrid's `sessionViews`) — the generic is not exercised by a second one yet.
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
