import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FORCED_SELECTION_OPTIONS } from './forcedSelection'

describe('FORCED_SELECTION_OPTIONS', () => {
  // xterm forces a selection over a program that takes the mouse with Shift off macOS and, on macOS, only with Option
  // and this option on (SelectionService.shouldForceSelection). Off, an Option-drag in Claude Code's fullscreen view went
  // to Claude Code like any drag, and its copy was the only copy there was.
  it('turns on the Option-drag selection xterm leaves off on macOS', () => {
    expect(FORCED_SELECTION_OPTIONS).toEqual({ macOptionClickForcesSelection: true })
  })
})

// Every terminal the renderer makes gets it, through consoleTerminalOptions or the constant itself, so a terminal added
// later cannot quietly be the one where Option-drag does nothing. Read from the source, as the other wiring tests are.
describe('every xterm in the renderer', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'renderer', 'src')
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) return files(full)
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
    })
  const makers = files(root)
    .map((file) => ({ file: path.relative(root, file), text: readFileSync(file, 'utf8') }))
    .filter((f) => f.text.includes('new Terminal('))

  it('finds the terminals it checks', () => {
    expect(makers.length).toBeGreaterThanOrEqual(5)
  })

  /** The whole `new Terminal(…)` call, by counting parentheses: a call can carry long comments. */
  const callAt = (text: string, at: number): string => {
    let depth = 0
    for (let i = text.indexOf('(', at); i < text.length; i++) {
      if (text[i] === '(') depth++
      else if (text[i] === ')' && --depth === 0) return text.slice(at, i + 1)
    }
    return text.slice(at)
  }

  it.each(makers.map((m) => [m.file, m.text] as const))('%s builds its terminal with the forced selection', (_file, text) => {
    for (let at = text.indexOf('new Terminal('); at !== -1; at = text.indexOf('new Terminal(', at + 1)) {
      const call = callAt(text, at)
      expect(call.includes('consoleTerminalOptions(') || call.includes('...FORCED_SELECTION_OPTIONS')).toBe(true)
    }
  })
})
