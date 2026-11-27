import { describe, it, expect } from 'vitest'
import { formatChord, makeActions, resolveBindings, type ActionId } from '../../../core/keys/binding'
import { PANEL_FOCUS, focusKeepsKey, keyDecision, keyFocusOf, panelChords, panelKeyAction, type KeyFocus } from './keyRouting'

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

// Test matrix T17, finding A1: main takes the app's keys from a plugin panel's page before the page sees them, and the
// renderer says which. The page is another renderer the app cannot look into, so its focus counts as a text field.
describe('panelChords', () => {
  const actions = makeActions('win32')
  const all = (): boolean => true
  const keys = (overrides: Record<string, string[]>, runnable: (id: ActionId) => boolean = all) =>
    panelChords(resolveBindings(overrides, actions), actions, runnable).map(formatChord)

  it('hands the app the keys it takes from a text field, and leaves the page the ones a field keeps', () => {
    const k = keys({})
    expect(k).toContain('Ctrl+Shift+P')
    expect(k).toContain('Ctrl+W')
    expect(k).toContain('Ctrl+Shift+A')
    // A field keeps the explorer toggle, tab cycling and pane focus (Ctrl+Shift+arrow selects by word there)
    expect(k).not.toContain('Ctrl+Shift+E')
    expect(k).not.toContain('Ctrl+Tab')
    expect(k).not.toContain('Ctrl+PageDown')
    expect(k).not.toContain(formatChord(resolveBindings({}, actions)['pane.focusLeft'][0]))
  })

  it('leaves the page the key of an action with nothing to do, unless the action keeps its key anyway', () => {
    const k = keys({}, (id) => id !== 'explorer.cyclePreview' && id !== 'run.run')
    // Ctrl+Shift+V is the page's paste without formatting while no preview can cycle
    expect(k).not.toContain('Ctrl+Shift+V')
    // Shift+F10 is kept with nothing to run, as everywhere else in the app
    expect(k).toContain('Shift+F10')
  })

  // The window's listener runs the first action a key is bound to (findActionForEvent); a key bound to two by hand is
  // decided by that first action here too, or the page would lose it with nothing run
  it('decides a key bound to two actions by the first, as the window does', () => {
    const k = keys({ 'explorer.cyclePreview': ['Ctrl+Shift+J'] }, (id) => id !== 'explorer.cyclePreview')
    expect(k).not.toContain('Ctrl+Shift+J')
  })

  it('asks only the actions that have a key whether they can run', () => {
    const asked: ActionId[] = []
    panelChords(resolveBindings({}, actions), actions, (id) => (asked.push(id), true))
    expect(asked).toContain('palette.open')
    expect(asked).not.toContain('session.new')
  })

  it('follows a key the person rebound and an action they turned off', () => {
    const k = keys({ 'palette.open': ['Ctrl+Alt+K'], 'explorer.closeFileTab': [] })
    expect(k).toContain('Ctrl+Alt+K')
    expect(k).not.toContain('Ctrl+Shift+P')
    expect(k).not.toContain('Ctrl+W')
  })
})

describe('panelKeyAction', () => {
  const actions = makeActions('win32')
  const bindings = resolveBindings({ 'palette.open': ['Ctrl+Alt+K'] }, actions)
  const chord = (ctrl: boolean, shift: boolean, alt: boolean, code: string) => ({ ctrl, shift, alt, meta: false, code })

  it('finds the action a key handed over from a panel is bound to, and runs it as from a text field', () => {
    const spec = panelKeyAction(bindings, chord(true, false, true, 'KeyK'), actions)
    expect(spec?.id).toBe('palette.open')
    expect(keyDecision(spec!, PANEL_FOCUS, true)).toBe('run')
    expect(panelKeyAction(bindings, chord(true, false, false, 'KeyW'), actions)?.id).toBe('explorer.closeFileTab')
  })

  it('finds nothing for a key no action is bound to now', () => {
    expect(panelKeyAction(bindings, chord(true, true, false, 'KeyP'), actions)).toBeNull()
    expect(panelKeyAction(bindings, { ...chord(true, false, true, 'KeyK'), meta: true }, actions)).toBeNull()
    expect(panelKeyAction(bindings, chord(false, false, true, 'KeyK'), actions)).toBeNull()
    expect(panelKeyAction(bindings, chord(true, false, false, 'KeyK'), actions)).toBeNull()
  })
})
