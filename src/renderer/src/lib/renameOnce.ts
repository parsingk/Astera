// One tab rename ends once (audit UI-2): Enter or Escape ends it, and the input's blur as it unmounts would end it again
// with the typed text. `state.ended` is cleared when a rename begins (the input's focus).

export function endRenameOnce(state: { ended: string | null }, tabId: string, end: () => void): void {
  if (state.ended === tabId) return
  state.ended = tabId
  end()
}
