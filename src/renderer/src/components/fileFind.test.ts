import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { SearchQuery } from '@codemirror/search'
import { countMatches } from './fileFind'

// 'view' appears four times: once plain, once upper case, once inside 'preview', once alone.
// That spread is what tells the case, whole-word and regexp options apart from each other.
const DOC = ['const view = 1', 'VIEW.focus()', 'preview.open()', 'view'].join('\n')

const stateWith = (from: number, to = from): EditorState =>
  EditorState.create({ doc: DOC, selection: { anchor: from, head: to } })

describe('countMatches', () => {
  it('counts every match, ignoring case by default', () => {
    expect(countMatches(stateWith(0), new SearchQuery({ search: 'view' })).total).toBe(4)
  })

  it('drops the upper-case hit when the query is case sensitive', () => {
    const q = new SearchQuery({ search: 'view', caseSensitive: true })
    expect(countMatches(stateWith(0), q).total).toBe(3)
  })

  it('drops the hit inside preview when the query is whole-word', () => {
    const q = new SearchQuery({ search: 'view', wholeWord: true })
    expect(countMatches(stateWith(0), q).total).toBe(3)
  })

  it('counts regular expression matches', () => {
    const q = new SearchQuery({ search: '\\bview\\b', regexp: true })
    expect(countMatches(stateWith(0), q).total).toBe(3)
  })

  it('reports no index while the selection is not on a match', () => {
    const q = new SearchQuery({ search: 'view' })
    expect(countMatches(stateWith(0), q).index).toBeNull()
  })

  it('numbers the match the selection covers, counting from one', () => {
    const q = new SearchQuery({ search: 'view' })
    const upper = DOC.indexOf('VIEW')
    expect(countMatches(stateWith(upper, upper + 4), q).index).toBe(2)
    const last = DOC.lastIndexOf('view')
    expect(countMatches(stateWith(last, last + 4), q).index).toBe(4)
  })

  it('reports a total of zero when nothing matches', () => {
    const q = new SearchQuery({ search: 'nothinghere' })
    expect(countMatches(stateWith(0), q)).toEqual({ index: null, total: 0 })
  })
})
