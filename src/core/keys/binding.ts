/**
 * The shortcut registry and key matching.
 *
 * Rather than hardcoding the bindings into conditionals, they are gathered into a list of actions so the
 * user can change them in settings.
 *
 * Matching is **based on `e.code`**. `e.key` becomes a Hangul jamo while an IME is composing, and it splits
 * into 'e'/'E' depending on Shift, which makes the comparison fragile. `e.code` is the physical key, so both
 * problems disappear.
 *
 * The stored string and the displayed string are the same (`Ctrl+Shift+E`) — keybindings.json still reads
 * when a human opens it, and the settings screen and the docs can use the same notation.
 */

export type Chord = { ctrl: boolean; shift: boolean; alt: boolean; code: string }

export type ActionId =
  | 'explorer.toggleMode'
  | 'explorer.closeFileTab'
  | 'sessionTab.prev'
  | 'sessionTab.next'
  | 'pane.splitRight'
  | 'pane.splitDown'
  | 'pane.focusLeft'
  | 'pane.focusRight'
  | 'pane.focusUp'
  | 'pane.focusDown'

export type ActionSpec = {
  id: ActionId
  /** The default bindings. The order here is the display order */
  defaults: string[]
  /** The settings-screen wording (an i18n key) */
  descKey: string
  /**
   * Does this action yield while xterm has focus. It differs per action — closing a file tab (Ctrl+W) yields
   * because the terminal's 'delete previous word' takes priority, while the mode toggle is intercepted even
   * over the terminal. This rule has to travel with the action even when the user changes the key, so it
   * lives here rather than on the binding.
   */
  yieldsToTerminal: boolean
}

/** The actions the global capture handler deals with. FileExplorer (F2·Delete·Ctrl+A/X/C/V) and CodeMirror
 *  (Ctrl+S) are handled by a different mechanism, so they are not in this list — the settings screen shows
 *  them separately as fixed entries. */
export const ACTIONS: readonly ActionSpec[] = [
  {
    id: 'explorer.toggleMode',
    defaults: ['Ctrl+Tab', 'Ctrl+Shift+E'],
    descKey: 'shortcut.explorer.toggleMode',
    yieldsToTerminal: false
  },
  {
    id: 'explorer.closeFileTab',
    defaults: ['Ctrl+W'],
    descKey: 'shortcut.explorer.closeFileTab',
    yieldsToTerminal: true
  },
  {
    id: 'sessionTab.prev',
    defaults: ['Ctrl+PageUp'],
    descKey: 'shortcut.sessionTab.prev',
    yieldsToTerminal: false
  },
  {
    id: 'sessionTab.next',
    defaults: ['Ctrl+PageDown'],
    descKey: 'shortcut.sessionTab.next',
    yieldsToTerminal: false
  },
  {
    id: 'pane.splitRight',
    defaults: ['Ctrl+\\'],
    descKey: 'shortcut.pane.splitRight',
    yieldsToTerminal: false
  },
  {
    id: 'pane.splitDown',
    defaults: ['Ctrl+Shift+\\'],
    descKey: 'shortcut.pane.splitDown',
    yieldsToTerminal: false
  },
  {
    id: 'pane.focusLeft',
    defaults: ['Ctrl+Shift+←'],
    descKey: 'shortcut.pane.focusLeft',
    yieldsToTerminal: false
  },
  {
    id: 'pane.focusRight',
    defaults: ['Ctrl+Shift+→'],
    descKey: 'shortcut.pane.focusRight',
    yieldsToTerminal: false
  },
  {
    id: 'pane.focusUp',
    defaults: ['Ctrl+Shift+↑'],
    descKey: 'shortcut.pane.focusUp',
    yieldsToTerminal: false
  },
  {
    id: 'pane.focusDown',
    defaults: ['Ctrl+Shift+↓'],
    descKey: 'shortcut.pane.focusDown',
    yieldsToTerminal: false
  }
]

/** Display token ↔ KeyboardEvent.code. A key that is not here cannot be bound (deliberately). */
const NAMED_CODES: Record<string, string> = {
  Tab: 'Tab',
  Enter: 'Enter',
  Space: 'Space',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Escape: 'Escape',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '\\': 'Backslash',
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash'
}
const CODE_TO_TOKEN: Record<string, string> = Object.fromEntries(
  Object.entries(NAMED_CODES).map(([token, code]) => [code, token])
)

function tokenToCode(token: string): string | null {
  if (/^[A-Za-z]$/.test(token)) return `Key${token.toUpperCase()}`
  if (/^[0-9]$/.test(token)) return `Digit${token}`
  if (/^F([1-9]|1[0-2])$/.test(token)) return token
  return NAMED_CODES[token] ?? null
}

function codeToToken(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-2])$/.test(code)) return code
  return CODE_TO_TOKEN[code] ?? null
}

/** 'Ctrl+Shift+E' → chord. null for notation that cannot be read, or anything including Meta. */
export function parseChord(text: string): Chord | null {
  const parts = text.split('+').map((p) => p.trim())
  if (parts.length === 0 || parts.some((p) => p === '')) return null
  const keyToken = parts[parts.length - 1]
  const modifiers = parts.slice(0, -1).map((m) => m.toLowerCase())
  if (modifiers.some((m) => !['ctrl', 'shift', 'alt'].includes(m))) return null
  const code = tokenToCode(keyToken)
  if (!code) return null
  return {
    ctrl: modifiers.includes('ctrl'),
    shift: modifiers.includes('shift'),
    alt: modifiers.includes('alt'),
    code
  }
}

/** chord → 'Ctrl+Alt+Shift+E'. Normalizes the modifier order. */
export function formatChord(chord: Chord): string {
  const token = codeToToken(chord.code) ?? chord.code
  const parts: string[] = []
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(token)
  return parts.join('+')
}

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/

/** A key event into a chord. Modifier keys themselves and Meta combinations are not accepted. */
export function chordFromEvent(e: KeyboardEvent): Chord | null {
  if (e.metaKey) return null
  if (MODIFIER_CODES.test(e.code)) return null
  if (!codeToToken(e.code)) return null
  return { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, code: e.code }
}

export function matchesChord(chord: Chord, e: KeyboardEvent): boolean {
  return (
    !e.metaKey &&
    e.ctrlKey === chord.ctrl &&
    e.shiftKey === chord.shift &&
    e.altKey === chord.alt &&
    e.code === chord.code
  )
}

export type Bindings = Record<ActionId, Chord[]>

/** Overlays the user's settings onto the defaults. An empty array means 'off', and bindings that cannot be parsed and unknown actions are ignored. */
export function resolveBindings(overrides: Partial<Record<string, string[]>>): Bindings {
  const result = {} as Bindings
  for (const action of ACTIONS) {
    const override = overrides[action.id]
    const source = Array.isArray(override) ? override : action.defaults
    result[action.id] = source
      .map(parseChord)
      .filter((c): c is Chord => c !== null)
  }
  return result
}

export function findActionForEvent(bindings: Bindings, e: KeyboardEvent): ActionId | null {
  for (const action of ACTIONS) {
    if (bindings[action.id]?.some((chord) => matchesChord(chord, e))) return action.id
  }
  return null
}

/** Collects the cases where the same key is bound to two or more actions. */
export function findConflicts(bindings: Bindings): { key: string; actions: ActionId[] }[] {
  const byKey = new Map<string, ActionId[]>()
  for (const action of ACTIONS) {
    for (const chord of bindings[action.id] ?? []) {
      const key = formatChord(chord)
      byKey.set(key, [...(byKey.get(key) ?? []), action.id])
    }
  }
  return [...byKey.entries()]
    .filter(([, actions]) => actions.length > 1)
    .map(([key, actions]) => ({ key, actions }))
}

/**
 * Is this a key the CLI inside the terminal uses. If the app swallows it at the capture phase that feature
 * dies, so a warning is raised before saving.
 * It is not blocked — the user knows their own terminal habits (a deliberate decision).
 */
export function riskyReasonKey(chord: Chord): string | null {
  if (chord.code === 'Tab' && !chord.ctrl) return 'shortcut.risk.cliMode' // Tab·Shift+Tab
  if (!chord.ctrl || chord.alt) return null
  switch (chord.code) {
    case 'KeyC':
      return 'shortcut.risk.interrupt'
    case 'KeyD':
      return 'shortcut.risk.eof'
    case 'KeyA':
    case 'KeyE':
    case 'KeyK':
    case 'KeyU':
    case 'KeyW':
    case 'KeyB':
    case 'KeyF':
      return 'shortcut.risk.readline'
    case 'KeyR':
      return 'shortcut.risk.historySearch'
    case 'KeyL':
      return 'shortcut.risk.clear'
    case 'KeyJ':
      return 'shortcut.risk.newline'
    default:
      return null
  }
}
