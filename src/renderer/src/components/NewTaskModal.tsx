import { useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { Select, type SelectOption } from './Select'

/** RunDetail 의 그래프가 Task 를 짓는 동안 상세 창의 아래 칸(.detail-events)이 통째로 바뀌는 폼.
 *  이름은 NewRunModal 을 따랐지만 그 컴포넌트처럼 `.modal-backdrop` 을 새로 세우지 않는다 — 그 배경은
 *  화면 전체의 클릭을 삼키는데, 이 폼은 **위의 그래프가 계속 눌려야 한다**(의존을 그래프에서 고르므로).
 *  그래서 RunDetail 이 이 컴포넌트를 자신의 `.detail-events` 자리에 직접 그린다: 새 창이 아니라 이미
 *  있는 창의 아래 칸이 두 번째 모습을 얻을 뿐이다.
 *
 *  NewRunModal 과 같은 관례로 로컬 draft 만 들고(제출 버튼 하나로 끝나는 한 번짜리 폼, flush/onBlur
 *  배선 없음), 실패해도 폼을 닫지 않는다 — 닫으면 에러를 보여줄 자리가 없어진다. */
export function NewTaskModal({
  projectPath,
  runId,
  deps,
  runConfigs,
  onClose,
  onCreated
}: {
  projectPath: string
  runId: string
  /** 지금 그래프에서 골라 둔 의존. 모달이 아니라 그래프가 소유한다 — 고르는 자리가 그래프다 */
  deps: string[]
  /** 검증 구성 목록. null 은 아직 안 온 것 */
  runConfigs: { id: string; name: string }[] | null
  onClose: () => void
  onCreated: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [spec, setSpec] = useState('')
  // '검증 없음'을 값 '' 으로 표현한다 — RunConfig.id 는 seed:* 접두사이거나 저장된 uuid라 절대 빈
  // 문자열이 될 수 없으므로 이 값과 겹칠 일이 없다.
  const [validateConfigId, setValidateConfigId] = useState('')
  const [review, setReview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const validateItems: SelectOption[] = [
    { value: '', label: t('jobs.task.validateNone') },
    ...(runConfigs ?? []).map((c) => ({ value: c.id, label: c.name }))
  ]

  const create = async (): Promise<void> => {
    const trimmedSpec = spec.trim()
    // busy 로 다시 걸러 이중 클릭이 Task 를 두 개 만들지 못하게 한다 — NewRunModal.create 와 같은
    // 이유다: 버튼의 disabled 는 같은 프레임에 반영되지 않을 수 있다.
    if (!trimmedSpec || busy) return
    setBusy(true)
    setError(null)
    try {
      const reply = await window.api.orch.command(projectPath, 'task-create', {
        // runId 를 언제나 명시한다 — task-create 의 기본값(`s.runs[마지막]`)에 기대면, 이 창이 아닌
        // 다른 프로젝트에서 방금 만들어진 Run 에 이 Task 가 들어간다(Global Constraints).
        runId,
        title: title.trim(),
        spec: trimmedSpec,
        deps,
        ...(validateConfigId ? { validate: validateConfigId } : {}),
        ...(review ? { review: true } : {})
        // parent 는 보내지 않는다 — parentId 는 통합(integration) Task 의 표식이라, 이 폼에서 보내면
        // 스케줄러가 이 Task 를 병합 단계 없이 프로젝트 폴더에서 돌리는 통합 Task 로 취급하게 된다.
      })
      if (reply.status >= 400) {
        // 실패해도 폼은 닫지 않는다 — 닫으면 에러를 보여줄 자리가 없고, 사용자는 눌러도 아무 일도
        // 없었다고 여긴다(NewRunModal.create 와 같은 이유).
        setError(t('jobs.task.failed'))
        return
      }
      onCreated()
    } catch {
      // orch.command 자체가 reject 하는 경우(IPC 실패) — 거부 팔이 없으면 DevTools 에
      // Uncaught (in promise) 가 뜬다. status>=400 과 같은 문구로 접는다: 사용자에게는 둘 다
      // "만들지 못했다"이지 원인을 구분해 보여줄 이유가 없다.
      setError(t('jobs.task.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* .detail-filter/.detail-clear 를 그대로 빌린다 — 걸러 놓은 Task 를 보여 주던 바로 그 자리에
          지금은 "무엇을 짓고 있는가"를 보여 준다. 같은 모양의 줄이 이 칸에서 늘 하던 일과 같은 일을
          하므로 새 CSS 를 만들 이유가 없다. */}
      <div className="detail-filter">
        <b>{t('jobs.task.new')}</b>
        <button
          className="detail-clear"
          title={t('common.cancel')}
          aria-label={t('common.cancel')}
          onClick={() => !busy && onClose()}
        >
          ✕
        </button>
      </div>
      <div className="detail-task-fields">
        <div className="field">
          <label>{t('jobs.task.title')}</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>{t('jobs.task.spec')}</label>
          <textarea rows={4} value={spec} onChange={(e) => setSpec(e.target.value)} />
        </div>
        <div className="field">
          {/* 골라 둔 개수만 여기 적는다 — 실제로 무엇을 골랐는지는 위 그래프의 체크 글리프가 이미
              보여 주고 있고, 이 폼은 id 만 받아서 제목을 모른다(제목은 그래프가 안다) */}
          <label>
            {t('jobs.task.deps')}
            {deps.length > 0 ? ` (${deps.length})` : ''}
          </label>
          <p className="modal-hint">{t('jobs.task.depsHint')}</p>
        </div>
        <div className="field">
          <label>{t('jobs.task.validate')}</label>
          <Select
            items={validateItems}
            value={validateConfigId}
            onChange={setValidateConfigId}
            ariaLabel={t('jobs.task.validate')}
          />
        </div>
        <label className="row check-small">
          <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
          {t('jobs.task.review')}
        </label>
        {error && <p className="warn">{error}</p>}
      </div>
      <div className="row right">
        <button onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </button>
        <button className="primary" disabled={busy || !spec.trim()} onClick={() => void create()}>
          {t('jobs.task.create')}
        </button>
      </div>
    </>
  )
}
