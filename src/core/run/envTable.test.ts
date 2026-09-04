import { describe, it, expect } from 'vitest'
import { envRowsOf, envRecordOf, envRowIssues, applyEnvPaste } from './envTable'

describe('envRowsOf / envRecordOf', () => {
  it('round-trips in insertion order', () => {
    const env = { NODE_ENV: 'test', CI: '1' }
    const rows = envRowsOf(env)
    expect(rows).toEqual([{ key: 'NODE_ENV', value: 'test' }, { key: 'CI', value: '1' }])
    expect(envRecordOf(rows)).toEqual(env)
  })

  it('an absent env is no rows, and no rows is undefined — today\'s stored shape', () => {
    expect(envRowsOf(undefined)).toEqual([])
    expect(envRecordOf([])).toBeUndefined()
    expect(envRecordOf([{ key: '', value: '' }])).toBeUndefined()
  })

  it('drops a row with an empty key, and the lower duplicate wins', () => {
    expect(envRecordOf([{ key: '', value: 'lost' }, { key: 'A', value: '1' }, { key: 'A', value: '2' }])).toEqual({ A: '2' })
  })
})

describe('envRowIssues', () => {
  it('flags a value with no key, and a key shadowed by a later row — not a fresh empty row', () => {
    const issues = envRowIssues([
      { key: '', value: 'lost' },
      { key: 'A', value: '1' },
      { key: 'B', value: 'x' },
      { key: 'A', value: '2' },
      { key: '', value: '' }
    ])
    expect(issues).toEqual(new Map([[0, 'emptyKey'], [1, 'shadowed']]))
  })
})

describe('applyEnvPaste', () => {
  const rows = [{ key: 'A', value: '1' }, { key: '', value: '' }]

  it('is not a bulk paste without a newline or an equals sign', () => {
    expect(applyEnvPaste(rows, 1, 'plain')).toBeNull()
  })

  it('expands KEY=VALUE lines into rows at the pasted position, replacing an empty row', () => {
    expect(applyEnvPaste(rows, 1, 'B=2\n# comment\nC=3\n')).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: '2' },
      { key: 'C', value: '3' }
    ])
  })

  it('overwrites an existing key in place instead of adding a row', () => {
    const out = applyEnvPaste(rows, 1, 'A=9\nD=4')
    expect(out).toEqual([{ key: 'A', value: '9' }, { key: 'D', value: '4' }])
    // Pasting the same text again changes nothing but the (already empty) target row
    expect(applyEnvPaste(out!, out!.length, 'A=9\nD=4')).toEqual(out)
  })

  it('leaves the row pasted into when the paste only overwrote keys the table already holds', () => {
    const start = [{ key: 'X', value: '9' }, { key: '', value: '' }, { key: 'Y', value: '8' }]
    expect(applyEnvPaste(start, 1, 'X=99')).toEqual([
      { key: 'X', value: '99' },
      { key: '', value: '' },
      { key: 'Y', value: '8' }
    ])
  })

  it('keeps a non-empty target row and inserts before it', () => {
    expect(applyEnvPaste([{ key: 'Z', value: '0' }], 0, 'B=2')).toEqual([{ key: 'B', value: '2' }, { key: 'Z', value: '0' }])
  })
})
