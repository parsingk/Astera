import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The palette needs a DOM to run, and vitest runs in node here, so its wiring is pinned by its text, as App.tsx's is.
// What it decides is tested in lib/paletteKey.test.ts and lib/paletteMatch.test.ts.
const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'CommandPalette.tsx'), 'utf8')

describe('CommandPalette wiring', () => {
  // React.StrictMode runs mount effects twice in development: read inside the effect, the second run would take the
  // palette's own box as "where focus was", and closing would restore nothing. The render runs before focus moves.
  it('takes where focus was during the first render, not in the mount effect', () => {
    expect(src).toMatch(/const \[restoreTo\] = useState\(\(\) => document\.activeElement as HTMLElement \| null\)/)
    expect(src).not.toMatch(/const before = document\.activeElement/)
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
  it('waits for the rows of what is typed before Enter opens one', () => {
    expect(src).toMatch(/files\.answeredFor !== text/)
  })

  it('says why there are no file rows, or that more are coming', () => {
    for (const key of ['quickOpen.indexing', 'quickOpen.unavailable', 'quickOpen.empty', 'action.blocked.noProject']) {
      expect(src).toContain(`t('${key}')`)
    }
  })

  it('names the box after its mode, and gives the empty box the file hint', () => {
    expect(src).toMatch(/mode === 'actions' \? t\('palette\.title'\) : t\('shortcut\.file\.quickOpen'\)/)
    expect(src).toContain("placeholder={t('quickOpen.placeholder')}")
  })

  // A path squeezed into an id character class collides (a-b.ts and a.b.ts); the row's place does not.
  it('gives each option an id by its place in the list', () => {
    expect(src).toMatch(/`\$\{listId\}-\$\{i\}`/)
  })
})

describe('useQuickOpenFiles', () => {
  it('stops asking for a query once the box holds another', () => {
    expect(hook).toMatch(/return pollFileIndex\(/)
    expect(hook).toMatch(/\}, \[root, text, enabled\]\)/)
  })
})
