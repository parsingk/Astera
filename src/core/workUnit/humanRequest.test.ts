import { describe, it, expect } from 'vitest'
import { isHumanRequest, requestTextOf, titleOf } from './humanRequest'

/** 실제 트랜스크립트 레코드의 모양을 줄인 것 */
const rec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'user',
  promptSource: 'typed',
  message: { content: '로그인 기능 만들어줘' },
  ...over
})

describe('isHumanRequest — 사람의 요청인가 (스펙 §16.2)', () => {
  it('사람이 친 말은 통과한다', () => {
    expect(isHumanRequest(rec())).toBe(true)
  })

  // 실측(40개 파일)에서 사람 것으로 갈린 네 값
  it('큐에 넣은 말·SDK·제안 수락도 사람의 요청이다', () => {
    expect(isHumanRequest(rec({ promptSource: 'queued' }))).toBe(true)
    expect(isHumanRequest(rec({ promptSource: 'sdk' }))).toBe(true)
    expect(isHumanRequest(rec({ promptSource: 'suggestion_accepted' }))).toBe(true)
  })

  // 실측에서 3,206개 중 2,674개(84%)가 이것이다
  it('도구 결과는 아니다 — toolUseResult 가 있으면 구조로 갈린다', () => {
    expect(isHumanRequest(rec({ toolUseResult: { stdout: 'ok' } }))).toBe(false)
  })

  it('하네스가 끼워 넣은 알림은 아니다', () => {
    expect(isHumanRequest(rec({ promptSource: 'system' }))).toBe(false)
  })

  it('스킬 본문과 이미지 자리표시자는 아니다', () => {
    expect(isHumanRequest(rec({ isMeta: true }))).toBe(false)
  })

  it('압축 이어가기 안내는 아니다', () => {
    expect(isHumanRequest(rec({ isCompactSummary: true }))).toBe(false)
  })

  it('슬래시 명령은 아니다 — promptSource 가 없다', () => {
    expect(isHumanRequest(rec({ promptSource: undefined }))).toBe(false)
  })

  it('promptSource 가 있어도 <command-name 으로 시작하면 슬래시 명령이다', () => {
    const r = rec({ message: { content: '<command-name>/clear</command-name>' } })
    expect(isHumanRequest(r)).toBe(false)
  })

  // **허용 목록이라는 것이 이 판정의 요점이다.** 차단 목록이면 새 값이 통과해 버린다.
  it('모르는 promptSource 는 거부한다 — 기본이 거부여야 새 주입이 새지 않는다', () => {
    expect(isHumanRequest(rec({ promptSource: 'some-future-injection' }))).toBe(false)
  })

  it('user 가 아닌 레코드는 아니다', () => {
    expect(isHumanRequest(rec({ type: 'assistant' }))).toBe(false)
  })

  it('빈 텍스트는 아니다', () => {
    expect(isHumanRequest(rec({ message: { content: '   \n ' } }))).toBe(false)
  })

  it('모양이 망가진 레코드에 던지지 않는다', () => {
    expect(isHumanRequest({})).toBe(false)
    expect(isHumanRequest(rec({ message: null }))).toBe(false)
    expect(isHumanRequest(rec({ message: { content: 42 } }))).toBe(false)
  })
})

describe('titleOf — 제목 (스펙 §8)', () => {
  it('사용자의 말을 그대로 쓴다 — 지어내지 않는다', () => {
    expect(titleOf('로그인 기능 만들어줘')).toBe('로그인 기능 만들어줘')
  })

  it('여러 줄과 잇단 공백은 한 줄로 접는다', () => {
    expect(titleOf(`로그인   기능
만들어줘`)).toBe('로그인 기능 만들어줘')
  })

  it('긴 것은 자른다 — toTitle 의 80자 규칙을 그대로 쓴다', () => {
    const long = 'ㄱ'.repeat(100)
    expect(titleOf(long)).toBe('ㄱ'.repeat(80) + '…')
  })

  // toTitle 은 빈 문자열에 null 을 준다. Unit 의 title 은 비어 있으면 안 되므로 감싼다
  it('빈 텍스트에도 문자열을 준다 — Unit 은 제목 없이 설 수 없다', () => {
    expect(titleOf('')).toBe('(제목 없음)')
    expect(titleOf('   ')).toBe('(제목 없음)')
  })
})

describe('requestTextOf — 텍스트 꺼내기', () => {
  it('문자열 content 를 그대로 준다', () => {
    expect(requestTextOf(rec())).toBe('로그인 기능 만들어줘')
  })

  it('블록 배열이면 text 블록만 이어 붙인다', () => {
    const r = rec({
      message: {
        content: [
          { type: 'text', text: '첫 줄' },
          { type: 'image', source: {} },
          { type: 'text', text: ' 둘째 줄' }
        ]
      }
    })
    expect(requestTextOf(r)).toBe('첫 줄 둘째 줄')
  })

  it('꺼낼 것이 없으면 빈 문자열이다', () => {
    expect(requestTextOf({})).toBe('')
    expect(requestTextOf(rec({ message: { content: [] } }))).toBe('')
  })
})
