// A Run's changed files and one file's diff, from the owning machine's git (remote runtime design Phase 10): the list
// with a stable id per file, its status, its line counts and a rename's source; the diff exactly as `git diff` prints
// it for the same range, bounded.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { makeRepo, gitSync } from '../worktrees/testRepo'
import { fileIdOf, readChanges, readFileDiff, type ChangedFile } from './changes'

const head = (repo: string): string => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim()
const gitDiff = (repo: string, args: string[]): string =>
  execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '-M', ...args], { cwd: repo, windowsHide: true, encoding: 'utf8' })
const write = (repo: string, rel: string, text: string | Buffer): Promise<void> =>
  fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true }).then(() => fs.writeFile(path.join(repo, rel), text))
const commit = (repo: string, msg: string): void => {
  gitSync(repo, ['add', '-A'])
  gitSync(repo, ['commit', '-q', '-m', msg])
}
const byPath = (files: ChangedFile[]): Record<string, ChangedFile> => Object.fromEntries(files.map((f) => [f.path, f]))

// Real git throughout: a loaded Windows runner is slow, as range.test.ts notes.
describe('readChanges', { timeout: 30_000 }, () => {
  it('lists added, modified, deleted and renamed files with their counts and a rename’s source', async () => {
    const repo = await makeRepo()
    await write(repo, 'keep.txt', 'a\nb\nc\n')
    await write(repo, 'gone.txt', 'x\n')
    await write(repo, 'old name.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n')
    commit(repo, 'base')
    const base = head(repo)
    await write(repo, 'keep.txt', 'a\nB\nc\nd\n')
    await fs.rm(path.join(repo, 'gone.txt'))
    await fs.mkdir(path.join(repo, 'dir'), { recursive: true })
    gitSync(repo, ['mv', 'old name.txt', 'dir/새 이름.txt'])
    await write(repo, 'dir/새 이름.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\n')
    await write(repo, 'has space/한글.txt', 'z\n')
    commit(repo, 'work')
    const files = (await readChanges(repo, base, head(repo)))!
    const f = byPath(files)
    expect(Object.keys(f).sort()).toEqual(['dir/새 이름.txt', 'gone.txt', 'has space/한글.txt', 'keep.txt'])
    expect(f['keep.txt']).toMatchObject({ status: 'modified', additions: 2, deletions: 1 })
    expect(f['gone.txt']).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 })
    expect(f['has space/한글.txt']).toMatchObject({ status: 'added', additions: 1, deletions: 0 })
    expect(f['dir/새 이름.txt']).toMatchObject({ status: 'renamed', oldPath: 'old name.txt', additions: 1, deletions: 1 })
    expect(new Set(files.map((x) => x.id)).size).toBe(4)
    for (const x of files) expect(x.id).toBe(fileIdOf(x))
  })

  it('a rename that changes only the case is one renamed file', async () => {
    const repo = await makeRepo()
    await write(repo, 'Readme.md', 'hello\n')
    commit(repo, 'base')
    const base = head(repo)
    gitSync(repo, ['mv', 'Readme.md', 'README.md'])
    commit(repo, 'case')
    expect(await readChanges(repo, base, head(repo))).toEqual([
      expect.objectContaining({ path: 'README.md', oldPath: 'Readme.md', status: 'renamed' })
    ])
  })

  it('a binary file has no line counts and says so', async () => {
    const repo = await makeRepo()
    const base = head(repo)
    await write(repo, 'img.bin', Buffer.from([0, 1, 2, 0, 255, 0]))
    commit(repo, 'bin')
    const [f] = (await readChanges(repo, base, head(repo)))!
    expect(f).toMatchObject({ path: 'img.bin', status: 'added', binary: true })
    expect(f.additions).toBeUndefined()
  })

  it('with no head it compares the base with the working tree, so uncommitted edits count', async () => {
    const repo = await makeRepo()
    await write(repo, 'w.txt', 'a\n')
    commit(repo, 'base')
    const base = head(repo)
    await write(repo, 'w.txt', 'a\nb\n')
    expect(await readChanges(repo, base, null)).toEqual([expect.objectContaining({ path: 'w.txt', status: 'modified', additions: 1 })])
  })

  it('a base git does not know answers null', async () => {
    const repo = await makeRepo()
    expect(await readChanges(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', null)).toBeNull()
  })
})

describe('readFileDiff', { timeout: 30_000 }, () => {
  it('is exactly what git diff prints for that file, a rename included', async () => {
    const repo = await makeRepo()
    await write(repo, 'old name.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n')
    await write(repo, 'm.txt', 'x\n')
    commit(repo, 'base')
    const base = head(repo)
    await fs.mkdir(path.join(repo, 'dir'), { recursive: true })
    gitSync(repo, ['mv', 'old name.txt', 'dir/새 이름.txt'])
    await write(repo, 'dir/새 이름.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\n')
    await write(repo, 'm.txt', 'y\n')
    commit(repo, 'work')
    const to = head(repo)
    const f = byPath((await readChanges(repo, base, to))!)
    const renamed = (await readFileDiff(repo, base, to, f['dir/새 이름.txt']))!
    expect(renamed).toEqual({ diff: gitDiff(repo, [base, to, '--', 'old name.txt', 'dir/새 이름.txt']), truncated: false })
    expect(renamed.diff).toContain('rename from old name.txt')
    expect((await readFileDiff(repo, base, to, f['m.txt']))!.diff).toBe(gitDiff(repo, [base, to, '--', 'm.txt']))
  })

  it('against the working tree too', async () => {
    const repo = await makeRepo()
    await write(repo, 'w.txt', 'a\n')
    commit(repo, 'base')
    const base = head(repo)
    await write(repo, 'w.txt', 'a\nb\n')
    const [f] = (await readChanges(repo, base, null))!
    expect((await readFileDiff(repo, base, null, f))!.diff).toBe(gitDiff(repo, [base, '--', 'w.txt']))
  })

  it('a diff past the limit is cut at a line and says so', async () => {
    const repo = await makeRepo()
    const base = head(repo)
    await write(repo, 'big.txt', Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n') + '\n')
    commit(repo, 'big')
    const [f] = (await readChanges(repo, base, head(repo)))!
    const r = (await readFileDiff(repo, base, head(repo), f, { maxBytes: 1000 }))!
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.diff)).toBeLessThanOrEqual(1000)
    expect(r.diff.endsWith('\n')).toBe(true)
  })
})
