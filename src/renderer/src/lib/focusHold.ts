// A moment in which a tab that activates does not take focus (agent tabs close on exit, 2026-10-20, review M4). When the
// app closes the tab a person is looking at — an agent's session that ended — the tab beside it becomes active, and a
// terminal takes focus as it activates: the keys a person goes on typing would land there, in another worker's
// permission prompt, say. The terminals ask this before they take it; a click still focuses as ever.
let heldUntil = 0

export function holdActivationFocus(ms = 1000): void {
  heldUntil = Date.now() + ms
}

export function activationFocusHeld(): boolean {
  return Date.now() < heldUntil
}

/** How long focus the app gave stays the app's: Electron confirms a plugin guest's focus a moment after focus() returns,
 *  with a focus event of its own (measured on the hidden desktop: 2 ms). */
const GIVEN_MS = 500
/** The element the app last gave the focus back to, and until when. */
let given: { el: unknown; until: number } | null = null

/** Gives the focus back as the app's (the palette closing), not the person moving it. A pane body that turns a focus
 *  event into a pane switch (a plugin panel's guest, whose clicks never reach this document) asks focusGivenByApp first,
 *  or giving the focus back would undo a pane switch the palette just ran (test matrix T17, finding A1, review). */
export function giveFocus(el: { focus: () => void }): void {
  given = { el, until: Date.now() + GIVEN_MS }
  el.focus()
}

/** Whether `el` took the focus because the app gave it back a moment ago. */
export function focusGivenByApp(el: unknown): boolean {
  return given !== null && given.el === el && Date.now() < given.until
}
