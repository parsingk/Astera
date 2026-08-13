import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { WorktreeRegistry } from './registry'
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
