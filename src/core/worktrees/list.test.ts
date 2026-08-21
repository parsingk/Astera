import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { listWithStatus } from './list'
import { createWorktree } from './create'
import { WorktreeRegistry } from './registry'
import { makeRepo, tempDir } from './testRepo'

describe('listWithStatus', () => {
  it('ok / orphan-dir 판정, 그리고 폴더가 사라진 항목은 걷힌다', async () => {
    const repo = await makeRepo('astera-wt-ls-')
    const root = await tempDir('astera-wt-lsroot-')
    const regDir = await tempDir('astera-wt-lsreg-')
    const reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
    await reg.load()
    const a = (await createWorktree({ repoPath: repo, name: 'a', registry: reg })).info
    const b = (await createWorktree({ repoPath: repo, name: 'b', registry: reg })).info
    const c = (await createWorktree({ repoPath: repo, name: 'c', registry: reg })).info
    // b: 디렉토리 삭제(= missing), c: git 등록만 삭제(= orphan-dir)
    execFileSync('git', ['worktree', 'remove', '--force', b.path], { cwd: repo, windowsHide: true })
    await fs.rm(path.join(repo, '.git', 'worktrees', path.basename(c.path)), {
      recursive: true,
      force: true
    })
    const items = await listWithStatus(reg)
    const byId = new Map(items.map((w) => [w.id, w.status]))
    expect(byId.get(a.id)).toBe('ok')
    expect(byId.get(c.id)).toBe('orphan-dir')
    // b 는 폴더가 사라졌다 — 관리할 것이 남지 않았으므로 목록에도, 레지스트리에도 없어야 한다.
    // 이것이 "폴더 없음" 줄을 사람이 하나씩 x 로 지우던 것을 없애는 자리다
    expect(byId.has(b.id)).toBe(false)
    expect(reg.list().some((w) => w.id === b.id)).toBe(false)
  })

  // git 은 아직 아는데 폴더만 사라진 갈래. 이때도 줄은 남지 않아야 하고, git 쪽 메타데이터는
  // prune 으로 걷혀야 한다 — 걷지 않으면 저장소에 잔해가 남는다
  it('폴더만 사라진 항목도 목록에서 지우고 git 메타데이터까지 걷는다', async () => {
    const repo = await makeRepo('astera-wt-ls2-')
    const root = await tempDir('astera-wt-ls2root-')
    const regDir = await tempDir('astera-wt-ls2reg-')
    const reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
    await reg.load()
    const w = (await createWorktree({ repoPath: repo, name: 'gone', registry: reg })).info
    // 폴더만 지운다 — git 의 .git/worktrees/<name> 은 그대로 남는다
    await fs.rm(w.path, { recursive: true, force: true })
    const metaDir = path.join(repo, '.git', 'worktrees', path.basename(w.path))
    expect(existsSync(metaDir)).toBe(true)
    const items = await listWithStatus(reg)
    expect(items.some((x) => x.id === w.id)).toBe(false)
    expect(reg.list()).toHaveLength(0)
    expect(existsSync(metaDir)).toBe(false)
  })

  // 폴더가 멀쩡한 항목은 건드리지 않는다 — 정리가 살아 있는 것을 지우지 않는다는 증거
  it('폴더가 있는 항목은 레지스트리에 그대로 남는다', async () => {
    const repo = await makeRepo('astera-wt-ls3-')
    const root = await tempDir('astera-wt-ls3root-')
    const regDir = await tempDir('astera-wt-ls3reg-')
    const reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
    await reg.load()
    const a = (await createWorktree({ repoPath: repo, name: 'keep', registry: reg })).info
    await listWithStatus(reg)
    expect(reg.list().map((w) => w.id)).toEqual([a.id])
  })
})
