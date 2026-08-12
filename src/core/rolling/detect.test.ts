import { describe, it, expect } from 'vitest'
import { OutputScanner, stripAnsi, findWaitChoice } from './detect'

describe('stripAnsi', () => {
  it('CSI·OSC 시퀀스를 제거한다', () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m \u001b]0;title\u0007text")).toBe("red text")
  })

  it('ST(ESC+백슬래시)로 끝나는 OSC 시퀀스도 제거한다', () => {
    expect(stripAnsi("\u001b]0;title\u001b\\text")).toBe("text")
  })
})

describe('OutputScanner', () => {
  // 아래 한도 문구 리터럴들은 문자열 접합으로 쪼개 소스에 통짜 트리거를 두지 않는다 — 이 파일이
  // 롤링 세션의 PTY로 흘러가면(예: 이 파일을 cat/read) 스캐너가 물어 실제 롤이 발생한다.
  // 런타임 값은 접합 후 동일하므로 테스트가 검증하는 동작은 그대로다.
  it('한도 문구를 감지한다', () => {
    const s = new OutputScanner()
    expect(s.push('Claude usage limit ' + 'reached ∙ resets 3am').limit).toBe(true)
  })

  // Claude Code 2.1.220에서 관찰한 문구. 화면에는 "You've hit your <라벨>" 형태로 나오고,
  // 라벨이 소진된 창을 가리킨다 (detect.ts의 목록 참고).
  it.each([
    ["You've hit your " + 'session limit', '5시간'],
    ["You've hit your " + 'weekly limit', '주간'],
    ["You've hit your " + 'Opus limit', 'Opus'],
    ["You've hit your " + 'Sonnet limit', 'Sonnet'],
    ["You've hit your " + 'Fable 5 limit', 'Fable 5'],
    ["You've hit your " + 'usage credit limit', '크레딧']
  ])('실측 한도 문구를 감지한다: %s (%s)', (text) => {
    expect(new OutputScanner().push(text).limit).toBe(true)
  })

  it('타이포그래픽 아포스트로피 변형도 감지한다', () => {
    expect(new OutputScanner().push('You’ve hit your ' + 'session limit').limit).toBe(true)
  })

  it('reached 어순 변형도 감지한다', () => {
    expect(new OutputScanner().push("You've reached your " + 'weekly limit').limit).toBe(true)
  })

  it('터미널 소프트랩으로 줄이 갈린 문구도 감지한다', () => {
    expect(new OutputScanner().push("You've hit your\r\nsession limit").limit).toBe(true)
  })

  it('사전 경고(Approaching)는 감지하지 않는다', () => {
    expect(new OutputScanner().push('Approaching your session limit').limit).toBe(false)
  })

  it('한도와 무관한 limit 문구는 감지하지 않는다', () => {
    const s = new OutputScanner()
    expect(s.push('Subagent spawn limit reached (3 of 6)').limit).toBe(false)
    expect(s.push('Context limit reached · /compact to continue').limit).toBe(false)
  })

  it('청크 경계에서 잘린 문구도 감지한다', () => {
    const s = new OutputScanner()
    expect(s.push('... usage limit re').limit).toBe(false)
    expect(s.push('ached ∙ resets 3am').limit).toBe(true)
  })

  it('ANSI 시퀀스가 섞여도 감지한다', () => {
    const s = new OutputScanner()
    expect(s.push("\u001b[1m5-hour limit \u001b[33mreached\u001b[0m").limit).toBe(true)
  })

  it('매치 후 버퍼가 비워져 같은 문구가 재트리거되지 않는다', () => {
    const s = new OutputScanner()
    expect(s.push('usage limit ' + 'reached').limit).toBe(true)
    expect(s.push(' 이후 무해한 출력').limit).toBe(false)
  })

  it("'Approaching usage limit' 경고는 매치하지 않는다", () => {
    const s = new OutputScanner()
    expect(s.push('Approaching usage limit · 12% remaining').limit).toBe(false)
  })

  it('폴더 신뢰 다이얼로그를 감지한다', () => {
    const s = new OutputScanner()
    const hit = s.push('Do you trust the files in this folder?\n1. Yes, proceed')
    expect(hit.trust).toBe(true)
    expect(hit.limit).toBe(false)
  })
})

describe('findWaitChoice', () => {
  // 아래 화면 모킹 문자열들도 한도 문구·대기 항목 번호가 한 리터럴에 통짜로 붙어 있지 않도록
  // 접합으로 분할한다 — 같은 이유, 이 describe 상단에서 한 번만 밝힌다.
  it('대기 항목의 번호를 찾는다', () => {
    const screen = [
      "You've hit your " + 'session limit',
      '  1. Adjust monthly spend limit: $50',
      '❯ 2. Wait for ' + 'limit to reset',
      '     Resets 3:00pm',
      '  3. Upgrade to Max for higher session limits every month'
    ].join('\n')
    expect(findWaitChoice(screen)).toBe(2)
  })

  it('항목 순서가 달라도 텍스트로 찾는다 — adjust가 없는 계정', () => {
    const screen = ['❯ 1. Wait for ' + 'limit to reset', '  2. Upgrade to Max'].join('\n')
    expect(findWaitChoice(screen)).toBe(1)
  })

  it('괄호 형식 번호도 인식한다', () => {
    expect(findWaitChoice('  2) Wait for ' + 'limit to reset')).toBe(2)
  })

  it('ANSI 색이 섞여 있어도 찾는다', () => {
    expect(findWaitChoice('[36m❯ 2.[0m Wait for ' + 'limit to reset')).toBe(2)
  })

  it('번호가 없는 렌더링이면 null — 방향키 전용 UI에 임의 입력하지 않는다', () => {
    expect(findWaitChoice('❯ Wait for limit to reset')).toBeNull()
  })

  it('번호가 다른 줄에 있으면 줍지 않는다 — 앞 줄 금액의 숫자를 오인하지 않기 위해', () => {
    expect(findWaitChoice('  1. Adjust monthly spend limit: $50.\n❯ Wait for limit to reset')).toBeNull()
  })

  it('앞 줄 금액의 숫자를 줍지 않는다 — [ \\t]*가 줄바꿈을 넘지 못하는지 검증', () => {
    // 커서 글리프 없는 형태. ❯ 가 있는 위 테스트는 글리프 자체가 매치를 막아 이 변경의
    // 판별 근거가 되지 못한다 — 이쪽이 \s* 시절 '50'을 반환하던 실제 회귀다.
    expect(findWaitChoice('  1. Adjust monthly spend limit: $50.\nWait for limit to reset')).toBeNull()
  })

  it('대기 항목이 없으면 null', () => {
    expect(findWaitChoice('  1. Upgrade to Max\n  2. Add funds')).toBeNull()
  })

  it('0번은 유효한 선택지가 아니므로 null — 가드 분기 검증', () => {
    expect(findWaitChoice('  0. Wait for ' + 'limit to reset')).toBeNull()
  })

  it('두 자리 번호도 인식한다', () => {
    expect(findWaitChoice('  10. Wait for ' + 'limit to reset')).toBe(10)
  })
})
