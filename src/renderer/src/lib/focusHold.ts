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
