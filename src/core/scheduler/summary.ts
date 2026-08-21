// 예약 규칙을 사람이 읽는 한 줄로. 세션 터미널의 배너와 Jobs 사이드바의 예약 줄이 같은 말을
// 해야 해서 여기 있다 — TerminalView.tsx 안에 있던 동안은 테스트도 닿지 않았다.
//
// t 를 인자로 받는다: 이 층은 프레임워크에 의존하지 않으므로 훅을 부를 수 없다(원래 있던 자리에서
// 모듈 수준 함수였던 것과 같은 사정이다).
import type { MessageKey, MessageParams } from '../i18n'
import type { ScheduleRule } from './rule'

/** 요일 번호(0 = 일요일) → 카탈로그 키. NewSessionDialog 와 session.sched.weekday.* 를 나눠 쓴다 */
export const WEEKDAY_KEYS: readonly MessageKey[] = [
  'session.sched.weekday.sun',
  'session.sched.weekday.mon',
  'session.sched.weekday.tue',
  'session.sched.weekday.wed',
  'session.sched.weekday.thu',
  'session.sched.weekday.fri',
  'session.sched.weekday.sat'
]

export const schedRuleSummary = (
  t: (key: MessageKey, params?: MessageParams) => string,
  rule?: ScheduleRule
): string => {
  if (!rule) return t('session.terminal.schedFallback')
  switch (rule.kind) {
    case 'interval':
      return t('session.terminal.schedSummary.interval', { minutes: rule.minutes })
    case 'daily':
      return t('session.terminal.schedSummary.daily', { time: rule.time })
    case 'weekly':
      return t('session.terminal.schedSummary.weekly', {
        days: rule.weekdays.map((d) => t(WEEKDAY_KEYS[d])).join('·'),
        time: rule.time
      })
    case 'monthly':
      return t('session.terminal.schedSummary.monthly', { days: rule.days.join('·'), time: rule.time })
  }
}
