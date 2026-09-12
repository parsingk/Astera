import { describe, it, expect } from 'vitest'
import {
  codexPickerStep,
  codexPickerRows,
  codexDigitFor,
  codexStatusModel
} from './codexPicker'

// Both screens as codex drew them (measured 2026-09-12, codex in a fresh folder).
const modelStep = [
  '  Select Model and Effort',
  '  Access legacy models by running codex -m <model_name> or in your config.toml',
  '  1. gpt-6-astra (default)  Our most capable model for complex, demanding work.',
  '› 2. gpt-5.6-sol (current)  Reliable agentic workhorse for everyday tasks.',
  '  3. gpt-5.6-terra          Balanced agentic coding model for everyday work.',
  '  4. gpt-5.6-luna           Fast and affordable agentic coding model.',
  '  5. gpt-5.5                Proven previous-generation model for coding and general work.',
  '  Press enter to confirm or esc to go back'
]

const effortStep = [
  '  Select Reasoning Level for gpt-5.6-sol',
  '  1. Low (default)         Fast responses with lighter reasoning',
  '  2. Medium                Balances speed and reasoning depth for everyday tasks',
  '  3. High                  Greater reasoning depth for complex problems',
  '› 4. Extra high (current)  Extra high reasoning depth for complex problems',
  '  5. More reasoning…       Max and Ultra consume usage limits faster',
  '  Press enter to confirm or esc to go back'
]

describe('codexPickerStep', () => {
  it('tells the two screens of one command apart by what each calls itself', () => {
    expect(codexPickerStep(modelStep)).toBe('model')
    expect(codexPickerStep(effortStep)).toBe('effort')
  })

  it('answers null when neither screen is up', () => {
    expect(codexPickerStep(['› Ask Codex to do anything'])).toBeNull()
    expect(codexPickerStep([])).toBeNull()
  })

  // The second screen replaces the first on the same terminal, so the scrollback above still holds
  // the first screen's heading. The later one is the one that is being asked.
  it('reads the question being asked, not the one before it', () => {
    expect(codexPickerStep([...modelStep, ...effortStep])).toBe('effort')
  })
})

describe('codexPickerRows', () => {
  it('reads the digit and the name, leaving the description out', () => {
    expect(codexPickerRows(effortStep)).toEqual([
      { digit: '1', label: 'Low (default)' },
      { digit: '2', label: 'Medium' },
      { digit: '3', label: 'High' },
      { digit: '4', label: 'Extra high (current)' },
      { digit: '5', label: 'More reasoning…' }
    ])
  })

  // A name with one space inside it must survive; only the wide gap before the description splits.
  it('keeps a name that has a space in it', () => {
    expect(codexPickerRows(effortStep)[3].label).toBe('Extra high (current)')
  })

  it('ignores the marker in front of the highlighted row', () => {
    expect(codexPickerRows(modelStep)[1]).toEqual({ digit: '2', label: 'gpt-5.6-sol (current)' })
  })
})

describe('codexDigitFor', () => {
  it('finds a row by its name, whatever number it happens to be at', () => {
    expect(codexDigitFor(effortStep, 'High')).toBe('3')
    expect(codexDigitFor(effortStep, 'Low')).toBe('1')
  })

  it('reads past the note codex adds to the current and the default row', () => {
    expect(codexDigitFor(effortStep, 'Extra high')).toBe('4')
  })

  // The point of matching the name: a list this app keeps that has gone stale presses nothing rather
  // than pressing whatever now sits at that number.
  it('answers null for a row that is not on the screen', () => {
    expect(codexDigitFor(effortStep, 'Ultra')).toBeNull()
    expect(codexDigitFor([], 'High')).toBeNull()
  })
})

describe('codexStatusModel', () => {
  // The bar codex keeps at the bottom of its screen, as it drew it (measured 2026-09-12).
  it('reads the model and level codex is running right now', () => {
    expect(
      codexStatusModel([
        '› Ask Codex to do anything',
        '  gpt-5.6-sol xhigh · ~\\AppData\\Local\\Temp\\claude\\scratchpad\\codexprobe'
      ])
    ).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh' })
  })

  it('follows a change the rollout has not recorded yet', () => {
    expect(codexStatusModel(['• Model changed to gpt-5.6-sol high', '  gpt-5.6-sol high · D:\\x'])).toEqual(
      { model: 'gpt-5.6-sol', effort: 'high' }
    )
  })

  // Only the bottom line is the bar. A `·` further up belongs to some other line.
  it('does not read a line that merely has a dot in it', () => {
    expect(codexStatusModel(['  Tip: run codex app · visit chatgpt.com', '› Ask Codex to do anything'])).toBeNull()
  })

  it('answers null while the bar is covered or absent', () => {
    expect(codexStatusModel(['  Press enter to confirm or esc to go back'])).toBeNull()
    expect(codexStatusModel([])).toBeNull()
  })
})
