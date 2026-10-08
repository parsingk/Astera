// A unified diff split into the rows the diff view draws (remote runtime design Phase 10): headers, hunk lines, added,
// removed and context lines, each with the line numbers it has on its side.
import { describe, it, expect } from 'vitest'
import { diffLines } from './diffLines'

const DIFF = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,4 @@ intro',
  ' a',
  '-b',
  '+B',
  '+c2',
  ' c',
  '\\ No newline at end of file',
  ''
].join('\n')

describe('diffLines', () => {
  it('numbers each side through a hunk', () => {
    expect(diffLines(DIFF)).toEqual([
      { kind: 'meta', text: 'diff --git a/a.txt b/a.txt' },
      { kind: 'meta', text: 'index 1111111..2222222 100644' },
      { kind: 'meta', text: '--- a/a.txt' },
      { kind: 'meta', text: '+++ b/a.txt' },
      { kind: 'hunk', text: '@@ -1,3 +1,4 @@ intro' },
      { kind: 'ctx', text: ' a', oldNo: 1, newNo: 1 },
      { kind: 'del', text: '-b', oldNo: 2 },
      { kind: 'add', text: '+B', newNo: 2 },
      { kind: 'add', text: '+c2', newNo: 3 },
      { kind: 'ctx', text: ' c', oldNo: 3, newNo: 4 },
      { kind: 'meta', text: '\\ No newline at end of file' }
    ])
  })
  it('a line that looks like a header inside a hunk is still a hunk line', () => {
    const rows = diffLines(['@@ -1,2 +1,2 @@', '---x', '+++y', ''].join('\n'))
    expect(rows.slice(1)).toEqual([
      { kind: 'del', text: '---x', oldNo: 1 },
      { kind: 'add', text: '+++y', newNo: 1 }
    ])
  })
  it('a binary diff is one meta line', () => {
    expect(diffLines('Binary files a/x.bin and b/x.bin differ\n')).toEqual([{ kind: 'meta', text: 'Binary files a/x.bin and b/x.bin differ' }])
  })
})
