// Which key presses the app leaves to the element that has focus. These are the rules the global keydown listener
// applied branch by branch before the action registry (ADR-007); they are about where focus is, not about whether
// the action can run, so they stay with the listener while the actions themselves moved to the registry.

import type { ActionId, ActionSpec, Bindings, Chord } from '../../../core/keys/binding'

export type KeyFocus = {
  /** Focus is inside a terminal. */
  inXterm: boolean
  /** Focus is inside the conversation view (its composer is a real <textarea>). */
  inConversation: boolean
  /** Focus is on something that edits text: an input, a textarea, a select, or contenteditable. */
  editable: boolean
  /** Focus is inside the CodeMirror editor (its content is contenteditable). */
  inEditor: boolean
}

export function keyFocusOf(el: Element | null): KeyFocus {
  if (!el) return { inXterm: false, inConversation: false, editable: false, inEditor: false }
  const html = el as HTMLElement
  return {
    inXterm: !!el.closest('.xterm'),
    inConversation: !!el.closest('[data-slot="conversation-pane"]'),
    editable: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || html.isContentEditable === true,
    inEditor: !!el.closest('.cm-editor')
  }
}

/**
 * True when the focused element keeps this action's key for itself, so the app does nothing with it.
 *
 * - A terminal keeps the key of an action that yields to it (ActionSpec.yieldsToTerminal: Ctrl+W deletes a word
 *   there on win32).
 * - A text field keeps the explorer toggle. The exceptions are the surfaces the app owns that have no such feature
 *   of their own: a terminal, the editor, and the conversation composer, which plays the part xterm plays in the
 *   other view.
 * - A text field keeps pane focus and tab cycling (Ctrl+Shift+arrow selects by word in it), except a terminal and
 *   the composer, which gave that up for pane focus; tab cycling also works from the editor, where the tab bar is
 *   otherwise out of reach.
 */
export function focusKeepsKey(action: ActionId, focus: KeyFocus, yieldsToTerminal: boolean): boolean {
  if (focus.inXterm && yieldsToTerminal) return true
  if (action === 'explorer.toggleMode') {
    return focus.editable && !focus.inConversation && !focus.inXterm && !focus.inEditor
  }
  const tabCycle = action === 'sessionTab.prev' || action === 'sessionTab.next'
  if (tabCycle || action.startsWith('pane.focus')) {
    return focus.editable && !focus.inXterm && !focus.inConversation && !(tabCycle && focus.inEditor)
  }
  return false
}

export type KeyDecision = 'pass' | 'swallow' | 'run'

/**
 * What the global listener does with a matched key. `pass`: leave it to whatever has focus (focus keeps it, or the
 * action has nothing to do). `swallow`: take it and do nothing (a blocked action that keeps its key, see
 * ActionSpec.swallowsWhenBlocked). `run`: take it and run the action.
 */
export function keyDecision(
  spec: Pick<ActionSpec, 'id' | 'yieldsToTerminal' | 'swallowsWhenBlocked'>,
  focus: KeyFocus,
  runnable: boolean
): KeyDecision {
  if (focusKeepsKey(spec.id, focus, spec.yieldsToTerminal)) return 'pass'
  if (runnable) return 'run'
  return spec.swallowsWhenBlocked ? 'swallow' : 'pass'
}

/**
 * Focus inside a plugin panel (test matrix T17, finding A1). The panel's page is another renderer the app cannot look
 * into, so it counts as a text field: the keys a field keeps stay the page's.
 */
export const PANEL_FOCUS: KeyFocus = { inXterm: false, inConversation: false, editable: true, inEditor: false }

/**
 * The keys main takes from a plugin panel's page for the app, right now: those the app would run or keep with the focus
 * in a text field. A key the app would pass on (a field keeps it, or its action has nothing to do and does not keep its
 * key) stays the page's, as it stays a focused field's in the window.
 */
export function panelChords(bindings: Bindings, actions: readonly ActionSpec[], runnable: (id: ActionId) => boolean): Chord[] {
  return actions.flatMap((a) => (keyDecision(a, PANEL_FOCUS, runnable(a.id)) === 'pass' ? [] : (bindings[a.id] ?? [])))
}

/** The action a key handed over from a plugin panel is bound to now, or null. */
export function panelKeyAction(bindings: Bindings, chord: Chord, actions: readonly ActionSpec[]): ActionSpec | null {
  const same = (c: Chord): boolean =>
    c.code === chord.code && c.ctrl === chord.ctrl && c.shift === chord.shift && c.alt === chord.alt && c.meta === chord.meta
  return actions.find((a) => bindings[a.id]?.some(same)) ?? null
}
