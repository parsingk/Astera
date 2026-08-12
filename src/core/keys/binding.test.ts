import { describe, it, expect } from 'vitest'
import {
  chordFromEvent,
  findActionForEvent,
  findConflicts,
  formatChord,
  matchesChord,
  parseChord,
  makeActions,
  resolveBindings,
  riskyReasonKey
} from './binding'

// binding.ts exposes makeActions(platform) rather than a ready-made list precisely so a test can pin the
// platform (see the note in renderer/src/lib/actions.ts) — the defaults differ per OS, and asserting on
// whatever the host happens to be would make this file pass or fail by machine.
const ACTIONS = makeActions('win32')

const ev = (over: Partial<KeyboardEvent> & { code: string }): KeyboardEvent =>
  ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...over }) as KeyboardEvent

describe('parseChord / formatChord — 저장 문자열과 표시 문자열은 같다', () => {
  it('문자 키', () => {
    expect(parseChord('Ctrl+Shift+E')).toEqual({ ctrl: true, shift: true, alt: false, meta: false, code: 'KeyE' })
    expect(formatChord({ ctrl: true, shift: true, alt: false, meta: false, code: 'KeyE' })).toBe('Ctrl+Shift+E')
  })

  it('이름 있는 키', () => {
    expect(parseChord('Ctrl+Tab')?.code).toBe('Tab')
    expect(parseChord('Ctrl+PageUp')?.code).toBe('PageUp')
    expect(parseChord('F2')).toEqual({ ctrl: false, shift: false, alt: false, meta: false, code: 'F2' })
    expect(formatChord({ ctrl: false, shift: false, alt: false, meta: false, code: 'Delete' })).toBe('Delete')
  })

  it('기호·화살표', () => {
    expect(parseChord('Ctrl+\\')?.code).toBe('Backslash')
    expect(formatChord({ ctrl: true, shift: true, alt: false, meta: false, code: 'Backslash' })).toBe('Ctrl+Shift+\\')
    expect(parseChord('Ctrl+Shift+←')?.code).toBe('ArrowLeft')
    expect(formatChord({ ctrl: true, shift: true, alt: false, meta: false, code: 'ArrowDown' })).toBe('Ctrl+Shift+↓')
  })

  it('수식자 순서는 Ctrl+Alt+Shift로 정규화된다', () => {
    expect(formatChord({ ctrl: true, shift: true, alt: true, meta: false, code: 'KeyE' })).toBe('Ctrl+Alt+Shift+E')
    expect(parseChord('Shift+Ctrl+E')).toEqual(parseChord('Ctrl+Shift+E'))
  })

  it('알 수 없는 표기는 null', () => {
    expect(parseChord('')).toBeNull()
    expect(parseChord('Ctrl+')).toBeNull()
    expect(parseChord('Ctrl+Meta+E')).toBeNull()
    expect(parseChord('Ctrl+없는키')).toBeNull()
  })

  it('모든 기본 바인딩은 왕복이 된다', () => {
    for (const action of ACTIONS) {
      for (const key of action.defaults) {
        const chord = parseChord(key)
        expect(chord, `${action.id}: ${key}`).not.toBeNull()
        expect(formatChord(chord!)).toBe(key)
      }
    }
  })
})

describe('chordFromEvent / matchesChord — e.code 기준', () => {
  it('IME로 e.key가 한글이어도 e.code로 맞춘다 — 지금 코드의 취약점', () => {
    const korean = ev({ code: 'KeyE', ctrlKey: true, shiftKey: true, key: 'ㄷ' } as never)
    expect(matchesChord(parseChord('Ctrl+Shift+E')!, korean)).toBe(true)
  })

  it('수식자가 다르면 맞지 않는다', () => {
    const chord = parseChord('Ctrl+Tab')!
    expect(matchesChord(chord, ev({ code: 'Tab', ctrlKey: true }))).toBe(true)
    expect(matchesChord(chord, ev({ code: 'Tab', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(matchesChord(chord, ev({ code: 'Tab' }))).toBe(false)
  })

  it('Meta(⌘)도 수식자로 받는다 — macOS에서는 Cmd가 주 수식자다', () => {
    // Meta를 거부하던 규칙은 macOS 지원과 함께 사라졌다(chordFromEvent 주석 참고).
    // 저장 문자열의 토큰은 'Cmd'이고 'Meta'는 아니다 — 아래 '알 수 없는 표기는 null'이 그것을 고정한다
    expect(chordFromEvent(ev({ code: 'KeyE', metaKey: true }))).toEqual({
      ctrl: false,
      shift: false,
      alt: false,
      meta: true,
      code: 'KeyE'
    })
    expect(formatChord(parseChord('Cmd+Shift+E')!)).toBe('Cmd+Shift+E')
  })

  it('수식자 키 자체는 chord가 아니다', () => {
    expect(chordFromEvent(ev({ code: 'ControlLeft', ctrlKey: true }))).toBeNull()
    expect(chordFromEvent(ev({ code: 'ShiftRight', shiftKey: true }))).toBeNull()
  })

  it('수식자 없는 단일 키도 chord다 (F2·Delete)', () => {
    expect(chordFromEvent(ev({ code: 'F2' }))).toEqual({
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
      code: 'F2'
    })
  })
})

describe('resolveBindings — 기본값에 사용자 설정을 덮어쓴다', () => {
  it('설정이 없으면 기본값 그대로', () => {
    const resolved = resolveBindings({}, ACTIONS)
    expect(resolved['explorer.toggleMode'].map(formatChord)).toEqual(['Ctrl+Shift+E'])
    // 탭 순환이 Ctrl+Tab을 가져갔다 — 탭 줄이 세션과 파일을 함께 담게 되면서 가장 잦은 동작이 되었다
    expect(resolved['sessionTab.next'].map(formatChord)).toEqual(['Ctrl+Tab', 'Ctrl+PageDown'])
    expect(resolved['sessionTab.prev'].map(formatChord)).toEqual(['Ctrl+Shift+Tab', 'Ctrl+PageUp'])
  })

  it('해당 액션만 갈아끼운다', () => {
    const resolved = resolveBindings({ 'explorer.toggleMode': ['Ctrl+`'] }, ACTIONS)
    expect(resolved['explorer.toggleMode'].map(formatChord)).toEqual(['Ctrl+`'])
    expect(resolved['sessionTab.next'].map(formatChord)).toEqual(['Ctrl+Tab', 'Ctrl+PageDown'])
  })

  it('빈 배열은 그 액션을 끈다 — 기본값으로 되돌아가지 않는다', () => {
    expect(resolveBindings({ 'explorer.toggleMode': [] }, ACTIONS)['explorer.toggleMode']).toEqual([])
  })

  it('알 수 없는 액션 id와 파싱 불가 문자열은 무시한다', () => {
    const resolved = resolveBindings(
      {
        'nope.action': ['Ctrl+Q'],
        'explorer.toggleMode': ['Ctrl+없는키', 'Ctrl+`']
      } as never,
      ACTIONS
    )
    expect(resolved['explorer.toggleMode'].map(formatChord)).toEqual(['Ctrl+`'])
  })
})

describe('findActionForEvent', () => {
  const bindings = resolveBindings({}, ACTIONS)

  it('기본 바인딩을 찾는다', () => {
    expect(findActionForEvent(bindings, ev({ code: 'Tab', ctrlKey: true }), ACTIONS)).toBe(
      'sessionTab.next'
    )
    expect(
      findActionForEvent(bindings, ev({ code: 'Tab', ctrlKey: true, shiftKey: true }), ACTIONS)
    ).toBe('sessionTab.prev')
    expect(findActionForEvent(bindings, ev({ code: 'KeyE', ctrlKey: true, shiftKey: true }), ACTIONS)).toBe(
      'explorer.toggleMode'
    )
    expect(findActionForEvent(bindings, ev({ code: 'PageUp', ctrlKey: true }), ACTIONS)).toBe(
      'sessionTab.prev'
    )
  })

  it('바인딩이 없으면 null', () => {
    expect(findActionForEvent(bindings, ev({ code: 'KeyQ', ctrlKey: true }), ACTIONS)).toBeNull()
  })
})

describe('findConflicts — 같은 키가 두 액션에 걸리면', () => {
  it('충돌이 없으면 빈 배열', () => {
    expect(findConflicts(resolveBindings({}, ACTIONS), ACTIONS)).toEqual([])
  })

  it('중복 키를 액션과 함께 보고한다', () => {
    const conflicts = findConflicts(
      resolveBindings({ 'explorer.toggleMode': ['Ctrl+Tab'] }, ACTIONS),
      ACTIONS
    )
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].key).toBe('Ctrl+Tab')
    expect(conflicts[0].actions.sort()).toEqual(['explorer.toggleMode', 'sessionTab.next'])
  })
})

describe('riskyReasonKey — 터미널에서 쓰이는 키 경고', () => {
  it('CLI가 쓰는 키는 사유 키를 돌려준다', () => {
    expect(riskyReasonKey(parseChord('Ctrl+C')!)).toBe('shortcut.risk.interrupt')
    expect(riskyReasonKey(parseChord('Ctrl+D')!)).toBe('shortcut.risk.eof')
    expect(riskyReasonKey(parseChord('Ctrl+E')!)).toBe('shortcut.risk.readline')
    expect(riskyReasonKey(parseChord('Shift+Tab')!)).toBe('shortcut.risk.cliMode')
  })

  it('무해한 키는 null', () => {
    expect(riskyReasonKey(parseChord('Ctrl+PageUp')!)).toBeNull()
    expect(riskyReasonKey(parseChord('F4')!)).toBeNull()
    expect(riskyReasonKey(parseChord('Ctrl+`')!)).toBeNull()
  })
})
