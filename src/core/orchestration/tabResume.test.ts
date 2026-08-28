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
  editedFilesSource: 'transcript',
  git,
  tail: [
    { role: 'user', text: 'Preserve the public AuthService API.' },
    { role: 'assistant', text: "I'll keep the public interface unchanged." }
  ],
  lastCommand: null
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

  // fix wave 최종, F2: 대화 증거(꼬리·요청·마지막 명령)가 하나도 없으면 null 이다 — git 만으로는
  // "대화를 읽었다"고 말할 수 없다(formatHandover 의 계약, 실측 2026-08-28). 이 테스트는 예전에
  // "git 도 꼬리도 없으면 null"만 확인했는데, base 의 requests 가 채워진 채였다면 그 낡은 조건으로도
  // 통과했을 것이다 — 그래서 이번엔 셋 다 명시적으로 비운다.
  it('대화 증거가 하나도 없으면 null — 할 말이 없으면 아무 말도 하지 않는다', () => {
    const out = formatTabResume(
      { ...base, git: null, tail: [], requests: [], lastCommand: null },
      'handover'
    )
    expect(out).toBeNull()
  })

  it('git 만 있고 대화 증거가 없으면 여전히 null 이다 — git 은 대화를 읽었다는 증거가 아니다', () => {
    const out = formatTabResume({ ...base, tail: [], requests: [], lastCommand: null }, 'handover')
    expect(out).toBeNull()
  })

  it('꼬리·요청·마지막 명령 중 하나만 있어도(git 이 없어도) null 이 아니다', () => {
    expect(formatTabResume({ ...base, git: null, requests: [], lastCommand: null }, 'handover')).not.toBeNull() // 꼬리만
    expect(formatTabResume({ ...base, git: null, tail: [], lastCommand: null }, 'handover')).not.toBeNull() // 요청만
    expect(
      formatTabResume(
        {
          ...base,
          git: null,
          tail: [],
          requests: [],
          lastCommand: { command: 'npm test', failed: false, excerpt: '' }
        },
        'handover'
      )
    ).not.toBeNull() // 마지막 명령만
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

// fix wave 최종, F9: git 목록으로 내려간 손댄 파일은 "이 대화에서 손댔다"는 증거가 아니다 — 지금
// 커밋 안 된 변경일 뿐이고, 이 대화가 시작되기 전부터 있었을 수도 있다. 두 출처가 같은 표제를 쓰면
// 메모가 실제로 아는 것보다 더 안다고 주장하는 셈이다.
describe('formatTabResume — 손댄 파일 절의 표제는 출처를 따라간다 (§9.3 실측)', () => {
  it("대화 기록에서 뽑았으면 'FILES TOUCHED IN THIS CONVERSATION'이다", () => {
    const out = formatTabResume({ ...base, editedFilesSource: 'transcript' }, 'handover')!
    expect(out).toContain('FILES TOUCHED IN THIS CONVERSATION')
    expect(out).not.toContain('UNCOMMITTED CHANGES')
  })

  it("git 의 변경 목록으로 내려갔으면 'UNCOMMITTED CHANGES (from git)'이다", () => {
    const out = formatTabResume({ ...base, editedFilesSource: 'git' }, 'handover')!
    expect(out).toContain('UNCOMMITTED CHANGES (from git)')
    expect(out).not.toContain('FILES TOUCHED IN THIS CONVERSATION')
  })

  it('손댄 파일이 아예 없으면 출처와 무관하게 절 자체가 빠진다', () => {
    const out = formatTabResume({ ...base, editedFiles: [], editedFilesSource: 'git' }, 'handover')!
    expect(out).not.toContain('UNCOMMITTED CHANGES')
    expect(out).not.toContain('FILES TOUCHED IN THIS CONVERSATION')
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

// Task 6 (Phase 2c) — 설계 문서가 요구하지만 구현이 아직 안 하던 세 가지. checkpoint.ts 의
// sanitize JSDoc 이 적어 둔 실측 사고("Fixed the token: it was being dropped by the interceptor."가
// "Fixed the token=[REDACTED] was being dropped by the interceptor."로 뭉개진 것)를 다시 만들지
// 않는지가 핵심이라, 자격 증명이 아닌 평범한 산문을 반드시 함께 확인한다.
describe('formatTabResume — 자격 증명 redaction (§17)', () => {
  const secret = 'sk-ant-api03-FAKESECRETVALUE1234567890'

  it('자격 증명처럼 보이는 값이 섞인 요청은 가려진다', () => {
    const out = formatTabResume(
      { ...base, requests: [`Left a note: token=${secret} in the config.`] },
      'handover'
    )!
    expect(out).not.toContain(secret)
    expect(out).toContain('[REDACTED]')
  })

  it('평범한 산문("the token was dropped")은 그대로 남는다 — 게이트 없는 규칙을 다시 만들지 않는다', () => {
    const prose = 'Fixed the token: it was being dropped by the interceptor.'
    const out = formatTabResume({ ...base, requests: [prose], tail: [{ role: 'user', text: prose }] }, 'handover')!
    expect(out).toContain(prose)
    expect(out).not.toContain('[REDACTED]')
  })

  it('대화 꼬리에 섞인 자격 증명도 가려진다', () => {
    const out = formatTabResume(
      { ...base, tail: [{ role: 'assistant', text: `Bearer ${secret} was the culprit.` }] },
      'handover'
    )!
    expect(out).not.toContain(secret)
  })

  it('git 요약·파일 경로처럼 앱이 구조로 만든 값에는 적용하지 않는다', () => {
    // branch 이름이 우연히 그 모양이어도(예: sk-1042-fix-login) 가리지 않는다 — 구조화된 값이다
    const out = formatTabResume({ ...base, git: { ...git, branch: 'sk-1042-fix-login-token' } }, 'handover')!
    expect(out).toContain('sk-1042-fix-login-token')
  })
})

describe('formatTabResume — git 이 없다는 사실을 메모에 밝힌다 (§10)', () => {
  it('git 이 null 이면 그 사실과 파일을 직접 확인하라는 말이 들어간다', () => {
    const out = formatTabResume({ ...base, git: null }, 'handover')!
    expect(out).not.toBeNull()
    expect(out.toLowerCase()).toContain('no git evidence')
    expect(out.toLowerCase()).toContain('inspect the files directly')
  })

  it('git 도 꼬리도 없으면 여전히 null 이다 — 계약은 그대로다', () => {
    expect(
      formatTabResume(
        { ...base, git: null, tail: [], requests: [], editedFiles: [], title: null, lastCommand: null },
        'handover'
      )
    ).toBeNull()
  })
})

describe('formatTabResume — LAST COMMAND (§7 의 LAST VALIDATION)', () => {
  const lastCommand = { command: 'npm test', failed: true, excerpt: '2 tests failed' }

  it('마지막 명령과 그 결과 발췌가 메모에 들어간다', () => {
    const out = formatTabResume({ ...base, lastCommand }, 'handover')!
    expect(out).toContain('LAST COMMAND')
    expect(out).toContain('npm test')
    expect(out).toContain('2 tests failed')
  })

  it('실패했으면 failed 라고 적는다 — 종료 코드는 없으므로 지어내지 않는다', () => {
    const out = formatTabResume({ ...base, lastCommand }, 'handover')!
    expect(out).toContain('failed')
    expect(out.toLowerCase()).not.toContain('exit code')
  })

  it('실패가 아니면 실패라고 적지 않는다', () => {
    const out = formatTabResume(
      { ...base, lastCommand: { command: 'npm test', failed: false, excerpt: 'all tests passed' } },
      'handover'
    )!
    expect(out).toContain('succeeded')
    expect(out.toLowerCase()).not.toContain('failed')
  })

  it('명령이 하나도 없으면 그 절이 빠진다', () => {
    const out = formatTabResume({ ...base, lastCommand: null }, 'handover')!
    expect(out).not.toContain('LAST COMMAND')
  })

  // 상한을 느슨하게(< 1000) 재던 것을 리뷰가 잡았다 — 상한이 900 으로 잘못 바뀌어도 통과한다.
  // 실제 경계(300)를 못박는다: 그보다 조금 넘으면 잘리고, 그 아래면 그대로 남는다.
  it('발췌가 상한(300자)에서 잘린다', () => {
    const out = formatTabResume(
      { ...base, lastCommand: { command: 'npm test', failed: true, excerpt: 'x'.repeat(400) } },
      'handover'
    )!
    expect(out).toContain('x'.repeat(300) + '…')
    expect(out).not.toContain('x'.repeat(301))
  })

  it('발췌가 상한 아래면 그대로 남는다', () => {
    const out = formatTabResume(
      { ...base, lastCommand: { command: 'npm test', failed: true, excerpt: 'y'.repeat(299) } },
      'handover'
    )!
    expect(out).toContain('y'.repeat(299))
    expect(out).not.toContain('…')
  })

  // 리뷰가 잡았다: 발췌에만 상한이 있고 명령 문자열에는 없었다. 여러 줄 heredoc 이면 명령 하나가
  // 수천 자이고, 전체 예산을 넘기면 뒤쪽 절(손댄 파일·대화 꼬리)이 밀려 나간다.
  it('명령 문자열도 상한(600자)에서 잘린다', () => {
    const out = formatTabResume(
      { ...base, lastCommand: { command: 'z'.repeat(900), failed: false, excerpt: '' } },
      'handover'
    )!
    expect(out).toContain('z'.repeat(600) + '…')
    expect(out).not.toContain('z'.repeat(601))
  })

  // 리뷰가 잡은 설계 결함: 예산을 넘기면 뒤에서 자르는데 가장 뒤가 지시문 블록이었다. 증거는 많고
  // 적음의 문제지만 지시문은 있고 없음의 문제다 — 이 기능이 존재하는 이유가 그 문장이다.
  it('예산을 넘겨 잘려도 지시문 블록은 남는다', () => {
    const out = formatTabResume(
      { ...base, editedFiles: Array.from({ length: 20 }, () => 'src/'.padEnd(400, 'x')) },
      'handover'
    )!
    expect(out).toContain('truncated to fit its size budget')
    expect(out).toContain('BEFORE EDITING')
    expect(out).toContain('Preserve the existing worktree and unfinished changes')
  })

  it('발췌에 섞인 자격 증명은 가려지고, 명령 자체는 가리지 않는다', () => {
    const secret = 'sk-ant-api03-FAKESECRETVALUE1234567890'
    const out = formatTabResume(
      {
        ...base,
        lastCommand: { command: `curl -H "token=${secret}"`, failed: false, excerpt: `token=${secret} rejected` }
      },
      'handover'
    )!
    // 명령 문자열 자리는 가리지 않는다 — 무엇을 실행했는지는 판단의 핵심이다
    expect(out).toContain(`curl -H "token=${secret}"`)
    // 결과 발췌는 가려진다
    expect(out).toContain('token=[REDACTED] rejected')
    expect(out).not.toContain(`${secret} rejected`)
  })
})
