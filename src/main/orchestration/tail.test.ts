import { describe, it, expect } from 'vitest'
import { WorkerTails, TAIL_UNTRACKED, TAIL_EMPTY, TAIL_DEFAULT_LIMIT } from './tail'

const never = (): boolean => false // 아무 dispatch도 종단에 이르지 않았다
const always = (): boolean => true // 전부 종단

describe('WorkerTails', () => {
  it('추적을 시작하지 않은 dispatch는 미추적 문구를 돌려준다', () => {
    const t = new WorkerTails()
    expect(t.read('dsp_1')).toBe(TAIL_UNTRACKED)
  })

  it('추적 중이지만 아직 출력이 없으면 미추적과 다른 문구다 (리뷰 I4)', () => {
    // worker-start 직후 첫 PTY 청크가 오기 전 창 — 반드시 성립한다. 빈 문자열을 돌려주면
    // 읽는 쪽이 "워커가 아무것도 출력하지 않았다"로 읽는다.
    const t = new WorkerTails()
    t.start({ dispatchId: 'dsp_1', sessionId: 'sess_A' }, never)
    expect(t.read('dsp_1')).toBe(TAIL_EMPTY)
    expect(t.read('dsp_1')).not.toBe('')
    expect(TAIL_EMPTY).not.toBe(TAIL_UNTRACKED)
  })

  it('추적 대상이 아닌 세션의 출력은 무시한다', () => {
    // 이 조기 반환이 stripAnsi보다 **먼저** 온다는 것이 이 설계의 핵심이다 — 게이트와 비용이 같은
    // 자리에 있어야 앱의 모든 세션 핫패스에 정규식이 붙지 않는다(아래 ANSI 테스트 참고).
    const t = new WorkerTails()
    t.push('sess_user', 'the user is typing')
    expect(t.size()).toBe(0)
  })

  it('push가 ANSI 이스케이프를 지워 보관한다 (게이트 뒤로 옮긴 비용)', () => {
    // 예전에는 호출부(ipc.ts의 onData)가 stripAnsi로 인자를 감쌌다 — 인자는 push 진입 전에
    // 평가되므로 토글이 꺼져 있어도 워커가 0개여도 모든 세션의 모든 바이트에 정규식이 붙었다.
    // 지금은 게이트(owner 조회)와 비용이 같은 자리에 있다. 읽는 쪽이 LLM이라 제거 자체는 계약이다.
    const t = new WorkerTails()
    t.start({ dispatchId: 'dsp_1', sessionId: 'sess_A' }, never)
    t.push('sess_A', "\u001b[31mred\u001b[0m \u001b]0;title\u0007text")
    expect(t.read('dsp_1')).toBe('red text')
  })

  it('append하고 마지막 줄들을 돌려준다', () => {
    const t = new WorkerTails()
    t.start({ dispatchId: 'dsp_1', sessionId: 'sess_A' }, never)
    t.push('sess_A', 'line1\nline2\n')
    t.push('sess_A', 'line3\n')
    expect(t.read('dsp_1')).toBe('line1\nline2\nline3')
  })

  it('캡을 넘기면 앞이 버려진다', () => {
    const t = new WorkerTails(10)
    t.start({ dispatchId: 'dsp_1', sessionId: 'sess_A' }, never)
    t.push('sess_A', 'abcdefgh')
    t.push('sess_A', 'IJKLMN')
    expect(t.read('dsp_1')).toBe('efghIJKLMN')
  })

  describe('dispatch 키잉 — 재사용 세션 (리뷰 I2)', () => {
    it('재사용 세션에서 A와 B의 출력이 섞이지 않는다', () => {
      const t = new WorkerTails()
      t.start({ dispatchId: 'dsp_A', sessionId: 'sess_S' }, never)
      t.push('sess_S', 'A가 만든 출력\n')
      // 같은 세션을 B가 물려받는다 (worker-start --terminal sess_S)
      t.start({ dispatchId: 'dsp_B', sessionId: 'sess_S' }, never)
      t.push('sess_S', 'B가 만든 출력\n')
      expect(t.read('dsp_A')).toBe('A가 만든 출력')
      expect(t.read('dsp_B')).toBe('B가 만든 출력')
    })

    it('재사용 뒤에도 A의 버퍼는 얼어붙어 자라지 않는다', () => {
      const t = new WorkerTails()
      t.start({ dispatchId: 'dsp_A', sessionId: 'sess_S' }, never)
      t.push('sess_S', 'first\n')
      t.start({ dispatchId: 'dsp_B', sessionId: 'sess_S' }, never)
      for (let i = 0; i < 100; i++) t.push('sess_S', `noise ${i}\n`)
      expect(t.read('dsp_A')).toBe('first')
    })

    it('캡을 넘기는 재사용에서도 A의 출력이 B의 것으로 대체되지 않는다', () => {
      // 세션 키잉이었을 때 가장 나쁜 결과: A의 내용이 전부 축출되고 B의 출력만 남아
      // "A가 무엇을 출력했나"에 조용히 틀린 답을 준다
      const t = new WorkerTails(8)
      t.start({ dispatchId: 'dsp_A', sessionId: 'sess_S' }, never)
      t.push('sess_S', 'AAAA')
      t.start({ dispatchId: 'dsp_B', sessionId: 'sess_S' }, never)
      t.push('sess_S', 'BBBBBBBBBBBB')
      expect(t.read('dsp_A')).toBe('AAAA')
      expect(t.read('dsp_B')).toBe('BBBBBBBB')
    })

    it('서로 다른 세션도 각자의 dispatch로 갈린다', () => {
      const t = new WorkerTails()
      t.start({ dispatchId: 'dsp_A', sessionId: 'sess_1' }, never)
      t.start({ dispatchId: 'dsp_B', sessionId: 'sess_2' }, never)
      t.push('sess_1', 'one')
      t.push('sess_2', 'two')
      expect(t.read('dsp_A')).toBe('one')
      expect(t.read('dsp_B')).toBe('two')
    })
  })

  describe('축출 — 종단 dispatch만 (리뷰 I3)', () => {
    it('상한을 넘기면 가장 오래된 종단 dispatch를 버린다', () => {
      const t = new WorkerTails(1024, 2)
      t.start({ dispatchId: 'dsp_1', sessionId: 'sess_1' }, always)
      t.start({ dispatchId: 'dsp_2', sessionId: 'sess_2' }, always)
      t.start({ dispatchId: 'dsp_3', sessionId: 'sess_3' }, always)
      expect(t.read('dsp_1')).toBe(TAIL_UNTRACKED)
      expect(t.read('dsp_2')).toBe(TAIL_EMPTY)
      expect(t.read('dsp_3')).toBe(TAIL_EMPTY)
      expect(t.size()).toBe(2)
    })

    it('살아 있는 워커의 꼬리는 상한을 넘겨도 버리지 않는다', () => {
      // 축출 기준이 "동시 생존 수"가 아니라 "누적 worker-start 횟수"였을 때, 장기 작업 중인
      // 1번 워커의 출력이 33번째 워커 시작으로 사라지고 그 뒤 push가 영구히 건너뛰었다
      const t = new WorkerTails(1024, 2)
      t.start({ dispatchId: 'dsp_long', sessionId: 'sess_long' }, never)
      t.push('sess_long', 'still working\n')
      t.start({ dispatchId: 'dsp_2', sessionId: 'sess_2' }, never)
      t.start({ dispatchId: 'dsp_3', sessionId: 'sess_3' }, never)
      expect(t.read('dsp_long')).toBe('still working')
      expect(t.size()).toBe(3) // 상한을 넘겼지만 버릴 수 있는 것이 없었다
    })

    it('축출 뒤에도 그 세션의 출력이 살아 있는 dispatch를 오염시키지 않는다', () => {
      const t = new WorkerTails(1024, 1)
      t.start({ dispatchId: 'dsp_old', sessionId: 'sess_S' }, always)
      t.push('sess_S', 'old\n')
      t.start({ dispatchId: 'dsp_new', sessionId: 'sess_T' }, always)
      expect(t.read('dsp_old')).toBe(TAIL_UNTRACKED)
      t.push('sess_S', 'more from the old session') // 축출됐으므로 되살리지 않는다
      expect(t.read('dsp_old')).toBe(TAIL_UNTRACKED)
      expect(t.read('dsp_new')).toBe(TAIL_EMPTY)
    })

    it('같은 dispatch로 다시 start해도 꼬리를 지우지 않는다', () => {
      const t = new WorkerTails()
      t.start({ dispatchId: 'dsp_1', sessionId: 'sess_A' }, never)
      t.push('sess_A', 'kept')
      t.start({ dispatchId: 'dsp_1', sessionId: 'sess_A' }, never)
      expect(t.read('dsp_1')).toBe('kept')
    })
  })

  describe('limit (리뷰 M5)', () => {
    const withLines = (): WorkerTails => {
      const t = new WorkerTails()
      t.start({ dispatchId: 'd', sessionId: 's' }, never)
      t.push('s', 'l1\nl2\nl3\nl4\n')
      return t
    }

    it('limit 1은 마지막 한 줄이다 — 빈 문자열이 아니다', () => {
      expect(withLines().read('d', 1)).toBe('l4')
    })

    it('줄 수보다 큰 limit은 전부 돌려준다', () => {
      expect(withLines().read('d', 999)).toBe('l1\nl2\nl3\nl4')
    })

    it('0·음수·소수는 조용히 1줄이 되지 않고 기본값으로 떨어진다', () => {
      const all = 'l1\nl2\nl3\nl4'
      expect(withLines().read('d', 0)).toBe(all)
      expect(withLines().read('d', -5)).toBe(all)
      expect(withLines().read('d', 1.5)).toBe(all)
      expect(withLines().read('d', Number.NaN)).toBe(all)
    })

    it('limit 미지정은 기본값이다', () => {
      const t = new WorkerTails()
      t.start({ dispatchId: 'd', sessionId: 's' }, never)
      const lines = Array.from({ length: TAIL_DEFAULT_LIMIT + 10 }, (_, i) => `line${i}`)
      t.push('s', lines.join('\n'))
      expect(t.read('d').split('\n')).toHaveLength(TAIL_DEFAULT_LIMIT)
      expect(t.read('d').split('\n')[0]).toBe('line10')
    })
  })
})
