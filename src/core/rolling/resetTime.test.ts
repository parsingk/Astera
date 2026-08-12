import { describe, it, expect } from 'vitest'
import { parseResetTime } from './resetTime'

// 이 리터럴들이 통짜면 이 파일 자체가 롤링 세션의 PTY·transcript로 흘러갈 때 스캐너가 물어
// 실제 롤을 유발한다 — 접합으로 쪼개 소스에 트리거를 두지 않는다.
const HIT = "You've hit your "
const sess = (tail: string, tz = 'Asia/Seoul'): string => `${HIT}session` + ` limit · resets ${tail} (${tz})`
const week = (tail: string, tz = 'Asia/Seoul'): string => `${HIT}weekly` + ` limit · resets ${tail} (${tz})`

const KST = (y: number, mo: number, d: number, h: number, mi = 0): number =>
  Date.UTC(y, mo, d, h - 9, mi) // Asia/Seoul은 DST가 없어 항상 UTC+9

describe('parseResetTime', () => {
  it('session · 분 없는 시각을 그날의 그 시각으로 읽는다', () => {
    const now = KST(2026, 7, 3, 9, 0)
    expect(parseResetTime(sess('11am'), now)).toEqual({ at: KST(2026, 7, 3, 11), weekly: false })
  })

  it('session · 분이 있는 오후 시각', () => {
    // now를 stated로부터 5시간(session 상한, Finding 1b) 이내로 둔다 — 12시 기준 3h10m 전.
    const now = KST(2026, 7, 3, 12, 0)
    expect(parseResetTime(sess('3:10pm'), now)).toEqual({ at: KST(2026, 7, 3, 15, 10), weekly: false })
  })

  it('12am은 자정, 12pm은 정오로 읽는다', () => {
    // now를 22:00으로 둔다(원래 13:00) — 13:00 기준이면 다음날 00:20까지 11h20m 앞이라 Finding 1b의
    // session 5시간 상한을 넘어 거부된다. 22:00이면 2h20m 앞으로 상한 안에 남아 day-roll 자체를
    // 검증하는 이 테스트의 취지를 그대로 지킨다.
    const now = KST(2026, 7, 3, 22, 0)
    // 12am은 now보다 과거이므로 다음 날로 넘어간다
    expect(parseResetTime(sess('12:20am'), now)?.at).toBe(KST(2026, 7, 4, 0, 20))
    const early = KST(2026, 7, 3, 9, 0)
    expect(parseResetTime(sess('12pm'), early)?.at).toBe(KST(2026, 7, 3, 12))
  })

  it('그 시각이 이미 지났으면 다음 날로 넘긴다', () => {
    const now = KST(2026, 7, 3, 23, 30)
    expect(parseResetTime(sess('1am'), now)?.at).toBe(KST(2026, 7, 4, 1))
  })

  it('weekly · 날짜가 명시되면 그 날짜로 읽는다', () => {
    const now = KST(2026, 6, 27, 10, 0) // Jul 27
    expect(parseResetTime(week('Jul 28, 10am'), now)).toEqual({
      at: KST(2026, 6, 28, 10),
      weekly: true
    })
  })

  it('weekly · 날짜가 생략되면 session과 같은 규칙을 쓴다', () => {
    const now = KST(2026, 7, 3, 9, 0)
    expect(parseResetTime(week('7pm'), now)).toEqual({ at: KST(2026, 7, 3, 19), weekly: true })
  })

  it('연말에 다음 해 날짜가 오면 해를 올린다', () => {
    const now = KST(2026, 11, 30, 10, 0) // 2026-12-30
    expect(parseResetTime(week('Jan 3, 10am'), now)?.at).toBe(KST(2027, 0, 3, 10))
  })

  it('연도 보정이 과거 방향엔 없어 살짝 지난 날짜는 그대로 과거에 남는다 — 거부한다', () => {
    // now Aug 4 2026, 문구는 Jul 28 10am — now보다 180일 넘게 과거가 아니라(7일 전) 연도 보정이
    // 걸리지 않고 그 과거 날짜가 그대로 남는다. blockedUntil이 과거가 되면 planRetry가 60초
    // 하한으로 떨어져 kill/respawn을 해머링한다 — 15분 폴백보다 나쁘다. now보다 과거인 결과는
    // 정직하게 거부해야 한다.
    const now = KST(2026, 7, 4, 10, 0) // Aug 4 2026 10:00 KST
    expect(parseResetTime(week('Jul 28, 10am'), now)).toBeNull()
  })

  it('연도 보정이 근미래 날짜를 몇 달 밀어내면 거부한다', () => {
    // now Aug 4 2026, 문구는 Feb 3 10am — 올해 Feb 3은 now보다 180일 넘게 과거라(약 183일) 연도
    // 보정이 다음 해(2027 Feb 3)로 올린다. +4392h(183일) 앞선 결과는 setTimeout의 32비트 지연
    // 상한(~24.8일)을 넘어 Node가 즉시 발화시킨다 — UI·Slack엔 몇 달 뒤라고 알려놓고 실제로는
    // 즉시 해머링한다. 정신 건강 상한(8일)이 이 방향도 거부해야 한다.
    const now = KST(2026, 7, 4, 10, 0) // Aug 4 2026 10:00 KST
    expect(parseResetTime(week('Feb 3, 10am'), now)).toBeNull()
  })

  it('봄 전환의 건너뛴 벽시계는 거부한다 — 수렴이 아니라 되읽어 검증한다', () => {
    // America/New_York 2026-03-08: 02:00에서 03:00으로 건너뛴다(EST→EDT). 02:00~02:59는 그 날
    // 존재하지 않는다. 고정 3회 반복은 이 입력에서 수렴하지 않고 06:00/07:00 UTC를 진동한다 —
    // 반복 횟수의 홀짝에 따라 답이 갈리므로(3회째는 07:00 UTC=03:00 EDT, 4회째는 06:00 UTC=
    // 02:00 EST) 검증 없이는 틀린 답을 자신 있게 낸다. 되읽은 시:분(03:00)이 입력(02:30)과
    // 달라 null이어야 한다.
    const now = Date.UTC(2026, 2, 8, 5, 30) // 00:30 EST — 전환 전, tzDate는 3/8로 읽는다
    expect(parseResetTime(sess('2:30am', 'America/New_York'), now)).toBeNull()
  })

  it('2시간 시프트 타임존(Antarctica/Troll)의 건너뛴 벽시계도 거부한다', () => {
    // Troll은 표준(UTC+0)↔DST(UTC+2)를 오간다 — 유럽처럼 3월 마지막 일요일에 전환하지만 시프트가
    // 2시간이라 01:00~02:59가 그 날 존재하지 않는다. 이 폭에서는 3회 반복의 답(23:30 UTC = 그
    // 전날 23:30, 되읽으면 로컬 23:30)이 참조 시각보다 "이전"이라 되읽은 시:분(23시)이 입력(1시)과
    // 달라 검증이 걸린다 — 검증이 없으면 호출자의 day-roll까지 잘못 건드려 우려하던
    // +22.8h류 오차로 번진다. weekly로 쓰는 이유: session의 5시간 상한(Finding 1b)은 이 오차
    // (~23h)를 우연히도 걸러내 검증 부재를 가려버린다 — weekly의 24시간 상한 밑이라 Finding 3의
    // 되읽기 검증이 실제로 막는지를 이 케이스가 순수하게 가른다.
    const now = Date.UTC(2026, 2, 29, 0, 30) // 00:30 UTC(=로컬 00:30, 전환 전) — tzDate는 3/29로 읽는다
    expect(parseResetTime(week('1:30am', 'Antarctica/Troll'), now)).toBeNull()
  })

  it('30분 시프트 타임존(Australia/Lord_Howe)의 정상 전환일 시각은 그대로 해석된다', () => {
    // Lord Howe는 표준(+10:30)↔DST(+11:00)를 30분 단위로 오간다 — 리뷰가 "정상 케이스는 계속
    // 통과해야 한다"고 확인한 사례 중 하나다. now를 전환 전날 저녁으로 두면 날짜 생략 분기의
    // day-roll이 전환 이후(다음날 새벽, DST 오프셋 +11:00)로 넘어간다 — 그 시각은 실제로 존재하는
    // 벽시계이므로 되읽기 검증(Finding 3)을 통과해 정상적으로 해석돼야 한다.
    const now = Date.UTC(2026, 9, 3, 9, 30) // Oct3 20:00 LHT(+10:30) — 전환 전날 저녁
    expect(parseResetTime(week('3am', 'Australia/Lord_Howe'), now)?.at).toBe(Date.UTC(2026, 9, 3, 16, 0))
  })

  it('DST 시작 당일의 벽시계를 여름 오프셋으로 변환한다', () => {
    // America/New_York: 2026-03-08 2am에 EST(-5) → EDT(-4). 그날 5am은 EDT라 09:00 UTC.
    const now = Date.UTC(2026, 2, 8, 5, 30) // 00:30 EST
    expect(parseResetTime(sess('5am', 'America/New_York'), now)?.at).toBe(Date.UTC(2026, 2, 8, 9, 0))
  })

  it('DST 종료 당일의 벽시계를 겨울 오프셋으로 변환한다', () => {
    // 2026-11-01 2am에 EDT(-4) → EST(-5). 그날 5am은 EST라 10:00 UTC.
    // now를 01:30 EDT로 둔다(원래 00:30 EDT) — 00:30 기준이면 stated까지 5.5h 앞이라 Finding 1b의
    // session 5시간 상한을 넘어 거부된다. 01:30이면 4.5h 앞으로 상한 안에 남아 겨울 오프셋 변환
    // 자체를 검증하는 이 테스트의 취지를 그대로 지킨다.
    const now = Date.UTC(2026, 10, 1, 5, 30) // 01:30 EDT
    expect(parseResetTime(sess('5am', 'America/New_York'), now)?.at).toBe(Date.UTC(2026, 10, 1, 10, 0))
  })

  it('기록 자신의 타임스탬프를 기준으로 하면 미래 몇 초 전 시각이 당일로 남는다 — 감지 틱을 기준으로 하면 다음날로 잘못 넘어간다', () => {
    // 실측: rate_limit 기록이 자기 reset 시각보다 7.2s·9s 전에 쓰였다(문구가 "몇 초 뒤 reset"을
    // 말한다). recordRecovery가 이 기록을 처리하는 시점(this.now())은 15초 틱 + I/O 대기 뒤라 이미
    // stated 시각을 지나 있을 수 있다 — 그 지연된 시각을 now로 넘기면(버그) 오늘이 이미 지났다고
    // 오판해 하루를 더한다. 기록 자신의 시각(hit.at, rolling.ts의 refAt)을 넘기면(수정) 그 시점엔
    // 아직 stated 시각 전이므로 day-roll이 트리거되지 않고 당일로 정확히 남는다.
    const statedAt = KST(2026, 7, 3, 11, 0)
    const hitAt = statedAt - 7_000 // 기록이 stated 시각보다 7초 전에 쓰였다 — 실측 사례
    expect(parseResetTime(sess('11am'), hitAt)?.at).toBe(statedAt) // 당일 그대로, 다음 날 아님

    // 대조: 감지 시점(틱 지연 후 typical)을 기준으로 잘못 넘기면 day-roll이 트리거돼 다음날로
    // +24h 가까이 밀려난다 — Finding 1b의 5시간 상한을 넘으므로 null로 거부된다(1b가 이 잘못된
    // anchoring의 2차 방어선 역할을 한다는 것을 보여준다). 절대 다음 날 시각을 그대로 내주지 않는다.
    const detectionNow = statedAt + 8_000
    expect(parseResetTime(sess('11am'), detectionNow)).toBeNull()
  })

  it('곱은 인용부호(U+2019) 변형도 읽는다 — 자매 스캐너가 둘 다 인정한다', () => {
    const now = KST(2026, 7, 3, 9, 0)
    const curly = 'You’ve hit your ' + 'session' + ' limit · resets 11am (Asia/Seoul)'
    expect(parseResetTime(curly, now)?.at).toBe(KST(2026, 7, 3, 11))
  })

  it('알 수 없는 타임존은 거부한다', () => {
    expect(parseResetTime(sess('11am', 'Mars/Olympus'), KST(2026, 7, 3, 9))).toBeNull()
  })

  it('알 수 없는 월 이름은 거부한다', () => {
    expect(parseResetTime(week('Foo 3, 10am'), KST(2026, 7, 3, 9))).toBeNull()
  })

  it('분이 60 이상이면 거부한다 — Date.UTC의 조용한 정규화를 막는다', () => {
    // '3:99pm'을 검사 없이 넘기면 Date.UTC가 99분을 시:분으로 정규화해 16:39가 된다. hour는
    // :124에서 이미 같은 방식으로 막혀 있었으므로 minute도 대칭으로 명시 검사한다 — 이 사례는
    // Finding 3의 되읽기 검증(wallToUtc가 원본 mi=99와 되읽은 mi=39를 비교)도 우연히 잡아내지만,
    // 그 우연에 기대지 않고 정규식 그룹 단계에서 즉시 거부해 hour와 같은 자리에서 같은 방식으로
    // 읽히게 한다.
    const now = KST(2026, 7, 3, 14, 0)
    expect(parseResetTime(sess('3:99pm'), now)).toBeNull()
  })

  it('일(day)이 31을 넘으면 거부한다 — Date.UTC의 조용한 정규화를 막는다', () => {
    // 'Jul 99'를 검사 없이 넘기면 Date.UTC가 10월 7일로 정규화한다. now를 그 근처(Oct 5)로 둬
    // 정규화된 결과가 겨우 48시간 앞이 되게 한다 — PARSE_CEILING_MS(8일, Finding 2)에 우연히
    // 걸리지 않고 day 범위 검사 하나가 실제로 막는지를 가른다.
    const now = KST(2026, 9, 5, 10, 0) // Oct 5 2026 10:00 KST
    expect(parseResetTime(week('Jul 99, 10am'), now)).toBeNull()
  })

  it('session·weekly 외 창은 거부한다 — 그 문구 형식을 실측한 적이 없다', () => {
    const opus = `${HIT}Opus` + ' limit · resets 11am (Asia/Seoul)'
    expect(parseResetTime(opus, KST(2026, 7, 3, 9))).toBeNull()
  })

  it('reset 부분이 없으면 거부한다', () => {
    expect(parseResetTime(`${HIT}session` + ' limit', KST(2026, 7, 3, 9))).toBeNull()
  })

  it('빈 문자열과 무관한 텍스트를 거부한다', () => {
    expect(parseResetTime('', KST(2026, 7, 3, 9))).toBeNull()
    expect(parseResetTime('npm test 실행 결과 3 passed', KST(2026, 7, 3, 9))).toBeNull()
  })

  it('앞뒤에 다른 출력이 붙어 있어도 문구를 찾는다 — PTY 누적 텍스트가 그렇다', () => {
    // 선택지 라벨을 접합으로 쪼갠다 — 통짜면 이 소스 파일 자체가 롤링
    // 세션의 PTY·transcript로 흘러갈 때 WAIT_CHOICE_RE(detect.ts)가 물어 실제 키 입력을 유발한다.
    // 런타임 값(noisy)은 접합 전과 동일하다.
    const noisy = `\x1b[2K전 작업 계속합니다\n${sess('11am')}\n1. Wait for ` + 'limit to reset'
    expect(parseResetTime(noisy, KST(2026, 7, 3, 9))?.at).toBe(KST(2026, 7, 3, 11))
  })

  it('줄바꿈이 문구 중간에 끼어도 찾는다 — 좁은 터미널이 그렇게 쪼갠다', () => {
    const wrapped = `${HIT}session` + ' limit ·\nresets 11am (Asia/Seoul)'
    expect(parseResetTime(wrapped, KST(2026, 7, 3, 9))?.at).toBe(KST(2026, 7, 3, 11))
  })

  it('now를 유일한 시간 입력으로 쓴다 — 같은 인자면 항상 같은 결과', () => {
    const now = KST(2026, 7, 3, 9, 0)
    const a = parseResetTime(sess('11am'), now)
    const b = parseResetTime(sess('11am'), now)
    expect(a).toEqual(b)
  })
})
