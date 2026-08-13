import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { listWithStatus } from './list'
import { createWorktree } from './create'
import { WorktreeRegistry } from './registry'
import { makeRepo, tempDir } from './testRepo'

describe('listWithStatus', () => {
  it('ok / missing / orphan-dir 판정', async () => {
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
    expect(byId.get(b.id)).toBe('missing')
    expect(byId.get(c.id)).toBe('orphan-dir')
  })
})
