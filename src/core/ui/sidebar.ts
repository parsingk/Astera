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

/** What the rail can choose. `'sessions'` — the accounts and project history — is the state where
 *  none of the other three is on, and it now has a button of its own.
 *
 *  **It used to be unreachable in one press.** Turning a view off collapses the sidebar (see below),
 *  so getting back to the accounts list took two: the view's own button to turn it off, then the
 *  collapse button to unfold onto the empty state. A list you can leave but not return to is not a
 *  view the rail offers — so it is one now, under the same rule as the rest. */
export type SidebarView = 'explorer' | 'jobs' | 'understanding' | 'sessions'
/** The three that are flags on the state. `'sessions'` is not one — it is the absence of all three. */
type FlagView = 'explorer' | 'jobs' | 'understanding'

export interface SidebarState {
  /** Whether the sidebar is on screen at all. */
  open: boolean
  explorer: boolean
  jobs: boolean
  understanding: boolean
}

const VIEWS: FlagView[] = ['explorer', 'jobs', 'understanding']

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
  // `'sessions'` is showing when the sidebar is open and nothing else is chosen. Everything after
  // this reads the same for it as for the other three: pressing what you see collapses, pressing
  // what you do not see shows it.
  const showing = view === 'sessions' ? s.open && VIEWS.every((v) => !s[v]) : s.open && s[view]
  if (showing) return view === 'sessions' ? { ...s, open: false } : { ...s, open: false, [view]: false }
  const next: SidebarState = { ...s, open: true }
  for (const v of VIEWS) next[v] = v === view
  return next
}
