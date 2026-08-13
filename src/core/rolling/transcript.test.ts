import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// 경로 매핑 테스트는 src/core/history/strategies/mapTargetPath.test.ts로 옮겼다.
import { copyTranscript } from './transcript'

describe('copyTranscript', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-roll-'))
  })

  it('대상 폴더를 만들고 복사한다', async () => {
    const src = path.join(tmp, 'src.jsonl')
    await fs.writeFile(src, 'line1\n', 'utf8')
    const dest = path.join(tmp, 'target', 'projects', 'slug', 'src.jsonl')
    await copyTranscript(src, dest)
    expect(await fs.readFile(dest, 'utf8')).toBe('line1\n')
  })

  it('대상이 이미 있으면 덮어쓴다 (릴레이 복귀 — 내용은 항상 superset이라 안전)', async () => {
    const src = path.join(tmp, 'src.jsonl')
    const dest = path.join(tmp, 'dest.jsonl')
    await fs.writeFile(src, 'newer-superset\n', 'utf8')
    await fs.writeFile(dest, 'old\n', 'utf8')
    await copyTranscript(src, dest)
    expect(await fs.readFile(dest, 'utf8')).toBe('newer-superset\n')
  })

  it('반복 실패 시 마지막 에러를 던진다', async () => {
    await expect(
      copyTranscript(path.join(tmp, 'missing.jsonl'), path.join(tmp, 'dest.jsonl'), 2, 1)
    ).rejects.toThrow()
  })

  it('src와 dest가 같으면 복사를 건너뛴다 (단일 계정 자동 재개)', async () => {
    const f = path.join(tmp, 'same.jsonl')
    await fs.writeFile(f, 'content\n', 'utf8')
    await copyTranscript(f, f) // 자기 자신 복사 — no-op이어야(에러/훼손 없이)
    expect(await fs.readFile(f, 'utf8')).toBe('content\n')
  })

  it('대소문자만 다른 같은 경로도 self-copy로 보고 건너뛴다 (ambient 계정, Windows)', async () => {
    const f = path.join(tmp, 'Same.jsonl')
    await fs.writeFile(f, 'content\n', 'utf8')
    // dest는 같은 파일을 대소문자만 바꿔 가리킴 — 가드가 정규화 비교로 no-op 처리해야
    await copyTranscript(f, f.toLowerCase())
    expect(await fs.readFile(f, 'utf8')).toBe('content\n')
  })
})
