import { describe, expect, it } from 'vitest'
import { extractLastAgentMessage } from './codexTranscript'

/** 현행 codex 형식의 메시지 한 줄(codexTranscript 의 주석 — 실측 2026-08-29) */
const msg = (role: string, text: unknown): string =>
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] }
  })
/** 옛 형식 한 줄 — 읽지 않아야 한다 */
const legacy = (payload: object): string => JSON.stringify({ type: 'event_msg', payload })

describe('extractLastAgentMessage', () => {
  it('마지막 assistant 메시지의 텍스트를 돌려준다', () => {
    const tail = [msg('assistant', '첫 번째'), msg('user', '사용자'), msg('assistant', '마지막')].join(
      '\n'
    )
    expect(extractLastAgentMessage(tail)).toBe('마지막')
  })

  it('사용자 메시지는 무시한다', () => {
    expect(extractLastAgentMessage(msg('user', '사용자'))).toBeNull()
  })

  // 스킬 지시문 등이 들어오는 롤 — 에이전트가 한 말이 아니다
  it('developer 롤은 무시한다', () => {
    expect(extractLastAgentMessage(msg('developer', '<skills_instructions>…'))).toBeNull()
  })

  it('assistant 메시지가 없으면 null', () => {
    const tail = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', id: 'r1' } })
    ].join('\n')
    expect(extractLastAgentMessage(tail)).toBeNull()
  })

  it('꼬리를 중간부터 읽어 첫 줄이 잘려도 무시하고 계속한다', () => {
    const tail = ['e":"깨진 조각"}}', msg('assistant', '정상')].join('\n')
    expect(extractLastAgentMessage(tail)).toBe('정상')
  })

  it('빈 문자열·공백만인 본문은 건너뛰고 그 앞을 본다', () => {
    const tail = [msg('assistant', '유효'), msg('assistant', '   ')].join('\n')
    expect(extractLastAgentMessage(tail)).toBe('유효')
  })

  it('text 가 문자열이 아니면 그 블록을 버린다 (방어적 파싱)', () => {
    const tail = [msg('assistant', '유효'), msg('assistant', { text: '객체' })].join('\n')
    expect(extractLastAgentMessage(tail)).toBe('유효')
  })

  it('한 레코드의 블록 여럿은 이어 붙인다', () => {
    const tail = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: '앞' },
          { type: 'output_text', text: '뒤' }
        ]
      }
    })
    expect(extractLastAgentMessage(tail)).toBe('앞뒤')
  })

  // **옛 형식은 읽지 않는다.** 구 형식 파일에도 response_item 이 함께 있으므로(실측 2026-08-29)
  // 둘을 함께 읽으면 같은 메시지가 두 번 잡힌다 — codexParser 의 eventMessage 와 같은 판단이다.
  it('옛 event_msg/agent_message 는 읽지 않는다', () => {
    expect(extractLastAgentMessage(legacy({ type: 'agent_message', message: 'x' }))).toBeNull()
  })
})
