import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Account } from '../types'
import { ProjectPathListing } from './projects'
import { makeDescriptors } from '../providers/descriptor'

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-projects-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const account = (id: string, provider?: 'codex'): Account => ({
  id,
  label: id,
  configDir: path.join(tmp, id),
  color: '#fff',
  createdAt: '2026-07-20T00:00:00Z',
  ...(provider ? { provider } : {})
})

async function claudeTranscript(acc: Account, slug: string, cwd: string): Promise<string> {
  const dir = path.join(acc.configDir, 'projects', slug)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 's1.jsonl')
  await fs.writeFile(file, JSON.stringify({ type: 'user', sessionId: 's1', cwd, message: { role: 'user', content: 'hi' } }), 'utf8')
  return file
}

async function codexRollout(acc: Account, cwd: string): Promise<string> {
  const dir = path.join(acc.configDir, 'sessions', '2026', '07', '09')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'rollout-2026-07-09T00-00-00-019f4524-e0ac-7571-a8af-5585504f0d40.jsonl')
  const meta = { type: 'session_meta', payload: { session_id: '019f4524-e0ac-7571-a8af-5585504f0d40', cwd } }
  await fs.writeFile(file, JSON.stringify(meta) + '\n', 'utf8')
  return file
}

describe('ProjectPathListing', () => {
  it('claude 슬러그 폴더와 codex 세션의 cwd 를 계정마다 모은다', async () => {
    const a = account('a')
    const cx = account('cx', 'codex')
    await claudeTranscript(a, 'proj-a', 'D:\\work\\proj-a')
    await codexRollout(cx, 'D:\\work\\proj-cx')
    const listing = new ProjectPathListing(makeDescriptors(process.platform))
    expect((await listing.projectPaths([a, cx])).sort()).toEqual(['D:\\work\\proj-a', 'D:\\work\\proj-cx'])
  })

  it('두 계정이 같은 폴더를 말하면 한 번만 싣는다', async () => {
    const a = account('a')
    const b = account('b')
    await claudeTranscript(a, 'proj', 'D:\\work\\proj')
    await claudeTranscript(b, 'proj', 'D:\\work\\proj')
    const listing = new ProjectPathListing(makeDescriptors(process.platform))
    expect(await listing.projectPaths([a, b])).toEqual(['D:\\work\\proj'])
  })

  // 감시자가 없으니 mtime 서명이 유일한 무효화다. 내용을 바꾸고 mtime 을 되돌리면 다시 읽지 않은
  // 것이 보인다 — 그리고 mtime 이 움직이면 곧바로 새 값을 읽는다.
  it('파일 mtime 이 그대로인 폴더는 다시 파싱하지 않고, 바뀌면 다시 읽는다', async () => {
    const a = account('a')
    const file = await claudeTranscript(a, 'proj', 'D:\\work\\before')
    // 초 단위로 박아 둔다 — 되돌렸을 때 어느 파일 시스템에서도 같은 mtimeMs 가 되도록.
    const pinned = new Date('2026-07-20T00:00:00Z')
    await fs.utimes(file, pinned, pinned)
    const listing = new ProjectPathListing(makeDescriptors(process.platform))
    expect(await listing.projectPaths([a])).toEqual(['D:\\work\\before'])

    await fs.writeFile(file, JSON.stringify({ type: 'user', sessionId: 's1', cwd: 'D:\\work\\after', message: { role: 'user', content: 'hi' } }), 'utf8')
    await fs.utimes(file, pinned, pinned)
    expect(await listing.projectPaths([a])).toEqual(['D:\\work\\before'])

    const later = new Date(pinned.getTime() + 5000)
    await fs.utimes(file, later, later)
    expect(await listing.projectPaths([a])).toEqual(['D:\\work\\after'])
  })

  it('새로 생긴 프로젝트 폴더는 다음 호출에 보인다', async () => {
    const a = account('a')
    await claudeTranscript(a, 'one', 'D:\\work\\one')
    const listing = new ProjectPathListing(makeDescriptors(process.platform))
    expect(await listing.projectPaths([a])).toEqual(['D:\\work\\one'])
    await claudeTranscript(a, 'two', 'D:\\work\\two')
    expect((await listing.projectPaths([a])).sort()).toEqual(['D:\\work\\one', 'D:\\work\\two'])
  })

  it('기록이 없는 계정은 빈 목록이다', async () => {
    const listing = new ProjectPathListing(makeDescriptors(process.platform))
    expect(await listing.projectPaths([account('none'), account('cx', 'codex')])).toEqual([])
  })
})
