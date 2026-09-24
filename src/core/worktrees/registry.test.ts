import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { WorktreeRegistry, defaultWorktreeRoot } from './registry'
import { tempDir } from './testRepo'
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
it('defaultWorktreeRoot is the folder the app has always used', () => {
  expect(defaultWorktreeRoot('C:/Users/x')).toBe(path.join('C:/Users/x', 'astera-worktrees'))
})
