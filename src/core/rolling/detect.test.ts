import { describe, it, expect } from 'vitest'
import { OutputScanner, stripAnsi, findWaitChoice, looksLikeChoicePrompt } from './detect'

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

  // rolling.log가 실제로 기록한 화면이다 — 단어 사이 공백이 하나도 없다. 패널을 다시 그릴 때
  // 터미널이 공백 대신 커서 이동 escape를 쓰고, stripAnsi가 그걸 지우면 단어가 붙어 버린다.
  // 이 렌더링을 놓쳐서 롤링 뒤 30초 폴백이 이어가기 문구를 이 다이얼로그 안으로 타이핑했다
  const SQUASHED_TRUST =
    'Thesewillapplywithoutasking.Onlyproceedifyoutrustthisconfiguration.Securityguide' +
    'Doyoutrustthefilesinthisfolder?1.Yes,Itrustthisfolder2.No,exitEntertoconfirm·Esctocancel'

  it('공백 없이 그려진 신뢰 다이얼로그를 감지한다', () => {
    const s = new OutputScanner()
    expect(s.push(SQUASHED_TRUST).trust).toBe(true)
  })

  // 실제로 화면에 뜬 문구다. 예전의 "Do you trust the files in this folder?"는 한 조각도 남아 있지
  // 않다 — 질문이 아니라 우리가 실제로 누르는 선택 항목에 앵커를 두는 이유
  const REAL_TRUST_SCREEN = [
    ' Accessing workspace:',
    '',
    ' D:\\comfyUI',
    '',
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a',
    ' well-known open source project, or work from your team). If not, take a moment to review what',
    " is in this folder first.",
    '',
    " Claude Code'll be able to read, edit, and execute files here.",
    '',
    ' Security guide',
    '',
    ' > 1. Yes, I trust this folder',
    '   2. No, exit'
  ].join('\n')

  it('현재 버전의 신뢰 다이얼로그 문구를 감지한다', () => {
    const s = new OutputScanner()
    expect(s.push(REAL_TRUST_SCREEN).trust).toBe(true)
  })

  it('현재 버전의 신뢰 다이얼로그를 대화상자로도 본다', () => {
    expect(looksLikeChoicePrompt(REAL_TRUST_SCREEN)).toBe(true)
  })

  it('공백 없이 그려진 한도 문구를 감지한다', () => {
    const s = new OutputScanner()
    expect(s.push('MCPs' + 'sessionlimit' + 'reached').limit).toBe(true)
  })

  it('소프트 랩으로 끊긴 신뢰 다이얼로그도 감지한다', () => {
    const s = new OutputScanner()
    expect(s.push('Do you trust the files in\r\nthis folder?\n1. Yes, proceed').trust).toBe(true)
  })

  it('청크 경계로 잘린 신뢰 다이얼로그도 감지한다', () => {
    const s = new OutputScanner()
    expect(s.push('Do you trust the fi').trust).toBe(false)
    expect(s.push('les in this folder?').trust).toBe(true)
  })
})

describe('looksLikeChoicePrompt', () => {
  it('커서가 놓인 선택 목록을 감지한다', () => {
    expect(looksLikeChoicePrompt('Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit')).toBe(true)
  })

  it('커서가 없는 번호 목록은 대화상자로 보지 않는다', () => {
    expect(looksLikeChoicePrompt('할 일:\n1. 테스트 작성\n2. 구현')).toBe(false)
  })

  it('빈 화면은 대화상자가 아니다', () => {
    expect(looksLikeChoicePrompt('')).toBe(false)
  })

  it('공백 없이 그려진 대화상자를 확인 푸터로 감지한다', () => {
    expect(looksLikeChoicePrompt('1.Yes,Itrustthisfolder2.No,exitEntertoconfirm·Esctocancel')).toBe(true)
  })

  // 작업 중 표시되는 'esc to interrupt' 힌트는 대화상자가 아니다 — 확인 푸터의 두 짝을 모두 요구하는 이유
  it('작업 중 인터럽트 힌트는 대화상자로 보지 않는다', () => {
    expect(looksLikeChoicePrompt('✻ Brewing… (esc to interrupt)')).toBe(false)
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

  // 2026-08-26 실측(관리자 통제 플랜): 라벨 앞에 'Stop and ' 가 붙었다. 번호가 라벨에 붙어 있어야 했던
  // 예전 형태는 이 화면에서 번호를 아예 못 찾았고(rolling.log 의 `limit choice not found`),
  // 그러면 아무 키도 누르지 못해 대화상자가 화면에 영원히 남는다.
  it('라벨 앞에 접두어가 붙어도 그 항목의 번호를 찾는다', () => {
    const screen =
      '> 1. Stop and wait for ' +
      'limit to reset\n  2. Wait here, then continue automatically shortly\n  3. Ask your admin for more usage'
    expect(findWaitChoice(screen)).toBe(1)
  })

  // 라벨에 **가장 가까운** 번호를 쓰는 이유. 예전 형태는 이 줄에서 첫 번호(1=adjust)를 집어
  // 지출 한도 인상을 누를 수 있었다.
  it('한 줄에 두 항목이 있으면 라벨에 가까운 번호를 쓴다', () => {
    expect(findWaitChoice('1. Adjust monthly spend limit: $50.  2. Wait for ' + 'limit to reset')).toBe(2)
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
