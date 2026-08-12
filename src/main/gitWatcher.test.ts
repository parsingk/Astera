import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { GitWatcher } from './gitWatcher'
import { makeRepo } from '../core/worktrees/testRepo'
import { gitDir } from '../core/worktrees/git'

const watchers: GitWatcher[] = []
afterEach(async () => {
  for (const w of watchers.splice(0)) await w.close()
})

/** chokidar 이벤트가 도착할 때까지 기다린다 (최대 ms). */
function waitFor(pred: () => boolean, ms = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = (): void => {
      if (pred()) return resolve(true)
      if (Date.now() - started > ms) return resolve(false)
      setTimeout(tick, 50)
    }
    tick()
  })
}

describe('GitWatcher', () => {
  it('index가 바뀌면 emit한다', async () => {
    const repo = await makeRepo()
    let hits = 0
    const w = new GitWatcher(() => hits++)
    watchers.push(w)
    await w.watch(repo)
    const dir = (await gitDir(repo)) as string
    // git add가 하는 일과 같다 — index 파일 교체
    await fs.writeFile(path.join(dir, 'index'), 'x', 'utf8')
    expect(await waitFor(() => hits > 0)).toBe(true)
  })

  it('HEAD가 바뀌면 emit한다', async () => {
    const repo = await makeRepo()
    let hits = 0
    const w = new GitWatcher(() => hits++)
    watchers.push(w)
    await w.watch(repo)
    const dir = (await gitDir(repo)) as string
    await fs.writeFile(path.join(dir, 'HEAD'), 'ref: refs/heads/other\n', 'utf8')
    expect(await waitFor(() => hits > 0)).toBe(true)
  })

  it('index·HEAD가 아닌 파일은 무시한다', async () => {
    const repo = await makeRepo()
    let hits = 0
    const w = new GitWatcher(() => hits++)
    watchers.push(w)
    await w.watch(repo)
    const dir = (await gitDir(repo)) as string
    await fs.writeFile(path.join(dir, 'COMMIT_EDITMSG'), 'msg', 'utf8')
    await fs.writeFile(path.join(dir, 'index.lock'), '', 'utf8')
    // 무시 대상만 건드렸으니 계속 0이어야 한다 (기다렸다가 확인)
    expect(await waitFor(() => hits > 0, 1200)).toBe(false)
    expect(hits).toBe(0)
  })

  it('git 저장소가 아니면 조용히 아무것도 감시하지 않는다', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-gw-plain-'))
    let hits = 0
    const w = new GitWatcher(() => hits++)
    watchers.push(w)
    await expect(w.watch(plain)).resolves.toBeUndefined()
    expect(hits).toBe(0)
  })

  it('unwatch 후에는 emit하지 않는다', async () => {
    const repo = await makeRepo()
    let hits = 0
    const w = new GitWatcher(() => hits++)
    watchers.push(w)
    await w.watch(repo)
    await w.unwatch()
    const dir = (await gitDir(repo)) as string
    await fs.writeFile(path.join(dir, 'index'), 'y', 'utf8')
    expect(await waitFor(() => hits > 0, 1200)).toBe(false)
  })
})
