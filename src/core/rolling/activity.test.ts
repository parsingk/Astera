import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lastActivityAt, parsePendingWorkflowCount, readPendingWorkflowCount } from './activity'

async function makeSession(): Promise<{ dir: string; transcript: string; sessionDir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-activity-'))
  const transcript = path.join(dir, 'sess-1.jsonl')
  await fs.writeFile(transcript, '{}\n')
  return { dir, transcript, sessionDir: path.join(dir, 'sess-1') }
}

const touch = async (p: string, atMs: number): Promise<void> => {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, 'x')
  await fs.utimes(p, new Date(atMs), new Date(atMs))
}

describe('lastActivityAt', () => {
  it('transcript만 있으면 그 mtime을 반환한다', async () => {
    const s = await makeSession()
    const t = Date.now() - 60_000
    await fs.utimes(s.transcript, new Date(t), new Date(t))
    const got = await lastActivityAt(s.transcript)
    expect(got).not.toBeNull()
    expect(Math.abs((got as number) - t)).toBeLessThan(2_000)
  })

  it('서브에이전트 트리의 더 최신 mtime이 이긴다', async () => {
    const s = await makeSession()
    const oldT = Date.now() - 60 * 60_000
    const newT = Date.now() - 5_000
    await fs.utimes(s.transcript, new Date(oldT), new Date(oldT))
    await touch(path.join(s.sessionDir, 'subagents', 'workflows', 'wf_x', 'journal.jsonl'), newT)
    const got = await lastActivityAt(s.transcript)
    expect(Math.abs((got as number) - newT)).toBeLessThan(2_000)
  })

  it('transcript도 서브에이전트 트리도 없으면 null', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-activity-'))
    expect(await lastActivityAt(path.join(dir, 'none.jsonl'))).toBeNull()
  })

  it('과도하게 깊은 트리는 depth cap에서 멈춘다 (심링크·비정상 방어)', async () => {
    const s = await makeSession()
    const oldT = Date.now() - 60 * 60_000
    await fs.utimes(s.transcript, new Date(oldT), new Date(oldT))
    // sessionDir 아래 12단계(cap=8 초과) 깊이에 최신 파일 — cap 너머라 무시돼야 한다
    const deep = path.join(s.sessionDir, ...Array<string>(12).fill('d'), 'x.jsonl')
    await touch(deep, Date.now() - 5_000)
    const got = await lastActivityAt(s.transcript)
    // cap 너머 파일 무시 → transcript의 oldT가 최댓값으로 남는다
    expect(Math.abs((got as number) - oldT)).toBeLessThan(2_000)
  })
})

describe('parsePendingWorkflowCount', () => {
  const td = (n?: number): string =>
    JSON.stringify({ type: 'system', subtype: 'turn_duration', ...(n !== undefined && { pendingWorkflowCount: n }) })

  it('마지막 turn_duration의 pendingWorkflowCount를 반환한다', () => {
    expect(parsePendingWorkflowCount([td(2), '{"type":"assistant"}', td(1)].join('\n'))).toBe(1)
  })

  it('turn_duration 항목이 없으면 null', () => {
    expect(parsePendingWorkflowCount('{"type":"assistant"}\n')).toBeNull()
  })

  it('깨진 줄(꼬리 절단)은 건너뛴다', () => {
    expect(parsePendingWorkflowCount(['ge":{"role":"user"}}', td(3)].join('\n'))).toBe(3)
  })

  it('pendingWorkflowCount 필드가 없는 turn_duration은 null 취급', () => {
    expect(parsePendingWorkflowCount(td())).toBeNull()
  })
})

describe('readPendingWorkflowCount', () => {
  it('파일 꼬리에서 파싱하고, 파일 없음은 null', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-activity-'))
    const f = path.join(dir, 't.jsonl')
    await fs.writeFile(f, JSON.stringify({ type: 'system', subtype: 'turn_duration', pendingWorkflowCount: 1 }) + '\n')
    expect(await readPendingWorkflowCount(f)).toBe(1)
    expect(await readPendingWorkflowCount(path.join(dir, 'none.jsonl'))).toBeNull()
  })
})
