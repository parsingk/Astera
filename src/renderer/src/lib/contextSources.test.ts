import { describe, it, expect } from 'vitest'
import { selectionContext } from './contextSources'
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
