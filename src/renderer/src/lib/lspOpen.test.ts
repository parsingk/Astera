import { describe, it, expect } from 'vitest'
import { lspOpenFiles } from './lspOpen'

// Phase 3 Part 3: which of the editor's tabs go to the Host's language servers
describe('lspOpenFiles', () => {
  it('keeps TS, JS and Python files once each, with their tab’s root', () => {
    expect(
      lspOpenFiles([
        { path: 'F:\\p\\a.ts', projectRoot: 'F:\\p' },
        { path: 'F:\\p\\a.ts', projectRoot: 'F:\\other' },
        { path: 'F:\\p\\notes.md', projectRoot: 'F:\\p' },
        { path: 'F:\\p\\c.py', projectRoot: 'F:\\p' },
        { path: 'F:\\p\\d.JSX', projectRoot: 'F:\\p' }
      ])
    ).toEqual([
      { path: 'F:\\p\\a.ts', root: 'F:\\p' },
      { path: 'F:\\p\\c.py', root: 'F:\\p' },
      { path: 'F:\\p\\d.JSX', root: 'F:\\p' }
    ])
    expect(lspOpenFiles([])).toEqual([])
  })
})
