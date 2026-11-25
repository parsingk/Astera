import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'TerminalView.tsx'), 'utf8')

// The terminal's registered paste is where "never submits" is kept for every caller (final review C2, I5): control
// characters never reach the pty (an ESC[201~ would end bracketed paste early), and text of several lines is not taken
// while bracketed paste is off, since each line break would then be an Enter.
describe("a terminal session's registered paste", () => {
  it('drops control characters and takes several lines only with bracketed paste on', () => {
    expect(src).toMatch(/sessionBus\.registerPaste\(\s*session\.id,\s*\(text\) => term\.paste\(stripControls\(text\)\.text\),\s*\{ accepts: \(text\) => !\/\[\\r\\n\]\/\.test\(text\) \|\| term\.modes\.bracketedPasteMode \}\s*\)/)
  })
})
