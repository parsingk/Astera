import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The preview needs a DOM; its wiring is pinned by its text, as the palette's is. What it shows is decided in
// core/context/contextRef.ts (the text, its masking and cut) and App (which sessions fit, what attaching does).
const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ContextPreview.tsx'), 'utf8')

describe('ContextPreview', () => {
  it('shows the exact text that will be pasted, and offers only the sessions it was given', () => {
    expect(src).toMatch(/<pre className="context-preview-text">\{text\}<\/pre>/)
    expect(src).toMatch(/items=\{sessions\.map\(\(s\) => \(\{ value: s\.id, label: s\.title \}\)\)\}/)
  })

  it('says what was masked or cut, and warns of unsaved edits', () => {
    expect(src).toMatch(/masked > 0 && <span className="modal-hint">\{t\('context\.preview\.masked', \{ count: masked \}\)\}/)
    expect(src).toMatch(/cut && <span className="modal-hint">\{t\('context\.preview\.cut'\)\}/)
    expect(src).toMatch(/dirty && <span className="modal-hint warn">\{t\('context\.preview\.dirty'\)\}/)
  })

  // Spec W4: an old revision is warned about and selected again; the button cannot paste it.
  it('stops attaching once the file changed, and says why a session refused', () => {
    expect(src).toMatch(/disabled=\{target === '' \|\| changed\}/)
    expect(src).toMatch(/outcome === 'changed'/)
    expect(src).toMatch(/t\('preview\.design\.sendWaiting', \{ name \}\)/)
    expect(src).toMatch(/t\('context\.preview\.notReady'\)/)
  })

  it('says it only puts the text in the input, and closes on Escape', () => {
    expect(src).toContain("t('context.preview.hint')")
    expect(src).toMatch(/if \(e\.key !== 'Escape'\) return/)
  })
})
