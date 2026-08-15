import { describe, it, expect, afterEach, vi } from 'vitest'
import chokidar from 'chokidar'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { GitWatcher } from './gitWatcher'
import { makeRepo } from '../core/worktrees/testRepo'
import { gitDir } from '../core/worktrees/git'

const watchers: GitWatcher[] = []
afterEach(async () => {
  for (const w of watchers.splice(0)) await w.close()
  vi.restoreAllMocks()
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

/** chokidar.watch를 감싸서, 만들어진 watcher가 ready를 냈는지 밖에서 관찰한다. 감시 동작 자체는
 *  진짜 chokidar 그대로다 — 관찰자만 하나 더 붙인다. GitWatcher보다 먼저 붙으므로 ready가 나면
 *  GitWatcher의 대기가 풀리기 전에 플래그가 선다. */
function observeReady(): () => boolean {
  const real = chokidar.watch
  let emitted = false
  vi.spyOn(chokidar, 'watch').mockImplementation((paths, options) => {
    const w = real(paths, options)
    w.on('ready', () => {
      emitted = true
    })
    return w
  })
  return () => emitted
}

describe('GitWatcher', () => {
  // chokidar는 inotify 등록을 비동기로 하고, 초기 스캔이 끝나야 ready를 낸다. ready 전의 watcher는
  // 살아 있지만 듣지는 않으므로, 그 틈에 들어온 쓰기는 이벤트가 아예 나지 않는다. 즉 ready를 기다리지
  // 않고 watch()를 끝내면 "감시 준비 완료"가 거짓말이 된다. 이 테스트는 시간에 기대지 않는다 —
  // ready는 실제 fs stat 뒤에 나므로, 기다리지 않는 구현에서는 이 시점에 반드시 false다.
  it('watch()는 chokidar가 ready를 낸 뒤에야 끝난다', async () => {
    const repo = await makeRepo()
    const ready = observeReady()
    const w = new GitWatcher(() => {})
    watchers.push(w)
    await w.watch(repo)
    expect(ready()).toBe(true)
  })

  // ready 대기가 생기면 close()와 겹칠 수 있다. chokidar의 close()는 리스너를 전부 떼므로
  // ready만 기다리는 구현은 여기서 영영 안 끝난다.
  it('ready를 기다리는 중 close()가 와도 watch()가 끝난다', async () => {
    const repo = await makeRepo()
    const w = new GitWatcher(() => {})
    watchers.push(w)
    const real = chokidar.watch
    // watcher가 만들어지고 doWatch가 대기에 들어간 직후에 close()를 끼워 넣는다.
    vi.spyOn(chokidar, 'watch').mockImplementation((paths, options) => {
      const fsw = real(paths, options)
      queueMicrotask(() => void w.close())
      return fsw
    })
    const hung = new Promise<string>((r) => setTimeout(() => r('hung'), 3000))
    expect(await Promise.race([w.watch(repo).then(() => 'done'), hung])).toBe('done')
  })

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
