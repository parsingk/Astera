import { useState } from 'react'
import type { Provider, ScheduleRule } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { Select, type SelectOption } from './Select'
import { ScheduleRuleFields } from './ScheduleRuleFields'

/** Provider 선택지 — 'Claude'/'Codex'는 번역하지 않는다. ProviderBadge/AccountRow 가 이미 같은
 *  이름을 그대로 쓰고, catalog.test.ts 의 LITERALS 가 네 카탈로그 모두에서 그대로 남도록 강제한다. */
const PROVIDER_ITEMS: SelectOption[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' }
]

/** 사이드바의 '+ 새 작업'이 여는 폼. 여기서 만든 Run 은 앱이 스스로 돌린다 — 워커를 붙이고
 *  검증·병합까지 미는 스케줄러는 이미 있고(Task 1~6), 이 컴포넌트는 그 스케줄러가 볼 첫 Run 하나를
 *  만들 뿐이다.
 *
 *  RunConfigForm 과 같은 관례로 로컬 draft 를 들지만, 이 폼은 '저장'이 아니라 '한 번 제출하고
 *  끝'이라 flush/onBlur 배선은 없다 — 제출 버튼 하나가 전부다. */
export function NewRunModal({
  projectPath,
  projectFolderBusy,
  onClose,
  onCreated
}: {
  /** 이 프로젝트 폴더에서 이미 일하는 워커가 있는가(OrchSnapshot.projectFolderBusy). 동시 실행 1 을
   *  고르면 이 Run 의 워커도 그 폴더로 가므로 둘이 한 작업 트리를 나눠 쓰게 된다 — 그때 경고한다.
   *  **막지 않는다**: 파일을 안 건드리는 워커끼리는 충돌할 것이 없고 앱은 그것을 알 수 없다. */
  projectFolderBusy: boolean
  projectPath: string
  onClose: () => void
  /** 만들어진 Run 의 id — 부르는 쪽이 곧바로 상세 창을 열어 Task 를 짜게 한다 */
  onCreated: (runId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [objective, setObjective] = useState('')
  const [provider, setProvider] = useState<Provider>('claude')
  const [concurrency, setConcurrency] = useState(3)
  const [scheduled, setScheduled] = useState(false)
  const [schedule, setSchedule] = useState<ScheduleRule | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async (): Promise<void> => {
    const trimmed = objective.trim()
    // busy 로 다시 걸러 이중 클릭이 Run 을 두 개 만들지 못하게 한다 — 버튼의 disabled 는 같은
    // 프레임에 반영되지 않을 수 있어 여기서도 확인한다.
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const reply = await window.api.orch.command(projectPath, 'run-create', {
        objective: trimmed,
        cwd: projectPath,
        provider,
        concurrency,
        // 예약이면 auto 를 보내지 않는다 — 템플릿은 자신이 돌지 않고, 발화가 만든 자식 Run 이
        // 돈다(그 자식은 spawnScheduledRun 이 autoDispatch 를 켠다). 예약이 아니면 이 UI 로 만든
        // Run 은 언제나 자동이다 — 사용자에게 스위치를 주지 않는다(스펙 5절)
        ...(scheduled && schedule ? { schedule } : { auto: true })
      })
      if (reply.status >= 400) {
        // 실패해도 모달은 닫지 않는다 — 닫으면 사용자는 눌러도 아무 일도 없었다고 여긴다
        setError(t('jobs.new.failed'))
        return
      }
      onCreated((reply.body as { id: string }).id)
    } catch {
      // orch.command 자체가 reject 하는 경우(IPC 실패) — 여기서 잡지 않으면 DevTools 에
      // Uncaught (in promise) 가 뜬다. status>=400 과 같은 문구로 접는다: 사용자에게는 둘 다
      // "만들지 못했다"이지 원인을 구분해 보여줄 이유가 없다.
      setError(t('jobs.new.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('jobs.new.title')}</h2>
        {/* 전제조건이라 폼보다 앞에 둔다. 워커는 언제나 워크트리에서 일하고 워크트리는 git 의
            것이므로, 저장소가 아닌 폴더에서는 이 작업을 만들 수는 있어도 시작하지 못한다 — 그
            사실을 '실행' 을 누른 뒤 Gate 에서 알게 되는 것이 늦다. 막지 않고 알리기만 하는 이유:
            저장소인지 확인하려면 main 에 물어야 하고, 그 왕복을 모달을 여는 길에 넣는 것은 이
            한 줄이 사는 값보다 크다(docs/jobs.md 에 같은 사실이 적혀 있다). */}
        <p className="modal-hint">{t('jobs.new.gitRequired')}</p>
        <div className="field">
          <label>{t('jobs.new.objective')}</label>
          <input
            type="text"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            autoFocus
          />
        </div>
        <div className="field">
          <label>{t('jobs.new.provider')}</label>
          <Select
            items={PROVIDER_ITEMS}
            value={provider}
            onChange={(v) => setProvider(v as Provider)}
            ariaLabel={t('jobs.new.provider')}
          />
        </div>
        <div className="field">
          <label>{t('jobs.new.concurrency')}</label>
          <input
            type="number"
            className="jobs-concurrency"
            min={1}
            value={concurrency}
            onChange={(e) => {
              const n = e.target.valueAsNumber
              setConcurrency(Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1)
            }}
          />
          <p className="modal-hint">{t('jobs.new.concurrencyHint')}</p>
          {/* 동시 실행 1 을 골랐고 그 폴더에 이미 워커가 있을 때만. 2 이상이면 배치 규칙이 워커마다
              워크트리를 주므로 나눠 쓸 일이 없다(ipc.ts 의 배치) — 그때 이 줄을 띄우면 틀린 말이다.
              **하필 조심스러운 값(1)이 위험한 값이다**: 상한 1 의 안전 논거는 "그 폴더에 한 번에
              하나"였는데 그 보장이 Run 별이고 위험은 폴더별이라, 상한 1 인 Run 둘이 각자 1슬롯씩
              받으면 워커 둘이 한 폴더에서 동시에 일한다. 그러고도 커밋 의무도 병합 단계도 붙지
              않아 앱의 어떤 기계도 알아채지 못한다 — 그래서 만들기 전에 여기서 말한다. */}
          {concurrency <= 1 && projectFolderBusy && (
            <p className="warn-text">{t('jobs.new.folderBusy')}</p>
          )}
        </div>
        <div className="field">
          <label className="check-small">
            <input
              type="checkbox"
              checked={scheduled}
              onChange={(e) => setScheduled(e.target.checked)}
            />
            {t('jobs.new.schedule')}
          </label>
          {scheduled && (
            <div className="jobs-sched">
              <ScheduleRuleFields onChange={setSchedule} />
              <p className="modal-hint">{t('jobs.new.scheduleHint')}</p>
              {/* 겹침을 막지 않기로 한 결정을 사람에게 알린다 — 상한이 3 인 예약의 회차 둘이
                  겹치면 워커는 여섯이다. 막지 않는 이유는 폴더 공유 경고와 같다: 파일을 안
                  건드리는 워커끼리는 충돌할 것이 없고 앱은 그것을 알 수 없다 */}
              <p className="warn-text">{t('jobs.new.scheduleOverlapHint')}</p>
            </div>
          )}
        </div>
        {error && <p className="warn">{error}</p>}
        <div className="row right">
          <button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            className="primary"
            disabled={busy || !objective.trim() || (scheduled && schedule === null)}
            onClick={() => void create()}
          >
            {t('jobs.new.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
