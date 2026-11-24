import { describe, it, expect } from 'vitest'
import { diffLines } from './diffLines'
import { hunkAt, repairObjective } from './hunks'

const GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,4 @@ function f() {',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  `+const token = "${GH}"`,
  ' return a',
  '@@ -40,2 +41,0 @@',
  '-gone()',
  '-also()',
  ''
].join('\n')

describe('hunkAt', () => {
  const rows = diffLines(DIFF)
  const first = rows.findIndex((r) => r.kind === 'hunk')
  const second = rows.findIndex((r, i) => r.kind === 'hunk' && i > first)

  it('takes a hunk from its header to the next one, and the lines it covers on the new side', () => {
    expect(hunkAt(rows, first)).toEqual({
      header: '@@ -10,3 +10,4 @@ function f() {',
      text: ['@@ -10,3 +10,4 @@ function f() {', ' const a = 1', '-const b = 2', '+const b = 3', `+const token = "${GH}"`, ' return a'].join('\n'),
      startLine: 10,
      endLine: 13
    })
  })

  it('gives a hunk that only removes lines the one line where they were', () => {
    const h = hunkAt(rows, second)
    expect(h && { startLine: h.startLine, endLine: h.endLine }).toEqual({ startLine: 41, endLine: 41 })
  })

  it('answers null for a row that is not a hunk header', () => {
    expect(hunkAt(rows, 0)).toBeNull()
    expect(hunkAt(rows, first + 1)).toBeNull()
    expect(hunkAt(rows, 999)).toBeNull()
  })
})

describe('repairObjective', () => {
  const rows = diffLines(DIFF)
  const hunk = hunkAt(rows, rows.findIndex((r) => r.kind === 'hunk'))!

  // Spec W4 "diff hunk → Repair Job draft": the objective names the file, its lines and the Job, leaves the person room
  // to say what is wrong, and carries the hunk masked.
  it('names the file, its lines and the Job, leaves room to say what is wrong, and carries the hunk masked', () => {
    const text = repairObjective({ file: 'src/a.ts', hunk, projectPath: 'D:\\repo', runId: 'run_1' })
    expect(text.startsWith('Repair the change below in src/a.ts (lines 10-13), made by Job run_1.\nWhat is wrong: \n')).toBe(true)
    expect(text).toContain('## Context from Astera: diff')
    expect(text).toContain('```diff\n@@ -10,3 +10,4 @@ function f() {')
    expect(text).not.toContain(GH)
  })
})
