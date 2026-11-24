// Which key presses the app leaves to the element that has focus. These are the rules the global keydown listener
// applied branch by branch before the action registry (ADR-007); they are about where focus is, not about whether
// the action can run, so they stay with the listener while the actions themselves moved to the registry.

import type { ActionId } from '../../../core/keys/binding'

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
