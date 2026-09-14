import { describe, it, expect } from 'vitest'
import { modelChoicesOf, effortChoicesOf, CODEX_EFFORT_ROWS } from './cliModels'
import type { ModelDescriptor } from './types'

// What the two CLIs actually answered (measured 2026-09-12, through settings.listModels).
const claude: ModelDescriptor[] = [
  { provider: 'claude', id: 'default', name: 'Default (recommended)', isDefault: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { provider: 'claude', id: 'opus[1m]', name: 'Opus (1M context)', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { provider: 'claude', id: 'haiku', name: 'Haiku' }
]

const codex: ModelDescriptor[] = [
  { provider: 'codex', id: 'gpt-6-astra', name: 'GPT-6-Astra', isDefault: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { provider: 'codex', id: 'gpt-5.5', name: 'GPT-5.5', effortLevels: ['low', 'medium', 'high', 'xhigh'] }
]

describe('modelChoicesOf', () => {
  it('offers what the CLI answered, by its own name', () => {
    expect(modelChoicesOf(claude)).toEqual([
      { key: 'default', label: 'Default (recommended)' },
      { key: 'opus[1m]', label: 'Opus (1M context)' },
      { key: 'haiku', label: 'Haiku' }
    ])
  })

  it('offers nothing when the CLI would not say', () => {
    expect(modelChoicesOf([])).toEqual([])
  })
})

describe('effortChoicesOf', () => {
  // The reason this is per model rather than one list: they really do differ.
  it('offers the levels the model it is on takes, not every level there is', () => {
    expect(effortChoicesOf(claude, 'Opus (1M context)', 'claude').map((c) => c.key)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    expect(effortChoicesOf([claude[2]], 'Haiku', 'claude')).toEqual([])
  })

  // codex's own picker reaches four of the six; the other two are a screen further in, and a row that
  // can only send someone to the terminal is worse than no row.
  it('offers codex only the levels its picker can be answered on', () => {
    expect(effortChoicesOf(codex, 'gpt-6-astra', 'codex').map((c) => c.key)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    expect(effortChoicesOf(codex, 'gpt-6-astra', 'claude').map((c) => c.key)).toContain('ultra')
  })

  it('matches what the CLI reports, whether that is an id or a display name', () => {
    expect(effortChoicesOf(claude, 'Opus (1M context)', 'claude')).toHaveLength(5)
    expect(effortChoicesOf(claude, 'opus[1m]', 'claude')).toHaveLength(5)
  })

  it('falls back to the default model when what it reports is not in the list', () => {
    expect(effortChoicesOf(codex, 'gpt-9-unheard-of', 'claude').map((c) => c.key)).toContain('ultra')
  })

  // Haiku takes no effort at all, and rows that would be refused are worse than no rows.
  it('offers nothing for a model that takes no effort, and nothing for no list', () => {
    expect(effortChoicesOf([claude[2]], 'Haiku', 'claude')).toEqual([])
    expect(effortChoicesOf([], 'anything', 'claude')).toEqual([])
  })
})

describe('CODEX_EFFORT_ROWS', () => {
  // The list and the screen disagree, and only the screen's wording can be found on the screen.
  it('translates the name codex lists into the one it draws', () => {
    expect(CODEX_EFFORT_ROWS['xhigh']).toBe('Extra high')
    expect(CODEX_EFFORT_ROWS['high']).toBe('High')
  })

  it('leaves out the levels codex keeps one screen further in', () => {
    expect(CODEX_EFFORT_ROWS['max']).toBeUndefined()
    expect(CODEX_EFFORT_ROWS['ultra']).toBeUndefined()
  })
})
