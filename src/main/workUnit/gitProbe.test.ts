import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { makeRepo, tempDir } from '../../core/worktrees/testRepo'
import { classifyTransition } from '../../core/git/transition'
import { readGitRef, isAncestorOf, readRange } from './gitProbe'

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

describe('readRange', () => {
  it('fast-forward 구간의 커밋과 파일이 들어 있다', async () => {
    const repo = await makeRepo()
    const before = headHash(repo)

    await fs.writeFile(path.join(repo, 'g.txt'), 'y', 'utf8')
    run(repo, ['add', 'g.txt'])
    run(repo, ['commit', '-m', 'second'])
    const mid = headHash(repo)

    // 공백이 든 디렉터리에 한글 파일명 — 인용·8진 이스케이프 없이 그대로 돌아오는지 확인한다
    // (실측: -c core.quotePath=false 없이는 "has space/\355\225\234\352\270\200.txt" 로 온다)
    await fs.mkdir(path.join(repo, 'has space'), { recursive: true })
    await fs.writeFile(path.join(repo, 'has space', '한글.txt'), 'z', 'utf8')
    run(repo, ['add', '-A'])
    run(repo, ['commit', '-m', 'third'])
    const after = headHash(repo)

    const range = await readRange(repo, before, after)
    // git log 는 최신 커밋을 먼저 낸다
    expect(range.commits).toEqual([after, mid])
    expect(range.changedFiles.sort()).toEqual(['g.txt', 'has space/한글.txt'])
    // subjects: same order and count as commits, but the human-readable line instead of the hash —
    // this is what feeds the write-up pipeline's material (main/understanding/pipeline.ts)
    expect(range.subjects).toEqual(['third', 'second'])
  })

  it('SHA-256 저장소의 64자 해시를 파일로 오인하지 않는다', async () => {
    // 저장소 초기화 자체가 SHA-256 을 지원하는 git 빌드를 요구한다(실험 기능) — 지원하지 않는
    // 환경에서는 init 이 그 자리에서 실패하므로 그때는 이 테스트를 건너뛴다.
    const repo = await tempDir('astera-gitprobe-sha256-')
    try {
      run(repo, ['init', '-q', '-b', 'main', '--object-format=sha256'])
    } catch {
      return
    }
    run(repo, ['config', 'user.email', 't@t.com'])
    run(repo, ['config', 'user.name', 'T'])
    await fs.writeFile(path.join(repo, 'f.txt'), 'x', 'utf8')
    run(repo, ['add', 'f.txt'])
    run(repo, ['commit', '-m', 'init'])
    const before = headHash(repo)
    await fs.writeFile(path.join(repo, 'g.txt'), 'y', 'utf8')
    run(repo, ['add', 'g.txt'])
    run(repo, ['commit', '-m', 'second'])
    const after = headHash(repo)
    expect(after).toHaveLength(64) // SHA-256 해시 — 40자 hex 모양 판정이 있었다면 여기서 깨졌을 것이다

    const range = await readRange(repo, before, after)
    expect(range.commits).toEqual([after])
    expect(range.changedFiles).toEqual(['g.txt'])
  })

  it('git 저장소가 아닌 디렉터리 → 던지지 않고 빈 목록', async () => {
    const notRepo = await tempDir('astera-gitprobe-range-notrepo-')
    await expect(readRange(notRepo, MISSING_HASH, MISSING_HASH)).resolves.toEqual({
      commits: [],
      changedFiles: [],
      authors: [],
      subjects: []
    })
  })

  // EG §6 이 pull 에서 수집할 것으로 `Authors` 를 적었고 §40 이 "author metadata" 를 필수 단위
  // 테스트로 걸었다. 이름은 **형식 문자열에 붙이지 않고 따로 묻는다** — 그 이유는 gitProbe.ts 의
  // readRange 주석에 있다. 여기서 한 번에 셋을 본다: 나오는 차례(git log 는 최신이 먼저다),
  // 중복 제거, 그리고 이름 안의 공백이 그대로 남는가.
  it('구간의 author 이름을 중복 없이 모은다 — 공백이 든 이름도 그대로다', async () => {
    const repo = await makeRepo()
    const before = headHash(repo)

    const commitAs = async (name: string, file: string): Promise<void> => {
      await fs.writeFile(path.join(repo, file), file, 'utf8')
      run(repo, ['add', file])
      run(repo, ['-c', `user.name=${name}`, '-c', 'user.email=x@x.com', 'commit', '-m', file])
    }
    await commitAs('Alice A', 'a.txt')
    // 가운데 공백이 둘이다 — 접히거나 깎이면 여기서 드러난다
    await commitAs('Bob  B', 'b.txt')
    // 같은 사람이 다시 — 목록에 한 번만 있어야 한다
    await commitAs('Alice A', 'c.txt')
    const after = headHash(repo)

    const range = await readRange(repo, before, after)
    expect(range.commits).toHaveLength(3)
    expect(range.authors).toEqual(['Alice A', 'Bob  B'])
    // 이 구간을 연 커밋의 author('Test User', makeRepo 가 심었다)는 before 자신이라 범위 밖이다
    expect(range.authors).not.toContain('Test User')
  })
})
