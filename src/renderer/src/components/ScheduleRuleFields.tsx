import { useEffect, useRef, useState } from 'react'
import type { ScheduleRule } from '../../../core/types'
import { buildScheduleRule } from '../../../core/scheduler/rule'
import { useI18n } from '../i18n/I18nProvider'
import { Select } from './Select'

type SchedKind = ScheduleRule['kind']

/** 예약 규칙 입력 — 주기 네 갈래와 그 값들. **명령 칸은 없다.**
 *
 *  ScheduleFields 에서 뽑아냈다. 세션 예약은 이 위에 명령 한 칸을 더한 것이고(그쪽이 이것을
 *  감싼다), Job 예약은 이것만 쓴다 — Job 에는 타이핑할 명령이 없다(Run.schedule).
 *
 *  조립·파싱·유효성은 core 의 buildScheduleRule 이 안다. 이 컴포넌트는 입력 상태만 들고 있다 —
 *  .tsx 안에 두면 vitest 가 닿지 못해 규칙에 회귀 검출기가 없어진다(ScheduleFields 와 같은 사정).
 *  initial 은 마운트 때 한 번만 읽는다 — 타이핑 중에 되먹이면 입력이 되돌아간다. */
export function ScheduleRuleFields({
  initial,
  onChange
}: {
  initial?: ScheduleRule | null
  onChange: (v: ScheduleRule | null) => void
}): React.JSX.Element {
  const { t } = useI18n()
  // 요일 버튼 라벨(0 = 일요일) — TerminalView·NewSessionDialog 와 session.sched.weekday.* 를 나눠 쓴다
  const weekdayLabels = [
    t('session.sched.weekday.sun'),
    t('session.sched.weekday.mon'),
    t('session.sched.weekday.tue'),
    t('session.sched.weekday.wed'),
    t('session.sched.weekday.thu'),
    t('session.sched.weekday.fri'),
    t('session.sched.weekday.sat')
  ]
  const [kind, setKind] = useState<SchedKind>(initial?.kind ?? 'interval')
  const [minutes, setMinutes] = useState(
    initial?.kind === 'interval' ? String(initial.minutes) : '30'
  )
  const [time, setTime] = useState(initial && initial.kind !== 'interval' ? initial.time : '09:00')
  const [weekdays, setWeekdays] = useState<number[]>(
    initial?.kind === 'weekly' ? initial.weekdays : []
  )
  const [days, setDays] = useState(initial?.kind === 'monthly' ? initial.days.join(',') : '')

  // onChange 를 ref 에 담아 effect 의 deps 에서 뺀다 — 부모가 useCallback 으로 싸지 않아도
  // 렌더마다 effect 가 다시 돌지 않는다(ScheduleFields 와 같은 관례)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    onChangeRef.current(buildScheduleRule({ kind, minutes, time, weekdays, days }))
  }, [kind, minutes, time, weekdays, days])

  return (
    <>
      <div className="row">
        <Select
          className="sched-kind"
          items={[
            { value: 'interval', label: t('session.new.schedMode.interval') },
            { value: 'daily', label: t('session.new.schedMode.daily') },
            { value: 'weekly', label: t('session.new.schedMode.weekly') },
            { value: 'monthly', label: t('session.new.schedMode.monthly') }
          ]}
          value={kind}
          onChange={(v) => setKind(v as SchedKind)}
        />
        {kind === 'interval' && (
          <>
            <input
              type="number"
              className="sched-minutes"
              min={1}
              max={525_600}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
            <span className="check-note">{t('session.new.schedMinutesUnit')}</span>
          </>
        )}
        {kind === 'monthly' && (
          <>
            <input
              type="text"
              className="sched-days"
              placeholder="1,15"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
            <span className="check-note">{t('session.new.schedDaysUnit')}</span>
          </>
        )}
        {kind !== 'interval' && (
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        )}
      </div>
      {kind === 'weekly' && (
        <div className="row sched-weekdays">
          {weekdayLabels.map((label, d) => (
            <button
              key={d}
              type="button"
              className={weekdays.includes(d) ? 'weekday on' : 'weekday'}
              onClick={() =>
                setWeekdays((prev) =>
                  prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)
                )
              }
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
