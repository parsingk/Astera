import { describe, it, expect } from 'vitest'
import { displayPath, enterAction, filesWaiting, paletteMode, settleEnter } from './quickOpen'

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

describe('filesWaiting', () => {
  it('waits while the file rows answer an older query or another project', () => {
    expect(filesWaiting({ mode: 'files', current: false, indexing: false, rows: 3 })).toBe(true)
  })

  // Review M2: during a first walk an Enter on no rows yet would otherwise be spent on nothing.
  it('waits while a first walk has found nothing yet', () => {
    expect(filesWaiting({ mode: 'files', current: true, indexing: true, rows: 0 })).toBe(true)
    expect(filesWaiting({ mode: 'files', current: true, indexing: true, rows: 2 })).toBe(false)
  })

  it('does not wait on a current answer, or on the actions list', () => {
    expect(filesWaiting({ mode: 'files', current: true, indexing: false, rows: 0 })).toBe(false)
    expect(filesWaiting({ mode: 'actions', current: false, indexing: true, rows: 0 })).toBe(false)
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
