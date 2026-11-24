import { describe, it, expect } from 'vitest'
import { displayPath, enterAction, markSegments, paletteMode, rowsWaiting, settleEnter } from './quickOpen'

describe('paletteMode', () => {
  it('reads a leading > as the actions list, and the rest as what to look for', () => {
    expect(paletteMode('>run')).toEqual({ mode: 'actions', text: 'run' })
    expect(paletteMode('> run')).toEqual({ mode: 'actions', text: 'run' })
    expect(paletteMode('>')).toEqual({ mode: 'actions', text: '' })
  })

  // Review M5: a path as a Windows terminal prints it.
  it('reads backslashes in a file name as the slashes the list uses', () => {
    expect(paletteMode('src\\main\\ipc')).toEqual({ mode: 'files', text: 'src/main/ipc' })
  })

  // W2b: a leading % searches text in the files. The text is kept as typed after the spaces that follow the %, backslashes
  // included: code has them.
  it('reads a leading % as text to find in the files', () => {
    expect(paletteMode('%useState')).toEqual({ mode: 'text', text: 'useState' })
    expect(paletteMode('%  a\\b ')).toEqual({ mode: 'text', text: 'a\\b ' })
    expect(paletteMode('%')).toEqual({ mode: 'text', text: '' })
  })

  it('reads anything else as a file name, without the spaces around it', () => {
    expect(paletteMode(' app ')).toEqual({ mode: 'files', text: 'app' })
    expect(paletteMode('')).toEqual({ mode: 'files', text: '' })
    expect(paletteMode('a>b')).toEqual({ mode: 'files', text: 'a>b' })
  })
})

describe('displayPath', () => {
  it('splits a file under the root into its name and its folder relative to the root', () => {
    expect(displayPath('D:\\p', 'D:\\p\\src\\core\\a.ts')).toEqual({ name: 'a.ts', folder: 'src/core' })
    expect(displayPath('/home/u/p', '/home/u/p/a/b.ts')).toEqual({ name: 'b.ts', folder: 'a' })
  })

  it('gives a file at the root no folder, with or without a trailing separator on the root', () => {
    expect(displayPath('D:\\p', 'D:\\p\\a.ts')).toEqual({ name: 'a.ts', folder: '' })
    expect(displayPath('D:\\p\\', 'D:\\p\\a.ts')).toEqual({ name: 'a.ts', folder: '' })
    expect(displayPath('D:\\', 'D:\\a.ts')).toEqual({ name: 'a.ts', folder: '' })
  })

  it('matches a Windows root written with other slashes or another case', () => {
    expect(displayPath('d:/p', 'D:\\p\\src\\a.ts')).toEqual({ name: 'a.ts', folder: 'src' })
  })

  it('does not take a sibling whose name starts with the root for a folder under it', () => {
    expect(displayPath('D:\\p', 'D:\\p2\\a.ts')).toEqual({ name: 'a.ts', folder: 'D:\\p2' })
  })

  it('shows the whole folder of a file that is not under the root', () => {
    expect(displayPath('/home/u/p', '/srv/x/b.ts')).toEqual({ name: 'b.ts', folder: '/srv/x' })
  })
})

describe('rowsWaiting', () => {
  it('waits while the file rows answer an older query or another project', () => {
    expect(rowsWaiting({ mode: 'files', current: false, busy: false, rows: 3 })).toBe(true)
  })

  // Review M2: during a first walk an Enter on no rows yet would otherwise be spent on nothing.
  it('waits while a first walk has found nothing yet', () => {
    expect(rowsWaiting({ mode: 'files', current: true, busy: true, rows: 0 })).toBe(true)
    expect(rowsWaiting({ mode: 'files', current: true, busy: true, rows: 2 })).toBe(false)
  })

  it('does not wait on a current answer, or on the actions list', () => {
    expect(rowsWaiting({ mode: 'files', current: true, busy: false, rows: 0 })).toBe(false)
    expect(rowsWaiting({ mode: 'actions', current: false, busy: true, rows: 0 })).toBe(false)
  })

  // W2b: the same rule for lines of text: rows of an older query, or none yet while files are still being read.
  it('waits on text rows the same way, a search under way standing for a walk', () => {
    expect(rowsWaiting({ mode: 'text', current: false, busy: false, rows: 5 })).toBe(true)
    expect(rowsWaiting({ mode: 'text', current: true, busy: true, rows: 0 })).toBe(true)
    expect(rowsWaiting({ mode: 'text', current: true, busy: true, rows: 1 })).toBe(false)
    expect(rowsWaiting({ mode: 'text', current: true, busy: false, rows: 0 })).toBe(false)
  })
})

describe('markSegments', () => {
  it('cuts a line into the plain and the matched parts, in order', () => {
    expect(markSegments('foo bar foo', [[0, 3], [8, 11]])).toEqual([
      { text: 'foo', mark: true },
      { text: ' bar ', mark: false },
      { text: 'foo', mark: true }
    ])
  })

  it('gives the whole line unmarked when nothing is marked, and ignores marks out of range or overlapping', () => {
    expect(markSegments('abc', [])).toEqual([{ text: 'abc', mark: false }])
    expect(markSegments('abcdef', [[1, 3], [2, 4], [9, 12]])).toEqual([
      { text: 'a', mark: false },
      { text: 'bc', mark: true },
      { text: 'def', mark: false }
    ])
  })
})

describe('enterAction', () => {
  it('waits while the rows are not yet those of what is typed', () => {
    expect(enterAction(true, 0)).toEqual({ do: 'wait' })
    expect(enterAction(true, -1)).toEqual({ do: 'wait' })
  })

  it('picks the selected row, or does nothing on an empty list', () => {
    expect(enterAction(false, 2)).toEqual({ do: 'choose', index: 2 })
    expect(enterAction(false, -1)).toEqual({ do: 'keep' })
  })
})

describe('settleEnter', () => {
  it('keeps a waiting Enter until the rows are current, then opens the first, or drops it when there is none', () => {
    expect(settleEnter(true, 5)).toBe('hold')
    expect(settleEnter(false, 5)).toBe('first')
    expect(settleEnter(false, 0)).toBe('none')
  })
})
