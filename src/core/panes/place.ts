/** Decides which group a new session goes into.
 *
 *  This gathers the four branches that used to be scattered across App.tsx's spawn success path
 *  (replaces / splitDir / already open / active group) into one pure function. Why it moved: two
 *  Critical bugs found in review were both in App.tsx, and that file has no unit tests, so
 *  "every session belongs to exactly one group" could only be checked by reading the code. The bug
 *  where an already-open session was re-inserted with addTab, leaving the same id straddling two
 *  groups, is the clearest example — a test would have caught it had the placement decision been
 *  a pure function.
 *
 *  Why not in tree.ts: that file holds the primitive tree operations, while this is policy that
 *  branches on "where is the active pane". It follows the convention of keeping policy in its own
 *  file, like core/run/config.ts. */

import {
  activateTab,
  addTab,
  createGroup,
  firstLeaf,
  groupOfSession,
  leafOf,
  replaceSessionId,
  splitAndMove,
  type PaneDir,
  type PaneLeaf,
  type PaneNode
} from './tree'

export type PlaceResult = {
  root: PaneNode
  /** The group to focus. null means do not change the active pane — restart and rolling only take
   *  over the tab's slot and must not steal the group the user was looking at */
  paneId: string | null
  /** A split was requested but could not happen, so the session landed in the active group.
   *  Reported so the caller can decide whether to tell the user */
  splitFellBack: boolean
}

export type PlaceOptions = {
  activePaneId?: string | null
  /** Direction to split into a new group (what Ctrl+\ reserves). Without it, opens as a tab in the active group */
  splitDir?: PaneDir | null
  /** Replace this session (restart/rolling). Only valid while it is in the tree, and takes precedence over splitDir */
  replaces?: string | null
  /** Add as a tab in the active group but **change neither the active tab nor the active pane**
   *  (worker sessions). This is the only switch that stops a session the user did not create from
   *  stealing focus. */
  background?: boolean
}

/** The active pane's group if it is valid, otherwise the first group. */
function targetGroup(root: PaneNode, activePaneId?: string | null): PaneLeaf {
  return (activePaneId ? leafOf(root, activePaneId) : null) ?? firstLeaf(root)
}

/** Adds the session as a tab in the active group. **If it is already in the tree, does not
 *  re-insert** but activates that group instead — the rolling-resume guard has a path that hands
 *  back an already-open live session instead of spawning a new one, and breaking addTab's contract
 *  (must not be in the tree yet) there would leave the same id straddling two groups. */
function intoGroup(root: PaneNode, sessionId: string, activePaneId?: string | null): PlaceResult {
  if (groupOfSession(root, sessionId)) {
    // not null, since the group was confirmed above
    const act = activateTab(root, sessionId)!
    return { root: act.root, paneId: act.paneId, splitFellBack: false }
  }
  const target = targetGroup(root, activePaneId)
  return { root: addTab(root, target.id, sessionId), paneId: target.id, splitFellBack: false }
}

/** Adds the session as a tab in the active group but leaves the active tab alone (worker placement).
 *
 *  The addTab that intoGroup uses makes the new tab that group's active tab (tree.ts) — which is
 *  right for sessions the user created. Workers, though, are created by the orchestrator, and the
 *  user may be typing into another tab at that moment. If the active tab switched to the worker,
 *  PaneGrid would hand active over to that terminal and TerminalView would call term.focus(), so
 *  subsequent typing would go into the worker PTY (and if the worker TUI has a permission prompt
 *  up, those keys get consumed as the answer). So worker tabs open as inactive background tabs and
 *  are barred from switching or taking focus.
 *
 *  Returning null for paneId follows the same convention as the replaces path — the "must not steal
 *  the group the user was looking at" note on PlaceResult.paneId applies as-is.
 *
 *  The behaviour of addTab and intoGroup is left unchanged — the user-driven paths use them. */
function intoGroupBackground(
  root: PaneNode,
  sessionId: string,
  activePaneId?: string | null
): PlaceResult {
  // If it is already in the tree, do nothing — not even activate. This is the path taken when
  // re-adoption (sessions.list) overlaps and the session gets placed twice
  if (groupOfSession(root, sessionId)) return { root, paneId: null, splitFellBack: false }
  const target = targetGroup(root, activePaneId)
  const keep = target.activeSessionId
  // Put back the active tab that addTab moved. By invariant 3, keep is guaranteed to be in that
  // group, and it differs from the new session (confirmed absent from the tree above) — the same
  // assertion convention intoGroup uses
  const restored = activateTab(addTab(root, target.id, sessionId), keep)!
  return { root: restored.root, paneId: null, splitFellBack: false }
}

export function placeSession(
  root: PaneNode | null,
  sessionId: string,
  opts: PlaceOptions = {}
): PlaceResult {
  // Restart/rolling — swap only the id, keeping the tab's slot, order and active state. Takes
  // precedence over a split request: the point of a restart is to inherit that slot, so moving it
  // into a new group would invert the intent
  if (opts.replaces && root && groupOfSession(root, opts.replaces))
    return {
      root: replaceSessionId(root, opts.replaces, sessionId),
      paneId: null,
      splitFellBack: false
    }
  if (!root) {
    const g = createGroup(sessionId)
    // Background placement does not set the active pane either. It is the only tab so it is visible,
    // but it does not take focus; it becomes the active pane when the user clicks it
    return { root: g, paneId: opts.background ? null : g.id, splitFellBack: false }
  }
  // Checked before the split — the worker path never passes splitDir (a worker is specified as "a
  // new tab in the active group"), and if both arrive we pick the option that preserves focus
  if (opts.background) return intoGroupBackground(root, sessionId, opts.activePaneId)
  if (opts.splitDir) {
    const target = targetGroup(root, opts.activePaneId)
    const res = splitAndMove(root, sessionId, target.id, opts.splitDir, false)
    if (res) return { root: res.root, paneId: res.paneId, splitFellBack: false }
    // Either MAX_PANES was exceeded, or it is the target group's only tab so splitting would give
    // back the same tree. The session still has to live somewhere (invariant 1), so it goes into the
    // active group — and it must be intoGroup, not addTab
    return { ...intoGroup(root, sessionId, opts.activePaneId), splitFellBack: true }
  }
  return intoGroup(root, sessionId, opts.activePaneId)
}
