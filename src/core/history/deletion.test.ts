import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { deletableTranscripts, prunableDirs } from './deletion'

const p = (...parts: string[]): string => path.join(...parts)
const CLAUDE = p('C:', 'u', 'me', '.claude', 'projects')
const CODEX = p('C:', 'u', 'me', '.codex', 'sessions')

describe('deletableTranscripts', () => {
  it('스캔 루트 밑의 .jsonl 만 통과시킨다', () => {
    const slug = p(CLAUDE, 'D--work-foo')
    const files = [p(slug, 'a.jsonl'), p(slug, 'b.jsonl')]
    expect(deletableTranscripts(files, [CLAUDE])).toEqual(files)
  })

  // 경로 해석이 어긋났을 때 마지막으로 막는 자리다 — 여기를 통과한 것은 그대로 지워진다
  it('스캔 루트 밖의 파일은 버린다', () => {
    const outside = p('C:', 'u', 'me', 'Documents', 'secret.jsonl')
    expect(deletableTranscripts([outside], [CLAUDE])).toEqual([])
  })

  it('스캔 루트 밑이어도 .jsonl 이 아니면 버린다', () => {
    const cfg = p(CLAUDE, 'D--work-foo', 'settings.json')
    expect(deletableTranscripts([cfg], [CLAUDE])).toEqual([])
  })

  it('스캔 루트 자기 자신은 버린다', () => {
    expect(deletableTranscripts([CLAUDE], [CLAUDE])).toEqual([])
  })

  it('스캔 루트가 여럿이면 어느 하나에만 들어도 통과한다', () => {
    const a = p(CLAUDE, 'slug', 'x.jsonl')
    const b = p(CODEX, '2026', '08', '24', 'rollout-1.jsonl')
    expect(deletableTranscripts([a, b], [CLAUDE, CODEX])).toEqual([a, b])
  })

  it('스캔 루트가 없으면 아무것도 통과시키지 않는다', () => {
    expect(deletableTranscripts([p(CLAUDE, 'slug', 'x.jsonl')], [])).toEqual([])
  })

  it('같은 파일이 두 번 들어와도 한 번만 돌려준다', () => {
    const f = p(CLAUDE, 'slug', 'x.jsonl')
    expect(deletableTranscripts([f, f], [CLAUDE])).toEqual([f])
  })

  // 루트 이름이 접두사로 겹치는 이웃 디렉터리 — startsWith 만으로 비교하면 새어 든다
  it('이름이 스캔 루트로 시작할 뿐인 형제 디렉터리는 버린다', () => {
    const sibling = p('C:', 'u', 'me', '.claude', 'projects-backup', 'x.jsonl')
    expect(deletableTranscripts([sibling], [CLAUDE])).toEqual([])
  })
})

describe('prunableDirs', () => {
  it('스캔 루트의 직계 자식만 고른다', () => {
    const slug = p(CLAUDE, 'D--work-foo')
    expect(prunableDirs([slug], [CLAUDE])).toEqual([slug])
  })

  // codex 는 sessions/<년>/<월>/<일> 이라 직계 자식이 아니다. 날짜 디렉터리에는 다른 프로젝트의
  // 세션이 남아 있을 수 있으므로 애초에 정리 대상으로 삼지 않는다.
  it('스캔 루트 두 단계 아래의 디렉터리는 고르지 않는다', () => {
    expect(prunableDirs([p(CODEX, '2026', '08', '24')], [CODEX])).toEqual([])
  })

  it('스캔 루트 자기 자신은 고르지 않는다', () => {
    expect(prunableDirs([CLAUDE], [CLAUDE])).toEqual([])
  })

  it('스캔 루트 밖의 디렉터리는 고르지 않는다', () => {
    expect(prunableDirs([p('C:', 'u', 'me', 'Documents')], [CLAUDE])).toEqual([])
  })

  it('같은 디렉터리가 여러 파일에서 올라와도 한 번만 돌려준다', () => {
    const slug = p(CLAUDE, 'D--work-foo')
    expect(prunableDirs([slug, slug, slug], [CLAUDE])).toEqual([slug])
  })

  it('고를 것이 없으면 빈 목록이다', () => {
    expect(prunableDirs([], [CLAUDE])).toEqual([])
  })
})
