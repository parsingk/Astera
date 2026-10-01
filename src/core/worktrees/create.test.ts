import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { createWorktree, rollbackAdd, probedRollbackFs, resolveRepo, type RollbackFs } from './create'
import type { WorktreeCreateProgress } from '../types'
import { WorktreeRegistry } from './registry'
import { git, localBranchExists } from './git'
import { makeRepo, addOrigin, tempDir } from './testRepo'
import { nameForRun } from './naming'
import { createProbePool, createProber, rootOf, ProbeBudget, PROBE_CONCURRENCY, PROBE_STUCK_CEILING_MS, PROBE_TIMEOUT_MS, processProbeBudget } from '../sessions/pathProbe'

let repo: string
let root: string
let reg: WorktreeRegistry

const gitIn = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim()

beforeEach(async () => {
  repo = await makeRepo('astera-wt-create-')
  root = await tempDir('astera-wt-root-')
  const regDir = await tempDir('astera-wt-regd-')
  reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
  await reg.load()
})

describe('createWorktree', () => {
  it('로컬 main 기반: 브랜치·경로·레지스트리·branch.base 기록', async () => {
    const { info, warnings } = await createWorktree({ repoPath: repo, name: 'Login Fix', registry: reg })
    expect(info.name).toBe('Login-Fix')
    expect(info.branch).toBe('Test-User/Login-Fix')
    expect(info.baseRef).toBe('main')
    expect(path.resolve(path.dirname(info.path))).toBe(path.resolve(path.join(root, path.basename(repo))))
    expect(existsSync(path.join(info.path, 'f.txt'))).toBe(true)
    expect(reg.get(info.id)?.path).toBe(info.path)
    const base = await git(['config', `branch.${info.branch}.base`], { cwd: repo })
    expect(base.stdout).toBe('refs/heads/main')
    expect(warnings).toEqual([])
  })

  it('origin이 있으면 origin/main 기반', async () => {
    await addOrigin(repo)
    const { info } = await createWorktree({ repoPath: repo, registry: reg })
    expect(info.baseRef).toBe('origin/main')
  })

  it('이름 충돌 시 -2 접미사', async () => {
    const a = await createWorktree({ repoPath: repo, name: 'dup', registry: reg })
    const b = await createWorktree({ repoPath: repo, name: 'dup', registry: reg })
    expect(a.info.name).toBe('dup')
    expect(b.info.name).toBe('dup-2')
    expect(b.info.branch).toBe('Test-User/dup-2')
  })

  it('.worktreeinclude 항목이 새 worktree에 복사된다', async () => {
    await fs.writeFile(path.join(repo, '.gitignore'), '.env\n', 'utf8')
    await fs.writeFile(path.join(repo, '.env'), 'K=1', 'utf8')
    await fs.writeFile(path.join(repo, '.worktreeinclude'), '.env\n', 'utf8')
    execFileSync('git', ['add', '.gitignore', '.worktreeinclude'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'inc'], { cwd: repo, windowsHide: true })
    const { info } = await createWorktree({ repoPath: repo, registry: reg })
    expect(await fs.readFile(path.join(info.path, '.env'), 'utf8')).toBe('K=1')
  })

  it('git repo가 아니면 NOT_GIT_REPO', async () => {
    const notRepo = await tempDir('astera-wt-plain-')
    await expect(createWorktree({ repoPath: notRepo, registry: reg })).rejects.toThrow(/NOT_GIT_REPO/)
  })

  it('base 판정 불가면 NO_BASE', async () => {
    execFileSync('git', ['branch', '-m', 'main', 'hotfix'], { cwd: repo, windowsHide: true })
    await expect(createWorktree({ repoPath: repo, registry: reg })).rejects.toThrow(/NO_BASE/)
  })

  it('후속 단계 실패 시 롤백: worktree·브랜치가 남지 않는다', async () => {
    // registry.add를 실패시키는 스텁으로 마지막 단계 실패를 유도
    const failing = Object.create(reg) as WorktreeRegistry
    failing.add = async () => {
      throw new Error('DISK_FULL')
    }
    await expect(createWorktree({ repoPath: repo, name: 'rb', registry: failing })).rejects.toThrow(
      /DISK_FULL/
    )
    expect(existsSync(path.join(root, path.basename(repo), 'rb'))).toBe(false)
    expect(await localBranchExists(repo, 'Test-User/rb')).toBe(false)
  })

  it('baseRef를 주면 그 브랜치에서 분기한다', async () => {
    // main에 없는 커밋을 가진 브랜치를 만들고 그것을 기준으로 지정한다
    gitIn(repo, ['checkout', '-q', '-b', 'develop'])
    await fs.writeFile(path.join(repo, 'd.txt'), 'd', 'utf8')
    gitIn(repo, ['add', 'd.txt'])
    gitIn(repo, ['commit', '-m', 'dev only'])
    gitIn(repo, ['checkout', '-q', 'main'])

    const { info } = await createWorktree({ repoPath: repo, name: 'from-dev', baseRef: 'develop', registry: reg })
    expect(info.baseRef).toBe('develop')
    // develop에만 있던 파일이 worktree에 체크아웃돼 있어야 한다
    expect(existsSync(path.join(info.path, 'd.txt'))).toBe(true)
  })

  it('baseRef를 주면 branch.<b>.base에 그 값이 기록된다 — 삭제 시 머지 판정 기준이 된다', async () => {
    gitIn(repo, ['branch', 'develop'])
    const { info } = await createWorktree({ repoPath: repo, name: 'recorded', baseRef: 'develop', registry: reg })
    expect(gitIn(repo, ['config', `branch.${info.branch}.base`])).toBe('refs/heads/develop')
  })

  it('슬래시가 든 로컬 브랜치를 baseRef로 줘도 생성된다', async () => {
    // fetchBaseRef가 이름 모양만 보고 원격으로 오판하면 FETCH_FAILED로 죽던 케이스
    gitIn(repo, ['branch', 'parsingk/maple'])
    const { info } = await createWorktree({
      repoPath: repo,
      name: 'slashed',
      baseRef: 'parsingk/maple',
      registry: reg
    })
    expect(info.baseRef).toBe('parsingk/maple')
  })

  it('존재하지 않는 baseRef는 NO_BASE', async () => {
    await expect(
      createWorktree({ repoPath: repo, name: 'nope', baseRef: 'no-such-branch', registry: reg })
    ).rejects.toThrow(/NO_BASE/)
  })

  it('baseRef가 없으면 기존 자동 감지를 그대로 쓴다', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'auto', registry: reg })
    expect(info.baseRef).toBe('main') // origin이 없는 픽스처 → 로컬 main
  })

  it('two 2,000-character objectives sharing their first 40 characters both get a worktree real git accepts', async () => {
    const head = 'Add an add a b function to math.js and export it '
    const a = nameForRun({ id: 'job_a', objective: head + 'x '.repeat(1000) })
    const b = nameForRun({ id: 'job_b', objective: head + 'y '.repeat(1000) })
    expect(a).toBe(b)
    const first = await createWorktree({ repoPath: repo, name: a, registry: reg })
    const second = await createWorktree({ repoPath: repo, name: b, registry: reg })
    expect(first.info.name).toBe(a)
    expect(second.info.name).toBe(`${a}-2`)
    expect(await localBranchExists(repo, first.info.branch)).toBe(true)
    expect(await localBranchExists(repo, second.info.branch)).toBe(true)
    expect(gitIn(second.info.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(second.info.branch)
  })
})

// 이름이 비었는지는 비동기로, 시간 제한을 두고 묻는다(presence.ts). 동기 existsSync 는 끊긴 네트워크
// 공유 위의 워크트리 루트에서 20~60초 동안 스레드를 세웠다. 닿지 않는 루트는 기다리지 않고 분명한
// 오류로 곧바로 실패한다.
describe('createWorktree, 루트에 닿지 않을 때', () => {
  it('후보 폴더 확인이 시간 초과면 만들지 않고 WORKTREE_ROOT_UNREACHABLE 로 실패한다', async () => {
    await expect(
      createWorktree({ repoPath: repo, name: 'dead', registry: reg, presence: async () => 'unreachable' })
    ).rejects.toThrow(/WORKTREE_ROOT_UNREACHABLE/)
    expect(await localBranchExists(repo, 'Test-User/dead')).toBe(false)
    expect(reg.list()).toEqual([])
  })

  it('부모 폴더를 만드는 호출이 시간 초과면 후보를 묻지도 않고 곧바로 실패한다', async () => {
    const asked: string[] = []
    await expect(
      createWorktree({
        repoPath: repo, name: 'deadroot', registry: reg,
        makeDir: async () => 'timeout',
        presence: async (p) => { asked.push(p); return 'missing' }
      })
    ).rejects.toThrow(/WORKTREE_ROOT_UNREACHABLE/)
    expect(asked).toEqual([])
    expect(reg.list()).toEqual([])
  })

  // Stage 4 T1: 저장소 폴더를 git 보다 먼저 묻는다. 끊긴 공유 위의 폴더를 cwd 로 git 을 띄우면
  // Windows 는 그 폴더를 부르는 스레드(Host 의 하나뿐인 스레드)에서 동기로 들여다본다.
  it('저장소 폴더가 답하지 않으면 git 을 띄우지 않고 REPO_UNREACHABLE 로 실패한다 — NOT_GIT_REPO 가 아니다', async () => {
    const asked: string[] = []
    const err = await createWorktree({
      repoPath: repo, name: 'deadrepo', registry: reg,
      repoProbe: async (p) => { asked.push(p); return 'timeout' }
    }).catch((e: unknown) => e)
    expect(String(err)).toMatch(/REPO_UNREACHABLE: folder not reachable/)
    expect(String(err)).not.toMatch(/NOT_GIT_REPO/)
    expect(asked).toEqual([repo])
    expect(reg.list()).toEqual([])
    expect(await fs.readdir(root)).toEqual([])
  })

  it('저장소 폴더가 없다고 답하면 NOT_GIT_REPO 다', async () => {
    await expect(
      createWorktree({ repoPath: repo, name: 'gone', registry: reg, repoProbe: async () => 'absent' })
    ).rejects.toThrow(/NOT_GIT_REPO/)
  })

  it('예산이 막힌 것으로 아는 루트는 호출 없이 거절된다', async () => {
    const budget = new ProbeBudget()
    const ticket = await budget.enter(rootOf(repo))
    if (typeof ticket === 'string') throw new Error(ticket)
    ticket.timedOut()
    const calls: string[] = []
    const repoProbe = createProber({
      access: async (p) => { calls.push(p) }, skipQueue: true, pool: createProbePool(PROBE_CONCURRENCY, PROBE_STUCK_CEILING_MS, budget), log: () => {}
    })
    await expect(createWorktree({ repoPath: repo, name: 'stuck', registry: reg, repoProbe })).rejects.toThrow(/REPO_UNREACHABLE/)
    expect(calls).toEqual([])
  })

  it('이름이 쓰였는지는 비동기 확인의 답으로 정한다', async () => {
    const first = path.join(root, path.basename(repo), 'taken')
    const { info } = await createWorktree({
      repoPath: repo, name: 'taken', registry: reg,
      presence: async (p) => (path.resolve(p) === path.resolve(first) ? 'present' : 'missing')
    })
    expect(info.name).toBe('taken-2')
  })
})

describe('createWorktree, names and the repo folder', () => {
  it('NAME_EXHAUSTED leaves no empty repo folder behind', async () => {
    await expect(
      createWorktree({ repoPath: repo, name: 'full', registry: reg, presence: async () => 'present' })
    ).rejects.toThrow(/NAME_EXHAUSTED/)
    expect(existsSync(path.join(root, path.basename(repo)))).toBe(false)
  })

  it('a refused candidate check is asked again, not taken as unreachable', async () => {
    const asked = new Map<string, number>()
    const { info } = await createWorktree({
      repoPath: repo, name: 'again', registry: reg,
      presence: async (p) => {
        const n = (asked.get(p) ?? 0) + 1
        asked.set(p, n)
        return n === 1 ? 'refused' : 'missing'
      }
    })
    expect(info.name).toBe('again')
  })
})

// Review round 2, I2. The cleanup of the repo folder create made itself: only that folder, never one
// the person made or a link at that path, never on the unreachable path, and never waited on past the
// probe limit.
describe('createWorktree, taking back the repo folder', () => {
  const repoDir = (): string => path.join(root, path.basename(repo))

  it('does not touch the folder at all on the unreachable path', async () => {
    const removed: string[] = []
    await expect(
      createWorktree({
        repoPath: repo, name: 'dead', registry: reg,
        presence: async () => 'unreachable',
        removeDirAccess: async (d) => { removed.push(d) }
      })
    ).rejects.toThrow(/WORKTREE_ROOT_UNREACHABLE/)
    expect(removed).toEqual([])
    expect(existsSync(repoDir())).toBe(true)
  })

  it('leaves a repo folder that was there before this call', async () => {
    await fs.mkdir(repoDir(), { recursive: true })
    const removed: string[] = []
    await expect(
      createWorktree({
        repoPath: repo, name: 'full', registry: reg,
        presence: async () => 'present',
        removeDirAccess: async (d) => { removed.push(d) }
      })
    ).rejects.toThrow(/NAME_EXHAUSTED/)
    expect(removed).toEqual([])
    expect(existsSync(repoDir())).toBe(true)
  })

  it('never removes a link that stands at that path, even when this call reports it made the folder', async () => {
    const target = await tempDir('astera-wt-linktarget-')
    await fs.writeFile(path.join(target, 'keep.txt'), 'k')
    await fs.symlink(target, repoDir(), 'junction')
    await expect(
      createWorktree({
        repoPath: repo, name: 'full', registry: reg,
        presence: async () => 'present',
        makeDir: async () => 'created'
      })
    ).rejects.toThrow(/NAME_EXHAUSTED/)
    expect((await fs.lstat(repoDir())).isSymbolicLink()).toBe(true)
    expect(existsSync(path.join(target, 'keep.txt'))).toBe(true)
  })

  // Stage 2 final review, I1: the rmdir is mutating work with its own deadline, outside the probe
  // budget. A hung one is not waited on past that deadline, and it marks no drive stuck.
  it('does not wait on a cleanup that hangs past its own deadline, and marks no root stuck', async () => {
    const started = Date.now()
    let asked = false
    const budget = new ProbeBudget()
    await expect(
      createWorktree({
        repoPath: repo, name: 'full', registry: reg,
        presence: async () => 'present',
        removeDirAccess: () => { asked = true; return new Promise<void>(() => {}) },
        cleanupPool: createProbePool(PROBE_CONCURRENCY, PROBE_STUCK_CEILING_MS, budget),
        fsWorkTimeoutMs: PROBE_TIMEOUT_MS + 500
      })
    ).rejects.toThrow(/NAME_EXHAUSTED/)
    expect(asked).toBe(true)
    expect(Date.now() - started).toBeLessThan(PROBE_TIMEOUT_MS + 8_000)
    expect(budget.stuckCount()).toBe(0)
  }, 20_000)
})


// 진행과 취소. 느린 것은 괜찮지만 멈춘 것처럼 보이면 안 된다 — 어느 단계인지 알리고, 긴 단계는
// 멈출 수 있어야 한다. 멈추면 이 호출이 만든 것을 되돌린다: 등록된 반쪽 워크트리를 남기지 않는다.
describe('createWorktree — 진행과 취소', () => {
  const wtDir = (name: string): string => path.join(root, path.basename(repo), name)

  /** 되돌리기가 끝났는가: 폴더도, 브랜치도, git 의 워크트리 목록 항목도, 레지스트리 항목도 없다. */
  const expectRolledBack = async (name: string): Promise<void> => {
    expect(existsSync(wtDir(name))).toBe(false)
    expect(await localBranchExists(repo, `Test-User/${name}`)).toBe(false)
    expect(gitIn(repo, ['worktree', 'list', '--porcelain'])).not.toContain(name)
    expect(reg.list()).toEqual([])
  }

  const withInclude = async (files: number): Promise<void> => {
    await fs.writeFile(path.join(repo, '.gitignore'), 'cache/\n', 'utf8')
    await fs.mkdir(path.join(repo, 'cache'))
    for (let i = 0; i < files; i++) await fs.writeFile(path.join(repo, 'cache', `c${i}.txt`), 'x'.repeat(10), 'utf8')
    await fs.writeFile(path.join(repo, '.worktreeinclude'), 'cache\n', 'utf8')
    gitIn(repo, ['add', '.gitignore', '.worktreeinclude'])
    gitIn(repo, ['commit', '-m', 'inc'])
  }

  it('단계를 fetch → checkout → copy-includes 순서로 알리고, 복사는 총량에 닿아 끝난다', async () => {
    await addOrigin(repo)
    await withInclude(3)
    const seen: WorktreeCreateProgress[] = []
    await createWorktree({ repoPath: repo, name: 'prog', registry: reg, onProgress: (p) => seen.push(p) })
    const stages = seen.map((p) => p.stage).filter((s, i, a) => i === 0 || a[i - 1] !== s)
    expect(stages).toEqual(['fetch', 'checkout', 'copy-includes'])
    expect(seen[seen.length - 1]).toEqual({
      stage: 'copy-includes', bytesCopied: 30, bytesTotal: 30, filesCopied: 3, filesTotal: 3
    })
  })

  it('포함 파일이 없으면 copy-includes 단계는 알리지 않는다', async () => {
    const seen: string[] = []
    await createWorktree({ repoPath: repo, name: 'plain', registry: reg, onProgress: (p) => seen.push(p.stage) })
    expect(seen).toEqual(['fetch', 'checkout'])
  })

  it('이미 취소된 신호면 아무것도 만들지 않는다', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      createWorktree({ repoPath: repo, name: 'never', registry: reg, signal: ac.signal })
    ).rejects.toThrow(/WORKTREE_CANCELLED/)
    expect(existsSync(path.join(root, path.basename(repo)))).toBe(false)
    expect(reg.list()).toEqual([])
  })

  it('fetch 중에 취소하면 걸린 git 을 죽이고 곧바로 끝난다 — 만든 것이 없다', async () => {
    await addOrigin(repo)
    // 로컬 원격의 upload-pack 앞에 30초 잠을 끼워 fetch 를 붙잡는다
    gitIn(repo, ['config', 'remote.origin.uploadpack', 'sleep 30; git-upload-pack'])
    const ac = new AbortController()
    const started = Date.now()
    await expect(
      createWorktree({
        repoPath: repo, name: 'infetch', registry: reg, signal: ac.signal,
        onProgress: (p) => { if (p.stage === 'fetch') setTimeout(() => ac.abort(), 500) }
      })
    ).rejects.toThrow(/WORKTREE_CANCELLED/)
    // fetch 의 자체 시간 제한(10초)보다 훨씬 먼저 — git 이 죽었다는 뜻이다
    expect(Date.now() - started).toBeLessThan(8_000)
    await expectRolledBack('infetch')
    expect(existsSync(path.join(root, path.basename(repo)))).toBe(false)
  }, 30_000)

  it('checkout(worktree add) 중에 취소하면 git 을 죽이고 반쯤 만든 워크트리와 브랜치를 되돌린다', async () => {
    // post-checkout 훅이 30초 잔다 — worktree add 가 그 안에서 붙잡힌다
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout')
    await fs.writeFile(hook, '#!/bin/sh\nsleep 30\n', 'utf8')
    await fs.chmod(hook, 0o755)
    const ac = new AbortController()
    const started = Date.now()
    await expect(
      createWorktree({
        repoPath: repo, name: 'inadd', registry: reg, signal: ac.signal,
        onProgress: (p) => { if (p.stage === 'checkout') setTimeout(() => ac.abort(), 1500) }
      })
    ).rejects.toThrow(/WORKTREE_CANCELLED/)
    expect(Date.now() - started).toBeLessThan(15_000)
    await expectRolledBack('inadd')
  }, 40_000)

  it('포함 파일 복사 중에 취소하면 멈추고 워크트리와 브랜치를 되돌린다', async () => {
    await withInclude(5)
    const ac = new AbortController()
    let copiedWhenCancelled = -1
    await expect(
      createWorktree({
        repoPath: repo, name: 'incopy', registry: reg, signal: ac.signal,
        onProgress: (p) => {
          if (p.stage === 'copy-includes' && p.filesCopied === 2 && !ac.signal.aborted) {
            copiedWhenCancelled = p.filesCopied
            ac.abort()
          }
        }
      })
    ).rejects.toThrow(/WORKTREE_CANCELLED/)
    expect(copiedWhenCancelled).toBe(2)
    await expectRolledBack('incopy')
    // 이 호출이 만든 저장소 폴더도 되돌린다 — 2026-09-28 화면 검증에서 빈 채로 남아 있었다
    expect(existsSync(path.join(root, path.basename(repo)))).toBe(false)
  })

  it('취소해도 다른 워크트리가 든 저장소 폴더는 남긴다', async () => {
    await withInclude(5)
    await createWorktree({ repoPath: repo, name: 'sibling', registry: reg })
    const ac = new AbortController()
    await expect(
      createWorktree({
        repoPath: repo, name: 'incopy2', registry: reg, signal: ac.signal,
        onProgress: (p) => {
          if (p.stage === 'copy-includes' && p.filesCopied === 2 && !ac.signal.aborted) ac.abort()
        }
      })
    ).rejects.toThrow(/WORKTREE_CANCELLED/)
    expect(existsSync(wtDir('incopy2'))).toBe(false)
    expect(existsSync(wtDir('sibling'))).toBe(true)
  })

  it('신호도 진행도 주지 않는 기존 호출은 그대로 동작한다', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'legacy', registry: reg })
    expect(reg.get(info.id)?.name).toBe('legacy')
  })
})

describe('createWorktree — 되돌리기가 끝나지 못할 때', () => {
  it('남은 것을 이름과 경로로 적은 ROLLBACK_INCOMPLETE 로 끝난다 — 조용히 반쪽을 남기지 않는다', async () => {
    // 마지막 단계에서 실패시키면서, 본 저장소의 HEAD 를 새 브랜치로 돌려 두어 branch -D 가 거절되게 한다
    const failing = Object.create(reg) as WorktreeRegistry
    failing.add = async () => {
      gitIn(repo, ['symbolic-ref', 'HEAD', 'refs/heads/Test-User/stuck'])
      throw new Error('DISK_FULL')
    }
    const err = await createWorktree({ repoPath: repo, name: 'stuck', registry: failing }).then(
      () => null,
      (e: Error) => e
    )
    expect(err?.message).toMatch(/^ROLLBACK_INCOMPLETE: /)
    const note = JSON.parse(/ROLLBACK_INCOMPLETE: (\{.*?\})/.exec(err!.message)![1])
    expect(note).toEqual({
      path: path.join(root, path.basename(repo), 'stuck'),
      branch: 'Test-User/stuck',
      remains: ['branch']
    })
    expect(err?.message).toContain('DISK_FULL')
  })
})

// 리뷰 2 차: 답하지 않은 worktree add 도 되돌리고, 되돌리기는 이 호출이 만든 것만 건드린다.
describe('createWorktree — worktree add 가 실패할 때', () => {
  const wtDir = (name: string): string => path.join(root, path.basename(repo), name)
  const sleepHook = async (secs: number): Promise<void> => {
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout')
    await fs.writeFile(hook, `#!/bin/sh\nsleep ${secs}\n`, 'utf8')
    await fs.chmod(hook, 0o755)
  }

  it('시간 제한에 걸려 git 이 답하지 않았으면 반쯤 만든 워크트리·폴더·브랜치를 되돌린다', async () => {
    await sleepHook(30)
    const started = Date.now()
    await expect(
      createWorktree({ repoPath: repo, name: 'slowadd', registry: reg, addTimeoutMs: 1500 })
    ).rejects.toThrow(/GIT_ADD_FAILED/)
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(existsSync(wtDir('slowadd'))).toBe(false)
    expect(await localBranchExists(repo, 'Test-User/slowadd')).toBe(false)
    expect(gitIn(repo, ['worktree', 'list', '--porcelain'])).not.toContain('slowadd')
    expect(reg.list()).toEqual([])
    // 이름이 타 버리지 않았다: 같은 이름으로 다시 만들 수 있다
    await fs.rm(path.join(repo, '.git', 'hooks', 'post-checkout'))
    const again = await createWorktree({ repoPath: repo, name: 'slowadd', registry: reg })
    expect(again.info.name).toBe('slowadd')
  }, 40_000)

  it('git 이 오류로 답했으면(이미 있는 폴더) 되돌리지 않는다 — 그 사이 나타난 폴더는 지우지 않는다', async () => {
    const theirs = wtDir('appeared')
    await fs.mkdir(theirs, { recursive: true })
    await fs.writeFile(path.join(theirs, 'mine.txt'), 'keep', 'utf8')
    await expect(
      createWorktree({ repoPath: repo, name: 'appeared', registry: reg, presence: async () => 'missing' })
    ).rejects.toThrow(/GIT_ADD_FAILED/)
    expect(await fs.readFile(path.join(theirs, 'mine.txt'), 'utf8')).toBe('keep')
  })

  it('같은 이름을 동시에 만들어도 서로 다른 이름을 받고, 한쪽의 취소가 다른 쪽을 지우지 않는다', async () => {
    await sleepHook(3)
    const ac = new AbortController()
    const a = createWorktree({
      repoPath: repo, name: 'dup', registry: reg, signal: ac.signal,
      onProgress: (p) => { if (p.stage === 'checkout') setTimeout(() => ac.abort(), 700) }
    }).then(() => 'made', (e: Error) => e.message)
    const b = createWorktree({ repoPath: repo, name: 'dup', registry: reg })
    const [aResult, bResult] = await Promise.all([a, b])
    expect(aResult).toMatch(/WORKTREE_CANCELLED/)
    expect(existsSync(bResult.info.path)).toBe(true)
    expect(await localBranchExists(repo, bResult.info.branch)).toBe(true)
    expect(reg.list().map((w) => w.id)).toEqual([bResult.info.id])
    expect(gitIn(repo, ['worktree', 'list', '--porcelain'])).toContain(bResult.info.branch)
  }, 40_000)
})

describe('rollbackAdd — 이 호출이 만든 것만', () => {
  it('git 이 모르는 폴더에 내용이 있으면 지우지 않고 남았다고 알린다', async () => {
    const theirs = path.join(root, 'someone')
    await fs.mkdir(theirs, { recursive: true })
    await fs.writeFile(path.join(theirs, 'a.txt'), 'a', 'utf8')
    const remains = await rollbackAdd(repo, theirs, 'Test-User/none')
    expect(remains).toContain('folder')
    expect(await fs.readFile(path.join(theirs, 'a.txt'), 'utf8')).toBe('a')
  })

  it('그 경로의 워크트리가 다른 브랜치면 지우지 않는다', async () => {
    const other = path.join(root, 'other-wt')
    gitIn(repo, ['worktree', 'add', '-b', 'someone/else', other, 'main'])
    const remains = await rollbackAdd(repo, other, 'Test-User/mine')
    expect(remains).toContain('git-worktree')
    expect(existsSync(path.join(other, 'f.txt'))).toBe(true)
    expect(await localBranchExists(repo, 'someone/else')).toBe(true)
  })

  it('이 브랜치의 워크트리는 지우고, 빈 폴더만 남은 자리도 치운다', async () => {
    const mine = path.join(root, 'mine-wt')
    gitIn(repo, ['worktree', 'add', '-b', 'Test-User/mine', mine, 'main'])
    expect(await rollbackAdd(repo, mine, 'Test-User/mine')).toEqual([])
    expect(existsSync(mine)).toBe(false)
    expect(await localBranchExists(repo, 'Test-User/mine')).toBe(false)
    const empty = path.join(root, 'empty-left')
    await fs.mkdir(empty)
    expect(await rollbackAdd(repo, empty, 'Test-User/none')).toEqual([])
    expect(existsSync(empty)).toBe(false)
  })
})

// Stage 2 final review, C1: the links are taken out before git removes the worktree. When that walk
// cannot finish, git is not run on the folder at all: it is kept and reported unverified.
describe('rollbackAdd — the links are taken out first', () => {
  it('keeps the worktree and reports unverified when the link walk fails', async () => {
    const mine = path.join(root, 'walk-fails')
    gitIn(repo, ['worktree', 'add', '-b', 'Test-User/walk', mine, 'main'])
    const real = probedRollbackFs()
    const removed: string[] = []
    const rfs: RollbackFs = {
      ...real,
      detachLinks: async () => false,
      removeOwned: async (p) => { removed.push(p); return true },
      removeIfEmpty: async (p) => { removed.push(p); return true }
    }
    const remains = await rollbackAdd(repo, mine, 'Test-User/walk', rfs)
    expect(remains).toContain('unverified')
    expect(remains).toContain('folder')
    expect(removed).toEqual([])
    expect(existsSync(path.join(mine, 'f.txt'))).toBe(true)
    expect(gitIn(repo, ['worktree', 'list', '--porcelain'])).toContain('walk-fails')
  })

  it('does not walk or remove a folder whose check did not answer', async () => {
    const mine = path.join(root, 'no-answer')
    gitIn(repo, ['worktree', 'add', '-b', 'Test-User/noanswer', mine, 'main'])
    let walked = false
    const rfs: RollbackFs = {
      exists: async () => 'unknown',
      detachLinks: async () => { walked = true; return true },
      removeOwned: async () => true,
      removeIfEmpty: async () => true
    }
    expect(await rollbackAdd(repo, mine, 'Test-User/noanswer', rfs)).toContain('unverified')
    expect(walked).toBe(false)
    expect(existsSync(path.join(mine, 'f.txt'))).toBe(true)
  })
})

// Stage 2 final review, I1: only the existence checks go through the probe budget. A slow rm is mutating
// work with its own deadline, so it never marks its drive stuck, and a probe of that drive still answers.
describe('rollback fs — slow removal is not a probe', () => {
  it('a slow rm does not mark the root stuck, and a session probe on that root still answers', async () => {
    const budget = new ProbeBudget()
    const pool = createProbePool(PROBE_CONCURRENCY, PROBE_STUCK_CEILING_MS, budget)
    const dir = await tempDir('astera-wt-slowrm-')
    const rfs = probedRollbackFs(pool, {
      rmTree: () => new Promise<void>((r) => setTimeout(r, PROBE_TIMEOUT_MS + 1_000))
    })
    const removing = rfs.removeOwned(dir)
    await new Promise((r) => setTimeout(r, PROBE_TIMEOUT_MS + 300))
    expect(budget.isStuck(rootOf(dir))).toBe(false)
    expect(budget.stuckCount()).toBe(0)
    const sessionProbe = createProber({ pool, skipQueue: true })
    expect(await sessionProbe(dir)).toBe('present')
    expect(await rfs.exists(dir)).toBe('yes')
    expect(await removing).toBe(true)
    expect(budget.stuckCount()).toBe(0)
  }, 15_000)

  it('an rm past its own deadline answers not done, still without marking the root stuck', async () => {
    const budget = new ProbeBudget()
    const pool = createProbePool(PROBE_CONCURRENCY, PROBE_STUCK_CEILING_MS, budget)
    const dir = await tempDir('astera-wt-hungrm-')
    const rfs = probedRollbackFs(pool, { rmTree: () => new Promise<void>(() => {}), fsWorkTimeoutMs: 200 })
    expect(await rfs.removeOwned(dir)).toBe(false)
    expect(budget.isStuck(rootOf(dir))).toBe(false)
  })
})

// Stage 4 T1 review: what the repository question says, and that a person's creation gets its call.
describe('resolveRepo', () => {
  it('git that cannot be started in a folder that is there is NO_GIT, not REPO_UNREACHABLE', async () => {
    const run = (async () => ({ ok: false, stdout: '', stderr: 'spawn git ENOENT', errorCode: 'ENOENT' })) as unknown as typeof git
    const err = await resolveRepo(repo, async () => 'present', run).catch((e: unknown) => e)
    expect(String(err)).toMatch(/NO_GIT:/)
    expect(String(err)).not.toMatch(/REPO_UNREACHABLE/)
  })

  it('the repo folder is asked past the stuck-call cap: dead drives elsewhere do not refuse it', async () => {
    const budget = processProbeBudget()
    try {
      for (const r of ['Q:/', 'R:/', 'S:/'].map(rootOf)) {
        const t = await budget.enter(r)
        if (typeof t === 'string') throw new Error(t)
        t.timedOut()
      }
      expect(await resolveRepo(repo)).toBe(path.resolve(gitIn(repo, ['rev-parse', '--show-toplevel'])))
    } finally {
      budget.reset()
    }
  })
})

// Stage 4 T1 review follow-up: the name check (the presence action lane) is asked past the stuck-call
// cap too, so dead drives elsewhere never stop a creation on a live local root.
describe('createWorktree with three dead roots stuck in the budget', () => {
  it('passes the name check on a fresh local root and creates the worktree', async () => {
    const budget = processProbeBudget()
    try {
      for (const r of ['Q:/', 'R:/', 'S:/'].map(rootOf)) {
        const t = await budget.enter(r)
        if (typeof t === 'string') throw new Error(t)
        t.timedOut()
      }
      const { info } = await createWorktree({ repoPath: repo, name: 'past-cap', registry: reg })
      expect(info.name).toBe('past-cap')
      expect(reg.get(info.id)?.path).toBe(info.path)
    } finally {
      budget.reset()
    }
  })
})

