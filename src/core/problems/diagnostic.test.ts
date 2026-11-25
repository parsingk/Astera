import { describe, it, expect } from 'vitest'
import { filterDiagnostics, problemCounts, sortDiagnostics, type Diagnostic } from './diagnostic'

const d = (over: Partial<Diagnostic> & Pick<Diagnostic, 'id'>): Diagnostic => ({
  schemaVersion: 1,
  source: { kind: 'check', id: 'plugin:lint', label: 'Lint' },
  severity: 'error',
  message: 'm',
  ...over
})

const LIST: Diagnostic[] = [
  d({ id: 'a', severity: 'warning', path: 'D:\\p\\src\\b.ts', line: 9, message: 'unused variable' }),
  d({ id: 'b', severity: 'error', path: 'D:\\p\\src\\a.ts', line: 20, message: 'type mismatch', source: { kind: 'review', id: 'review', label: 'Review' } }),
  d({ id: 'c', severity: 'info', message: 'CI summary without a file', source: { kind: 'check', id: 'github-ci', label: 'GitHub CI' } }),
  d({ id: 'e', severity: 'error', path: 'D:\\p\\src\\a.ts', line: 3, message: 'missing import' })
]

describe('sortDiagnostics', () => {
  it('by severity puts errors first, then by file and line, and keeps a problem without a file last of its severity', () => {
    expect(sortDiagnostics(LIST, 'severity').map((x) => x.id)).toEqual(['e', 'b', 'a', 'c'])
  })

  it('by file goes by path and line, and puts problems without a file last', () => {
    expect(sortDiagnostics(LIST, 'file').map((x) => x.id)).toEqual(['e', 'b', 'a', 'c'])
  })

  it('by source groups by its label, errors first within it', () => {
    expect(sortDiagnostics(LIST, 'source').map((x) => x.id)).toEqual(['c', 'e', 'a', 'b'])
  })

  it('does not change the list it was given', () => {
    const before = LIST.map((x) => x.id)
    sortDiagnostics(LIST, 'file')
    expect(LIST.map((x) => x.id)).toEqual(before)
  })
})

describe('filterDiagnostics', () => {
  it('keeps the severities asked for', () => {
    expect(filterDiagnostics(LIST, { severities: new Set(['error']), text: '' }).map((x) => x.id)).toEqual(['b', 'e'])
  })

  it('matches the text in the message, the file or the source, ignoring case', () => {
    const all = new Set(['error', 'warning', 'info'] as const)
    expect(filterDiagnostics(LIST, { severities: all, text: 'IMPORT' }).map((x) => x.id)).toEqual(['e'])
    expect(filterDiagnostics(LIST, { severities: all, text: 'b.ts' }).map((x) => x.id)).toEqual(['a'])
    expect(filterDiagnostics(LIST, { severities: all, text: 'github' }).map((x) => x.id)).toEqual(['c'])
  })
})

describe('problemCounts', () => {
  it('counts each severity', () => {
    expect(problemCounts(LIST)).toEqual({ error: 2, warning: 1, info: 1 })
  })
})
