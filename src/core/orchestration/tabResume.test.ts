import { describe, it, expect } from 'vitest'
import { formatTabResume, type TabResumeInput } from './tabResume'
import type { GitSummary } from './checkpoint'

const git: GitSummary = {
  branch: 'main',
  head: 'abc123',
  changed: ['src/auth/AuthService.ts', 'test/AuthService.test.ts'],
  diffstat: '2 files changed, 10 insertions(+), 2 deletions(-)'
}

const base: TabResumeInput = {
  cwd: 'C:/projects/my-api',
  title: 'refactor-auth-module',
  requests: ['Refactor the authentication module.', 'Also update its tests.'],
  editedFiles: ['src/auth/AuthService.ts'],
  git,
  tail: [
    { role: 'user', text: 'Preserve the public AuthService API.' },
    { role: 'assistant', text: "I'll keep the public interface unchanged." }
  ]
}

describe('formatTabResume — handover', () => {
  it('이어받는 작업이라는 것과 처음부터 다시 하지 말라는 것이 들어 있다', () => {
    const out = formatTabResume(base, 'handover')
    expect(out).not.toBeNull()
    expect(out!.toLowerCase()).toContain('continuing an existing')
    expect(out!.toLowerCase()).toContain('do not start over from scratch')
  })

  it('현재 git 상태를 직접 확인하라는 지시가 들어 있다', () => {
    const out = formatTabResume(base, 'handover')!
    expect(out.toLowerCase()).toContain('inspect git status')
    expect(out.toLowerCase()).toContain('inspect the current git diff before editing')
  })

  it('워크트리와 마무리되지 않은 변경을 보존하라는 지시가 들어 있다', () => {
    const out = formatTabResume(base, 'handover')!
    expect(out).toContain('Preserve the existing worktree and unfinished changes')
  })

  // Job 워커의 formatResumeSection 과 다른 자리: 탭 세션에는 worker_done 을 받을 Task 가 없으므로
  // 보고 의무 문장을 넣지 않는다 — 넣으면 없는 프로토콜을 따르라고 지시하는 것이 된다.
  it('Job 과 달리 보고 의무 문장(astera send --type worker_done)이 없다', () => {
    const out = formatTabResume(base, 'handover')!
    expect(out).not.toContain('astera send')
    expect(out.toLowerCase()).not.toContain('worker_done')
    expect(out.toLowerCase()).not.toContain('report when done')
  })

  it('git 도 꼬리도 없으면 null — 할 말이 없으면 아무 말도 하지 않는다', () => {
    const out = formatTabResume({ ...base, git: null, tail: [] }, 'handover')
    expect(out).toBeNull()
  })

  it('git 이나 꼬리 중 하나만 있어도 null 이 아니다', () => {
    expect(formatTabResume({ ...base, tail: [] }, 'handover')).not.toBeNull()
    expect(formatTabResume({ ...base, git: null }, 'handover')).not.toBeNull()
  })

  it('꼬리가 있으면 메시지들이 들어가되 개수 상한을 넘지 않는다', () => {
    const tail = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `message ${i}`
    }))
    const out = formatTabResume({ ...base, tail }, 'handover')!
    // 상한을 넘는 메시지는 실리지 않는다 — 가장 오래된 것들은 빠진다
    expect(out).not.toContain('message 0')
    expect(out).not.toContain('message 13')
    // 가장 최근 메시지는 남는다
    expect(out).toContain('message 19')
    const tailLines = out
      .split('\n\n')
      .find((s) => s.startsWith('CONVERSATION TAIL'))!
      .split('\n')
      .filter((l) => l.startsWith('['))
    expect(tailLines.length).toBeLessThanOrEqual(6)
  })

  it('대화 제목이 없어도 메모가 성립한다 — 그 줄만 빠지고 나머지는 그대로다', () => {
    const out = formatTabResume({ ...base, title: null }, 'handover')
    expect(out).not.toBeNull()
    expect(out).not.toContain('CONVERSATION TITLE')
    // 제목 말고 나머지 재료는 그대로 들어간다
    expect(out).toContain('Refactor the authentication module.')
    expect(out).toContain('src/auth/AuthService.ts')
  })

  it('최근 사용자 요청이 시간 순으로 들어가고, 어느 하나도 "작업"으로 이름 붙지 않는다', () => {
    // 요청이 바뀐 대화를 재현한다 — 첫 요청과 마지막 요청이 서로 다르다
    const changed: TabResumeInput = {
      ...base,
      requests: [
        'Refactor the authentication module.',
        'Actually, hold off on that — fix the flaky CI test first.',
        'Also add a regression test for the fix.'
      ]
    }
    const out = formatTabResume(changed, 'handover')!
    // 셋 다 들어간다
    expect(out).toContain('Refactor the authentication module.')
    expect(out).toContain('Actually, hold off on that — fix the flaky CI test first.')
    expect(out).toContain('Also add a regression test for the fix.')
    // 첫 번째만 골라 강조하는 문구가 없다 — "objective"/"the task"로 부르지 않는다
    expect(out.toLowerCase()).not.toContain('objective')
    expect(out.toLowerCase()).not.toContain('the task is')
    // 순서가 유지된다(시간 순)
    const idxFirst = out.indexOf('Refactor the authentication module.')
    const idxSecond = out.indexOf('Actually, hold off on that')
    const idxThird = out.indexOf('Also add a regression test')
    expect(idxFirst).toBeLessThan(idxSecond)
    expect(idxSecond).toBeLessThan(idxThird)
  })
})

describe('formatTabResume — update', () => {
  it('짧다 — 꼬리를 싣지 않고 git 상태만 싣는다', () => {
    const out = formatTabResume(base, 'update')!
    expect(out).not.toBeNull()
    expect(out).not.toContain('Preserve the public AuthService API') // 꼬리 메시지가 없다
    expect(out).not.toContain('Refactor the authentication module') // 요청도 없다
    expect(out).not.toContain('CONVERSATION TITLE')
    expect(out).toContain('src/auth/AuthService.ts') // git 변경 파일은 있다
  })

  it('handover 와 다른 문자열을 낸다', () => {
    const handover = formatTabResume(base, 'handover')
    const update = formatTabResume(base, 'update')
    expect(update).not.toEqual(handover)
  })

  it('git 을 못 읽었으면 null이다 — 꼬리가 있어도 마찬가지다(꼬리는 update 재료가 아니다)', () => {
    const out = formatTabResume({ ...base, git: null }, 'update')
    expect(out).toBeNull()
  })

  it('변경사항이 없으면 그렇게 말한다', () => {
    const out = formatTabResume({ ...base, git: { ...git, changed: [] } }, 'update')!
    expect(out).toContain('no uncommitted changes')
  })
})

// 아래 셋은 리뷰가 실측으로 잡은 결함을 고정한다(2026-08-28). 이 저장소의 실제 대화 파일 하나의
// 마지막 파일 이력 레코드가 추적 파일 149개를 싣고 있었고, 상한이 없던 파일 절만 렌더하면 8,620자로
// Job packet 이 메모 전체에 두는 예산(6000자)을 혼자 넘겼다.
describe('formatTabResume — 크기 상한', () => {
  const many = (n: number, prefix: string): string[] =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`)

  it('파일 목록은 상한까지만 싣고 잘린 개수를 밝힌다', () => {
    const out = formatTabResume({ ...base, editedFiles: many(149, 'src/f') }, 'handover')!
    expect(out).toContain('- src/f0')
    expect(out).toContain('- src/f19')
    expect(out).not.toContain('- src/f20')
    expect(out).toContain('…and 129 more') // 조용히 자르면 새 세션이 "이게 전부" 로 읽는다
  })

  it('최근 요청은 상한까지만 싣고, 남기는 것은 최신 쪽이다', () => {
    const out = formatTabResume({ ...base, requests: many(12, 'req') }, 'handover')!
    expect(out).toContain('req11') // 가장 최근
    expect(out).toContain('req7')
    expect(out).not.toContain('req6') // 12개 중 마지막 5개만
  })

  it('메모 전체가 예산을 넘으면 뒤에서 자르고 잘렸다고 밝힌다', () => {
    const out = formatTabResume(
      { ...base, editedFiles: many(20, 'src/'.padEnd(400, 'x') + '/') },
      'handover'
    )!
    expect(out.length).toBeLessThanOrEqual(6000)
    expect(out).toContain('truncated to fit its size budget')
    // 앞쪽 절은 살아남는다 — 무엇을 이어받는지가 대화 꼬리보다 잃으면 안 되는 정보다
    expect(out.toLowerCase()).toContain('do not start over from scratch')
  })
})
