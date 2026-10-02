import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { makeRepo, tempDir, gitSync } from '../../core/worktrees/testRepo'
import { classifyTransition } from '../../core/git/transition'
import { readGitRef, isAncestorOf, readChangedFiles } from './gitProbe'
import type { GitRun } from '../../core/git/range'
import { git, type GitResult } from '../../core/worktrees/git'

const run = (repo: string, args: string[]): void => {
  gitSync(repo, args)
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

describe('readChangedFiles', () => {
  it('바뀐 파일을 준다', async () => {
    const repo = await makeRepo()
    await fs.writeFile(path.join(repo, 'n.txt'), 'n', 'utf8')
    expect(await readChangedFiles(repo)).toEqual(['n.txt'])
  })

  it('깨끗한 작업 트리는 빈 목록이다', async () => {
    const repo = await makeRepo()
    expect(await readChangedFiles(repo)).toEqual([])
  })

  // 저장소가 아닌 폴더는 "모름"이 아니라 확실한 답이다: 바뀐 것을 잴 git 이 없으니 바뀐 것도 없다.
  // 탐색기(ipc.ts 의 git.status)가 그렇게 다룬다. null 로 주면 수집기가 git 없는 프로젝트의 모든
  // 완료를 "모름"으로 붙잡아 파일 없는 기록과 설명 에이전트를 만든다.
  it('git 저장소가 아닌 폴더는 null 이 아니라 빈 목록이다 (확실히 바뀐 것 없음)', async () => {
    const notRepo = await tempDir('astera-gitprobe-changed-notrepo-')
    expect(await readChangedFiles(notRepo)).toEqual([])
  })

  // git 이 답하지 못했을 때 []를 주면 깨끗한 작업 트리와 구별되지 않는다 — 수집기가 그것을 "바뀐 것
  // 없음"으로 읽고 Unit 을 지운다.
  it('저장소인데 status 가 실패하면 빈 목록이 아니라 null(모름)이다', async () => {
    const repo = await makeRepo()
    await fs.writeFile(path.join(repo, '.git', 'index'), 'not an index', 'utf8')
    expect(await readChangedFiles(repo)).toBeNull()
  })

  it('폴더가 없어 git 을 띄우지도 못하면 null(모름)이다', async () => {
    const parent = await tempDir('astera-gitprobe-changed-gone-')
    expect(await readChangedFiles(path.join(parent, 'gone'))).toBeNull()
  })
})

// ── git 을 몇 번 띄우는가 (stage 4, task 4) ────────────────────────────
// 감시 회차마다 도는 두 물음이다. 프로세스 하나하나가 Windows 에서는 바이러스 백신 검사 값을 치른다.

const counting = (): { calls: string[][]; run: GitRun } => {
  const calls: string[][] = []
  return {
    calls,
    run: (args, opts) => {
      calls.push(args)
      return git(args, opts)
    }
  }
}

/** git 을 띄우지 않고 정해진 답을 주는 runner — 시간 초과처럼 진짜로 만들기 어려운 답을 흉내 낸다 */
const answering = (answer: GitResult): GitRun => async () => answer

describe('readGitRef — 띄우는 수', () => {
  it('보통의 저장소에서는 git 한 번으로 브랜치와 HEAD 를 함께 읽는다', async () => {
    const repo = await makeRepo()
    const { calls, run } = counting()
    const ref = await readGitRef(repo, run)
    expect(ref).toEqual({ branch: 'main', head: headHash(repo) })
    expect(calls).toHaveLength(1)
  })

  it('브랜치와 같은 이름의 태그가 있어도 symbolic-ref --short 와 같은 이름을 준다', async () => {
    const repo = await makeRepo()
    run(repo, ['tag', 'main'])
    const expected = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: repo,
      windowsHide: true,
      encoding: 'utf8'
    }).trim()
    expect((await readGitRef(repo)).branch).toBe(expected)
  })

  it('git 이 답하지 못하면(시간 초과) 둘 다 null 이다 — 지어내지 않는다', async () => {
    const repo = await makeRepo()
    const ref = await readGitRef(repo, answering({ ok: false, stdout: '', stderr: 'timed out', timedOut: true }))
    expect(ref).toEqual({ branch: null, head: null })
  })
})

describe('isAncestorOf — 띄우는 수와 모름', () => {
  it('두 커밋이 있으면 merge-base 한 번으로 답한다', async () => {
    const repo = await makeRepo()
    const before = headHash(repo)
    await fs.writeFile(path.join(repo, 'g.txt'), 'y', 'utf8')
    run(repo, ['add', 'g.txt'])
    run(repo, ['commit', '-m', 'second'])
    const after = headHash(repo)
    const { calls, run: counted } = counting()
    expect(await isAncestorOf(repo, before, after, counted)).toBe(true)
    expect(await isAncestorOf(repo, after, before, counted)).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('merge-base 가 답하지 못하면(종료 코드 없음) null — false 가 아니다', async () => {
    const repo = await makeRepo()
    const h = headHash(repo)
    const timedOut = answering({ ok: false, stdout: '', stderr: 'timed out', timedOut: true })
    expect(await isAncestorOf(repo, h, h, timedOut)).toBeNull()
  })

  it('종료 코드 1 만 "조상이 아니다"이고, 그 밖의 실패 코드는 null 이다', async () => {
    const repo = await makeRepo()
    const h = headHash(repo)
    expect(await isAncestorOf(repo, h, h, answering({ ok: false, stdout: '', stderr: '', exitCode: 1 }))).toBe(false)
    expect(await isAncestorOf(repo, h, h, answering({ ok: false, stdout: '', stderr: 'fatal', exitCode: 128 }))).toBeNull()
  })
})
