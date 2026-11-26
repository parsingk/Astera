import { describe, it, expect } from 'vitest'
import { logContext, problemLine, problemsContext, selectionContext } from './contextSources'
import type { Diagnostic } from '../../../core/problems/diagnostic'
import { contextText, sessionFits } from '../../../core/context/contextRef'
import { contentRevision } from '../../../core/context/contextRef'

const DOC = 'line one\nline two\nline three\nline four\n'
const base = { path: 'D:\\repo\\src\\a.ts', root: 'D:\\repo', doc: DOC, saved: DOC }
const offset = (line: number): number => DOC.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0)

describe('selectionContext', () => {
  it('takes the selected text, its lines, the saved revision and the file type', () => {
    const r = selectionContext({ ...base, from: offset(2), to: offset(3) + 'line three'.length })
    expect(r).toEqual({
      ok: true,
      ref: {
        schemaVersion: 1,
        kind: 'selection',
        root: 'D:\\repo',
        path: 'D:\\repo\\src\\a.ts',
        range: { startLine: 2, endLine: 3 },
        revision: contentRevision(DOC),
        label: 'src/a.ts:2-3'
      },
      excerpt: 'line two\nline three',
      language: 'ts',
      dirty: false
    })
  })

  // Whole lines selected end right after a line break: the next line is not part of it.
  it('does not count the line after a selection that ends at a line break', () => {
    const r = selectionContext({ ...base, from: offset(1), to: offset(3) })
    expect(r.ok && r.ref.range).toEqual({ startLine: 1, endLine: 2 })
    expect(r.ok && r.ref.label).toBe('src/a.ts:1-2')
  })

  it('names a one-line selection by its line alone', () => {
    const r = selectionContext({ ...base, from: offset(4), to: offset(4) + 4 })
    expect(r.ok && r.ref.label).toBe('src/a.ts:4')
  })

  // The agent reads the file on disk, which unsaved edits are not in yet.
  it('says when the editor holds edits the file on disk does not', () => {
    const r = selectionContext({ ...base, doc: `edited\n${DOC}`, from: 0, to: 6 })
    expect(r.ok && r.dirty).toBe(true)
    expect(r.ok && r.ref.revision).toBe(contentRevision(DOC))
  })

  it('refuses an empty or blank selection', () => {
    expect(selectionContext({ ...base, from: 3, to: 3 })).toEqual({ ok: false, reason: 'empty' })
    expect(selectionContext({ ...base, doc: 'a   \n  b', saved: 'a   \n  b', from: 1, to: 6 })).toEqual({ ok: false, reason: 'empty' })
  })

  // Spec W4: secrets are removed. A secret file's format is anyone's, so its content is not sent at all.
  it('refuses a selection in a credential file', () => {
    expect(selectionContext({ ...base, path: 'D:\\repo\\.env', from: 0, to: 4 })).toEqual({ ok: false, reason: 'credential' })
  })

  it('gives a file with no extension no fence language', () => {
    const r = selectionContext({ ...base, path: 'D:\\repo\\Makefile', from: 0, to: 4 })
    expect(r.ok && r.language).toBe('')
  })
})

describe('logContext', () => {
  const run = { runId: 'run-7', projectPath: 'D:\\repo', configName: 'npm run dev' }

  it('takes what is selected in the console when there is a selection', () => {
    expect(logContext({ run, selection: 'Error: boom\n  at x', tail: ['a', 'b'] })).toEqual({
      ok: true,
      ref: { schemaVersion: 1, kind: 'log', root: 'D:\\repo', sourceId: 'run-7', label: 'Run: npm run dev' },
      excerpt: 'Error: boom\n  at x',
      fromTail: false
    })
  })

  // Spec W4 "log → context preview": with nothing selected, the end of the log is what a person means.
  it('takes the end of the log, without trailing blank lines, when nothing is selected', () => {
    const r = logContext({ run, selection: '', tail: ['one', 'two', '', '  '] })
    expect(r.ok && r.excerpt).toBe('one\ntwo')
    expect(r.ok && r.fromTail).toBe(true)
  })

  it('refuses a log with nothing in it', () => {
    expect(logContext({ run, selection: '  ', tail: ['', ' '] })).toEqual({ ok: false, reason: 'empty' })
  })
})

// Phase 3 Part 1: Problems rows sent to an agent through the W4 preview
describe('problemsContext', () => {
  const FILE = ['import a', 'const x = 1', 'const y = 2', 'call(x)', 'const z = 3', 'log(z)', 'end', 'tail one', 'tail two'].join('\n')
  const row = (over: Partial<Diagnostic> = {}): Diagnostic => ({
    schemaVersion: 1,
    id: 'check:t1:lint:0',
    ref: 'check:t1:0123456789ab',
    source: { kind: 'check', id: 'plugin:lint', label: 'Lint' },
    severity: 'error',
    message: 'x is not defined',
    path: 'D:\\repo\\src\\a.ts',
    line: 4,
    ...over
  })

  it('builds one problem’s context with the lines around it and the file’s revision', () => {
    const r = problemsContext({ rows: [row()], root: 'D:\\repo', files: { 'D:\\repo\\src\\a.ts': FILE } })
    if (!r.ok) throw new Error(r.reason)
    expect(r.ref).toEqual({
      schemaVersion: 1,
      kind: 'diagnostic',
      root: 'D:\\repo',
      path: 'D:\\repo\\src\\a.ts',
      range: { startLine: 4, endLine: 4 },
      revision: contentRevision(FILE),
      sourceId: 'check:t1:0123456789ab',
      label: 'src/a.ts:4 Lint'
    })
    expect(r.excerpt).toBe(
      [
        'error src/a.ts:4 Lint: x is not defined',
        '    1 | import a',
        '    2 | const x = 1',
        '    3 | const y = 2',
        '  > 4 | call(x)',
        '    5 | const z = 3',
        '    6 | log(z)',
        '    7 | end'
      ].join('\n')
    )
    // The W4 text heads it with its kind and file
    expect(contextText(r.ref, r.excerpt).text).toContain('## Context from Astera: diagnostic\n**File:** src/a.ts (line 4)')
  })

  it('lists several problems without one file, each with its own lines, and a row with no file by its words alone', () => {
    const r = problemsContext({
      rows: [row(), row({ id: 'review:t1:i1', ref: 'review:t1:aaaaaaaaaaaa', source: { kind: 'review', id: 'review', label: 'Review' }, severity: 'warning', message: 'off by one', line: 1 }), row({ id: 'check:t1:cfg', path: undefined, line: undefined, message: 'npm test failed' })],
      root: 'D:\\repo',
      files: { 'D:\\repo\\src\\a.ts': FILE }
    })
    if (!r.ok) throw new Error(r.reason)
    expect(r.ref).toEqual({ schemaVersion: 1, kind: 'diagnostic', root: 'D:\\repo', label: '3 problems' })
    expect(r.excerpt.split('\n\n')).toEqual([
      expect.stringMatching(/^error src\/a\.ts:4 Lint: x is not defined\n/),
      expect.stringMatching(/^warning src\/a\.ts:1 Review: off by one\n  > 1 \| import a\n/),
      'error Lint: npm test failed'
    ])
  })

  it('never includes a credential file’s lines, and lists its problem by its words', () => {
    const r = problemsContext({ rows: [row({ path: 'D:\\repo\\.env', line: 2, message: 'bad key' })], root: 'D:\\repo', files: { 'D:\\repo\\.env': 'A=1\nTOKEN=abcdef1234567890\n' } })
    if (!r.ok) throw new Error(r.reason)
    expect(r.excerpt).toBe('error .env:2 Lint: bad key')
    expect(r.excerpt).not.toContain('TOKEN')
    expect(r.ref.revision).toBeUndefined()
  })

  it('refuses no rows', () => {
    expect(problemsContext({ rows: [], root: 'D:\\repo', files: {} })).toEqual({ ok: false, reason: 'empty' })
  })

  // Final review I3: a Task's finding is found in its worker folder, outside the project; only a session working in that
  // folder may take it, as a session of another worktree may not (W4)
  it('gives a row found in a worker folder that folder as its root, so a session working there takes it', () => {
    const WT = 'F:\\wt\\t1'
    const r = problemsContext({ rows: [row({ path: `${WT}\\src\\a.ts`, root: WT })], root: 'D:\\repo', files: { [`${WT}\\src\\a.ts`]: FILE } })
    if (!r.ok) throw new Error(r.reason)
    expect(r.ref.root).toBe(WT)
    expect(sessionFits(r.ref, { cwd: WT, alive: true })).toBe(true)
    expect(sessionFits(r.ref, { cwd: 'D:\\repo', alive: true })).toBe(false)
    expect(r.excerpt.startsWith('error src/a.ts:4 Lint: x is not defined\n')).toBe(true)
  })

  it('gives rows of one worker folder that folder, a row with no file joining them, and refuses rows of two folders', () => {
    const WT = 'F:\\wt\\t1'
    const inWt = row({ path: `${WT}\\src\\a.ts`, root: WT })
    const noFile = row({ id: 'check:t1:cfg', path: undefined, line: undefined, message: 'npm test failed' })
    const together = problemsContext({ rows: [inWt, noFile], root: 'D:\\repo', files: {} })
    if (!together.ok) throw new Error(together.reason)
    expect(together.ref.root).toBe(WT)
    expect(sessionFits(together.ref, { cwd: 'D:\\repo', alive: true })).toBe(false)
    expect(problemsContext({ rows: [inWt, row({ root: 'D:\\repo' })], root: 'D:\\repo', files: {} })).toEqual({ ok: false, reason: 'folders' })
  })

  // Final review M15: the lines pasted for a row whose file changed may not be the lines it was about
  it('says on the problem’s line when its file changed since it was found, or is not there', () => {
    expect(problemLine(row({ stale: 'changed' }), 'D:\\repo')).toBe('error src/a.ts:4 Lint: x is not defined (the file changed since this was found)')
    expect(problemLine(row({ stale: 'missing' }), 'D:\\repo')).toBe('error src/a.ts:4 Lint: x is not defined (the file is not there now)')
  })
})
