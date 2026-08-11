import { useEffect, useRef, useState } from 'react'
import type { ScheduleConfig, ScheduleRule } from '../../../core/types'
import { buildScheduleConfig } from '../../../core/scheduler/rule'
import { useI18n } from '../i18n/I18nProvider'
import { Select } from './Select'

type SchedKind = ScheduleRule['kind']

/** Recurring command schedule input (extracted from NewSessionDialog, where it used to live).
 *  The new session modal and the resume modal share it — copy-pasting it makes the two modals'
 *  validation rules drift apart.
 *  This component owns nothing but the input state; assembling, parsing and validity checks are all
 *  delegated to core's buildScheduleConfig — kept inside the .tsx, vitest cannot reach them and the
 *  validation rules would stay outside the tests.
 *  initial is read exactly once, at mount — reapplying it while the user types would revert their input. */
export function ScheduleFields({
  initial,
  onChange
}: {
  initial?: ScheduleConfig | null
  onChange: (v: ScheduleConfig | null) => void
}): React.JSX.Element {
  const { t } = useI18n()
  // Weekday button labels (0 = Sunday) — shares the session.sched.weekday.* catalog with TerminalView
  const weekdayLabels = [
    t('session.sched.weekday.sun'),
    t('session.sched.weekday.mon'),
    t('session.sched.weekday.tue'),
    t('session.sched.weekday.wed'),
    t('session.sched.weekday.thu'),
    t('session.sched.weekday.fri'),
    t('session.sched.weekday.sat')
  ]
  const [kind, setKind] = useState<SchedKind>(initial?.rule.kind ?? 'interval')
  const [minutes, setMinutes] = useState(
    initial?.rule.kind === 'interval' ? String(initial.rule.minutes) : '30'
  )
  const [time, setTime] = useState(
    initial && initial.rule.kind !== 'interval' ? initial.rule.time : '09:00'
  )
  const [weekdays, setWeekdays] = useState<number[]>(
    initial?.rule.kind === 'weekly' ? initial.rule.weekdays : []
  )
  const [days, setDays] = useState(
    initial?.rule.kind === 'monthly' ? initial.rule.days.join(',') : ''
  )
  const [command, setCommand] = useState(initial?.command ?? '')

  // onChange is held in a ref and kept out of the effect deps — this stops the effect from re-running on
  // every render even when the parent does not wrap it in useCallback
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    onChangeRef.current(buildScheduleConfig({ kind, minutes, time, weekdays, days, command }))
  }, [kind, minutes, time, weekdays, days, command])

  return (
    <div className="field sched-field">
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
      <input
        type="text"
        value={command}
        maxLength={500}
        placeholder={t('session.new.schedCommandPlaceholder')}
        onChange={(e) => setCommand(e.target.value)}
      />
      <span className="roll-prompt-hint">{t('session.new.schedHint')}</span>
    </div>
  )
}
