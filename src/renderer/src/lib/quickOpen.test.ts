import { describe, it, expect } from 'vitest'
import { displayPath, paletteMode } from './quickOpen'

describe('paletteMode', () => {
  it('reads a leading > as the actions list, and the rest as what to look for', () => {
    expect(paletteMode('>run')).toEqual({ mode: 'actions', text: 'run' })
    expect(paletteMode('> run')).toEqual({ mode: 'actions', text: 'run' })
    expect(paletteMode('>')).toEqual({ mode: 'actions', text: '' })
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
