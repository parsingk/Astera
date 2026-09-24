import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { WorktreeRegistry, defaultWorktreeRoot } from './registry'
import { tempDir } from './testRepo'
import { RepairNeeded } from '../settings/repairNeeded'
import type { WorktreeInfo } from '../types'

let tmp: string
let reg: WorktreeRegistry

const info = (id: string): WorktreeInfo => ({
  id,
  repoPath: 'D:\\repos\\app',
  path: `D:\\wt\\app\\${id}`,
  name: id,
  branch: `u/${id}`,
  baseRef: 'origin/main',
  createdAt: '2026-07-30T00:00:00.000Z'
})

beforeEach(async () => {
  tmp = await tempDir('astera-wt-reg-')
  reg = new WorktreeRegistry(path.join(tmp, 'worktrees.json'), 'D:\\default-root')
  await reg.load()
})

describe('WorktreeRegistry', () => {
  it('초기 상태: 빈 목록 + 기본 루트', () => {
    expect(reg.list()).toEqual([])
    expect(reg.getRoot()).toBe('D:\\default-root')
  })

  it('add/get/removeEntry + 재로드 유지', async () => {
    await reg.add(info('a'))
    await reg.add(info('b'))
    expect(reg.get('a')?.branch).toBe('u/a')
    await reg.removeEntry('a')
    const again = new WorktreeRegistry(path.join(tmp, 'worktrees.json'), 'D:\\default-root')
    await again.load()
    expect(again.list().map((w) => w.id)).toEqual(['b'])
    expect(again.get('a')).toBeNull()
  })

  it('setRoot 저장·재로드, null이면 기본 루트로 복귀', async () => {
    await reg.setRoot('E:\\custom')
    const again = new WorktreeRegistry(path.join(tmp, 'worktrees.json'), 'D:\\default-root')
    await again.load()
    expect(again.getRoot()).toBe('E:\\custom')
    await again.setRoot(null)
    expect(again.getRoot()).toBe('D:\\default-root')
  })

  it('빈 root("")는 로드 시 기본 루트로 정규화', async () => {
    const fp = path.join(tmp, 'empty-root.json')
    await fs.writeFile(fp, JSON.stringify({ root: '', items: [] }), 'utf8')
    const r = new WorktreeRegistry(fp, 'D:\\default-root')
    await r.load()
    expect(r.getRoot()).toBe('D:\\default-root')
  })

  it('손상 JSON → 빈 목록 기동 + .bak 보존', async () => {
    const fp = path.join(tmp, 'corrupt.json')
    await fs.writeFile(fp, '{bad', 'utf8')
    const r = new WorktreeRegistry(fp, 'D:\\default-root')
    expect((await r.load()).recovered).toBe(true)
    expect(r.list()).toEqual([])
    expect(await fs.readFile(fp + '.bak', 'utf8')).toBe('{bad')
  })

  it('스키마 불일치(items가 배열 아님)도 손상 취급', async () => {
    const fp = path.join(tmp, 'schema.json')
    await fs.writeFile(fp, JSON.stringify({ items: 'x' }), 'utf8')
    const r = new WorktreeRegistry(fp, 'D:\\default-root')
    expect((await r.load()).recovered).toBe(true)
  })
})

const wt = (id: string): WorktreeInfo => ({
  id, repoPath: 'D:/r', path: `D:/wt/${id}`, name: id, branch: `u/${id}`, baseRef: 'main', createdAt: '2026-09-24T00:00:00.000Z'
})
describe('one worktrees.json, more than one writer (Host S3, D3)', () => {
  // §9.2's registry test: fails on today's code, where each instance rewrites the file from memory.
  it('a write keeps the entry another process added after this one loaded', async () => {
    const file = path.join(tmp, 'worktrees.json')
    const app = new WorktreeRegistry(file, 'D:/root'); await app.load()
    const host = new WorktreeRegistry(file, 'D:/root'); await host.load()
    await host.add(wt('h1'))
    await app.add(wt('a1'))
    const fresh = new WorktreeRegistry(file, 'D:/root'); await fresh.load()
    expect(fresh.list().map((w) => w.id).sort()).toEqual(['a1', 'h1'])
  })
  it('a removal and a root change keep the entries they did not name', async () => {
    const file = path.join(tmp, 'worktrees.json')
    const a = new WorktreeRegistry(file, 'D:/root'); await a.load()
    const b = new WorktreeRegistry(file, 'D:/root'); await b.load()
    await a.add(wt('x')); await b.add(wt('y'))
    await a.removeEntry('y'); await b.setRoot('D:/other')
    const fresh = new WorktreeRegistry(file, 'D:/root'); await fresh.load()
    expect(fresh.list().map((w) => w.id)).toEqual(['x'])
    expect(fresh.getRoot()).toBe('D:/other')
  })
  it('two writes started together both land', async () => {
    const file = path.join(tmp, 'worktrees.json')
    const r = new WorktreeRegistry(file, 'D:/root'); await r.load()
    await Promise.all([r.add(wt('p')), r.add(wt('q'))])
    const fresh = new WorktreeRegistry(file, 'D:/root'); await fresh.load()
    expect(fresh.list().map((w) => w.id).sort()).toEqual(['p', 'q'])
  })
  it('writes through the writer it was given, holds what the writer answered, and touches no file', async () => {
    const file = path.join(tmp, 'worktrees.json')
    const r = new WorktreeRegistry(file, 'D:/root'); await r.load()
    const calls: string[] = []
    r.writeThrough({
      add: async (w) => { calls.push(`add ${w.id}`); return { items: [wt('h1'), w] } },
      removeEntry: async (id) => { calls.push(`remove ${id}`); return { items: [wt('h1')] } },
      setRoot: async (root) => { calls.push(`root ${root}`); return { ...(root ? { root } : {}), items: [wt('h1')] } }
    })
    await r.add(wt('a1'))
    expect(r.list().map((w) => w.id)).toEqual(['h1', 'a1'])
    await r.removeEntry('a1'); await r.setRoot('D:/elsewhere')
    expect(calls).toEqual(['add a1', 'remove a1', 'root D:/elsewhere'])
    expect(r.getRoot()).toBe('D:/elsewhere')
    await expect(fs.stat(file)).rejects.toThrow()
  })
  // Constraint 13: nothing is held that the Host did not confirm.
  it('keeps what it held when the writer refuses, and lets the refusal out', async () => {
    const r = new WorktreeRegistry(path.join(tmp, 'worktrees.json'), 'D:/root'); await r.load()
    r.writeThrough({ add: async () => { throw new Error('the Host did not answer') }, removeEntry: async () => ({ items: [] }), setRoot: async () => ({ items: [] }) })
    await expect(r.add(wt('a1'))).rejects.toThrow(/did not answer/)
    expect(r.list()).toEqual([])
  })
  it('writes the file again, re-reading it first, once the writer is taken away', async () => {
    const file = path.join(tmp, 'worktrees.json')
    const r = new WorktreeRegistry(file, 'D:/root'); await r.load()
    r.writeThrough({ add: async (w) => ({ items: [w] }), removeEntry: async () => ({ items: [] }), setRoot: async () => ({ items: [] }) })
    await r.add(wt('through'))
    const other = new WorktreeRegistry(file, 'D:/root'); await other.load(); await other.add(wt('on-disk'))
    r.writeThrough(null)
    await r.add(wt('local'))
    const fresh = new WorktreeRegistry(file, 'D:/root'); await fresh.load()
    expect(fresh.list().map((w) => w.id)).toEqual(['on-disk', 'local'])
  })
  it('accepts a pushed file and refuses a malformed one', () => {
    const r = new WorktreeRegistry(path.join(tmp, 'worktrees.json'), 'D:/root')
    expect(r.accept({ root: 'D:/pushed', items: [wt('h1')] })).toBe(true)
    expect(r.list().map((w) => w.id)).toEqual(['h1'])
    expect(r.getRoot()).toBe('D:/pushed')
    expect(r.accept({ items: [{ id: 'no-path' }] })).toBe(false)
    expect(r.list().map((w) => w.id)).toEqual(['h1'])
  })
  it('tells its listeners after a local write, and a throwing listener costs neither the write nor the others', async () => {
    const logs: string[] = []
    const r = new WorktreeRegistry(path.join(tmp, 'worktrees.json'), 'D:/root', (m) => logs.push(m)); await r.load()
    const seen: string[][] = []
    r.onChange(() => { throw new Error('boom') })
    r.onChange((f) => seen.push(f.items.map((w) => w.id)))
    await r.add(wt('a1'))
    expect(seen).toEqual([['a1']])
    expect(logs.join('\n')).toMatch(/boom/)
  })
  // Constraint 13 again: a file that cannot be read back is not overwritten with what this process
  // happens to hold, which would erase the entries the file had.
  it('refuses a local write when the re-read finds the file damaged, and leaves file and memory as they were', async () => {
    const logs: string[] = []
    const file = path.join(tmp, 'worktrees.json')
    const r = new WorktreeRegistry(file, 'D:/root', (m) => logs.push(m)); await r.load()
    await r.add(wt('kept'))
    await fs.writeFile(file, '{bad', 'utf8')
    await expect(r.add(wt('new'))).rejects.toThrow(/worktrees\.json/)
    expect(await fs.readFile(file, 'utf8')).toBe('{bad')
    expect(r.list().map((w) => w.id)).toEqual(['kept'])
    expect(logs.join('\n')).toMatch(/unreadable/)
  })
  it('a recovery at load is logged', async () => {
    const logs: string[] = []
    const file = path.join(tmp, 'worktrees.json')
    await fs.writeFile(file, '{bad', 'utf8')
    const r = new WorktreeRegistry(file, 'D:/root', (m) => logs.push(m))
    expect((await r.load()).recovered).toBe(true)
    expect(logs).toEqual(['worktrees.json was unreadable — kept it as worktrees.json.bak and started an empty list'])
  })
})
describe('a damaged worktrees.json heals at load, a busy rename is retried, and a push keeps its place (Task 1 fix round)', () => {
  const eperm = (): Error => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
  const tmps = async (): Promise<string[]> => (await fs.readdir(tmp)).filter((n) => n.endsWith('.tmp'))
  const onDisk = async (file: string): Promise<string[]> =>
    (JSON.parse(await fs.readFile(file, 'utf8')) as { items: WorktreeInfo[] }).items.map((w) => w.id)

  it('load writes the recovered empty file, so the next add succeeds and the next start is clean', async () => {
    const file = path.join(tmp, 'worktrees.json')
    await fs.writeFile(file, '{"items":[{"id":"x"', 'utf8')
    const r = new WorktreeRegistry(file, 'D:/root')
    expect((await r.load()).recovered).toBe(true)
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe('{"items":[{"id":"x"')
    expect(await onDisk(file)).toEqual([])
    await r.add(wt('after'))
    const next = new WorktreeRegistry(file, 'D:/root')
    expect((await next.load()).recovered).toBe(false)
    expect(next.list().map((w) => w.id)).toEqual(['after'])
  })
  it('a restart after a refused write heals the file', async () => {
    const file = path.join(tmp, 'worktrees.json')
    const r = new WorktreeRegistry(file, 'D:/root'); await r.load()
    await r.add(wt('kept'))
    await fs.writeFile(file, '{bad', 'utf8')
    await expect(r.add(wt('refused'))).rejects.toThrow(/unreadable/)
    expect(r.list().map((w) => w.id)).toEqual(['kept'])
    expect(await fs.readFile(file, 'utf8')).toBe('{bad')
    const restarted = new WorktreeRegistry(file, 'D:/root')
    expect((await restarted.load()).recovered).toBe(true)
    await restarted.add(wt('later'))
    expect(await onDisk(file)).toEqual(['later'])
  })
  it('does not overwrite the damaged file when the .bak copy fails', async () => {
    const file = path.join(tmp, 'worktrees.json')
    await fs.writeFile(file, '{bad', 'utf8')
    const realWrite = fs.writeFile.bind(fs)
    const copy = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).endsWith('.bak')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      return realWrite(...args)
    })
    try {
      expect((await new WorktreeRegistry(file, 'D:/root').load()).recovered).toBe(true)
    } finally {
      copy.mockRestore()
    }
    expect(await fs.readFile(file, 'utf8')).toBe('{bad')
  })
  it('a heal that cannot be written is logged and load still resolves', async () => {
    const logs: string[] = []
    const file = path.join(tmp, 'worktrees.json')
    await fs.writeFile(file, '{bad', 'utf8')
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(eperm())
    try {
      expect((await new WorktreeRegistry(file, 'D:/root', (m) => logs.push(m)).load()).recovered).toBe(true)
    } finally {
      rename.mockRestore()
    }
    expect(logs.join('\n')).toMatch(/could not write the recovered worktrees\.json.*EPERM/)
    expect(await tmps()).toEqual([])
  })
  it('retries a rename that fails with EPERM a few times', async () => {
    const file = path.join(tmp, 'worktrees.json')
    const r = new WorktreeRegistry(file, 'D:/root'); await r.load()
    const rename = vi.spyOn(fs, 'rename')
    rename.mockRejectedValueOnce(eperm()).mockRejectedValueOnce(eperm()).mockRejectedValueOnce(eperm())
    try {
      await r.add(wt('a1'))
    } finally {
      rename.mockRestore()
    }
    expect(await onDisk(file)).toEqual(['a1'])
    expect(await tmps()).toEqual([])
  })
  it('a rename that never succeeds rejects, leaves memory as it was and no tmp behind', async () => {
    const file = path.join(tmp, 'worktrees.json')
    const r = new WorktreeRegistry(file, 'D:/root'); await r.load()
    await r.add(wt('kept'))
    const seen: string[][] = []
    r.onChange((f) => seen.push(f.items.map((w) => w.id)))
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(eperm())
    try {
      await expect(r.add(wt('lost'))).rejects.toThrow(/EPERM/)
    } finally {
      rename.mockRestore()
    }
    expect(r.list().map((w) => w.id)).toEqual(['kept'])
    expect(seen).toEqual([])
    expect(await onDisk(file)).toEqual(['kept'])
    expect(await tmps()).toEqual([])
  })
  // A push that lands while a local add is between its re-read and its save.
  it('a push arriving during the re-read of a local add loses neither the push nor the add', async () => {
    const file = path.join(tmp, 'worktrees.json')
    const r = new WorktreeRegistry(file, 'D:/root'); await r.load()
    const seen: string[][] = []
    r.onChange((f) => seen.push(f.items.map((w) => w.id)))
    const real = fs.readFile.bind(fs)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let reached!: () => void
    const atRead = new Promise<void>((res) => (reached = res))
    const read = vi.spyOn(fs, 'readFile').mockImplementation((async (...a: Parameters<typeof real>) => {
      reached()
      await gate
      return real(...a)
    }) as typeof fs.readFile)
    try {
      const adding = r.add(wt('a1'))
      await atRead
      expect(r.accept({ items: [wt('h1')] })).toBe(true)
      release()
      await adding
    } finally {
      read.mockRestore()
    }
    expect(seen).toEqual([['a1']])
    expect(await onDisk(file)).toEqual(['a1'])
    expect(r.list().map((w) => w.id)).toEqual(['h1'])
  })
  it('a push arriving during the save of a local add loses neither the push nor the add', async () => {
    const file = path.join(tmp, 'worktrees.json')
    const r = new WorktreeRegistry(file, 'D:/root'); await r.load()
    const seen: string[][] = []
    r.onChange((f) => seen.push(f.items.map((w) => w.id)))
    const real = fs.rename.bind(fs)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let reached!: () => void
    const atRename = new Promise<void>((res) => (reached = res))
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      reached()
      await gate
      return real(from, to)
    })
    try {
      const adding = r.add(wt('a1'))
      await atRename
      expect(r.accept({ items: [wt('h1')] })).toBe(true)
      release()
      await adding
    } finally {
      rename.mockRestore()
    }
    expect(seen).toEqual([['a1']])
    expect(await onDisk(file)).toEqual(['a1'])
    expect(r.list().map((w) => w.id)).toEqual(['h1'])
  })
  it('a writer answer waits for a local write started before it', async () => {
    const file = path.join(tmp, 'worktrees.json')
    const r = new WorktreeRegistry(file, 'D:/root'); await r.load()
    const real = fs.rename.bind(fs)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let reached!: () => void
    const atRename = new Promise<void>((res) => (reached = res))
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      reached()
      await gate
      return real(from, to)
    })
    try {
      const local = r.add(wt('a1'))
      await atRename
      r.writeThrough({ add: async (w) => ({ items: [wt('h1'), w] }), removeEntry: async () => ({ items: [] }), setRoot: async () => ({ items: [] }) })
      const through = r.add(wt('t1'))
      release()
      await Promise.all([local, through])
    } finally {
      rename.mockRestore()
    }
    expect(r.list().map((w) => w.id)).toEqual(['h1', 't1'])
  })
})
it('defaultWorktreeRoot is the folder the app has always used', () => {
  expect(defaultWorktreeRoot('C:/Users/x')).toBe(path.join('C:/Users/x', 'astera-worktrees'))
})
describe('a re-read per operation, and a .bak two healers share (Host S3 Task 6)', () => {
  // The Host re-reads before every worktree operation (R2), and must not heal by wiping there (N1).
  it('refresh takes what another process wrote, and hears no change of its own', async () => {
    const file = path.join(tmp, 'worktrees.json')
    const r = new WorktreeRegistry(file, 'D:/root'); await r.load()
    const heard: string[][] = []
    r.onChange((f) => heard.push(f.items.map((w) => w.id)))
    await fs.writeFile(file, JSON.stringify({ root: 'D:/elsewhere', items: [wt('by-app')] }), 'utf8')
    await r.refresh()
    expect(r.list().map((w) => w.id)).toEqual(['by-app'])
    expect(r.getRoot()).toBe('D:/elsewhere')
    expect(heard).toEqual([])
  })
  it('refresh refuses a damaged file as a RepairNeeded naming it, and leaves file and memory alone', async () => {
    const file = path.join(tmp, 'worktrees.json')
    const r = new WorktreeRegistry(file, 'D:/root'); await r.load()
    await r.add(wt('kept'))
    await fs.writeFile(file, '{bad', 'utf8')
    const err = await r.refresh().then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(RepairNeeded)
    expect((err as RepairNeeded).file).toBe('worktrees.json')
    expect(r.list().map((w) => w.id)).toEqual(['kept'])
    expect(await fs.readFile(file, 'utf8')).toBe('{bad')
    await expect(fs.stat(file + '.bak')).rejects.toThrow()
  })
  it('a local write over a damaged file is refused the same way', async () => {
    const file = path.join(tmp, 'worktrees.json')
    const r = new WorktreeRegistry(file, 'D:/root'); await r.load()
    await fs.writeFile(file, '{bad', 'utf8')
    await expect(r.add(wt('x'))).rejects.toBeInstanceOf(RepairNeeded)
  })
  // N4: a second process healing the same damage must not put the healed file (or anything else)
  // over the .bak the first one kept.
  it('load keeps a .bak that is newer than the damaged file', async () => {
    const file = path.join(tmp, 'worktrees.json')
    await fs.writeFile(file, '{second-damage', 'utf8')
    await fs.writeFile(file + '.bak', '{the-original', 'utf8')
    const t = Date.now() / 1000
    await fs.utimes(file, t - 60, t - 60)
    await fs.utimes(file + '.bak', t - 30, t - 30)
    expect((await new WorktreeRegistry(file, 'D:/root').load()).recovered).toBe(true)
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe('{the-original')
    expect(await onDiskIds(file)).toEqual([])
  })
  it('load replaces a .bak older than the damaged file', async () => {
    const file = path.join(tmp, 'worktrees.json')
    await fs.writeFile(file, '{new-damage', 'utf8')
    await fs.writeFile(file + '.bak', '{an-old-one', 'utf8')
    const t = Date.now() / 1000
    await fs.utimes(file + '.bak', t - 60, t - 60)
    await fs.utimes(file, t - 30, t - 30)
    expect((await new WorktreeRegistry(file, 'D:/root').load()).recovered).toBe(true)
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe('{new-damage')
  })
  // The race itself: the first healer kept the damage in .bak and healed the file; the second read
  // the damage before that heal and copies after it. Its copy would be the healed file.
  it('a second healer that read the damage before the first one healed keeps the first one’s .bak', async () => {
    const file = path.join(tmp, 'worktrees.json')
    await fs.writeFile(file, '{bad', 'utf8')
    const t = Date.now() / 1000
    await fs.utimes(file, t - 60, t - 60)
    const real = fs.readFile.bind(fs)
    const read = vi.spyOn(fs, 'readFile').mockImplementationOnce(async (...args: Parameters<typeof fs.readFile>) => {
      const text = await real(...args)
      // the first healer, between this read and this process's copy
      expect((await new WorktreeRegistry(file, 'D:/root').load()).recovered).toBe(true)
      return text
    })
    try {
      expect((await new WorktreeRegistry(file, 'D:/root').load()).recovered).toBe(true)
    } finally {
      read.mockRestore()
    }
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe('{bad')
  })
})
describe('the .bak holds what was read, and says when it was kept (Task 6 fix round 2, M4 and M9)', () => {
  // The window left by copying the live file: this process found no .bak, then another healed the
  // file (and wrote its own .bak) before this one copied — the copy would be the healed empty list.
  it('writes the bytes this process read, not whatever the file holds by then', async () => {
    const file = path.join(tmp, 'worktrees.json')
    await fs.writeFile(file, '{bad', 'utf8')
    const real = fs.stat.bind(fs)
    const stat = vi.spyOn(fs, 'stat').mockImplementation(async (p: Parameters<typeof fs.stat>[0]) => {
      if (String(p).endsWith('.bak')) await fs.writeFile(file, JSON.stringify({ items: [] }), 'utf8')
      return real(p)
    })
    try {
      expect((await new WorktreeRegistry(file, 'D:/root').load()).recovered).toBe(true)
    } finally {
      stat.mockRestore()
    }
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe('{bad')
  })
  it('logs a .bak it kept rather than wrote', async () => {
    const logs: string[] = []
    const file = path.join(tmp, 'worktrees.json')
    await fs.writeFile(file, '{bad', 'utf8')
    await fs.writeFile(file + '.bak', '{older-copy', 'utf8')
    const t = Date.now() / 1000
    await fs.utimes(file, t - 60, t - 60)
    await new WorktreeRegistry(file, 'D:/root', (m) => logs.push(m)).load()
    expect(logs).toEqual([
      'worktrees.json was unreadable — a newer worktrees.json.bak was already there and was kept; started an empty list'
    ])
  })
  it('a refused write says what repairs the file', async () => {
    const file = path.join(tmp, 'worktrees.json')
    const r = new WorktreeRegistry(file, 'D:/root'); await r.load()
    await fs.writeFile(file, '{bad', 'utf8')
    await expect(r.add(wt('x'))).rejects.toThrow(/unreadable.*reopen Astera/)
  })
})
const onDiskIds = async (file: string): Promise<string[]> =>
  (JSON.parse(await fs.readFile(file, 'utf8')) as { items: WorktreeInfo[] }).items.map((w) => w.id)
