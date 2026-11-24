import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// App.tsx cannot run without a full React + Electron harness, so its wiring is pinned by its text, as
// App.layoutWriteThrough.test.ts does. Every UI action runs through the action registry (ADR-007): the keydown listener
// only routes keys, the handlers live in actionImplRef (a Record over ActionId, so the compiler proves each action has
// one), and one effect registers a delegate for every action in ACTIONS. Mutation: branch on an action id in the
// listener again, register a hand-picked subset, or run the palette's choice without closing the palette first, and
// this fails.
const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'App.tsx'), 'utf8')
const listener = src.slice(src.indexOf('  // The global shortcuts: one capture listener'), src.indexOf('  // One delegate per action'))

describe('App.tsx runs shortcuts through the action registry', () => {
  it('has a keydown listener that routes keys and never branches on an action id', () => {
    expect(listener).toContain("window.addEventListener('keydown', onKey, true)")
    expect(listener).toContain('keyDecision(spec, keyFocusOf(document.activeElement), actionRegistry.state(action).ok)')
    expect(listener).toContain("if (decision === 'pass') return")
    expect(listener).toContain("if (decision === 'run') actionRegistry.run(action)")
    expect(listener).not.toMatch(/action === '/)
    expect(src).not.toMatch(/action === '[a-zA-Z]+\.[a-zA-Z]+'/)
  })

  it('registers a delegate for every action in ACTIONS under the core owner', () => {
    expect(src).toMatch(/ACTIONS\.map\(\(a\) =>\s*actionRegistry\.register\('core', a\.id,/)
    expect(src).toMatch(/const actionImplRef = useRef<Record<ActionId, ActionHandler> \| null>\(null\)/)
    expect(src).toMatch(/actionImplRef\.current = \{/)
  })

  it('treats an open palette as a modal, and closes it before running the chosen action', () => {
    expect(src).toMatch(/modalOpenRef\.current = modalOpenRef\.current \|\| paletteOpen !== null \|\|/)
    expect(src).toMatch(/onRun=\{\(id\) => \{\s*setPaletteOpen\(null\)\s*actionRegistry\.run\(id\)/)
  })

  // A menu left open would stay drawn over the palette's backdrop (a tab's menu sits above it) and act on the workbench.
  it('closes the tab menu and the run configuration menu as the palette opens', () => {
    expect(src).toMatch(/const openPalette = \(query: PaletteStart\): void => \{[\s\S]*?setTabMenu\(null\)\s*setRunMenuOpen\(false\)\s*setPaletteOpen\(\{ query \}\)/)
    expect(src).toMatch(/'palette\.open': \{ run: \(\) => openPalette\('>'\) \}/)
  })

  // W2a: Ctrl+P is the same box on the explorer's project's files. With no project it still opens, and the box says why it
  // is empty (review M7): a key that does nothing explains nothing.
  it('goes to a file through the palette opened on files, with or without a project', () => {
    expect(src).toMatch(/'file\.quickOpen': \{ run: \(\) => openPalette\(''\) \}/)
  })

  // W2b: Ctrl+Shift+F is the same box on text in the project's files, behind a leading %.
  it('finds in files through the palette opened on text', () => {
    expect(src).toMatch(/'search\.text': \{ run: \(\) => openPalette\('%'\) \}/)
    expect(src).toMatch(/const openPalette = \(query: PaletteStart\): void =>/)
  })

  // Review M1: read once as the palette opens, in the handler, so a remount on the other list keeps it.
  it('reads where focus was as the palette opens from closed, and hands it to the box', () => {
    expect(src).toMatch(/if \(paletteOpen === null\) paletteRestoreRef\.current = document\.activeElement as HTMLElement \| null/)
    expect(src).toMatch(/restoreTo=\{paletteRestoreRef\.current\}/)
  })

  // The key remounts the box when it is reopened on the other list (going to a file chosen from the actions list).
  it("gives the palette the query it opens with, the explorer's project, and a file opener that closes it first", () => {
    expect(src).toMatch(/<CommandPalette\s+key=\{paletteOpen\.query\}\s+initialQuery=\{paletteOpen\.query\}\s+projectRoot=\{currentProject\}/)
    // The explorer's own opener: an image or a video goes to the media viewer, as a click in the explorer sends it
    expect(src).toMatch(/onOpenFile=\{\(path\) => \{\s*setPaletteOpen\(null\)\s*(?:\/\/[^\n]*\n\s*)?openProjectFile\(path\)/)
    expect(src).toMatch(/const \[paletteOpen, setPaletteOpen\] = useState<\{ query: PaletteStart \} \| null>\(null\)/)
    expect(src).toMatch(/type PaletteStart = '>' \| '' \| '%'/)
  })

  // Every dialog with a backdrop holds the shortcuts and the palette off the workbench behind it. These three had been
  // left out of the guard.
  it('counts the update gate, the remote sessions dialog and the first-run question as modals', () => {
    expect(src).toMatch(/remoteDialog !== null \|\| campaign\?\.mode === 'block' \|\| \(firstRunAsked === false && accounts\.length > 0\)/)
  })

  // The handlers are rebuilt every render, so nothing they call needs a ref against a stale closure any more.
  it('keeps no ref that existed only for the old listener', () => {
    expect(src).not.toMatch(/(splitActiveRef|cliRef|runStartRef|runStopSelectionRef|runRerunSelectedRef)/)
  })
})
