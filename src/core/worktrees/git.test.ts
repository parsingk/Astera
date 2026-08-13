import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  git, repoRoot, gitDir, gitUserName, detectBaseRef, toFullRef, fetchBaseRef,
  localBranchExists, isCleanWorktree, listGitWorktrees, gitVersionAtLeast, listBranches
} from './git'
import { makeRepo, addOrigin } from './testRepo'

let repo: string
beforeEach(async () => {
  repo = await makeRepo()
})

describe('git 어댑터', () => {
  it('repoRoot: repo 안 → 루트, 밖 → null', async () => {
    const sub = path.join(repo, 'sub')
    await fs.mkdir(sub)
    expect(await repoRoot(sub)).toBe(path.resolve(repo))
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-wt-out-'))
    expect(await repoRoot(out)).toBeNull()
  })

  it('gitUserName: 설정값 반환', async () => {
    expect(await gitUserName(repo)).toBe('Test User')
  })

  it('detectBaseRef: origin 없으면 로컬 main, origin/HEAD 있으면 origin/main', async () => {
    expect(await detectBaseRef(repo)).toBe('main')
    await addOrigin(repo)
    expect(await detectBaseRef(repo)).toBe('origin/main')
  })

  it('detectBaseRef: 브랜치가 hotfix뿐이면 null', async () => {
    execFileSync('git', ['branch', '-m', 'main', 'hotfix'], { cwd: repo, windowsHide: true })
    expect(await detectBaseRef(repo)).toBeNull()
  })

  it('detectBaseRef: origin/HEAD 미설정이어도 loop로 origin/main 탐지 (로컬 main보다 우선)', async () => {
    await addOrigin(repo)
    await git(['remote', 'set-head', 'origin', '--delete'], { cwd: repo })
    // 로컬 main 브랜치도 여전히 존재 — BASE_PROBES 순서상 origin/main이 먼저 매칭돼야 하는 계약
    expect(await localBranchExists(repo, 'main')).toBe(true)
    expect(await detectBaseRef(repo)).toBe('origin/main')
  })

  it('detectBaseRef: origin/master (entry 2) — origin/HEAD 미설정 시 폴백', async () => {
    execFileSync('git', ['branch', '-m', 'main', 'master'], { cwd: repo, windowsHide: true })
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-wt-origin-'))
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: bare, windowsHide: true })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo, windowsHide: true })
    execFileSync('git', ['push', '-u', 'origin', 'master'], { cwd: repo, windowsHide: true })
    expect(await detectBaseRef(repo)).toBe('origin/master')
  })

  it('detectBaseRef: master 로컬 전용 (entry 4)', async () => {
    execFileSync('git', ['branch', '-m', 'main', 'master'], { cwd: repo, windowsHide: true })
    expect(await detectBaseRef(repo)).toBe('master')
  })

  it('toFullRef: 검증된 완전 ref로 승격', async () => {
    expect(await toFullRef(repo, 'main')).toBe('refs/heads/main')
    expect(await toFullRef(repo, 'no-such')).toBeNull()
    await addOrigin(repo)
    expect(await toFullRef(repo, 'origin/main')).toBe('refs/remotes/origin/main')
  })

  it('fetchBaseRef: 로컬 base는 local, 원격 base는 fetched, 원격 소실+로컬 ref 있음은 stale', async () => {
    expect(await fetchBaseRef(repo, 'main')).toBe('local')
    const bare = await addOrigin(repo)
    expect(await fetchBaseRef(repo, 'origin/main')).toBe('fetched')
    await fs.rm(bare, { recursive: true, force: true }) // 원격 소실 시뮬레이션
    expect(await fetchBaseRef(repo, 'origin/main')).toBe('stale')
  })

  it('fetchBaseRef: 원격 자체가 없고 로컬 추적 ref도 없으면 FETCH_FAILED', async () => {
    // addOrigin을 쓰지 않음 — push한 적이 없으니 refs/remotes/origin/main이 애초에 존재하지 않는다
    const missing = path.join(os.tmpdir(), `astera-wt-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    execFileSync('git', ['remote', 'add', 'origin', missing], { cwd: repo, windowsHide: true })
    await expect(fetchBaseRef(repo, 'origin/main')).rejects.toThrow(/FETCH_FAILED/)
  })

  it('fetchBaseRef: 슬래시가 든 로컬 브랜치를 원격으로 오판하지 않는다', async () => {
    // 'parsingk/maple'은 origin/main과 같은 <a>/<b> 모양이다. 이름 모양으로 판정하면
    // git fetch parsingk refs/heads/maple을 시도해 FETCH_FAILED로 죽고, worktree 생성 자체가 실패한다
    execFileSync('git', ['branch', 'parsingk/maple'], { cwd: repo, windowsHide: true })
    expect(await fetchBaseRef(repo, 'parsingk/maple')).toBe('local')
  })

  it('fetchBaseRef: 로컬과 원격에 같은 이름이 있으면 원격으로 본다', async () => {
    // origin/main이 있는 상태에서 'origin/main'이라는 로컬 브랜치까지 만들어도 원격 판정이 우선이다
    await addOrigin(repo)
    expect(await fetchBaseRef(repo, 'origin/main')).toBe('fetched')
  })

  it('listBranches: 로컬과 원격을 모두 짧은 이름으로 돌려주고 origin/HEAD는 제외한다', async () => {
    await addOrigin(repo) // origin/main + origin/HEAD(symref)를 만든다
    execFileSync('git', ['branch', 'feature/x'], { cwd: repo, windowsHide: true })
    const names = (await listBranches(repo)).map((b) => b.name)
    expect(names).toContain('main')
    expect(names).toContain('feature/x')
    expect(names).toContain('origin/main')
    expect(names).not.toContain('origin/HEAD') // 실제 브랜치가 아니라 symref
    expect(names.some((n) => n.startsWith('refs/'))).toBe(false) // 전부 짧은 형태
  })

  it('listBranches: remote 플래그로 원격과 로컬을 구분한다', async () => {
    await addOrigin(repo)
    const byName = new Map((await listBranches(repo)).map((b) => [b.name, b]))
    expect(byName.get('main')?.remote).toBe(false)
    expect(byName.get('origin/main')?.remote).toBe(true)
  })

  it('listBranches: 마지막 커밋이 최신인 순으로 정렬한다', async () => {
    // main보다 나중에 커밋된 브랜치를 만든다. 이름은 일부러 알파벳 뒤쪽으로 둬서, 정렬이 이름순이면
    // 실패하게 한다. committerdate는 초 단위라 그냥 커밋하면 main과 동률이 되고 동률일 때
    // for-each-ref는 refname 순으로 폴백하므로, 날짜를 명시해 시각을 확실히 벌린다
    execFileSync('git', ['checkout', '-q', '-b', 'zzz-newer'], { cwd: repo, windowsHide: true })
    await fs.writeFile(path.join(repo, 'n.txt'), 'n', 'utf8')
    execFileSync('git', ['add', 'n.txt'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'newer'], {
      cwd: repo,
      windowsHide: true,
      env: { ...process.env, GIT_COMMITTER_DATE: '2030-01-01T00:00:00', GIT_AUTHOR_DATE: '2030-01-01T00:00:00' }
    })
    const locals = (await listBranches(repo)).filter((b) => !b.remote).map((b) => b.name)
    expect(locals.indexOf('zzz-newer')).toBeLessThan(locals.indexOf('main'))
  })

  it('listBranches: 현재 브랜치에만 current가 붙는다', async () => {
    execFileSync('git', ['branch', 'other'], { cwd: repo, windowsHide: true })
    const list = await listBranches(repo)
    expect(list.filter((b) => b.current).map((b) => b.name)).toEqual(['main'])
  })

  it('listBranches: detached HEAD면 current인 항목이 없다', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim()
    execFileSync('git', ['checkout', '-q', head], { cwd: repo, windowsHide: true })
    const list = await listBranches(repo)
    expect(list.length).toBeGreaterThan(0)
    expect(list.some((b) => b.current)).toBe(false)
  })

  it('listBranches: updatedAt이 파싱 가능한 날짜다', async () => {
    const list = await listBranches(repo)
    expect(Number.isNaN(Date.parse(list[0].updatedAt))).toBe(false)
  })

  it('localBranchExists / isCleanWorktree', async () => {
    expect(await localBranchExists(repo, 'main')).toBe(true)
    expect(await localBranchExists(repo, 'nope')).toBe(false)
    expect((await isCleanWorktree(repo)).clean).toBe(true)
    await fs.writeFile(path.join(repo, 'new.txt'), 'y', 'utf8')
    const r = await isCleanWorktree(repo)
    expect(r.clean).toBe(false)
    expect(r.changedCount).toBe(1)
  })

  it('isCleanWorktree: git repo가 아니면 GIT_REMOVE_FAILED', async () => {
    const notRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-wt-notrepo-'))
    await expect(isCleanWorktree(notRepo)).rejects.toThrow(/GIT_REMOVE_FAILED/)
  })

  it('listGitWorktrees: 메인 + 추가 worktree 파싱', async () => {
    const wt = path.join(repo, '.wt-x')
    await git(['worktree', 'add', '--no-track', '-b', 'x', wt, 'refs/heads/main'], { cwd: repo })
    const rows = await listGitWorktrees(repo)
    expect(rows.length).toBe(2)
    expect(rows.some((r) => path.resolve(r.path) === path.resolve(wt) && r.branch === 'x')).toBe(true)
  })

  it('listGitWorktrees: git repo가 아니면 GIT_REMOVE_FAILED', async () => {
    const notRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-wt-notrepo-'))
    await expect(listGitWorktrees(notRepo)).rejects.toThrow(/GIT_REMOVE_FAILED/)
  })

  it('gitVersionAtLeast: 2.0은 항상 true', async () => {
    expect(await gitVersionAtLeast(2, 0)).toBe(true)
    expect(await gitVersionAtLeast(99, 0)).toBe(false)
  })
})

describe('git() trim 옵션', () => {
  it('기본은 기존대로 trim한다', async () => {
    const repo = await makeRepo()
    const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })
    expect(r.stdout).toBe('main') // 개행 없음
  })

  it('trim:false면 porcelain의 선행 공백을 보존한다', async () => {
    const repo = await makeRepo()
    // makeRepo가 커밋해 둔 f.txt를 고쳐 "스테이지 안 된 수정"을 만든다 → 레코드가 " M f.txt"
    await fs.writeFile(path.join(repo, 'f.txt'), 'changed', 'utf8')
    const r = await git(
      ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'],
      { cwd: repo, trim: false }
    )
    expect(r.ok).toBe(true)
    expect(r.stdout.startsWith(' M f.txt')).toBe(true)
    expect(r.stdout.endsWith('\0')).toBe(true)
  })

  it('trim 기본값이면 같은 출력의 선행 공백이 사라진다 (옵션이 필요한 이유)', async () => {
    const repo = await makeRepo()
    await fs.writeFile(path.join(repo, 'f.txt'), 'changed', 'utf8')
    const r = await git(
      ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'],
      { cwd: repo }
    )
    expect(r.stdout.startsWith('M f.txt')).toBe(true) // 한 칸 밀렸다
  })
})

describe('gitDir', () => {
  it('일반 저장소에서는 <repo>/.git', async () => {
    const repo = await makeRepo()
    const d = await gitDir(repo)
    expect(d).not.toBeNull()
    expect(path.basename(d as string)).toBe('.git')
    expect((await fs.stat(path.join(d as string, 'HEAD'))).isFile()).toBe(true)
  })

  it('링크된 worktree에서는 그 worktree 전용 git dir', async () => {
    const repo = await makeRepo()
    const wt = path.join(repo, '..', `wt-${path.basename(repo)}`)
    await git(['worktree', 'add', '-b', 'feat', wt], { cwd: repo })
    const d = await gitDir(wt)
    expect(d).not.toBeNull()
    // 주저장소의 .git/worktrees/<이름> 아래여야 한다 — <wt>/.git 이 아니다
    expect((d as string).includes('worktrees')).toBe(true)
    expect((await fs.stat(path.join(d as string, 'HEAD'))).isFile()).toBe(true)
    await git(['worktree', 'remove', '--force', wt], { cwd: repo })
  })

  it('git 저장소가 아니면 null', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-git-plain-'))
    expect(await gitDir(plain)).toBeNull()
  })
})
