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
