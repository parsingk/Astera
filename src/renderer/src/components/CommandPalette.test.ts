import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The palette needs a DOM to run, and vitest runs in node here, so its wiring is pinned by its text, as App.tsx's is.
// What it decides is tested in lib/paletteKey.test.ts and lib/paletteMatch.test.ts.
const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'CommandPalette.tsx'), 'utf8')

describe('CommandPalette wiring', () => {
  // Where focus was is read by App as the palette opens (an event handler, so React.StrictMode's doubled effects cannot
  // read the box itself), and kept when the box is remounted on the other list. Read in the box's own first render, a
  // remount took the old box's input, already gone, and Escape left focus nowhere (review M1).
  it('gives focus back to the element App read as the palette opened', () => {
    expect(src).toMatch(/restoreTo: HTMLElement \| null/)
    expect(src).not.toMatch(/useState\(\(\) => document\.activeElement/)
    expect(src).toMatch(/queueMicrotask\(\(\) => \{\s*const now = document\.activeElement\s*if \(\(now === null \|\| now === document\.body\) && restoreTo\?\.isConnected\) giveFocus\(restoreTo\)\s*\}\)/)
  })

  // A menu left open behind the palette (the run configuration menu, a tab's context menu) listens on document in the
  // capture phase and would take the arrows and Enter first. The window's capture phase runs before any of them.
  it('owns its keys in a window capture listener that stops them there', () => {
    expect(src).toMatch(/window\.addEventListener\('keydown', onKey, true\)/)
    expect(src).toMatch(/paletteKey\(e\.key,/)
    expect(src).toMatch(/e\.stopPropagation\(\)/)
    expect(src).not.toMatch(/onKeyDown=/)
  })

  it('keeps focus in the box when anything else in the palette is pressed', () => {
    expect(src).toMatch(/className="palette"[^>]*onMouseDown=\{\(e\) => \{\s*if \(e\.target !== inputRef\.current\) e\.preventDefault\(\)/)
  })

  it('shows a cut-off reason in full on hover', () => {
    expect(src).toMatch(/<span className="palette-reason" title=\{t\(row\.blocked\)\}>/)
  })
})

const hook = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../hooks/useQuickOpenFiles.ts'), 'utf8')

// W2a: the same box finds files (lib/quickOpen.ts decides the mode, main/quickOpen.ts the matches).
describe('the palette on files (Quick Open)', () => {
  it('starts from the query it was opened with, and reads its mode from what is typed', () => {
    expect(src).toMatch(/useState\(initialQuery\)/)
    expect(src).toMatch(/paletteMode\(query\)/)
  })

  it('asks for files only in file mode, under the project it was given', () => {
    expect(src).toMatch(/useQuickOpenFiles\(projectRoot, text, mode === 'files'\)/)
  })

  it('opens a chosen file, and counts only actions as recent', () => {
    expect(src).toMatch(/pick: \(\) => onOpenFile\(p\)/)
    expect(src.match(/rememberAction\(/g)).toHaveLength(1)
    expect(src).toMatch(/pick: \(\) => \{\s*rememberAction\(r\.id, known\)/)
  })

  // Rows answering an older query stay on screen while the newer one is asked; Enter on them would open a file the
  // person did not finish typing the name of.
  it('waits for the rows of what is typed before Enter opens one (lib/quickOpen.ts decides)', () => {
    expect(src).toMatch(/rowsWaiting\(\{ mode, current: list\.current, busy: list\.busy, rows: rows\.length \}\)/)
    expect(src).toMatch(/enterAction\(waiting, cur\)/)
    expect(src).toMatch(/settleEnter\(waiting, rows\.length\)/)
  })

  // Spec W2 asks for the search scope to show (review M6): which project, and whether a large one was cut.
  it('says which project it searches, and when the list was cut', () => {
    expect(src).toMatch(/t\('quickOpen\.scope', \{ name: /)
    expect(src).toContain("t('quickOpen.truncated')")
  })

  it('says why there are no file rows, or that more are coming', () => {
    for (const key of ['quickOpen.indexing', 'quickOpen.unavailable', 'quickOpen.empty', 'action.blocked.noProject']) {
      expect(src).toContain(`t('${key}')`)
    }
  })

  it('names the box after its mode, and gives the empty box the file hint', () => {
    expect(src).toMatch(/mode === 'actions' \? t\('palette\.title'\) : mode === 'text' \? t\('shortcut\.search\.text'\) : t\('shortcut\.file\.quickOpen'\)/)
    expect(src).toContain("placeholder={t('quickOpen.placeholder')}")
  })

  // A path squeezed into an id character class collides (a-b.ts and a.b.ts); the row's place does not.
  it('gives each option an id by its place in the list', () => {
    expect(src).toMatch(/`\$\{listId\}-\$\{i\}`/)
  })
})

const textHook = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../hooks/useTextSearch.ts'), 'utf8')

// W2b: the same box finds text in the files (lib/quickOpen.ts decides the mode, main/textSearch.ts the lines).
describe('the palette on text in files', () => {
  it('searches only in text mode, under the project it was given', () => {
    expect(src).toMatch(/useTextSearch\(projectRoot, text, mode === 'text'\)/)
  })

  // Enter lands on the line and column of the match, in the editor (not the media viewer: an SVG's text is what matched).
  it('opens a chosen line at its line and column', () => {
    expect(src).toMatch(/pick: \(\) => onOpenAt\(m\.path, \{ line: m\.line, col: m\.col \}\)/)
    expect(src).toMatch(/onOpenAt: \(path: string, at: \{ line: number; col: number \}\) => void/)
  })

  it('draws the matches in a row marked, and the file and line beside it', () => {
    expect(src).toMatch(/markSegments\(row\.title, row\.marks\)/)
    expect(src).toMatch(/<mark key=\{j\} className="palette-mark">/)
    expect(src).toMatch(/detail: `\$\{folder \? `\$\{folder\}\/` : ''\}\$\{name\}:\$\{m\.line\}`/)
  })

  // Review M1: the cut notices came after the fixed sentence, and the line's ellipsis hid them. They come first now, and
  // the whole line is the tooltip.
  it('says what was cut first, then which project it searches and what it leaves out, all of it on hover', () => {
    expect(src).toMatch(/const textScope = \[\s*found\.truncated \? t\('textSearch\.truncated', \{ count: rows\.length \}\) : null,\s*found\.fileCut \? t\('textSearch\.fileCut', \{ count: TEXT_SEARCH_LINES_PER_FILE \}\) : null,\s*found\.partial \? t\('quickOpen\.truncated'\) : null,\s*t\('textSearch\.scope', \{ name: projectName \}\)\s*\]/)
    expect(src).toMatch(/<div className="palette-scope" title=\{textScope\}>\s*\{textScope\}/)
  })

  it('says why there are no text rows, or that more are coming', () => {
    for (const key of ['textSearch.hint', 'textSearch.searching', 'textSearch.empty']) expect(src).toContain(`t('${key}')`)
  })

  // Review M5: a pasted line over the cap read "No file contains this text", which was not true.
  it('says the text is too long rather than that nothing matched', () => {
    expect(src).toMatch(/text\.length > TEXT_SEARCH_MAX_QUERY\s*\? t\('textSearch\.tooLong', \{ max: TEXT_SEARCH_MAX_QUERY \}\)/)
  })
})

describe('useTextSearch', () => {
  it('asks for a fresh list on its first sent ask for a project, after the debounce', () => {
    expect(textHook).toMatch(/let first = refreshedFor\.current !== root/)
    expect(textHook).toMatch(/window\.api\.files\.searchText\(root, text, first\)/)
    expect(textHook).toMatch(/if \(first\) refreshedFor\.current = root/)
    expect(textHook).toMatch(/delayMs: DEBOUNCE_MS/)
  })

  it('counts rows as current only for the project and the query they answer; no query to search has nothing to wait for', () => {
    expect(textHook).toMatch(/current: !enabled \|\| root === null \|\| !searchable\(text\) \|\| found\.answeredFor === answerKey\(root, text\)/)
    expect(textHook).toMatch(/const searchable = \(text: string\): boolean => text !== '' && text\.length <= TEXT_SEARCH_MAX_QUERY/)
  })

  // Review I1, related: going back to a bare % left main reading for the query that was there.
  it("stops main's search when the box is left with nothing to search", () => {
    expect(textHook).toMatch(/if \(!searchable\(text\)\) \{\s*setFound\(NONE\)\s*(?:\/\/[^\n]*\n\s*)?void window\.api\.files\.searchText\(root, ''\)\.catch\(\(\) => \{\}\)/)
  })

  // Closing the box, leaving %, or moving to another project stops main reading files for a search nobody will see.
  it("stops main's search when the box stops searching this project", () => {
    expect(textHook).toMatch(/return \(\) => \{\s*void window\.api\.files\.searchText\(root, ''\)\.catch\(\(\) => \{\}\)\s*\}\s*\}, \[root, enabled\]\)/)
  })
})

describe('useQuickOpenFiles', () => {
  // The watcher runs only while the explorer is open, so the box's first ask walks the project again (main/quickOpen.ts).
  it('asks for a fresh list on its first ask for a project, and not as the person types', () => {
    expect(hook).toMatch(/let first = refreshedFor\.current !== root/)
    expect(hook).toMatch(/window\.api\.files\.quickOpen\(root, text, first\)/)
    expect(hook).toMatch(/first = false/)
  })

  // Review M3: rows of the project the box was on before are not current for the one it is on now.
  it('counts rows as current only for the project and the query they answer', () => {
    expect(hook).toMatch(/current: enabled && root !== null && files\.answeredFor === answerKey\(root, text\)/)
  })

  it('stops asking for a query once the box holds another', () => {
    expect(hook).toMatch(/return pollFileIndex\(/)
    expect(hook).toMatch(/\}, \[root, text, enabled\]\)/)
  })
})

// Final review M6: an action hidden while its feature is off keeps its place in the recent list
describe('the recent list and hidden actions', () => {
  const app = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../App.tsx'), 'utf8')
  it('remembers against every action, not only those shown', () => {
    expect(src).toMatch(/actionIds: readonly RegistryId\[\]/)
    expect(src).toMatch(/const known = actionIds/)
    // Every core action, and the plugin commands last read (Phase 2 step 3)
    expect(app).toMatch(/actionIds=\{\[\.\.\.ACTIONS\.map\(\(a\) => a\.id\), \.\.\.pluginCommands\.map\(\(c\) => c\.key\)\]\}/)
  })
})

// Phase 2 step 3: an entry carries its title as the caller worded it (a core action's i18n text, a plugin command's
// manifest title) and, for a plugin's command, the plugin's name, drawn dimmed after the title.
describe('the palette with plugin commands', () => {
  it('ranks the titles it is given and draws a plugin row’s source', () => {
    expect(src).toMatch(/rankActions\(entries, text, recent\)/)
    expect(src).not.toContain('t(e.descKey')
    expect(src).toMatch(/\{row\.source && <span className="palette-source">\{row\.source\}<\/span>\}/)
  })
})
