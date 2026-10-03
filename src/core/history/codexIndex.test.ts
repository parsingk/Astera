import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Account } from '../types'

// Counts every parse of a rollout, per file, while leaving the real parser to do the work. The head
// parse (parseCodexMeta) is what a listing or a cwd lookup costs; the tail read (parseCodexTail) is
// what building an expansion row costs on top of it.
const heads = new Map<string, number>()
const tails = new Map<string, number>()
vi.mock('./codexParser', async (importOriginal) => {
  const real = await importOriginal<typeof import('./codexParser')>()
  return {
    ...real,
    parseCodexMeta: async (file: string, ...rest: [number?]) => {
      heads.set(path.basename(file), (heads.get(path.basename(file)) ?? 0) + 1)
      return real.parseCodexMeta(file, ...rest)
    },
    parseCodexTail: async (file: string, ...rest: [number?]) => {
      tails.set(path.basename(file), (tails.get(path.basename(file)) ?? 0) + 1)
      return real.parseCodexTail(file, ...rest)
    }
  }
})

const { HistoryIndex } = await import('./index')
const { SessionCwdCache } = await import('./sessionCwdCache')

let tmp: string
let index: InstanceType<typeof HistoryIndex> | null = null

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codex-index-'))
  heads.clear()
  tails.clear()
})
afterEach(async () => {
  await index?.stop()
  index = null
  await fs.rm(tmp, { recursive: true, force: true })
})

const codexAccount = (id: string): Account => ({
  id,
  label: id,
  configDir: path.join(tmp, id),
  color: '#fff',
  createdAt: '2026-07-20T00:00:00Z',
  provider: 'codex'
})

const uuid = (n: number): string => `019f4524-e0ac-7571-a8af-${String(n).padStart(12, '0')}`
const nameOf = (n: number): string => `rollout-2026-07-09T00-00-00-${uuid(n)}.jsonl`

const user = (t: string): unknown => ({
  timestamp: '2026-07-09T01:00:00Z',
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] }
})
const agent = (t: string): unknown => ({
  timestamp: '2026-07-09T01:00:01Z',
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] }
})

async function writeRollout(acc: Account, n: number, cwd: string, day = '09'): Promise<string> {
  const dir = path.join(acc.configDir, 'sessions', '2026', '07', day)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, nameOf(n))
  const lines = [{ type: 'session_meta', payload: { session_id: uuid(n), cwd, source: 'cli' } }, user(`질문 ${n}`)]
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  return file
}

const ALPHA = 'D:\\proj\\alpha'
const BETA = 'D:\\proj\\beta'
const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0)

describe('codex expansion through the rollout index', () => {
  it('펼치기는 그 프로젝트의 rollout 만 행으로 만든다 — 다른 프로젝트의 파일은 다시 열지 않는다', async () => {
    const cx = codexAccount('cx')
    for (let i = 0; i < 6; i++) await writeRollout(cx, i, i < 2 ? ALPHA : BETA, i % 2 ? '09' : '10')
    index = new HistoryIndex(() => [cx])
    await index.projectsPage()
    expect(sum(heads)).toBe(6) // the listing reads every head once
    heads.clear()

    const { entries } = await index.page({ projectPath: ALPHA })
    expect(entries.map((e) => e.sessionId).sort()).toEqual([uuid(0), uuid(1)])
    expect(entries.map((e) => e.title).sort()).toEqual(['질문 0', '질문 1'])
    // Only the two alpha files were built; the four beta files were never opened again
    expect([...tails.keys()].sort()).toEqual([nameOf(0), nameOf(1)])
    expect([...heads.keys()].sort()).toEqual([nameOf(0), nameOf(1)])
  })

  it('두 번째 펼치기는(재시작 뒤 새 객체라도) 바뀌지 않은 파일을 하나도 읽지 않는다', async () => {
    const cx = codexAccount('cx')
    for (let i = 0; i < 4; i++) await writeRollout(cx, i, i < 2 ? ALPHA : BETA)
    const store = path.join(tmp, 'session-cwd.json')
    const cache = new SessionCwdCache(store)
    await cache.load()
    index = new HistoryIndex(() => [cx], undefined, cache)
    await index.projectsPage()
    await index.page({ projectPath: ALPHA })
    await index.stop()
    await cache.flush() // the index asks for a debounced write; a quit-time flush is this call

    // "Restart": a fresh cache object read from the file, a fresh index
    heads.clear()
    tails.clear()
    const reloaded = new SessionCwdCache(store)
    await reloaded.load()
    index = new HistoryIndex(() => [cx], undefined, reloaded)
    await index.projectsPage()
    const { entries } = await index.page({ projectPath: ALPHA })
    expect(entries.map((e) => e.title).sort()).toEqual(['질문 0', '질문 1'])
    expect(sum(heads)).toBe(0)
    expect(sum(tails)).toBe(0)
  })

  it('새 파일과 바뀐 파일만 다시 읽는다', async () => {
    const cx = codexAccount('cx')
    for (let i = 0; i < 4; i++) await writeRollout(cx, i, i < 2 ? ALPHA : BETA)
    index = new HistoryIndex(() => [cx])
    await index.projectsPage()
    await index.page({ projectPath: ALPHA })
    heads.clear()
    tails.clear()

    // One alpha file grows (a reply arrives), one new alpha file and one new beta file appear
    const grown = path.join(cx.configDir, 'sessions', '2026', '07', '09', nameOf(1))
    await fs.appendFile(grown, JSON.stringify(agent('답')) + '\n', 'utf8')
    await writeRollout(cx, 10, ALPHA)
    await writeRollout(cx, 11, BETA)

    const { entries } = await index.page({ projectPath: ALPHA })
    expect(entries.map((e) => e.sessionId).sort()).toEqual([uuid(0), uuid(1), uuid(10)])
    expect(entries.find((e) => e.sessionId === uuid(1))?.awaitingReply).toBe(true)
    // The new beta file needs its head read to learn it is not alpha, and nothing more
    expect([...heads.keys()].sort()).toEqual([nameOf(1), nameOf(10), nameOf(11)].sort())
    expect([...tails.keys()].sort()).toEqual([nameOf(1), nameOf(10)].sort())
  })

  it('프로젝트 목록 없이 바로 펼쳐도 그 프로젝트의 것만 행으로 만든다', async () => {
    const cx = codexAccount('cx')
    for (let i = 0; i < 4; i++) await writeRollout(cx, i, i < 2 ? ALPHA : BETA)
    index = new HistoryIndex(() => [cx])
    const { entries } = await index.page({ projectPath: ALPHA })
    expect(entries.map((e) => e.sessionId).sort()).toEqual([uuid(0), uuid(1)])
    expect(sum(tails)).toBe(2)
  })

  it('지워진 rollout 은 다음 목록 갱신에서 인덱스에서도 빠진다', async () => {
    const cx = codexAccount('cx')
    const files: string[] = []
    for (let i = 0; i < 3; i++) files.push(await writeRollout(cx, i, ALPHA))
    const cache = new SessionCwdCache(path.join(tmp, 'session-cwd.json'))
    await cache.load()
    index = new HistoryIndex(() => [cx], undefined, cache)
    await index.page({ projectPath: ALPHA })
    const st = await fs.stat(files[2])
    expect(cache.getRow(files[2], st.mtimeMs, st.size)).toBeDefined()

    await fs.rm(files[2])
    await index.refresh()
    await index.projectsPage()
    expect(cache.get(files[2], st.mtimeMs, st.size)).toBeUndefined()
    expect((await index.page({ projectPath: ALPHA })).entries).toHaveLength(2)
  })

  it('exec rollout 은 펼치기와 지우기 대상에서 빠진다', async () => {
    const cx = codexAccount('cx')
    await writeRollout(cx, 0, ALPHA)
    const dir = path.join(cx.configDir, 'sessions', '2026', '07', '09')
    await fs.writeFile(
      path.join(dir, nameOf(1)),
      JSON.stringify({ type: 'session_meta', payload: { session_id: uuid(1), cwd: ALPHA, source: 'exec' } }) + '\n',
      'utf8'
    )
    index = new HistoryIndex(() => [cx])
    expect((await index.page({ projectPath: ALPHA })).entries.map((e) => e.sessionId)).toEqual([uuid(0)])
    expect((await index.deletionTargets(ALPHA)).files).toEqual([path.join(dir, nameOf(0))])
  })

  // A child thread (a sub-agent codex starts, measured on 0.160) writes its own rollout with the same cwd
  // and the parent's id in `parent_thread_id`. It is not a conversation to resume, so it is no row of the
  // list; but it holds part of that conversation, so deleting the project's history takes it too.
  const writeChild = async (acc: Account, n: number, parent: number): Promise<string> => {
    const dir = path.join(acc.configDir, 'sessions', '2026', '07', '09')
    const file = path.join(dir, nameOf(n))
    const meta = { session_id: uuid(parent), id: uuid(n), parent_thread_id: uuid(parent), cwd: ALPHA, source: 'cli' }
    await fs.writeFile(file, [{ type: 'session_meta', payload: meta }, user('child')].map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
    // Newer than the parent, as the live one is: it shares the parent's session id, so the list's
    // newest-per-session rule would show it in the parent's place.
    const later = new Date(Date.now() + 60_000)
    await fs.utimes(file, later, later)
    return file
  }

  it('a child thread rollout is no row, the parent keeps its row, and deleting the history takes both', async () => {
    const cx = codexAccount('cx')
    const parent = await writeRollout(cx, 0, ALPHA)
    const child = await writeChild(cx, 1, 0)
    index = new HistoryIndex(() => [cx])
    expect((await index.page({ projectPath: ALPHA })).entries.map((e) => e.title)).toEqual(['질문 0'])
    expect([...(await index.deletionTargets(ALPHA)).files].sort()).toEqual([parent, child].sort())
  })

  it('after a restart the memoized child row is still hidden and still a deletion target, without a parse', async () => {
    const cx = codexAccount('cx')
    const parent = await writeRollout(cx, 0, ALPHA)
    const child = await writeChild(cx, 1, 0)
    const store = path.join(tmp, 'session-cwd.json')
    const cache = new SessionCwdCache(store)
    await cache.load()
    index = new HistoryIndex(() => [cx], undefined, cache)
    await index.page({ projectPath: ALPHA })
    await index.stop()
    await cache.flush()

    heads.clear()
    tails.clear()
    const reloaded = new SessionCwdCache(store)
    await reloaded.load()
    index = new HistoryIndex(() => [cx], undefined, reloaded)
    expect((await index.page({ projectPath: ALPHA })).entries.map((e) => e.title)).toEqual(['질문 0'])
    expect([...(await index.deletionTargets(ALPHA)).files].sort()).toEqual([parent, child].sort())
    expect(sum(heads)).toBe(0)
  })

  it('a child thread row an older build cached is built again and dropped', async () => {
    const cx = codexAccount('cx')
    await writeRollout(cx, 0, ALPHA)
    const child = await writeChild(cx, 1, 0)
    const st = await fs.stat(child)
    const store = path.join(tmp, 'session-cwd.json')
    // The row an earlier build wrote for the child: row version 1, shown as a session of its own.
    const key = path.resolve(child).toLowerCase()
    await fs.writeFile(store, JSON.stringify({ [key]: [st.mtimeMs, st.size, ALPHA, 1, uuid(1), 'child', 0] }), 'utf8')
    const cache = new SessionCwdCache(store, 'win32')
    await cache.load()
    index = new HistoryIndex(() => [cx], undefined, cache)
    expect((await index.page({ projectPath: ALPHA })).entries.map((e) => e.title)).toEqual(['질문 0'])
  })
})

describe('codex first-time scan progress', () => {
  it('처음 훑는 동안 done/total 을 알리고, 끝나면 active:false 로 닫는다', async () => {
    const cx = codexAccount('cx')
    for (let i = 0; i < 30; i++) await writeRollout(cx, i, i % 2 ? ALPHA : BETA)
    index = new HistoryIndex(() => [cx])
    const events: { active: boolean; done: number; total: number }[] = []
    index.onScanProgress = (e) => events.push(e)
    await index.projectsPage()

    expect(events[0]).toEqual({ active: true, done: 0, total: 30 })
    expect(events.at(-1)).toEqual({ active: false, done: 30, total: 30 })
    for (let i = 1; i < events.length; i++) expect(events[i].done).toBeGreaterThanOrEqual(events[i - 1].done)
    expect(events.slice(0, -1).every((e) => e.active)).toBe(true)
  })

  it('이미 인덱스에 있는 파일뿐이면(두 번째 훑기) 아무것도 알리지 않는다', async () => {
    const cx = codexAccount('cx')
    for (let i = 0; i < 30; i++) await writeRollout(cx, i, ALPHA)
    index = new HistoryIndex(() => [cx])
    await index.projectsPage()
    const events: unknown[] = []
    index.onScanProgress = (e) => events.push(e)
    await index.refresh()
    await index.projectsPage()
    await index.page({ projectPath: ALPHA })
    expect(events).toEqual([])
  })

  it('새 파일 몇 개(문턱 아래)는 진행 표시를 띄우지 않는다', async () => {
    const cx = codexAccount('cx')
    for (let i = 0; i < 3; i++) await writeRollout(cx, i, ALPHA)
    index = new HistoryIndex(() => [cx])
    const events: unknown[] = []
    index.onScanProgress = (e) => events.push(e)
    await index.projectsPage()
    expect(events).toEqual([])
  })

  it('알림을 받는 쪽이 던져도 훑기는 끝나고 목록이 온다', async () => {
    const cx = codexAccount('cx')
    for (let i = 0; i < 25; i++) await writeRollout(cx, i, ALPHA)
    index = new HistoryIndex(() => [cx])
    index.onScanProgress = () => {
      throw new Error('renderer gone')
    }
    expect((await index.projectsPage()).projects.map((p) => p.projectPath)).toEqual([ALPHA])
  })
})

describe('codex index — writes and listing failures', () => {
  /** A memory store that counts what the index asks of it. */
  const countingStore = async () => {
    const { MemoryCwdStore } = await import('./projects')
    const calls = { flush: 0, prune: 0 }
    class Counting extends MemoryCwdStore {
      override async flush(): Promise<void> {
        calls.flush++
      }
      override prune(root: string, live: Iterable<string>): number {
        calls.prune++
        return super.prune(root, live)
      }
    }
    return { store: new Counting(), calls }
  }

  it('목록 한 번, 펼치기 한 번에 인덱스 저장을 한 번씩만 청한다', async () => {
    const cx = codexAccount('cx')
    for (let i = 0; i < 4; i++) await writeRollout(cx, i, i < 2 ? ALPHA : BETA)
    const { store, calls } = await countingStore()
    index = new HistoryIndex(() => [cx], undefined, store)
    await index.projectsPage()
    expect(calls.flush).toBe(1)
    await index.page({ projectPath: ALPHA })
    expect(calls.flush).toBe(2)
  })

  it('폴더를 읽다 일시적으로 실패한 목록은 인덱스를 prune 하지 않는다', async () => {
    const cx = codexAccount('cx')
    const files: string[] = []
    for (let i = 0; i < 3; i++) files.push(await writeRollout(cx, i, ALPHA))
    const { store, calls } = await countingStore()
    index = new HistoryIndex(() => [cx], undefined, store)
    await index.projectsPage()
    expect(calls.prune).toBe(1) // a complete listing prunes

    const dayDir = path.dirname(files[0])
    const realReaddir = fs.readdir.bind(fs)
    const spy = vi.spyOn(fs, 'readdir').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      if (path.resolve(String(p)) === path.resolve(dayDir)) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return (realReaddir as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
    }) as typeof fs.readdir)
    await index.refresh()
    await index.projectsPage()
    spy.mockRestore()
    expect(calls.prune).toBe(1) // the failed listing did not prune
    const st = await fs.stat(files[0])
    expect(store.get(files[0], st.mtimeMs, st.size)).toBe(ALPHA)

    // The next good listing is complete again, and prunes
    await index.refresh()
    await index.projectsPage()
    expect(calls.prune).toBe(2)
  })

  it('뿌리 폴더가 아직 없으면(ENOENT) 빈 목록도 완전한 목록이다', async () => {
    const cx = codexAccount('cx-none')
    const { store, calls } = await countingStore()
    index = new HistoryIndex(() => [cx], undefined, store)
    await index.projectsPage()
    expect(calls.prune).toBe(1)
  })
})
