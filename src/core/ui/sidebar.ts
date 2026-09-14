// What the rail's three view toggles do to the sidebar.
//
// The sidebar shows one of four things: the file explorer, Jobs, How It Works, or — when none of the
// three is chosen — the session list. Whether it is on screen at all is `open`, which the rail's own
// collapse button drives.
//
// **Toggling a view off now collapses the sidebar.** It used to only turn that view off, leaving the
// panel on screen showing the session list, so pressing Ctrl+Shift+E a second time looked like
// nothing had happened: the file tree was gone but a sidebar was still there. A key that opens
// something should put things back when pressed again, which is what its own rail button looks like
// it promises too.
//
// Hoisted out of App.tsx because it is a rule with four states and eight transitions, and the three
// closures it replaces were identical but for one name — the kind of thing that drifts apart.

/** The three views the rail can choose. The session list is not one of them: it is what the sidebar
 *  falls back to, not something a button turns on. */
export type SidebarView = 'explorer' | 'jobs' | 'understanding'

export interface SidebarState {
  /** Whether the sidebar is on screen at all. */
  open: boolean
  explorer: boolean
  jobs: boolean
  understanding: boolean
}

const VIEWS: SidebarView[] = ['explorer', 'jobs', 'understanding']

/**
 * The next state after pressing `view`'s button or shortcut.
 *
 * Opening it: the view goes on, the other two go off (the sidebar shows one at a time), and the
 * sidebar is unfolded if it was collapsed — otherwise the press would appear to do nothing.
 *
 * Closing it: the view goes off **and the sidebar collapses with it**. Not the session list, which is
 * where this used to land: nothing asked for the session list, and leaving a panel on screen is not
 * what "pressed again" means.
 *
 * A view that is on while the sidebar is collapsed — possible, since the collapse button leaves the
 * chosen view alone — counts as **not showing**, so the press unfolds rather than turning it off.
 * Pressing the key for what you cannot see should show it.
 */
export function toggleSidebarView(s: SidebarState, view: SidebarView): SidebarState {
  const showing = s.open && s[view]
  if (showing) return { ...s, open: false, [view]: false }
  const next: SidebarState = { ...s, open: true }
  for (const v of VIEWS) next[v] = v === view
  return next
}
