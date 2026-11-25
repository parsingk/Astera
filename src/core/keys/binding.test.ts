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
import { CATALOGS } from '../i18n'

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

describe('makeActions — yieldsToTerminal', () => {
  // Ctrl+Shift+V(mac: Cmd+Shift+V)는 터미널의 붙여넣기(TerminalView.tsx)와 같은 조합이다 —
  // TerminalView 의 붙여넣기 매칭이 v/V·clipMod 만 보고 shiftKey 를 확인하지 않아서다(복사 쪽
  // 매칭과 다르다). App.tsx 의 전역 keydown 리스너는 capture:true 로 등록되어 있어 yieldsToTerminal
  // 이 거짓이면 e.stopPropagation() 이 xterm 에 닿기 전에 이벤트를 삼켜, 터미널의 붙여넣기가
  // 동작하지 않게 된다 — 그래서 참이어야 한다.
  it('explorer.cyclePreview 는 터미널에 양보한다 — Ctrl+Shift+V 가 터미널 붙여넣기와 겹친다', () => {
    const spec = ACTIONS.find((a) => a.id === 'explorer.cyclePreview')
    expect(spec?.yieldsToTerminal).toBe(true)
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
    expect(
      findActionForEvent(bindings, ev({ code: 'KeyV', ctrlKey: true, shiftKey: true }), ACTIONS)
    ).toBe('explorer.cyclePreview')
  })

  it('바인딩이 없으면 null', () => {
    expect(findActionForEvent(bindings, ev({ code: 'KeyQ', ctrlKey: true }), ACTIONS)).toBeNull()
  })
})

describe('findConflicts — 같은 키가 두 액션에 걸리면', () => {
  it('기본 바인딩끼리는 충돌하지 않는다', () => {
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

  // 셸의 이전·다음 명령 키. 빠른 열기의 Ctrl+P 는 터미널에 양보하지만, 다른 동작을 이 키에 묶으면 경고해야 한다
  it('Ctrl+P·Ctrl+N 도 줄 편집 키로 경고한다', () => {
    expect(riskyReasonKey(parseChord('Ctrl+P')!)).toBe('shortcut.risk.readline')
    expect(riskyReasonKey(parseChord('Ctrl+N')!)).toBe('shortcut.risk.readline')
  })

  it('무해한 키는 null', () => {
    expect(riskyReasonKey(parseChord('Ctrl+PageUp')!)).toBeNull()
    expect(riskyReasonKey(parseChord('F4')!)).toBeNull()
    expect(riskyReasonKey(parseChord('Ctrl+`')!)).toBeNull()
  })
})

// The two sidebar views the rail can open. Nothing but the rail button reached them before, so a
// keyboard user had to leave the keyboard to switch between Jobs, How It Works and the file tree.
describe('sidebar view actions', () => {
  const mac = makeActions('darwin')

  it('both views are bindable actions', () => {
    expect(ACTIONS.map((a) => a.id)).toEqual(
      expect.arrayContaining(['sidebar.home', 'sidebar.jobs', 'sidebar.howItWorks'])
    )
  })

  it('defaults follow the Ctrl+Shift+<letter> family the sidebar already uses', () => {
    expect(ACTIONS.find((a) => a.id === 'sidebar.home')?.defaults).toEqual(['Ctrl+Shift+A'])
    expect(ACTIONS.find((a) => a.id === 'sidebar.jobs')?.defaults).toEqual(['Ctrl+Shift+J'])
    expect(ACTIONS.find((a) => a.id === 'sidebar.howItWorks')?.defaults).toEqual(['Ctrl+Shift+H'])
  })

  // Cmd rather than Ctrl on mac, for the reason makeActions gives: Ctrl combos have to reach the
  // shell through xterm, Cmd never does
  it('mac binds them to Cmd', () => {
    expect(mac.find((a) => a.id === 'sidebar.home')?.defaults).toEqual(['Cmd+Shift+A'])
    expect(mac.find((a) => a.id === 'sidebar.jobs')?.defaults).toEqual(['Cmd+Shift+J'])
    expect(mac.find((a) => a.id === 'sidebar.howItWorks')?.defaults).toEqual(['Cmd+Shift+H'])
  })

  // Opening a sidebar view competes with nothing a shell reads, the same judgement
  // explorer.toggleMode makes for Ctrl+Shift+E
  it('they do not yield to the terminal', () => {
    for (const id of ['sidebar.home', 'sidebar.jobs', 'sidebar.howItWorks'] as const)
      expect(ACTIONS.find((a) => a.id === id)?.yieldsToTerminal).toBe(false)
  })

  it('the events reach them', () => {
    const bindings = resolveBindings({}, ACTIONS)
    expect(
      findActionForEvent(bindings, ev({ code: 'KeyA', ctrlKey: true, shiftKey: true }), ACTIONS)
    ).toBe('sidebar.home')
    expect(
      findActionForEvent(bindings, ev({ code: 'KeyJ', ctrlKey: true, shiftKey: true }), ACTIONS)
    ).toBe('sidebar.jobs')
    expect(
      findActionForEvent(bindings, ev({ code: 'KeyH', ctrlKey: true, shiftKey: true }), ACTIONS)
    ).toBe('sidebar.howItWorks')
  })

  // The defaults-do-not-conflict test above covers win32; mac has its own set of defaults and
  // nothing else asserts on them
  it('mac defaults do not conflict either', () => {
    expect(findConflicts(resolveBindings({}, mac), mac)).toEqual([])
  })
})

describe('run shortcuts', () => {
  const RUN_IDS = ['run.run', 'run.stop', 'run.rerun', 'run.selectConfig'] as const

  it.each(['win32', 'darwin', 'linux'])('exist with defaults on %s', (platform) => {
    const actions = makeActions(platform)
    for (const id of RUN_IDS) {
      const a = actions.find((x) => x.id === id)
      expect(a, id).toBeDefined()
      expect(a!.defaults.length, id).toBeGreaterThan(0)
    }
  })

  // F-key combinations, not Ctrl+letter: this app's main screen is a terminal, and a run shortcut has
  // to work while it has focus. IntelliJ's macOS default for Run — Ctrl+R — is the terminal's
  // reverse-history search, so it is deliberately not used.
  it('binds the same keys on every platform', () => {
    const win = makeActions('win32')
    const mac = makeActions('darwin')
    for (const id of RUN_IDS) {
      expect(mac.find((a) => a.id === id)!.defaults, id).toEqual(win.find((a) => a.id === id)!.defaults)
    }
  })

  it('never yields to the terminal', () => {
    for (const a of makeActions('win32').filter((x) => RUN_IDS.includes(x.id as typeof RUN_IDS[number]))) {
      expect(a.yieldsToTerminal, a.id).toBe(false)
    }
  })
})

describe('actions with no default key, and the palette', () => {
  it('new session, new Job and Kubernetes are actions with no default key', () => {
    for (const platform of ['win32', 'darwin']) {
      const actions = makeActions(platform)
      for (const id of ['session.new', 'job.new', 'kube.open', 'context.attachSelection']) {
        const a = actions.find((x) => x.id === id)
        expect(a, `${platform} ${id}`).toBeDefined()
        expect(a!.defaults, `${platform} ${id}`).toEqual([])
      }
    }
  })

  // Ctrl+Shift+P is what every editor with a palette binds; Astera binds nothing to it, and the shell's
  // previous-history key is Ctrl+P without Shift.
  it('opens the palette with Ctrl+Shift+P, Cmd+Shift+P on macOS, over a focused terminal too', () => {
    const win = makeActions('win32').find((a) => a.id === 'palette.open')!
    const mac = makeActions('darwin').find((a) => a.id === 'palette.open')!
    expect(win.defaults).toEqual(['Ctrl+Shift+P'])
    expect(mac.defaults).toEqual(['Cmd+Shift+P'])
    expect(win.yieldsToTerminal).toBe(false)
  })

  // Ctrl+P is the shell's previous-history key, so with a terminal focused it stays the shell's on Windows and Linux.
  // Cmd+P has no competitor in a terminal.
  it('goes to a file with Ctrl+P, Cmd+P on macOS, and leaves Ctrl+P to a focused terminal', () => {
    for (const platform of ['win32', 'linux']) {
      const a = makeActions(platform).find((x) => x.id === 'file.quickOpen')
      expect(a?.defaults, platform).toEqual(['Ctrl+P'])
      expect(a?.yieldsToTerminal, platform).toBe(true)
      expect(a?.swallowsWhenBlocked, platform).toBe(false)
    }
    const mac = makeActions('darwin').find((x) => x.id === 'file.quickOpen')
    expect(mac?.defaults).toEqual(['Cmd+P'])
    expect(mac?.yieldsToTerminal).toBe(false)
  })

  // What every editor binds to finding in files. Nothing in Astera takes it: the find bars are Ctrl+F without Shift, and
  // so is the shell's forward-char, which a focused terminal keeps.
  it('finds in files with Ctrl+Shift+F, Cmd+Shift+F on macOS, over a focused terminal too', () => {
    for (const platform of ['win32', 'linux']) {
      const a = makeActions(platform).find((x) => x.id === 'search.text')
      expect(a?.defaults, platform).toEqual(['Ctrl+Shift+F'])
      expect(a?.yieldsToTerminal, platform).toBe(false)
      expect(a?.swallowsWhenBlocked, platform).toBe(false)
    }
    expect(makeActions('darwin').find((x) => x.id === 'search.text')?.defaults).toEqual(['Cmd+Shift+F'])
  })

  // VS Code's key for its Problems panel. Nothing in Astera takes it, and the shell sees Ctrl+M (Enter) only without Shift.
  it('shows problems with Ctrl+Shift+M, Cmd+Shift+M on macOS, over a focused terminal too', () => {
    const win = makeActions('win32').find((a) => a.id === 'problems.open')
    expect(win?.defaults).toEqual(['Ctrl+Shift+M'])
    expect(win?.yieldsToTerminal).toBe(false)
    expect(makeActions('darwin').find((a) => a.id === 'problems.open')?.defaults).toEqual(['Cmd+Shift+M'])
  })

  // Spec W3: the layout presets are palette actions; none takes a key until the person gives it one
  it('lists the layout presets with no default key', () => {
    const ids = ['layout.coding', 'layout.review', 'layout.agents', 'layout.devops', 'layout.reset', 'layout.presets']
    for (const platform of ['win32', 'darwin']) {
      const actions = makeActions(platform)
      for (const id of ids) {
        const a = actions.find((x) => x.id === id)
        expect(a, `${platform} ${id}`).toMatchObject({ defaults: [], descKey: `shortcut.${id}`, yieldsToTerminal: false })
      }
    }
  })

  it('no two actions share a default key, on any platform', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      const actions = makeActions(platform)
      expect(findConflicts(resolveBindings({}, actions), actions), platform).toEqual([])
    }
  })

  // A blocked action normally lets its key go on to whatever has focus. These two families keep it: an
  // unclaimed F-key reaches a terminal as an escape sequence, and Ctrl+\ is SIGQUIT there.
  it('keeps the key for a blocked action only for the run and split chords', () => {
    const swallowing = makeActions('win32').filter((a) => a.swallowsWhenBlocked).map((a) => a.id)
    expect(swallowing.sort()).toEqual(
      ['pane.splitDown', 'pane.splitRight', 'run.rerun', 'run.run', 'run.selectConfig', 'run.stop'].sort()
    )
  })
})

describe('action wording', () => {
  it('every action and every blocked reason is worded in every language', () => {
    const keys = [
      ...makeActions('win32').map((a) => a.descKey),
      'action.blocked.noHandler',
      'action.blocked.noProject',
      'action.blocked.noRunConfig',
      'action.blocked.nothingRunning',
      'action.blocked.noSelectedRun',
      'action.blocked.noTarget',
      'action.blocked.noClosableTab',
      'action.blocked.notMarkdown',
      'action.blocked.noCli',
      'action.blocked.noLocalCli',
      'action.blocked.noKubectl',
      'action.blocked.noSelection',
      'quickOpen.placeholder',
      'quickOpen.empty',
      'quickOpen.indexing',
      'quickOpen.unavailable',
      'textSearch.hint',
      'textSearch.searching',
      'textSearch.empty',
      'textSearch.scope',
      'textSearch.truncated',
      'textSearch.fileCut',
      'textSearch.tooLong'
    ]
    for (const [lang, { messages: catalog }] of Object.entries(CATALOGS)) {
      for (const key of keys) expect((catalog as Record<string, string | undefined>)[key], `${lang} ${key}`).toBeTruthy()
    }
  })

  // The box's one line of help names its three lists: a file name, > for a command, % for text in files.
  it('the palette placeholder names the > and % prefixes, and the scope lines take their values', () => {
    for (const [lang, { messages: catalog }] of Object.entries(CATALOGS)) {
      const c = catalog as Record<string, string>
      expect(c['quickOpen.placeholder'], lang).toContain('>')
      expect(c['quickOpen.placeholder'], lang).toContain('%')
      expect(c['textSearch.scope'], lang).toContain('{name}')
      expect(c['textSearch.truncated'], lang).toContain('{count}')
      expect(c['textSearch.fileCut'], lang).toContain('{count}')
      expect(c['textSearch.tooLong'], lang).toContain('{max}')
    }
  })
})
