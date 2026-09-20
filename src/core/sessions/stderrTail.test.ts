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
})
