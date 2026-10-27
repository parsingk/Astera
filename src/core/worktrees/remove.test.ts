import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { removeWorktree, isDangerousRemovalPath, isPermissionFailure } from './remove'
import { createWorktree } from './create'
import { WorktreeRegistry } from './registry'
import { localBranchExists } from './git'
import { makeRepo, tempDir } from './testRepo'
import { absPath } from '../testPaths'

const noUse = (): null => null
let repo: string
let reg: WorktreeRegistry

const gitIn = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim()

beforeEach(async () => {
  repo = await makeRepo('astera-wt-rm-')
  const root = await tempDir('astera-wt-rmroot-')
  const regDir = await tempDir('astera-wt-rmreg-')
  reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
  await reg.load()
})

describe('isPermissionFailure', () => {
  it("knows git's Windows wordings and errno codes", () => {
    expect(isPermissionFailure("error: failed to delete 'a/b': Permission denied", 'win32')).toBe(true)
    expect(isPermissionFailure('fatal: Access is denied.', 'win32')).toBe(true)
    expect(isPermissionFailure(new Error('EPERM: operation not permitted, unlink'), 'win32')).toBe(true)
    expect(isPermissionFailure(Object.assign(new Error('x'), { code: 'EACCES' }), 'win32')).toBe(true)
  })
  it('is false for other failures and off Windows', () => {
    expect(isPermissionFailure('fatal: not a working tree', 'win32')).toBe(false)
    expect(isPermissionFailure(new Error('ENOENT: no such file'), 'win32')).toBe(false)
    expect(isPermissionFailure('Permission denied', 'linux')).toBe(false)
  })
})

describe('isDangerousRemovalPath', () => {
  it('repo 자체·홈·홈 상위·드라이브 루트는 위험', () => {
    const home = absPath('Users', 'me')
    const repoPath = absPath('repos', 'app')
    expect(isDangerousRemovalPath(repoPath, repoPath, home)).toBe(true)
    expect(isDangerousRemovalPath(home, repoPath, home)).toBe(true)
    expect(isDangerousRemovalPath(absPath('Users'), repoPath, home)).toBe(true) // 홈 포함 상위
    expect(isDangerousRemovalPath(path.parse(repoPath).root, repoPath, home)).toBe(true) // 파일시스템 루트
    expect(isDangerousRemovalPath(absPath('repos'), repoPath, home)).toBe(true) // repo 포함 상위
    expect(isDangerousRemovalPath(absPath('Users', 'me', 'wt', 'a'), repoPath, home)).toBe(false)
  })
})

describe('removeWorktree', () => {
  it('깨끗한 worktree: 디렉토리 제거 + 미머지 브랜치 보존', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'clean', registry: reg })
    await fs.writeFile(path.join(info.path, 'w.txt'), 'w', 'utf8')
    gitIn(info.path, ['add', 'w.txt'])
    gitIn(info.path, ['commit', '-m', 'work']) // base에 없는 커밋 = 미머지
    const r = await removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse })
    expect(r.removed).toBe(true)
    expect(r.branchDeleted).toBe(false)
    expect(r.branchPreserved?.branch).toBe(info.branch)
    expect(existsSync(info.path)).toBe(false)
    expect(await localBranchExists(repo, info.branch)).toBe(true) // 보존
    expect(reg.get(info.id)).toBeNull()
  })

  it.runIf(process.platform === 'win32')('a worktree with a read-only file is removed', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'readonly', registry: reg })
    await fs.mkdir(path.join(info.path, 'objs'), { recursive: true })
    const f = path.join(info.path, 'objs', 'obj.bin')
    await fs.writeFile(f, 'x', 'utf8')
    await fs.chmod(f, 0o444)
    const r = await removeWorktree({ id: info.id, force: true, registry: reg, isPathInUse: noUse })
    expect(r.removed).toBe(true)
    expect(existsSync(info.path)).toBe(false)
    expect(reg.get(info.id)).toBeNull()
  })

  describe('the retry after a permission failure', () => {
    const denied = { ok: false, stdout: '', stderr: "error: failed to delete 'x': Permission denied" }
    const okResult = { ok: true, stdout: '', stderr: '' }

    it.runIf(process.platform === 'win32')('git removal failing once is retried once after files were cleared, with the same args', async () => {
      const { info } = await createWorktree({ repoPath: repo, name: 'retry-git', registry: reg })
      const calls: string[][] = []
      const removeGit = async (args: string[]): Promise<typeof okResult> => {
        calls.push(args)
        if (calls.length === 1) return denied
        await fs.rm(info.path, { recursive: true, force: true })
        return okResult
      }
      const r = await removeWorktree({
        id: info.id, registry: reg, isPathInUse: noUse, removeGit, clear: async () => 3
      })
      expect(r.removed).toBe(true)
      expect(calls).toHaveLength(2)
      expect(calls[1]).toEqual(calls[0])
      expect(calls[0]).not.toContain('--force')
    })

    it.runIf(process.platform === 'win32')('is not retried when nothing was cleared, and the original error is reported', async () => {
      const { info } = await createWorktree({ repoPath: repo, name: 'retry-none', registry: reg })
      let n = 0
      const removeGit = async (): Promise<typeof denied> => {
        n++
        return denied
      }
      await expect(
        removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse, removeGit, clear: async () => 0 })
      ).rejects.toThrow(/GIT_REMOVE_FAILED: .*Permission denied/)
      expect(n).toBe(1)
    })

    it.runIf(process.platform === 'win32')('the orphan fs.rm failing with EPERM once is cleared and retried once', async () => {
      const { info } = await createWorktree({ repoPath: repo, name: 'retry-orphan', registry: reg })
      await fs.rm(path.join(repo, '.git', 'worktrees', path.basename(info.path)), { recursive: true, force: true })
      let n = 0
      const rmDir = async (p: string): Promise<void> => {
        n++
        if (n === 1) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
        await fs.rm(p, { recursive: true, force: true })
      }
      const r = await removeWorktree({
        id: info.id, force: true, registry: reg, isPathInUse: noUse, rmDir, clear: async () => 1
      })
      expect(r.removed).toBe(true)
      expect(n).toBe(2)
      expect(existsSync(info.path)).toBe(false)
    })
  })

  it('머지된 브랜치는 -d로 삭제된다', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'merged', registry: reg })
    await fs.writeFile(path.join(info.path, 'm.txt'), 'm', 'utf8')
    gitIn(info.path, ['add', 'm.txt'])
    gitIn(info.path, ['commit', '-m', 'work'])
    gitIn(repo, ['merge', '--no-edit', info.branch]) // base(main)에 머지
    const r = await removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse })
    expect(r.branchDeleted).toBe(true)
    expect(await localBranchExists(repo, info.branch)).toBe(false)
  })

  it('squash 머지 감지: -d는 거부해도 patch-equivalent면 삭제', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'squash', registry: reg })
    await fs.writeFile(path.join(info.path, 's.txt'), 's', 'utf8')
    gitIn(info.path, ['add', 's.txt'])
    gitIn(info.path, ['commit', '-m', 'work'])
    gitIn(repo, ['merge', '--squash', info.branch]) // squash — 머지 커밋 없음
    gitIn(repo, ['commit', '-m', 'squashed'])
    const r = await removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse })
    expect(r.branchDeleted).toBe(true) // -d 실패 → 감지 → -D
  })

  it('미커밋 변경: DIRTY 거부, force면 제거', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'dirty', registry: reg })
    await fs.writeFile(path.join(info.path, 'd.txt'), 'd', 'utf8')
    await expect(removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse })).rejects.toThrow(
      /DIRTY/
    )
    expect(existsSync(info.path)).toBe(true)
    const r = await removeWorktree({ id: info.id, force: true, registry: reg, isPathInUse: noUse })
    expect(r.removed).toBe(true)
    expect(existsSync(info.path)).toBe(false)
  })

  it('사용 중이면 IN_USE 거부', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'used', registry: reg })
    await expect(
      removeWorktree({ id: info.id, registry: reg, isPathInUse: () => '세션이 사용 중' })
    ).rejects.toThrow(/IN_USE/)
    expect(existsSync(info.path)).toBe(true)
  })

  it('미등재 id는 NOT_MANAGED', async () => {
    await expect(removeWorktree({ id: 'nope', registry: reg, isPathInUse: noUse })).rejects.toThrow(
      /NOT_MANAGED/
    )
  })

  it('고아: 디렉토리가 이미 없으면 레지스트리 정리만', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'gone', registry: reg })
    gitIn(repo, ['worktree', 'remove', info.path]) // 외부에서 제거됨
    const r = await removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse })
    expect(r.removed).toBe(true)
    expect(reg.get(info.id)).toBeNull()
  })

  it('고아: git이 잊었지만 디렉토리가 남음 — 확인 불가로 거부, force면 .git 증명 후 삭제', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'orphan', registry: reg })
    // admin 엔트리(.git/worktrees/<name>)가 곧 등록이다 — 지우면 git이 잊은 상태가 된다
    await fs.rm(path.join(repo, '.git', 'worktrees', path.basename(info.path)), {
      recursive: true,
      force: true
    })
    // git status를 쓸 수 없어 청결을 확인할 수 없다 — 체크아웃된 파일(f.txt)이 남아있어 force 없이는 거부
    await expect(removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse })).rejects.toThrow(
      /ORPHAN_UNVERIFIABLE/
    )
    expect(existsSync(info.path)).toBe(true)
    const r = await removeWorktree({ id: info.id, force: true, registry: reg, isPathInUse: noUse })
    expect(r.removed).toBe(true)
    expect(existsSync(info.path)).toBe(false)
  })

  it('고아: 미커밋/미추적 파일이 있으면 확인 불가로 거부(디렉토리 보존)', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'orphan-dirty', registry: reg })
    await fs.rm(path.join(repo, '.git', 'worktrees', path.basename(info.path)), {
      recursive: true,
      force: true
    })
    await fs.writeFile(path.join(info.path, 'untracked.txt'), 'u', 'utf8') // 미추적 파일
    await expect(removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse })).rejects.toThrow(
      /ORPHAN_UNVERIFIABLE/
    )
    expect(existsSync(info.path)).toBe(true)
  })

  it('고아 확인 불가라도 force면 삭제된다', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'orphan-force', registry: reg })
    await fs.rm(path.join(repo, '.git', 'worktrees', path.basename(info.path)), {
      recursive: true,
      force: true
    })
    await fs.writeFile(path.join(info.path, 'untracked.txt'), 'u', 'utf8') // 미추적 파일
    const r = await removeWorktree({ id: info.id, force: true, registry: reg, isPathInUse: noUse })
    expect(r.removed).toBe(true)
    expect(existsSync(info.path)).toBe(false)
  })

  it('고아: .git만 남으면 force 없이도 삭제된다(빈 케이스는 어렵게 만들지 않는다)', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'orphan-empty', registry: reg })
    await fs.rm(path.join(repo, '.git', 'worktrees', path.basename(info.path)), {
      recursive: true,
      force: true
    })
    await fs.rm(path.join(info.path, 'f.txt'), { force: true }) // 체크아웃된 트랙 파일까지 제거 — .git만 남김
    const r = await removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse })
    expect(r.removed).toBe(true)
    expect(existsSync(info.path)).toBe(false)
  })

  it('디렉토리 소실 + git 등록 남음: 청결 검사 없이 정리 후 레지스트리 제거', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'dirgone', registry: reg })
    await fs.rm(info.path, { recursive: true, force: true }) // 디렉토리만 직접 삭제, git 등록은 남김
    const r = await removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse })
    expect(r.removed).toBe(true)
    expect(reg.get(info.id)).toBeNull()
  })


  it('빈 고아 폴더 + 브랜치도 사라진 상태를 정리한다 (생성이 중간에 깨진 뒤의 모습)', async () => {
    // 실제로 겪은 상태: 레지스트리에는 남아 있는데 git 관리 엔트리도, 브랜치도, 폴더 내용도 없다.
    // 브랜치가 없으면 -d 가 실패하고 머지 판정으로 넘어가는데, 그 경로가 던지면 정리가 막힌다
    const { info } = await createWorktree({ repoPath: repo, name: 'halfmade', registry: reg })
    await fs.rm(path.join(repo, '.git', 'worktrees', path.basename(info.path)), {
      recursive: true,
      force: true
    })
    gitIn(repo, ['branch', '-D', info.branch]) // 브랜치까지 사라진 상태
    await fs.rm(info.path, { recursive: true, force: true })
    await fs.mkdir(info.path) // 빈 폴더만 남는다

    const r = await removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse })
    expect(r.removed).toBe(true)
    expect(r.branchDeleted).toBe(false)
    expect(r.branchPreserved).toBeUndefined() // 없는 브랜치를 '보존했다'고 보고하면 안 된다
    expect(existsSync(info.path)).toBe(false)
    expect(reg.get(info.id)).toBeNull()
  })

  it('고아 증명 실패라도 완전히 빈 디렉토리는 삭제된다', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'unproven-empty', registry: reg })
    await fs.rm(path.join(repo, '.git', 'worktrees', path.basename(info.path)), {
      recursive: true,
      force: true
    })
    // .git 증명도, 남은 파일도 없다 — 잃을 것이 없으므로 소유권 증명을 요구할 이유가 없다
    await fs.rm(info.path, { recursive: true, force: true })
    await fs.mkdir(info.path)
    const r = await removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse })
    expect(r.removed).toBe(true)
    expect(existsSync(info.path)).toBe(false)
  })

  it('고아 증명 실패 + .git 디렉토리만 남은 중첩 repo는 거부한다', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'unproven-nested', registry: reg })
    await fs.rm(path.join(repo, '.git', 'worktrees', path.basename(info.path)), {
      recursive: true,
      force: true
    })
    await fs.rm(info.path, { recursive: true, force: true })
    await fs.mkdir(info.path)
    // .git이 파일이 아니라 디렉토리 = 별개의 repo. 빈 디렉토리 판정이 .git을 빼고 세면 이것이 통째로 지워진다
    await fs.mkdir(path.join(info.path, '.git'))
    await fs.writeFile(path.join(info.path, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
    await expect(removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse })).rejects.toThrow(
      /ORPHAN_UNPROVEN/
    )
    expect(existsSync(info.path)).toBe(true)
  })

  it('삭제 후 비어버린 repo 단위 부모 디렉토리도 정리한다', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'lastone', registry: reg })
    const parent = path.dirname(info.path) // <root>/<repoDirName>
    expect(existsSync(parent)).toBe(true)
    await removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse })
    expect(existsSync(parent)).toBe(false)
    expect(existsSync(reg.getRoot())).toBe(true) // root 자체는 남긴다
  })

  it('같은 repo에 다른 worktree가 남아 있으면 부모 디렉토리는 유지한다', async () => {
    const a = await createWorktree({ repoPath: repo, name: 'keep-a', registry: reg })
    const b = await createWorktree({ repoPath: repo, name: 'keep-b', registry: reg })
    const parent = path.dirname(a.info.path)
    await removeWorktree({ id: a.info.id, registry: reg, isPathInUse: noUse })
    expect(existsSync(parent)).toBe(true)
    expect(existsSync(b.info.path)).toBe(true)
  })

  it('고아 증명 실패(.git 파일 없음, 파일 남음)면 ORPHAN_UNPROVEN', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'unproven', registry: reg })
    await fs.rm(path.join(repo, '.git', 'worktrees', path.basename(info.path)), {
      recursive: true,
      force: true
    })
    await fs.rm(path.join(info.path, '.git'), { force: true }) // 증명 소실
    await expect(removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse })).rejects.toThrow(
      /ORPHAN_UNPROVEN/
    )
    expect(existsSync(info.path)).toBe(true)
  })
})

// 폴더가 있는지는 비동기로, 시간 제한을 두고 묻는다(presence.ts). 동기 existsSync 는 끊긴 네트워크
// 공유에서 20~60초 동안 메인 스레드나 Host 스레드를 세웠다. 그리고 **확인하지 못한 것은 없는 것이
// 아니다** — 시간 초과나 모르는 답으로는 레지스트리 항목도 폴더도 지우지 않는다.
describe('removeWorktree, 폴더 확인이 답하지 못할 때', () => {
  const unreachable = async (): Promise<'unreachable'> => 'unreachable'
  const refused = async (): Promise<'refused'> => 'refused'

  it('원본 저장소를 읽지 못하고 폴더 확인도 시간 초과면 레지스트리 항목을 남기고 거절한다', async () => {
    const wt = path.join(reg.getRoot(), 'somerepo', 'x')
    const info = {
      id: 'dead-share', repoPath: path.join(reg.getRoot(), 'no-such-repo'), path: wt,
      name: 'x', branch: 'u/x', baseRef: 'main', createdAt: new Date().toISOString()
    }
    await reg.add(info)
    await expect(
      removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse, presence: unreachable })
    ).rejects.toThrow(/WORKTREE_UNREACHABLE/)
    expect(reg.get(info.id)).not.toBeNull()
  })

  it('원본 저장소를 읽지 못해도 폴더가 없다고 확인되면 레지스트리 항목만 정리한다', async () => {
    const info = {
      id: 'gone-both', repoPath: path.join(reg.getRoot(), 'no-such-repo'), path: path.join(reg.getRoot(), 'r', 'y'),
      name: 'y', branch: 'u/y', baseRef: 'main', createdAt: new Date().toISOString()
    }
    await reg.add(info)
    const r = await removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse, presence: async () => 'missing' })
    expect(r.removed).toBe(true)
    expect(reg.get(info.id)).toBeNull()
  })

  it('git 이 잊은 폴더라도 확인이 거절되면(refused) force 여도 지우지 않는다', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'orphan-dead', registry: reg })
    await fs.rm(path.join(repo, '.git', 'worktrees', path.basename(info.path)), { recursive: true, force: true })
    await expect(
      removeWorktree({ id: info.id, force: true, registry: reg, isPathInUse: noUse, presence: refused })
    ).rejects.toThrow(/WORKTREE_UNREACHABLE/)
    expect(existsSync(info.path)).toBe(true)
    expect(reg.get(info.id)).not.toBeNull()
  })

  it('git 에 등록된 워크트리라도 폴더 확인이 시간 초과면 청결 검사 없이 지우지 않는다', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'live-dead', registry: reg })
    await expect(
      removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse, presence: unreachable })
    ).rejects.toThrow(/WORKTREE_UNREACHABLE/)
    expect(existsSync(info.path)).toBe(true)
    expect(reg.get(info.id)).not.toBeNull()
    expect(await localBranchExists(repo, info.branch)).toBe(true)
  })

  it('폴더가 없다고 확인되면 git 에 등록된 워크트리도 청결 검사 없이 정리한다', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'live-gone', registry: reg })
    await fs.rm(info.path, { recursive: true, force: true })
    const seen: string[] = []
    const r = await removeWorktree({
      id: info.id, registry: reg, isPathInUse: noUse,
      presence: async (p) => { seen.push(p); return 'missing' }
    })
    expect(r.removed).toBe(true)
    expect(seen).toEqual([info.path])
    expect(reg.get(info.id)).toBeNull()
  })
})

describe('removeWorktree, a refused check', () => {
  it('is asked again, not taken as unreachable', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'refused-once', registry: reg })
    let n = 0
    const r = await removeWorktree({
      id: info.id, registry: reg, isPathInUse: noUse,
      presence: async () => (++n === 1 ? 'refused' : 'present')
    })
    expect(r.removed).toBe(true)
    expect(existsSync(info.path)).toBe(false)
  })
})

// Stage 2 final review, C1: before git removes the folder its links are taken out (detachLinks.ts). When
// that walk cannot finish, git is not run on the folder at all and nothing is removed.
describe('removeWorktree, the links are taken out first', () => {
  it('a failed link walk removes nothing and says so (LINKS_UNVERIFIED)', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'walkfail', registry: reg })
    for (const force of [false, true]) {
      await expect(
        removeWorktree({
          id: info.id, force, registry: reg, isPathInUse: noUse,
          detach: async () => ({ ok: false, reason: 'timeout' })
        })
      ).rejects.toThrow(/LINKS_UNVERIFIED/)
      expect(existsSync(path.join(info.path, 'f.txt'))).toBe(true)
      expect(reg.get(info.id)).not.toBeNull()
      expect(await localBranchExists(repo, info.branch)).toBe(true)
      expect(gitIn(repo, ['worktree', 'list', '--porcelain'])).toContain('walkfail')
    }
  })

  it('walks the folder it removes; without force git\'s tracked symlinks are spared, with force nothing is', async () => {
    const seen: Array<{ root: string; spares: boolean }> = []
    const detach = async (root: string, opts: { keep?: (rel: string) => boolean }) => {
      seen.push({ root, spares: opts.keep !== undefined })
      return { ok: true as const, unlinked: 0 }
    }
    const a = await createWorktree({ repoPath: repo, name: 'walk-a', registry: reg })
    await removeWorktree({ id: a.info.id, registry: reg, isPathInUse: noUse, detach })
    const b = await createWorktree({ repoPath: repo, name: 'walk-b', registry: reg })
    await removeWorktree({ id: b.info.id, force: true, registry: reg, isPathInUse: noUse, detach })
    expect(seen).toEqual([
      { root: a.info.path, spares: true },
      { root: b.info.path, spares: false }
    ])
  })
})

describe('removeWorktree without force, with a tracked symlink', () => {
  it('spares git\'s own symlink, so the clean worktree is still removed', async (ctx) => {
    gitIn(repo, ['config', 'core.symlinks', 'true'])
    await fs.mkdir(path.join(repo, 'dir'))
    await fs.writeFile(path.join(repo, 'dir', 'x.txt'), 'x', 'utf8')
    try {
      await fs.symlink('dir', path.join(repo, 'alias'), 'dir')
    } catch {
      ctx.skip('symlinks cannot be made here')
    }
    gitIn(repo, ['add', 'dir', 'alias'])
    gitIn(repo, ['commit', '-m', 'tracked link'])
    const { info } = await createWorktree({ repoPath: repo, name: 'tracked-link', registry: reg })
    if (!(await fs.lstat(path.join(info.path, 'alias'))).isSymbolicLink()) ctx.skip('git checked the link out as a file')
    const r = await removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse })
    expect(r.removed).toBe(true)
    expect(existsSync(info.path)).toBe(false)
  })
})

// Re-review minor: without force, a locked worktree or one with submodules is refused by git anyway.
// It is refused before the link walk, so its node_modules links are not taken out for nothing.
describe('removeWorktree without force, refused before the link walk', () => {
  const walkSpy = () => {
    const walked: string[] = []
    const detach = async (root: string) => {
      walked.push(root)
      return { ok: true as const, unlinked: 0 }
    }
    return { walked, detach }
  }

  it('a locked worktree: WORKTREE_LOCKED, no walk, nothing removed', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'locked', registry: reg })
    gitIn(repo, ['worktree', 'lock', info.path])
    const { walked, detach } = walkSpy()
    await expect(removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse, detach })).rejects.toThrow(
      /WORKTREE_LOCKED/
    )
    expect(walked).toEqual([])
    expect(existsSync(path.join(info.path, 'f.txt'))).toBe(true)
    expect(reg.get(info.id)).not.toBeNull()
  })

  it('a worktree with a submodule: HAS_SUBMODULES, no walk, nothing removed', async () => {
    const sub = await makeRepo('astera-wt-rm-sub-')
    gitIn(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'sub'])
    gitIn(repo, ['commit', '-m', 'add submodule'])
    const { info } = await createWorktree({ repoPath: repo, name: 'withsub', registry: reg })
    const { walked, detach } = walkSpy()
    await expect(removeWorktree({ id: info.id, registry: reg, isPathInUse: noUse, detach })).rejects.toThrow(
      /HAS_SUBMODULES/
    )
    expect(walked).toEqual([])
    expect(existsSync(path.join(info.path, 'f.txt'))).toBe(true)
    expect(reg.get(info.id)).not.toBeNull()
  })
})
