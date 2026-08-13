import { describe, expect, it } from 'vitest'
import { extractLastAgentMessage } from './codexTranscript'

const line = (payload: object): string => JSON.stringify({ type: 'event_msg', payload })

describe('extractLastAgentMessage', () => {
  it('마지막 agent_message의 텍스트를 돌려준다', () => {
    const tail = [
      line({ type: 'agent_message', message: '첫 번째' }),
      line({ type: 'user_message', message: '사용자' }),
      line({ type: 'agent_message', message: '마지막' })
    ].join('\n')
    expect(extractLastAgentMessage(tail)).toBe('마지막')
  })

  it('user_message는 무시한다', () => {
    expect(extractLastAgentMessage(line({ type: 'user_message', message: '사용자' }))).toBeNull()
  })

  it('agent_message가 없으면 null', () => {
    const tail = [
      line({ type: 'task_complete' }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message' } })
    ].join('\n')
    expect(extractLastAgentMessage(tail)).toBeNull()
  })

  it('꼬리를 중간부터 읽어 첫 줄이 잘려도 무시하고 계속한다', () => {
    const tail = ['e":"깨진 조각"}}', line({ type: 'agent_message', message: '정상' })].join('\n')
    expect(extractLastAgentMessage(tail)).toBe('정상')
  })

  it('빈 문자열·공백만인 message는 건너뛰고 그 앞을 본다', () => {
    const tail = [
      line({ type: 'agent_message', message: '유효' }),
      line({ type: 'agent_message', message: '   ' })
    ].join('\n')
    expect(extractLastAgentMessage(tail)).toBe('유효')
  })

  it('message가 문자열이 아니면 무시한다 (방어적 파싱)', () => {
    const tail = [
      line({ type: 'agent_message', message: '유효' }),
      line({ type: 'agent_message', message: { text: '객체' } })
    ].join('\n')
    expect(extractLastAgentMessage(tail)).toBe('유효')
  })

  it('event_msg가 아닌 줄은 무시한다', () => {
    const tail = JSON.stringify({ type: 'response_item', payload: { type: 'agent_message', message: 'x' } })
    expect(extractLastAgentMessage(tail)).toBeNull()
  })
})
