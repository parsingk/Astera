import { describe, it, expect } from 'vitest'
import type { ActionId } from '../../../core/keys/binding'
import { focusKeepsKey, keyDecision, keyFocusOf, type KeyFocus } from './keyRouting'

const none: KeyFocus = { inXterm: false, inConversation: false, editable: false, inEditor: false }
const terminal: KeyFocus = { ...none, inXterm: true }
const field: KeyFocus = { ...none, editable: true }
const editor: KeyFocus = { ...none, editable: true, inEditor: true }
const composer: KeyFocus = { ...none, editable: true, inConversation: true }

describe('focusKeepsKey', () => {
  it('lets a terminal keep the key of an action that yields to it, whatever the action', () => {
    expect(focusKeepsKey('explorer.closeFileTab', terminal, true)).toBe(true)
    expect(focusKeepsKey('explorer.closeFileTab', terminal, false)).toBe(false)
    expect(focusKeepsKey('palette.open', terminal, false)).toBe(false)
  })

  it('lets a plain field keep the explorer toggle, but not the composer, a terminal or the editor', () => {
    expect(focusKeepsKey('explorer.toggleMode', field, false)).toBe(true)
    expect(focusKeepsKey('explorer.toggleMode', composer, false)).toBe(false)
    expect(focusKeepsKey('explorer.toggleMode', terminal, false)).toBe(false)
    expect(focusKeepsKey('explorer.toggleMode', editor, false)).toBe(false)
  })

  it('lets a field keep pane focus and tab cycling, except the composer, and tab cycling in the editor', () => {
    for (const a of ['pane.focusLeft', 'pane.focusRight', 'pane.focusUp', 'pane.focusDown'] as const) {
      expect(focusKeepsKey(a, field, false), a).toBe(true)
      expect(focusKeepsKey(a, editor, false), a).toBe(true) // the editor's own Ctrl+Shift+arrow selection
      expect(focusKeepsKey(a, composer, false), a).toBe(false)
      expect(focusKeepsKey(a, terminal, false), a).toBe(false)
    }
    for (const a of ['sessionTab.prev', 'sessionTab.next'] as const) {
      expect(focusKeepsKey(a, field, false), a).toBe(true)
      expect(focusKeepsKey(a, editor, false), a).toBe(false)
      expect(focusKeepsKey(a, composer, false), a).toBe(false)
    }
  })

  it('never lets a field keep the sidebar, run, split or button actions', () => {
    for (const a of ['sidebar.jobs', 'run.run', 'pane.splitRight', 'explorer.cyclePreview', 'session.new', 'job.new', 'kube.open', 'palette.open'] as const) {
      expect(focusKeepsKey(a, field, false), a).toBe(false)
      expect(focusKeepsKey(a, none, false), a).toBe(false)
    }
  })
})

describe('keyFocusOf', () => {
  const el = (tagName: string, inside: string[] = [], isContentEditable = false): Element =>
    ({ tagName, isContentEditable, closest: (sel: string) => (sel.split(',').some((s) => inside.includes(s.trim())) ? {} : null) }) as unknown as Element

  it('reads nothing from no focused element', () => {
    expect(keyFocusOf(null)).toEqual(none)
  })

  it('reads a terminal, the composer and the editor from where the element sits', () => {
    expect(keyFocusOf(el('TEXTAREA', ['.xterm']))).toEqual({ ...none, inXterm: true, editable: true })
    expect(keyFocusOf(el('TEXTAREA', ['[data-slot="conversation-pane"]']))).toEqual(composer)
    expect(keyFocusOf(el('DIV', ['.cm-editor'], true))).toEqual(editor)
  })

  it('counts inputs, selects and contenteditable as editable', () => {
    expect(keyFocusOf(el('INPUT')).editable).toBe(true)
    expect(keyFocusOf(el('SELECT')).editable).toBe(true)
    expect(keyFocusOf(el('DIV', [], true)).editable).toBe(true)
    expect(keyFocusOf(el('BUTTON')).editable).toBe(false)
  })
})

describe('keyDecision', () => {
  const spec = (id: ActionId, swallowsWhenBlocked = false, yieldsToTerminal = false) => ({ id, swallowsWhenBlocked, yieldsToTerminal })

  // Review focus 1: Ctrl+Shift+Down in a terminal with no pane below reaches the terminal.
  it('passes the key on when the action has nothing to do and does not keep its key', () => {
    expect(keyDecision(spec('pane.focusDown'), terminal, false)).toBe('pass')
    expect(keyDecision(spec('explorer.closeFileTab'), none, false)).toBe('pass')
  })

  // Review focus 5: the run chords with nothing to run are still taken.
  it('swallows the key of a blocked action that keeps its key', () => {
    expect(keyDecision(spec('run.run', true), terminal, false)).toBe('swallow')
    expect(keyDecision(spec('pane.splitRight', true), none, false)).toBe('swallow')
  })

  it('runs an action that can run, unless focus keeps the key', () => {
    expect(keyDecision(spec('sidebar.jobs'), terminal, true)).toBe('run')
    expect(keyDecision(spec('explorer.closeFileTab', false, true), terminal, true)).toBe('pass')
    expect(keyDecision(spec('explorer.toggleMode'), field, true)).toBe('pass')
  })
})
