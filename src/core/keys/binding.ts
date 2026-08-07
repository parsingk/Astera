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
 * macOS 에서는 주 수식어가 Cmd 다 (makeActions 참고). 저장 표기도 그대로 `Cmd+W` 형태다.
 */

export type Chord = { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; code: string }

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

/**
 * 플랫폼별 액션 목록.
 *
 * **왜 상수가 아니라 팩토리인가:** macOS 는 앱 단축키에 Cmd 를 쓴다. 그냥 취향이 아니라, 이 앱의
 * 주 화면이 터미널이기 때문이다 — Ctrl 조합은 xterm 을 거쳐 셸(readline, claude 자신)로 가야 하고,
 * 앱이 캡처 단계에서 삼키면 그 기능이 죽는다. 반대로 Cmd 는 셸이 쓰지 않으므로 안전하게 앱 것이다.
 *
 * yieldsToTerminal 도 같은 이유로 플랫폼마다 다르다. win32 에서 Ctrl+W 가 양보하는 것은 터미널의
 * '앞 단어 삭제'가 우선이기 때문인데, Cmd+W 에는 경쟁자가 없으므로 양보할 이유가 없다.
 */
export function makeActions(platform: string): readonly ActionSpec[] {
  const mac = platform === 'darwin'
  /** 앱 단축키의 주 수식어. mac=Cmd, 그 외=Ctrl */
  const M = mac ? 'Cmd' : 'Ctrl'
  return [
    {
      id: 'explorer.toggleMode',
      defaults: [`${M}+Tab`, `${M}+Shift+E`],
      descKey: 'shortcut.explorer.toggleMode',
      yieldsToTerminal: false
    },
    {
      id: 'explorer.closeFileTab',
      defaults: [`${M}+W`],
      descKey: 'shortcut.explorer.closeFileTab',
      // win32 의 Ctrl+W 는 터미널의 '앞 단어 삭제'에 양보한다. mac 의 Cmd+W 는 경쟁자가 없다.
      yieldsToTerminal: !mac
    },
    {
      id: 'sessionTab.prev',
      defaults: [`${M}+PageUp`],
      descKey: 'shortcut.sessionTab.prev',
      yieldsToTerminal: false
    },
    {
      id: 'sessionTab.next',
      defaults: [`${M}+PageDown`],
      descKey: 'shortcut.sessionTab.next',
      yieldsToTerminal: false
    },
    {
      id: 'pane.splitRight',
      defaults: [`${M}+\\`],
      descKey: 'shortcut.pane.splitRight',
      yieldsToTerminal: false
    },
    {
      id: 'pane.splitDown',
      defaults: [`${M}+Shift+\\`],
      descKey: 'shortcut.pane.splitDown',
      yieldsToTerminal: false
    },
    {
      id: 'pane.focusLeft',
      defaults: [`${M}+Shift+←`],
      descKey: 'shortcut.pane.focusLeft',
      yieldsToTerminal: false
    },
    {
      id: 'pane.focusRight',
      defaults: [`${M}+Shift+→`],
      descKey: 'shortcut.pane.focusRight',
      yieldsToTerminal: false
    },
    {
      id: 'pane.focusUp',
      defaults: [`${M}+Shift+↑`],
      descKey: 'shortcut.pane.focusUp',
      yieldsToTerminal: false
    },
    {
      id: 'pane.focusDown',
      defaults: [`${M}+Shift+↓`],
      descKey: 'shortcut.pane.focusDown',
      yieldsToTerminal: false
    }
  ]
}

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

/** 'Ctrl+Shift+E' → chord. 읽을 수 없는 표기는 null. */
export function parseChord(text: string): Chord | null {
  const parts = text.split('+').map((p) => p.trim())
  if (parts.length === 0 || parts.some((p) => p === '')) return null
  const keyToken = parts[parts.length - 1]
  const modifiers = parts.slice(0, -1).map((m) => m.toLowerCase())
  if (modifiers.some((m) => !['ctrl', 'cmd', 'shift', 'alt'].includes(m))) return null
  const code = tokenToCode(keyToken)
  if (!code) return null
  return {
    ctrl: modifiers.includes('ctrl'),
    shift: modifiers.includes('shift'),
    alt: modifiers.includes('alt'),
    meta: modifiers.includes('cmd'),
    code
  }
}

/** chord → 'Ctrl+Cmd+Alt+Shift+E'. 수식어 순서를 정규화한다. */
export function formatChord(chord: Chord): string {
  const token = codeToToken(chord.code) ?? chord.code
  const parts: string[] = []
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.meta) parts.push('Cmd')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(token)
  return parts.join('+')
}

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/

/** 키 이벤트를 chord 로. 수식어 키 자체는 받지 않는다.
 *  (Meta 를 거부하던 규칙은 macOS 지원과 함께 사라졌다 — 거기서는 Cmd 가 주 수식어다.) */
export function chordFromEvent(e: KeyboardEvent): Chord | null {
  if (MODIFIER_CODES.test(e.code)) return null
  if (!codeToToken(e.code)) return null
  return { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, code: e.code }
}

export function matchesChord(chord: Chord, e: KeyboardEvent): boolean {
  return (
    e.ctrlKey === chord.ctrl &&
    e.metaKey === chord.meta &&
    e.shiftKey === chord.shift &&
    e.altKey === chord.alt &&
    e.code === chord.code
  )
}

export type Bindings = Record<ActionId, Chord[]>

/** 사용자 설정을 기본값 위에 덮는다. 빈 배열은 '끔', 읽을 수 없는 바인딩과 모르는 액션은 무시한다. */
export function resolveBindings(
  overrides: Partial<Record<string, string[]>>,
  actions: readonly ActionSpec[]
): Bindings {
  const result = {} as Bindings
  for (const action of actions) {
    const override = overrides[action.id]
    const source = Array.isArray(override) ? override : action.defaults
    result[action.id] = source.map(parseChord).filter((c): c is Chord => c !== null)
  }
  return result
}

export function findActionForEvent(
  bindings: Bindings,
  e: KeyboardEvent,
  actions: readonly ActionSpec[]
): ActionId | null {
  for (const action of actions) {
    if (bindings[action.id]?.some((chord) => matchesChord(chord, e))) return action.id
  }
  return null
}

/** 같은 키가 둘 이상의 액션에 걸린 경우를 모은다. */
export function findConflicts(
  bindings: Bindings,
  actions: readonly ActionSpec[]
): { key: string; actions: ActionId[] }[] {
  const byKey = new Map<string, ActionId[]>()
  for (const action of actions) {
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
 * 터미널 안의 CLI 가 쓰는 키인가. 앱이 캡처 단계에서 삼키면 그 기능이 죽으므로 저장 전에 경고한다.
 * 막지는 않는다 — 자기 터미널 습관은 사용자가 안다 (의도된 결정).
 * mac 의 Cmd 조합은 chord.ctrl 이 false 라 자동으로 통과한다. 셸은 Cmd 를 쓰지 않는다.
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
