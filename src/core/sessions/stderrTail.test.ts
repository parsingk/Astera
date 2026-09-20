import { describe, it, expect } from 'vitest'
import { createStderrTail, STDERR_TAIL_MAX } from './stderrTail'

describe('createStderrTail', () => {
  it('아무것도 안 들어오면 undefined — 빈 문자열과 다르다', () => {
    expect(createStderrTail().value()).toBeUndefined()
  })

  it('들어온 것을 이어 붙인다', () => {
    const t = createStderrTail()
    t.push('error: Could not parse ')
    t.push('project manifest\n')
    expect(t.value()).toBe('error: Could not parse project manifest\n')
  })

  // 상한을 넘으면 **뒤를** 남긴다 — 프로세스가 죽기 직전에 한 말이 이유이고, 앞쪽 진행 로그가 아니다
  it('상한을 넘으면 마지막 것만 남긴다', () => {
    const t = createStderrTail(10)
    t.push('0123456789')
    t.push('abcde')
    expect(t.value()).toBe('56789abcde')
  })

  it('기본 상한은 4000 — CheckResult.outputTail 과 같은 값', () => {
    expect(STDERR_TAIL_MAX).toBe(4000)
    const t = createStderrTail()
    t.push('x'.repeat(5000))
    expect(t.value()?.length).toBe(4000)
  })

  // 최종 리뷰 파동(finding 6): 빈 청크가 undefined 를 '' 로 뒤집으면 "아무도 안 모았다"가
  // "프로세스가 말이 없었다"로 바뀐다 — Node 의 'data' 는 빈 청크를 안 내놓아 오늘은 닿지 않는
  // 경로지만, 지켜서 잃을 것이 없다
  it('빈 청크는 undefined 를 뒤집지 않는다', () => {
    const t = createStderrTail()
    t.push('')
    expect(t.value()).toBeUndefined()
  })
})
