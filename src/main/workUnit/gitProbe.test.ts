import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { makeRepo, tempDir } from '../../core/worktrees/testRepo'
import { classifyTransition } from '../../core/git/transition'
import { readGitRef, isAncestorOf } from './gitProbe'

const run = (repo: string, args: string[]): void => {
  execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' })
}

const headHash = (repo: string): string =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim()

// 저장소에 없는 40자 hex — 실제 오브젝트가 아니다
const MISSING_HASH = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

describe('readGitRef', () => {
  it('커밋이 하나도 없는 저장소 → head 는 null, 브랜치 이름은 있다', async () => {
    const repo = await tempDir('astera-gitprobe-empty-')
    run(repo, ['init', '-b', 'main'])
    const ref = await readGitRef(repo)
    expect(ref.head).toBeNull()
    expect(ref.branch).toBe('main')
  })

  it('git 저장소가 아닌 디렉터리 → 던지지 않고 { branch: null, head: null }', async () => {
    const notRepo = await tempDir('astera-gitprobe-notrepo-')
    await expect(readGitRef(notRepo)).resolves.toEqual({ branch: null, head: null })
  })

  it('detached HEAD → branch 는 null', async () => {
    const repo = await makeRepo()
    const hash = headHash(repo)
    run(repo, ['checkout', '-q', hash])
    const ref = await readGitRef(repo)
    expect(ref.branch).toBeNull()
    expect(ref.head).toBe(hash)
  })
})

describe('readGitRef + isAncestorOf → classifyTransition (끝에서 끝까지)', () => {
  it('커밋을 하나 더 쌓으면 fast-forward', async () => {
    const repo = await makeRepo()
    const before = await readGitRef(repo)

    await fs.writeFile(path.join(repo, 'g.txt'), 'y', 'utf8')
    run(repo, ['add', 'g.txt'])
    run(repo, ['commit', '-m', 'second'])

    const after = await readGitRef(repo)
    const isAncestor = await isAncestorOf(repo, before.head, after.head)
    expect(isAncestor).toBe(true)
    expect(classifyTransition(before, after, isAncestor)).toBe('fast-forward')
  })

  it('새 브랜치를 만들어 옮겨 타면 branch-switch', async () => {
    const repo = await makeRepo()
    const before = await readGitRef(repo)

    run(repo, ['checkout', '-q', '-b', 'feature'])

    const after = await readGitRef(repo)
    const isAncestor = await isAncestorOf(repo, before.head, after.head)
    expect(classifyTransition(before, after, isAncestor)).toBe('branch-switch')
  })

  it('commit --amend 로 역사를 바꾸면 history-rewritten', async () => {
    const repo = await makeRepo()
    const before = await readGitRef(repo)

    run(repo, ['commit', '--amend', '-m', 'rewritten'])

    const after = await readGitRef(repo)
    expect(after.head).not.toBe(before.head)
    const isAncestor = await isAncestorOf(repo, before.head, after.head)
    expect(isAncestor).toBe(false)
    expect(classifyTransition(before, after, isAncestor)).toBe('history-rewritten')
  })
})

describe('isAncestorOf', () => {
  it('before 나 after 가 null 이면 묻지 않고 null', async () => {
    const repo = await makeRepo()
    const hash = headHash(repo)
    expect(await isAncestorOf(repo, null, hash)).toBeNull()
    expect(await isAncestorOf(repo, hash, null)).toBeNull()
    expect(await isAncestorOf(repo, null, null)).toBeNull()
  })

  it('저장소에 없는 커밋 해시가 하나라도 있으면 null — false 로 뭉개지 않는다', async () => {
    const repo = await makeRepo()
    const hash = headHash(repo)
    expect(await isAncestorOf(repo, hash, MISSING_HASH)).toBeNull()
    expect(await isAncestorOf(repo, MISSING_HASH, hash)).toBeNull()
  })
})
