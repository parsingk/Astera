import { describe, it, expect } from 'vitest'
import { LSP_PROBLEMS_MAX, toProblems } from './convert'

// Phase 3 Part 3: an LSP Diagnostic[] as the problems Astera keeps
const d = (over: Record<string, unknown> = {}) => ({
  range: { start: { line: 89, character: 6 }, end: { line: 89, character: 13 } },
  severity: 1,
  message: "Type 'string' is not assignable to type 'number'.",
  code: 2322,
  ...over
})

describe('toProblems', () => {
  it('turns 0-based ranges into 1-based lines and columns', () => {
    expect(toProblems([d()])).toEqual([{ line: 90, column: 7, endLine: 90, endColumn: 14, severity: 'error', message: "Type 'string' is not assignable to type 'number'.", code: '2322' }])
  })

  it('drops hints and maps 1, 2, 3 to error, warning, info', () => {
    const got = toProblems([d({ severity: 1 }), d({ severity: 2 }), d({ severity: 3 }), d({ severity: 4 }), d({ severity: undefined })])
    expect(got.map((p) => p.severity)).toEqual(['error', 'warning', 'info', 'error'])
  })

  it('keeps a numeric or string code as a string, and none when it has none', () => {
    expect(toProblems([d({ code: 'reportMissingImports' })])[0].code).toBe('reportMissingImports')
    expect(toProblems([d({ code: undefined })])[0]).not.toHaveProperty('code')
  })

  it('keeps at most 200 and cuts a message at 2000', () => {
    expect(toProblems(Array.from({ length: 300 }, () => d()))).toHaveLength(LSP_PROBLEMS_MAX)
    expect(LSP_PROBLEMS_MAX).toBe(200)
    expect(toProblems([d({ message: 'x'.repeat(5000) })])[0].message.length).toBeLessThanOrEqual(2000)
  })

  it('ignores items that are not diagnostics', () => {
    expect(toProblems(null)).toEqual([])
    expect(toProblems([null, 1, 'x', {}, { range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } }, message: 'm' }, d({ message: 3 })])).toEqual([])
  })
})
