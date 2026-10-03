import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { makeRepo, tempDir, gitSync, addOrigin } from '../worktrees/testRepo'
import { readRange, readRangeFiles, readHeadSteps } from './range'


const run = (repo: string, args: string[]): void => {
  gitSync(repo, args)
}

const headHash = (repo: string): string =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim()

// 저장소에 없는 40자 hex — 실제 오브젝트가 아니다
const MISSING_HASH = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

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

    const range = (await readRange(repo, before, after))!
    // git log 는 최신 커밋을 먼저 낸다
    expect(range.commits).toEqual([after, mid])
    expect(range.changedFiles.sort()).toEqual(['g.txt', 'has space/한글.txt'])
    // subjects: same order and count as commits, but the human-readable line instead of the hash —
    // this is what feeds the write-up pipeline's material (core/understanding/pipeline.ts)
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

    const range = (await readRange(repo, before, after))!
    expect(range.commits).toEqual([after])
    expect(range.changedFiles).toEqual(['g.txt'])
  })

  // 모른다는 것은 비었다는 것이 아니다. 실패(저장소가 아니다, 시간 초과, 출력 한도)를 빈 목록으로
  // 주면 큰 pull 뒤의 기록이 "아무 것도 안 바뀌었다"로 남는다 — null 이 그 둘을 가른다.
  it('git 저장소가 아닌 디렉터리 → 던지지 않고 null(모름) — 빈 목록이 아니다', async () => {
    const notRepo = await tempDir('astera-gitprobe-range-notrepo-')
    await expect(readRange(notRepo, MISSING_HASH, MISSING_HASH)).resolves.toBeNull()
  })

  it('저장소에 없는 커밋이 끼면 null(모름)이다', async () => {
    const repo = await makeRepo()
    await expect(readRange(repo, MISSING_HASH, headHash(repo))).resolves.toBeNull()
  })

  it('두 HEAD 가 같은 구간은 null 이 아니라 빈 목록이다', async () => {
    const repo = await makeRepo()
    const h = headHash(repo)
    await expect(readRange(repo, h, h)).resolves.toEqual({ commits: [], changedFiles: [], authors: [], subjects: [] })
  })

  // EG §6 이 pull 에서 수집할 것으로 `Authors` 를 적었고 §40 이 "author metadata" 를 필수 단위
  // 테스트로 걸었다. 이름은 **형식 문자열에 붙이지 않고 따로 묻는다** — 그 이유는 range.ts 의
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

    const range = (await readRange(repo, before, after))!
    expect(range.commits).toHaveLength(3)
    expect(range.authors).toEqual(['Alice A', 'Bob  B'])
    // 이 구간을 연 커밋의 author('Test User', makeRepo 가 심었다)는 before 자신이라 범위 밖이다
    expect(range.authors).not.toContain('Test User')
  })
})

describe('readRangeFiles', () => {
  it('gives the files of the range, unquoted, and null when git cannot answer', async () => {
    const repo = await makeRepo()
    const before = headHash(repo)
    await fs.mkdir(path.join(repo, 'has space'), { recursive: true })
    await fs.writeFile(path.join(repo, 'has space', '한글.txt'), 'z', 'utf8')
    run(repo, ['add', '-A'])
    run(repo, ['commit', '-m', 'second'])
    const after = headHash(repo)

    await expect(readRangeFiles(repo, before, after)).resolves.toEqual(['has space/한글.txt'])
    await expect(readRangeFiles(repo, after, after)).resolves.toEqual([])
    await expect(readRangeFiles(repo, MISSING_HASH, after)).resolves.toBeNull()
  })
})

describe('readHeadSteps', () => {
  const commit = async (repo: string, name: string): Promise<void> => {
    await fs.writeFile(path.join(repo, name), name, 'utf8')
    run(repo, ['add', name])
    run(repo, ['commit', '-m', `add ${name}`])
  }

  it('plain commits: one step each, newest first', async () => {
    const repo = await makeRepo()
    const before = headHash(repo)
    await commit(repo, 'a.txt')
    await commit(repo, 'b.txt')
    await expect(readHeadSteps(repo, before, headHash(repo))).resolves.toEqual(['commit: add b.txt', 'commit: add a.txt'])
  })

  it('a subject with spaces, colons and non-ASCII text comes back whole', async () => {
    const repo = await makeRepo()
    const before = headHash(repo)
    await fs.writeFile(path.join(repo, 'k.txt'), 'k', 'utf8')
    run(repo, ['add', 'k.txt'])
    run(repo, ['commit', '-m', '한글 fix: x y'])
    await expect(readHeadSteps(repo, before, headHash(repo))).resolves.toEqual(['commit: 한글 fix: x y'])
  })

  it('the pull subjects git writes carry the pull arguments', async () => {
    const repo = await makeRepo()
    const bare = await addOrigin(repo)
    const other = await tempDir('astera-range-clone-')
    run(other, ['clone', '-q', bare, '.'])
    run(other, ['config', 'user.email', 't@t.com'])
    run(other, ['config', 'user.name', 'Other'])
    await commit(other, 'p.txt')
    run(other, ['push', '-q', 'origin', 'main'])
    const before = headHash(repo)
    run(repo, ['pull', '-q', '--ff-only', 'origin', 'main'])
    await expect(readHeadSteps(repo, before, headHash(repo))).resolves.toEqual(['pull -q --ff-only origin main: Fast-forward'])
    await commit(other, 'q.txt')
    run(other, ['push', '-q', 'origin', 'main'])
    await commit(repo, 'r.txt')
    const mid = headHash(repo)
    run(repo, ['-c', 'user.name=T', 'pull', '-q', '--rebase', 'origin', 'main'])
    const steps = (await readHeadSteps(repo, mid, headHash(repo)))!
    expect(steps[0]).toBe('pull -q --rebase origin main (finish): returning to refs/heads/main')
    expect(steps.every((x) => x.startsWith('pull '))).toBe(true)
  })

  it('a fast-forward merge is one merge step, and the checkouts before it are not walked', async () => {
    const repo = await makeRepo()
    run(repo, ['branch', 'o'])
    run(repo, ['checkout', '-q', 'o'])
    await commit(repo, 'o.txt')
    run(repo, ['checkout', '-q', 'main'])
    const before = headHash(repo)
    run(repo, ['merge', '-q', '--ff-only', 'o'])
    await expect(readHeadSteps(repo, before, headHash(repo))).resolves.toEqual(['merge o: Fast-forward'])
  })

  it('a pull that merges is one pull step', async () => {
    const repo = await makeRepo()
    const bare = await addOrigin(repo)
    const other = await tempDir('astera-range-clone-')
    run(other, ['clone', '-q', bare, '.'])
    run(other, ['config', 'user.email', 't@t.com'])
    run(other, ['config', 'user.name', 'Other'])
    await commit(other, 'p.txt')
    run(other, ['push', '-q', 'origin', 'main'])
    await commit(repo, 'c.txt')
    const before = headHash(repo)
    run(repo, ['pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main'])
    const steps = (await readHeadSteps(repo, before, headHash(repo)))!
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatch(/^pull/)
  })

  it('a reset is one reset step', async () => {
    const repo = await makeRepo()
    const start = headHash(repo)
    await commit(repo, 'a.txt')
    const before = headHash(repo)
    run(repo, ['reset', '-q', '--hard', start])
    const steps = (await readHeadSteps(repo, before, start))!
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatch(/^reset: /)
  })

  it('reads the HEAD reflog of a linked worktree, not the main one', async () => {
    const repo = await makeRepo()
    const wt = path.join(await tempDir('astera-range-wt-'), 'wt')
    run(repo, ['worktree', 'add', '-q', '-b', 'side', wt])
    const before = headHash(wt)
    await commit(wt, 'w.txt')
    await expect(readHeadSteps(wt, before, headHash(wt))).resolves.toEqual(['commit: add w.txt'])
    // The main worktree's HEAD did not move, so it has no step from before to the side commit
    await expect(readHeadSteps(repo, before, headHash(wt))).resolves.toBeNull()
  })

  it('null when the reflog does not reach before, or does not start at after', async () => {
    const repo = await makeRepo()
    const before = headHash(repo)
    await commit(repo, 'a.txt')
    const after = headHash(repo)
    await expect(readHeadSteps(repo, MISSING_HASH, after)).resolves.toBeNull()
    await commit(repo, 'b.txt') // HEAD moved on: the newest entry is no longer after
    await expect(readHeadSteps(repo, before, after)).resolves.toBeNull()
  })

  it('null when git cannot answer (not a repository)', async () => {
    const plain = await tempDir('astera-range-plain-')
    await expect(readHeadSteps(plain, MISSING_HASH, MISSING_HASH)).resolves.toBeNull()
  })
})
