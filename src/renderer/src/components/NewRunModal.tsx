import { useState } from 'react'
import type { Provider } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { Select, type SelectOption } from './Select'

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
  onClose,
  onCreated
}: {
  projectPath: string
  onClose: () => void
  /** 만들어진 Run 의 id — 부르는 쪽이 곧바로 상세 창을 열어 Task 를 짜게 한다 */
  onCreated: (runId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [objective, setObjective] = useState('')
  const [provider, setProvider] = useState<Provider>('claude')
  const [concurrency, setConcurrency] = useState(3)
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
        // 이 UI 로 만든 Run 은 언제나 자동이다 — 사용자에게 스위치를 주지 않는다(스펙 5절)
        auto: true
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
            min={1}
            value={concurrency}
            onChange={(e) => {
              const n = e.target.valueAsNumber
              setConcurrency(Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1)
            }}
          />
          <p className="modal-hint">{t('jobs.new.concurrencyHint')}</p>
        </div>
        {error && <p className="warn">{error}</p>}
        <div className="row right">
          <button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            className="primary"
            disabled={busy || !objective.trim()}
            onClick={() => void create()}
          >
            {t('jobs.new.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
