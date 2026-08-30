import { describe, it, expect } from 'vitest'
import { isCodexTurnComplete, isHumanRequest, requestTextOf, titleOf } from './humanRequest'

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

// ── codex (rollout) ────────────────────────────────────────────────────
//
// 실측(2026-08-30, 최근 60개 rollout): role:'user' 메시지 262건 중 사람이 친 것 37건.
// 나머지는 재개 되쓰기 63 · AGENTS.md/환경/플러그인 48 · 옛 기록 114 다.

/** codex rollout 의 사람 메시지 모양. 실제 파일에서 그대로 줄인 것이다 */
const codexUser = (text: string, kinds: unknown = ['user.text']): Record<string, unknown> => ({
  timestamp: '2026-08-30T00:00:00.000Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: {
      turn_id: 't1',
      content_item_kinds: kinds
    }
  }
})

describe('isHumanRequest — codex 갈래', () => {
  it('사람이 친 말은 통과한다', () => {
    expect(isHumanRequest(codexUser('이어서 작업 진행해 줘'))).toBe(true)
  })

  // 실측 48건. codex 가 주입의 종류를 스스로 이름 붙여 준다
  it('AGENTS.md·환경 컨텍스트·플러그인 추천은 아니다', () => {
    const kinds = ['agents_md.instructions', 'environments.environment_context']
    expect(isHumanRequest(codexUser('# AGENTS.md instructions', kinds))).toBe(false)
    expect(isHumanRequest(codexUser('<environment_context>', ['environments.environment_context']))).toBe(false)
    expect(
      isHumanRequest(codexUser('<recommended_plugins>', ['plugins.recommendations', 'agents_md.instructions']))
    ).toBe(false)
  })

  // **가장 중요한 한 줄.** 실측 63건이 전부 재개 되쓰기였고, 이것이 새면 켜기 전의 대화가
  // Unit 이 되어 스펙 §16.1 의 약속이 깨진다
  it('재개 되쓰기는 아니다 — user.text 가 여러 개다', () => {
    const many = Array(12).fill('user.text')
    expect(isHumanRequest(codexUser('The following is the Codex agent history…', many))).toBe(false)
  })

  // 실측 114건 — 8/25 세션 하나에 몰려 있는 옛 codex 다. 지금 codex 는 늘 싣는다
  it('표지가 없는 옛 기록은 거부한다 — 허용 목록의 기본이 거부다', () => {
    // passthrough 자체가 없는 모양
    const noMeta = {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '그래' }] }
    }
    expect(isHumanRequest(noMeta)).toBe(false)
    // passthrough 는 있는데 kinds 만 없는 모양
    const noKinds = codexUser('진행해')
    delete (
      (noKinds.payload as Record<string, unknown>)
        .internal_chat_message_metadata_passthrough as Record<string, unknown>
    ).content_item_kinds
    expect(isHumanRequest(noKinds)).toBe(false)
  })

  it('모르는 kind 는 거부한다 — 새 주입 종류가 생겨도 조용히 새지 않는다', () => {
    expect(isHumanRequest(codexUser('무언가', ['some.future.injection']))).toBe(false)
  })

  it('user 가 아닌 codex 레코드는 아니다', () => {
    const assistant = codexUser('답변')
    ;(assistant.payload as Record<string, unknown>).role = 'assistant'
    expect(isHumanRequest(assistant)).toBe(false)
    expect(isHumanRequest({ type: 'event_msg', payload: { type: 'token_count' } })).toBe(false)
  })

  it('빈 텍스트는 아니다', () => {
    expect(isHumanRequest(codexUser('   '))).toBe(false)
  })

  it('망가진 모양에 던지지 않는다', () => {
    expect(isHumanRequest({ type: 'response_item' })).toBe(false)
    expect(isHumanRequest({ type: 'response_item', payload: null })).toBe(false)
    expect(isHumanRequest({ type: 'response_item', payload: { type: 'message', role: 'user', content: 42 } })).toBe(false)
  })
})

describe('requestTextOf — codex 의 input_text 블록', () => {
  it('input_text 만 이어 붙인다', () => {
    expect(requestTextOf(codexUser('로그인 고쳐줘'))).toBe('로그인 고쳐줘')
  })

  it('claude 의 text 블록과 섞이지 않는다 — 형식마다 자기 종류만 읽는다', () => {
    const r = codexUser('x')
    ;(r.payload as Record<string, unknown>).content = [
      { type: 'input_text', text: '가' },
      { type: 'text', text: '나' },
      { type: 'image', source: {} }
    ]
    expect(requestTextOf(r)).toBe('가')
  })
})

describe('isCodexTurnComplete — 턴이 끝났다는 codex 자신의 기록', () => {
  it('task_complete 를 알아본다', () => {
    expect(isCodexTurnComplete({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } })).toBe(true)
  })

  it('task_started 와 turn_aborted 는 완료가 아니다', () => {
    expect(isCodexTurnComplete({ type: 'event_msg', payload: { type: 'task_started' } })).toBe(false)
    // 끊긴 턴은 완료가 아니다 — 그 Unit 은 다음 메시지나 세션 종료가 닫는다 (WU §14)
    expect(isCodexTurnComplete({ type: 'event_msg', payload: { type: 'turn_aborted' } })).toBe(false)
  })

  it('다른 레코드와 망가진 모양에 던지지 않는다', () => {
    expect(isCodexTurnComplete({ type: 'response_item', payload: { type: 'task_complete' } })).toBe(false)
    expect(isCodexTurnComplete({ type: 'event_msg' })).toBe(false)
    expect(isCodexTurnComplete({})).toBe(false)
  })
})
