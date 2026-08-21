/** The session scheduler's repeat rule. time is a local 'HH:mm' clock time. */
export type ScheduleRule =
  | { kind: 'interval'; minutes: number } // every N minutes (minimum 1)
  | { kind: 'daily'; time: string } // daily at the given time
  | { kind: 'weekly'; weekdays: number[]; time: string } // 0 (Sun) to 6 (Sat), must not be empty
  | { kind: 'monthly'; days: number[]; time: string } // 1 to 31, must not be empty

export interface ScheduleConfig {
  rule: ScheduleRule
  command: string // the command typed into the session at each fire time (whitespace alone is not allowed)
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function isValidRule(v: unknown): v is ScheduleRule {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  switch (o.kind) {
    case 'interval':
      // Upper bound 525,600 minutes (= 365 days) — without it, input longer than 4 to 5 digits pushes
      // nextFireAt past the representable Date range and new Date().toISOString() in pushState throws a
      // RangeError
      return (
        typeof o.minutes === 'number' && Number.isInteger(o.minutes) && o.minutes >= 1 && o.minutes <= 525_600
      )
    case 'daily':
      return typeof o.time === 'string' && TIME_RE.test(o.time)
    case 'weekly':
      return (
        Array.isArray(o.weekdays) &&
        o.weekdays.length > 0 &&
        o.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) &&
        typeof o.time === 'string' &&
        TIME_RE.test(o.time)
      )
    case 'monthly':
      return (
        Array.isArray(o.days) &&
        o.days.length > 0 &&
        o.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 31) &&
        typeof o.time === 'string' &&
        TIME_RE.test(o.time)
      )
    default:
      return false
  }
}

export function isValidScheduleConfig(v: unknown): v is ScheduleConfig {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.command === 'string' && o.command.trim().length > 0 && isValidRule(o.rule)
}

/** 규칙만 만드는 입력 — UI 원본 그대로다(분·시각·일자는 input 값이라 문자열이고, 요일만
 *  토글 버튼이 만든 숫자 배열이다). */
export interface ScheduleRuleInput {
  kind: ScheduleRule['kind']
  minutes: string // interval minutes
  time: string // 'HH:mm'
  weekdays: number[] // 0 (Sun) to 6 (Sat)
  days: string // day of month — comma-separated, "1,15"
}

/** 세션 예약의 입력 — 위의 것에 명령 한 칸을 더한 것이다. Job 예약에는 그 칸이 없다(Run.schedule) */
export interface ScheduleInput extends ScheduleRuleInput {
  command: string
}

// Parses the day-of-month input ("1,15") — integers 1 to 31 only, duplicates removed. Any bad token gives
// null. Empty tokens (",," or a trailing ",") are ignored — rejecting a mid-typing state makes the field
// unpleasant to type into.
function parseMonthDays(s: string): number[] | null {
  const tokens = s.split(',').map((t) => t.trim()).filter(Boolean)
  if (tokens.length === 0) return null
  const days: number[] = []
  for (const t of tokens) {
    if (!/^\d{1,2}$/.test(t)) return null
    const n = Number(t)
    if (n < 1 || n > 31) return null
    if (!days.includes(n)) days.push(n)
  }
  return days
}

/**
 * 규칙만 조립한다 — Job 예약(Run.schedule)이 쓰는 갈래다.
 * null = 입력이 불완전하다 → 부르는 쪽이 만들기 버튼을 잠근다.
 *
 * 판정은 isValidRule 에 맡긴다. UI 가 판정의 사본을 들면 둘이 갈라진다.
 * parseMonthDays 의 실패는 빈 배열로 넘겨 isValidRule 이 "비었다"로 자연히 거절하게 한다.
 * 숫자 변환도 같은 원리다 — Number('')=0, Number('abc')=NaN, Number('1.5')=1.5 가 모두
 * isValidRule 의 정수·범위 검사에 걸린다.
 */
export function buildScheduleRule(input: ScheduleRuleInput): ScheduleRule | null {
  let rule: ScheduleRule
  if (input.kind === 'interval') rule = { kind: 'interval', minutes: Number(input.minutes) }
  else if (input.kind === 'daily') rule = { kind: 'daily', time: input.time }
  else if (input.kind === 'weekly')
    rule = { kind: 'weekly', weekdays: input.weekdays, time: input.time }
  else rule = { kind: 'monthly', days: parseMonthDays(input.days) ?? [], time: input.time }
  return isValidRule(rule) ? rule : null
}

/**
 * Assembles the UI input into the ScheduleConfig handed to spawn (a pure function).
 * null = the input is incomplete → the caller disables the start button.
 *
 * The assembly and parsing used to sit inside ScheduleFields.tsx and were moved here — the two modals (new
 * session and resume) came to share them, and a non-exported function inside a .tsx is out of vitest's reach
 * (*.test.ts only, environment: 'node'), so the validation rules had no regression detector.
 *
 * The validity verdict is delegated to isValidScheduleConfig — if the UI held its own copy of the verdict,
 * the two would drift apart.
 */
export function buildScheduleConfig(input: ScheduleInput): ScheduleConfig | null {
  const rule = buildScheduleRule(input)
  if (!rule) return null
  const candidate: ScheduleConfig = { rule, command: input.command.trim() }
  return isValidScheduleConfig(candidate) ? candidate : null
}

/**
 * The first fire time (ms) strictly after fromMs, in the local timezone. It is called at registration and
 * restore time, so past occurrences ("missed runs") are naturally ignored. For monthly, a date the month
 * does not have (the 31st in February) skips ahead to a month that does have it.
 */
export function nextFireAt(rule: ScheduleRule, fromMs: number): number {
  if (rule.kind === 'interval') return fromMs + rule.minutes * 60_000
  let accept: (d: Date) => boolean
  if (rule.kind === 'daily') accept = () => true
  else if (rule.kind === 'weekly') {
    const days = rule.weekdays
    accept = (d) => days.includes(d.getDay())
  } else {
    const days = rule.days
    accept = (d) => days.includes(d.getDate())
  }
  const [h, m] = rule.time.split(':').map(Number)
  const d = new Date(fromMs)
  d.setHours(h, m, 0, 0)
  // Walks at most 366 days — even monthly's rare date (the 31st) is guaranteed to exist within a year.
  // isValidRule rejects an empty array, so a valid rule never produces NaN.
  for (let i = 0; i <= 366; i++) {
    if (d.getTime() > fromMs && accept(d)) return d.getTime()
    d.setDate(d.getDate() + 1)
    d.setHours(h, m, 0, 0)
  }
  return NaN
}
