import { describe, it, expect } from 'vitest'
import { nextFireAt, isValidRule, isValidScheduleConfig, buildScheduleConfig, buildScheduleRule, scheduleConfigOf, type ScheduleRuleInput } from './rule'

// 로컬 타임존 기준 시각 헬퍼. 2026-07-31은 금요일(getDay()=5).
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime()

describe('nextFireAt — interval', () => {
  it('fromMs + N분', () => {
    expect(nextFireAt({ kind: 'interval', minutes: 30 }, at(2026, 7, 31, 10, 0))).toBe(
      at(2026, 7, 31, 10, 30)
    )
  })
})

describe('nextFireAt — daily', () => {
  it('오늘 시각이 남았으면 오늘', () => {
    expect(nextFireAt({ kind: 'daily', time: '18:00' }, at(2026, 7, 31, 10, 0))).toBe(
      at(2026, 7, 31, 18, 0)
    )
  })
  it('오늘 시각이 지났으면 내일 (자정 넘김)', () => {
    expect(nextFireAt({ kind: 'daily', time: '09:00' }, at(2026, 7, 31, 10, 0))).toBe(
      at(2026, 8, 1, 9, 0)
    )
  })
  it('정확히 같은 시각이면 다음 회차 (strict 이후)', () => {
    expect(nextFireAt({ kind: 'daily', time: '10:00' }, at(2026, 7, 31, 10, 0))).toBe(
      at(2026, 8, 1, 10, 0)
    )
  })
})

describe('nextFireAt — weekly', () => {
  it('같은 주의 뒤 요일 (토=6)', () => {
    expect(nextFireAt({ kind: 'weekly', weekdays: [6], time: '09:00' }, at(2026, 7, 31, 10, 0))).toBe(
      at(2026, 8, 1, 9, 0)
    )
  })
  it('주말 넘겨 다음 주 월요일 (주 넘김)', () => {
    expect(nextFireAt({ kind: 'weekly', weekdays: [1], time: '09:30' }, at(2026, 7, 31, 10, 0))).toBe(
      at(2026, 8, 3, 9, 30)
    )
  })
  it('오늘 요일인데 시각이 지났으면 다음 해당 요일', () => {
    expect(nextFireAt({ kind: 'weekly', weekdays: [5], time: '09:00' }, at(2026, 7, 31, 10, 0))).toBe(
      at(2026, 8, 7, 9, 0)
    )
  })
  it('복수 요일 중 가장 이른 것', () => {
    expect(nextFireAt({ kind: 'weekly', weekdays: [1, 6], time: '09:00' }, at(2026, 7, 31, 10, 0))).toBe(
      at(2026, 8, 1, 9, 0)
    )
  })
})

describe('nextFireAt — monthly', () => {
  it('이번 달의 뒤 날짜', () => {
    expect(nextFireAt({ kind: 'monthly', days: [15], time: '09:00' }, at(2026, 7, 1, 0, 0))).toBe(
      at(2026, 7, 15, 9, 0)
    )
  })
  it('이번 달 날짜가 지났으면 다음 달 (월 넘김)', () => {
    expect(nextFireAt({ kind: 'monthly', days: [1], time: '09:00' }, at(2026, 7, 31, 10, 0))).toBe(
      at(2026, 8, 1, 9, 0)
    )
  })
  it('그 달에 없는 날짜는 건너뜀 — 31일은 2월을 지나 3월 31일로', () => {
    expect(nextFireAt({ kind: 'monthly', days: [31], time: '09:00' }, at(2027, 2, 1, 0, 0))).toBe(
      at(2027, 3, 31, 9, 0)
    )
  })
  it('윤년 2월 29일 (2028)', () => {
    expect(nextFireAt({ kind: 'monthly', days: [29], time: '09:00' }, at(2028, 2, 1, 0, 0))).toBe(
      at(2028, 2, 29, 9, 0)
    )
  })
})

describe('isValidRule', () => {
  it('각 모드의 정상 규칙을 통과시킨다', () => {
    expect(isValidRule({ kind: 'interval', minutes: 1 })).toBe(true)
    expect(isValidRule({ kind: 'daily', time: '09:30' })).toBe(true)
    expect(isValidRule({ kind: 'weekly', weekdays: [0, 6], time: '23:59' })).toBe(true)
    expect(isValidRule({ kind: 'monthly', days: [1, 31], time: '00:00' })).toBe(true)
  })
  it('경계 밖·형식 오류를 거부한다', () => {
    expect(isValidRule({ kind: 'interval', minutes: 0 })).toBe(false)
    expect(isValidRule({ kind: 'interval', minutes: 1.5 })).toBe(false)
    // 상한 525,600분(=365일) 경계 — 넘으면 nextFireAt이 Date 표현 범위를 벗어나 RangeError
    expect(isValidRule({ kind: 'interval', minutes: 525_600 })).toBe(true)
    expect(isValidRule({ kind: 'interval', minutes: 525_601 })).toBe(false)
    expect(isValidRule({ kind: 'daily', time: '25:00' })).toBe(false)
    expect(isValidRule({ kind: 'daily', time: '9:00' })).toBe(false)
    expect(isValidRule({ kind: 'weekly', weekdays: [], time: '09:00' })).toBe(false)
    expect(isValidRule({ kind: 'weekly', weekdays: [7], time: '09:00' })).toBe(false)
    expect(isValidRule({ kind: 'monthly', days: [0], time: '09:00' })).toBe(false)
    expect(isValidRule({ kind: 'monthly', days: [32], time: '09:00' })).toBe(false)
    expect(isValidRule({ kind: 'unknown' })).toBe(false)
    expect(isValidRule(null)).toBe(false)
  })
})

describe('isValidScheduleConfig', () => {
  it('command가 비면 거부한다', () => {
    expect(isValidScheduleConfig({ rule: { kind: 'interval', minutes: 5 }, command: '  ' })).toBe(false)
    expect(isValidScheduleConfig({ rule: { kind: 'interval', minutes: 5 }, command: '점검' })).toBe(true)
  })
})

// scheduleConfigOf — 규칙(ScheduleRuleFields)과 명령(ScheduleFields)이 나뉘어 있는 새-Job 모달이
// 그 둘을 합치는 지점. buildScheduleConfig 도 내부에서 이것을 쓴다.
describe('scheduleConfigOf', () => {
  it('규칙이 null 이면 null', () => {
    expect(scheduleConfigOf(null, '점검')).toBeNull()
  })

  it('명령이 비었거나 공백뿐이면 null (규칙이 유효해도)', () => {
    expect(scheduleConfigOf({ kind: 'interval', minutes: 5 }, '')).toBeNull()
    expect(scheduleConfigOf({ kind: 'interval', minutes: 5 }, '   ')).toBeNull()
  })

  it('유효한 규칙과 명령이면 명령의 앞뒤 공백을 잘라 담는다', () => {
    expect(scheduleConfigOf({ kind: 'interval', minutes: 5 }, '  점검  ')).toEqual({
      rule: { kind: 'interval', minutes: 5 },
      command: '점검'
    })
  })
})

// buildScheduleConfig — ScheduleFields.tsx 안에 있어 테스트할 수 없던 조립·파싱을
// 여기로 옮겼다. 입력은 전부 UI 원본 그대로(분·시각·일자는 문자열)이고, 반환은 spawn에 넘길
// ScheduleConfig 또는 null(입력 불완전 → 시작 버튼 비활성).
const input = (over: Partial<Parameters<typeof buildScheduleConfig>[0]> = {}): Parameters<typeof buildScheduleConfig>[0] => ({
  kind: 'interval',
  minutes: '30',
  time: '09:00',
  weekdays: [],
  days: '',
  command: '점검',
  ...over
})

describe('buildScheduleConfig — command', () => {
  it('명령이 비었거나 공백뿐이면 null (규칙이 유효해도)', () => {
    expect(buildScheduleConfig(input({ command: '' }))).toBeNull()
    expect(buildScheduleConfig(input({ command: '   ' }))).toBeNull()
  })

  it('명령의 앞뒤 공백을 잘라 담는다', () => {
    expect(buildScheduleConfig(input({ command: '  점검  ' }))?.command).toBe('점검')
  })
})

describe('buildScheduleConfig — interval', () => {
  it('문자열 분을 숫자로 바꿔 담는다', () => {
    expect(buildScheduleConfig(input({ minutes: '45' }))).toEqual({
      rule: { kind: 'interval', minutes: 45 },
      command: '점검'
    })
  })

  it('0·음수·상한 초과·비수치는 null', () => {
    expect(buildScheduleConfig(input({ minutes: '0' }))).toBeNull()
    expect(buildScheduleConfig(input({ minutes: '-5' }))).toBeNull()
    expect(buildScheduleConfig(input({ minutes: '525601' }))).toBeNull() // 365일 상한 초과
    expect(buildScheduleConfig(input({ minutes: '' }))).toBeNull()
    expect(buildScheduleConfig(input({ minutes: 'abc' }))).toBeNull()
    expect(buildScheduleConfig(input({ minutes: '1.5' }))).toBeNull() // 정수만
  })

  it('상한값 자체는 통과한다', () => {
    expect(buildScheduleConfig(input({ minutes: '525600' }))?.rule).toEqual({
      kind: 'interval',
      minutes: 525_600
    })
  })
})

describe('buildScheduleConfig — daily / weekly', () => {
  it('daily는 시각만 쓴다', () => {
    expect(buildScheduleConfig(input({ kind: 'daily', time: '07:30' }))).toEqual({
      rule: { kind: 'daily', time: '07:30' },
      command: '점검'
    })
  })

  it('잘못된 시각 형식은 null', () => {
    expect(buildScheduleConfig(input({ kind: 'daily', time: '24:00' }))).toBeNull()
    expect(buildScheduleConfig(input({ kind: 'daily', time: '7:30' }))).toBeNull()
    expect(buildScheduleConfig(input({ kind: 'daily', time: '' }))).toBeNull()
  })

  it('weekly는 요일이 하나 이상이어야 한다', () => {
    expect(buildScheduleConfig(input({ kind: 'weekly', weekdays: [] }))).toBeNull()
    expect(buildScheduleConfig(input({ kind: 'weekly', weekdays: [1, 3] }))).toEqual({
      rule: { kind: 'weekly', weekdays: [1, 3], time: '09:00' },
      command: '점검'
    })
  })
})

describe('buildScheduleConfig — monthly 일자 파싱', () => {
  const monthly = (days: string): ReturnType<typeof buildScheduleConfig> =>
    buildScheduleConfig(input({ kind: 'monthly', days }))

  it('콤마로 나눠 담고 앞뒤 공백을 허용한다', () => {
    expect(monthly('1,15')?.rule).toEqual({ kind: 'monthly', days: [1, 15], time: '09:00' })
    expect(monthly('1, 15')?.rule).toEqual({ kind: 'monthly', days: [1, 15], time: '09:00' })
  })

  it('빈 토큰은 무시한다 — 유효한 일자가 남으면 통과', () => {
    expect(monthly('1,,15')?.rule).toEqual({ kind: 'monthly', days: [1, 15], time: '09:00' })
    expect(monthly('1,')?.rule).toEqual({ kind: 'monthly', days: [1], time: '09:00' })
  })

  it('중복은 제거하고 입력 순서를 유지한다', () => {
    expect(monthly('15,1,15')?.rule).toEqual({ kind: 'monthly', days: [15, 1], time: '09:00' })
  })

  it('범위를 벗어난 일자는 null — 하나라도 잘못되면 전체를 거부한다', () => {
    expect(monthly('0')).toBeNull()
    expect(monthly('32')).toBeNull()
    expect(monthly('1,32')).toBeNull() // 앞이 유효해도 뒤가 틀리면 거부
  })

  it('비수치·3자리 이상은 null', () => {
    expect(monthly('abc')).toBeNull()
    expect(monthly('1.5')).toBeNull()
    expect(monthly('001')).toBeNull() // \d{1,2}만 허용
    expect(monthly('-1')).toBeNull()
  })

  it('일자가 하나도 없으면 null', () => {
    expect(monthly('')).toBeNull()
    expect(monthly(',')).toBeNull()
    expect(monthly('   ')).toBeNull()
  })
})

// buildScheduleRule — Job 예약이 쓰는 반쪽. 세션 예약과 갈라지는 지점은 command 하나뿐이라,
// 규칙 조립·파싱을 이쪽에 두고 buildScheduleConfig 가 그것을 감싼다
const ruleInput = (over: Partial<ScheduleRuleInput> = {}): ScheduleRuleInput => ({
  kind: 'interval',
  minutes: '30',
  time: '09:00',
  weekdays: [],
  days: '',
  ...over
})

describe('buildScheduleRule', () => {
  it('command 를 요구하지 않는다 — 그것이 이 함수가 있는 이유다', () => {
    expect(buildScheduleRule(ruleInput({ kind: 'daily' }))).toEqual({
      kind: 'daily',
      time: '09:00'
    })
  })

  it('interval 의 분을 정수로 바꾼다', () => {
    expect(buildScheduleRule(ruleInput({ minutes: '45' }))).toEqual({
      kind: 'interval',
      minutes: 45
    })
  })

  it('범위를 벗어난 분은 null — 시작 버튼을 잠그는 신호다', () => {
    expect(buildScheduleRule(ruleInput({ minutes: '0' }))).toBeNull()
    expect(buildScheduleRule(ruleInput({ minutes: '525601' }))).toBeNull()
  })

  it('monthly 의 일자 목록을 파싱한다', () => {
    expect(buildScheduleRule(ruleInput({ kind: 'monthly', days: '1, 15' }))).toEqual({
      kind: 'monthly',
      days: [1, 15],
      time: '09:00'
    })
  })

  it('weekly 는 요일이 비면 null', () => {
    expect(buildScheduleRule(ruleInput({ kind: 'weekly', weekdays: [] }))).toBeNull()
  })
})
