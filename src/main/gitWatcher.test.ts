import { describe, it, expect, afterEach, vi } from 'vitest'
import chokidar from 'chokidar'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { GitWatcher } from './gitWatcher'
import { makeRepo, gitSync, addOrigin } from '../core/worktrees/testRepo'
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

  // gitwatch-probe.cjs로 git 2.45.1에서 측정: 이 다섯 조작은 HEAD의 커밋을 옮기면서도 index와
  // 최상위 HEAD 파일을 둘 다 건드리지 않는다 — 흔적은 logs/HEAD(reflog)에만 남는다. logs/HEAD를
  // 보기 전에는 이 테스트가 첫 단계(allow-empty)에서 반드시 실패한다.
  it('index도 HEAD 파일도 건드리지 않는 HEAD 이동에도 emit한다 — allow-empty·amend·soft reset·재커밋·update-ref', async () => {
    const repo = await makeRepo()
    let hits = 0
    const w = new GitWatcher(() => hits++)
    watchers.push(w)
    await w.watch(repo)

    const step = async (args: string[]): Promise<void> => {
      hits = 0
      gitSync(repo, args)
      expect(await waitFor(() => hits > 0)).toBe(true)
    }
    // 매 단계 트리가 부모와 똑같은 빈 커밋 체인이라, amend와 재커밋에도 --allow-empty가 필요하다
    // (아니면 git이 "내용 없는 커밋"으로 보고 거부한다) — reflog에 남는지가 관심사일 뿐 이 플래그가
    // "index를 건드리지 않는다"는 성질 자체는 바꾸지 않는다(probe의 commit --allow-empty 측정과 같다).
    await step(['commit', '--allow-empty', '-m', 'empty'])
    await step(['commit', '--amend', '--allow-empty', '-m', 'amended message only'])
    await step(['reset', '--soft', 'HEAD~1'])
    await step(['commit', '--allow-empty', '-m', 're-commit after soft reset'])
    await step(['update-ref', 'refs/heads/main', 'HEAD~1'])
  })

  it('링크된 worktree의 git dir(.git/worktrees/<name>)에서도 같다', async () => {
    const repo = await makeRepo()
    const wt = path.join(repo, '..', `wt-gw-${path.basename(repo)}`)
    gitSync(repo, ['worktree', 'add', '-b', 'gw-feat', wt])
    let hits = 0
    const w = new GitWatcher(() => hits++)
    watchers.push(w)
    await w.watch(wt)
    const dir = (await gitDir(wt)) as string
    expect(dir.includes('worktrees')).toBe(true) // 워크트리 전용 git dir을 보고 있는지 확인
    gitSync(wt, ['commit', '--allow-empty', '-m', 'wt-empty'])
    expect(await waitFor(() => hits > 0)).toBe(true)
    hits = 0
    gitSync(wt, ['update-ref', 'refs/heads/gw-feat', 'HEAD~1'])
    expect(await waitFor(() => hits > 0)).toBe(true)
    gitSync(repo, ['worktree', 'remove', '--force', wt])
  })

  it('watch 시작 시 logs/가 없던 저장소도 첫 커밋에서 emit한다', async () => {
    // makeRepo()가 이미 커밋 1개를 만들어서 index는 존재한다 — 커밋이 한 번도 없던 저장소로
    // 시험하면(진짜 fresh init) 첫 커밋이 index 파일 자체를 새로 만들어 내면서 구현 이전 코드도
    // 우연히 emit해 버린다(index가 WATCHED라서). logs/만 지워 "감시 시작 시 logs/ 없음"을
    // 재현하고, 그 뒤의 조작은 index도 HEAD 파일도 건드리지 않는 allow-empty로 골라 옛 코드에서는
    // 반드시 실패하게 한다.
    const repo = await makeRepo()
    const gd = (await gitDir(repo)) as string
    await fs.rm(path.join(gd, 'logs'), { recursive: true, force: true })
    await expect(fs.stat(path.join(gd, 'logs', 'HEAD'))).rejects.toThrow()

    let hits = 0
    const w = new GitWatcher(() => hits++)
    watchers.push(w)
    await w.watch(repo)
    gitSync(repo, ['commit', '--allow-empty', '-m', 'after logs/ was removed'])
    expect(await waitFor(() => hits > 0)).toBe(true)
  })

  it('git fetch는 HEAD를 옮기지 않으므로 emit하지 않는다', async () => {
    const repo = await makeRepo()
    await addOrigin(repo)
    let hits = 0
    const w = new GitWatcher(() => hits++)
    watchers.push(w)
    await w.watch(repo)
    gitSync(repo, ['fetch', 'origin'])
    expect(await waitFor(() => hits > 0, 1200)).toBe(false)
    expect(hits).toBe(0)
  })
})
