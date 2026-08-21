import { useEffect, useRef, useState } from 'react'
import type { ScheduleConfig, ScheduleRule } from '../../../core/types'
import { scheduleConfigOf } from '../../../core/scheduler/rule'
import { useI18n } from '../i18n/I18nProvider'
import { ScheduleRuleFields } from './ScheduleRuleFields'

/** 주기 명령 예약 입력(NewSessionDialog 에서 뽑아낸 것). 새 세션 모달과 이어하기 모달이 나눠 쓴다 —
 *  복사해 두면 두 모달의 검증 규칙이 갈라진다.
 *
 *  **규칙 부분은 ScheduleRuleFields 가 그린다.** Job 예약이 같은 규칙 UI 를 쓰면서 명령 칸만
 *  필요 없어서 나눴다. 이 컴포넌트가 더하는 것은 명령 한 칸과 "규칙 + 명령" 의 조립뿐이다.
 *  이 컴포넌트의 공개 인터페이스는 나누기 전과 같다.
 *  initial 은 마운트 때 한 번만 읽는다 — 타이핑 중에 되먹이면 입력이 되돌아간다. */
export function ScheduleFields({
  initial,
  onChange
}: {
  initial?: ScheduleConfig | null
  onChange: (v: ScheduleConfig | null) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [rule, setRule] = useState<ScheduleRule | null>(initial?.rule ?? null)
  const [command, setCommand] = useState(initial?.command ?? '')

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // 규칙과 명령을 합치는 판정은 core 의 scheduleConfigOf 에 맡긴다 — UI 가 판정의 사본을
  // 들면 둘이 갈라진다
  useEffect(() => {
    onChangeRef.current(scheduleConfigOf(rule, command))
  }, [rule, command])

  return (
    <div className="field sched-field">
      <ScheduleRuleFields initial={initial?.rule ?? null} onChange={setRule} />
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
