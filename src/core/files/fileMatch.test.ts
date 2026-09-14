import { describe, it, expect } from 'vitest'
import { filterFilePaths, fileTokenAt } from './fileMatch'

describe('filterFilePaths', () => {
  const paths = [
    'src/core/conv/other.ts',
    'src/core/history/codexConversation.ts',
    'src/core/history/conversation.ts',
    'README.md'
  ]

  // Enter takes the first row. Ordering the tiers any other way hands someone a file they did not ask
  // for, which is worse than showing them nothing.
  it('puts a name that starts with the query first, then a name that contains it, then the path', () => {
    expect(filterFilePaths(paths, 'conv', 10)).toEqual([
      'src/core/history/conversation.ts',
      'src/core/history/codexConversation.ts',
      'src/core/conv/other.ts'
    ])
  })

  // `fileMatch.test.ts` starts with `fileMatch` too, and sorts ahead of it. Without an exact tier the
  // file someone named is not the one Enter takes.
  it('puts the file whose name IS the query ahead of one that merely starts with it', () => {
    const found = filterFilePaths(
      ['src/core/files/fileMatch.test.ts', 'src/core/files/fileMatch.ts'],
      'filematch',
      10
    )
    expect(found).toEqual(['src/core/files/fileMatch.ts', 'src/core/files/fileMatch.test.ts'])
  })

  it('ignores case', () => {
    expect(filterFilePaths(paths, 'README', 10)).toEqual(['README.md'])
    expect(filterFilePaths(paths, 'readme', 10)).toEqual(['README.md'])
  })

  it('offers everything for a bare @', () => {
    expect(filterFilePaths(paths, '', 10)).toEqual(paths)
  })

  it('never returns more than the cap', () => {
    expect(filterFilePaths(paths, '', 2)).toHaveLength(2)
    expect(filterFilePaths(paths, 'ts', 1)).toHaveLength(1)
  })
})

describe('fileTokenAt', () => {
  it('finds the reference being typed at the caret', () => {
    expect(fileTokenAt('@conv', 5)).toEqual({ start: 0, query: 'conv' })
    expect(fileTokenAt('이 파일 @src/core 봐줘', 14)).toEqual({ start: 5, query: 'src/core' })
  })

  it('offers everything for a bare @', () => {
    expect(fileTokenAt('@', 1)).toEqual({ start: 0, query: '' })
  })

  // The two that decide whether this helps or gets in the way: an address is not a file reference,
  // and a reference ends at the first space.
  it('stays out of an address and stops at a space', () => {
    expect(fileTokenAt('claude2@anipen.com', 18)).toBeNull()
    expect(fileTokenAt('@src/a.ts 를 봐줘', 15)).toBeNull()
  })

  it('reads what is before the caret, not what follows it', () => {
    expect(fileTokenAt('@conversation.ts', 5)).toEqual({ start: 0, query: 'conv' })
  })

  it('answers null when there is no reference at all', () => {
    expect(fileTokenAt('그냥 메시지', 6)).toBeNull()
  })
})
