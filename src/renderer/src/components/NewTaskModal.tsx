import { useState } from 'react'
import type { Account, JobTask } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { AccountSelect } from './AccountSelect'
import { Select, type SelectOption } from './Select'

/** 계정 슬롯 최대 개수. 새 세션 대화상자의 MAX_ROLL_ACCOUNTS 와 같은 값이지만 **상수를 공유하지
 *  않는다** — 저쪽은 탭 세션의 롤링이고 이쪽은 Task 의 체인이다. 한쪽을 늘릴 때 다른 쪽이 따라
 *  움직이면 안 된다. core·CLI 에는 상한이 없다(롤링 코디네이터에 상한이 없다) — 이것은 레이아웃
 *  사정이고, 이 폼은 만들기 전용이라 CLI 로 넷 이상 지정한 Task 를 여기서 보여 줄 일이 없다. */
const MAX_TASK_ACCOUNTS = 3

/** RunDetail 의 그래프가 Task 를 짓는 동안 상세 창의 아래 칸(.detail-events)이 통째로 바뀌는 폼.
 *  이름은 NewRunModal 을 따랐지만 그 컴포넌트처럼 `.modal-backdrop` 을 새로 세우지 않는다 — 그 배경은
 *  화면 전체의 클릭을 삼킨다. **예전 이유는 "위의 그래프가 계속 눌려야 한다"였다** — 의존을 그래프
 *  노드를 눌러 골랐기 때문이다. 지금은 폼 안의 셀렉트로 고르므로 그 이유는 없어졌고, 그래도 이 자리에
 *  남는 이유는 바뀌었다: 의존을 **이름으로** 고르는 동안 위 그래프가 계속 **보여야** 한다. 무엇에
 *  붙이는지 판단할 근거가 그 그림이고, 새 모달을 세우면 그것을 가린다.
 *
 *  NewRunModal 과 같은 관례로 로컬 draft 만 들고(제출 버튼 하나로 끝나는 한 번짜리 폼, flush/onBlur
 *  배선 없음), 실패해도 폼을 닫지 않는다 — 닫으면 에러를 보여줄 자리가 없어진다. */
export function NewTaskModal({
  projectPath,
  runId,
  tasks,
  accounts,
  runConfigs,
  onClose,
  onCreated
}: {
  projectPath: string
  runId: string
  /** 이 Run 의 Task 들 — 의존 셀렉트의 항목이다. 제목이 필요하므로 id 목록으로는 안 된다.
   *  자기 자신은 아직 만들어지지 않았으므로 목록에 있을 수가 없고, 그래서 "자신을 의존으로 고르는"
   *  경우를 걸러 낼 필요가 없다. */
  tasks: JobTask[]
  /** 고를 수 있는 계정 — 이 Run 의 provider 것만 걸러 온다. null 은 아직 안 온 것 */
  accounts: Account[] | null
  /** 검증 구성 목록. null 은 아직 안 온 것 */
  runConfigs: { id: string; name: string }[] | null
  onClose: () => void
  onCreated: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [spec, setSpec] = useState('')
  /** 고른 의존. **이 폼이 소유한다** — 예전에는 그래프가 들고 있었다(고르는 자리가 그래프였다).
   *  셀렉트로 옮기면서 값과 그 값을 고치는 화면이 같은 자리에 있게 됐다. */
  const [deps, setDeps] = useState<string[]>([])
  // '검증 없음'을 값 '' 으로 표현한다 — RunConfig.id 는 seed:* 접두사이거나 저장된 uuid라 절대 빈
  // 문자열이 될 수 없으므로 이 값과 겹칠 일이 없다.
  /** 이 Task 를 띄울 계정들, 순서대로. **빈 배열이 "지정 안 함"이고 그것이 기본이다** — 그때는 그
   *  provider 의 기본 계정으로 간다(core/accounts/dispatchAccount.ts). 첫 계정으로 띄우고 나머지는
   *  한도에 걸렸을 때 갈아탈 순서다.
   *
   *  **첫 칸을 비우면 뒤 칸도 함께 사라진다** — 지정 없이 "두 번째 계정" 만 있는 상태는 뜻이 없다. */
  const [accountIds, setAccountIds] = useState<string[]>([])
  const [validateConfigId, setValidateConfigId] = useState('')
  const [review, setReview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const validateItems: SelectOption[] = [
    { value: '', label: t('jobs.task.validateNone') },
    ...(runConfigs ?? []).map((c) => ({ value: c.id, label: c.name }))
  ]

  /** 아직 안 고른 Task 만 항목으로 낸다 — 고른 것을 다시 고르면 deps 에 같은 id 가 둘 들어가고
   *  그래프가 같은 선을 두 번 긋는다. 이 셀렉트는 값을 들고 있지 않고(value 는 늘 '') 고르는 순간
   *  목록에 더하는 **더하기 손잡이**다: 의존은 여럿일 수 있는데 Select 의 값은 하나이므로, 고른
   *  것들은 아래 칩으로 서고 그 자리에서 지운다. */
  const depItems: SelectOption[] = tasks
    .filter((tk) => !deps.includes(tk.id))
    .map((tk) => ({ value: tk.id, label: tk.title }))
  const titleOf = (id: string): string => tasks.find((tk) => tk.id === id)?.title ?? id

  /** 뒤에 빈 칸을 하나 더 세울지 — **그 칸에서 고를 것이 남았을 때만 세운다.** 이미 고른 계정은 다른
   *  칸의 항목에서 빠지므로(아래 filter), 계정이 하나뿐인 사람이 그것을 고르면 둘째 칸의 목록이 비고
   *  '추가 안 함' 한 줄만 있는 죽은 드롭다운이 남는다 — 계정이 하나인 사람이 가장 흔한 경우다.
   *  새 세션 대화상자가 '계정 추가' 버튼에 같은 판단을 쓴다(NewSessionDialog.tsx 의 canAdd).
   *  상한도 여기서 본다: 이것이 칸을 늘리는 유일한 길이므로 accountIds 는 상한을 넘을 수 없다. */
  const canAddSlot =
    accountIds.length < MAX_TASK_ACCOUNTS &&
    (accounts ?? []).some((a) => !accountIds.includes(a.id))

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
        // 쉼표로 보낸다 — task-create 의 문법이다(server.ts). 빈 배열이면 칸 자체를 보내지 않는다.
        ...(accountIds.length > 0 ? { account: accountIds.join(',') } : {}),
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
        {/* 고를 것도 고른 것도 없으면 이 칸을 아예 그리지 않는다 — Run 의 첫 Task 를 만들 때가
            그렇다(가리킬 Task 가 존재하지 않는다). 라벨과 안내문만 남기면 무엇을 해야 하는지 알 수
            없는 죽은 칸이 된다. 셀렉트만 감추는 것으로 부족한 이유가 그것이다 */}
        {(depItems.length > 0 || deps.length > 0) && (
          <div className="field">
            <label>{t('jobs.task.deps')}</label>
            {/* 다 골랐으면 셀렉트가 빠진다 — 빈 셀렉트는 눌러도 아무것도 없는 자리가 된다 */}
            {depItems.length > 0 && (
              <Select
                items={depItems}
                value=""
                placeholder={t('jobs.task.depsAdd')}
                onChange={(id) => setDeps((cur) => [...cur, id])}
                ariaLabel={t('jobs.task.deps')}
              />
            )}
            {deps.length > 0 && (
              <div className="detail-dep-list">
                {deps.map((id) => (
                  <span key={id} className="detail-chip detail-dep">
                    <span>{titleOf(id)}</span>
                    <button
                      type="button"
                      title={t('common.cancel')}
                      aria-label={`${titleOf(id)} — ${t('common.cancel')}`}
                      onClick={() => setDeps((cur) => cur.filter((x) => x !== id))}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            <p className="modal-hint">{t('jobs.task.depsHint')}</p>
          </div>
        )}
        {/* **계정이 하나도 없을 때만 접는다** — 위 선행 Task 칸과 같은 규칙이다: 고를 것이 없는
            컨트롤만 감춘다. 한때 "둘 이상일 때만" 이었는데 둘이 어긋났다. (1) 계정이 하나여도
            "지정 안 함"과 "이 계정으로 못박음"은 뜻이 다르다 — 그 계정이 로그아웃되고 둘째가
            등록되면 지정 없는 Task 는 새 계정으로 조용히 넘어가고 못박은 Task 는 Gate 를 연다.
            (2) 칸이 없는 이유를 화면이 말하지 않아, 계정이 하나인 사람은 기능이 빠진 줄 안다.
            null 은 아직 안 온 것이라 같이 접힌다 */}
        {(accounts?.length ?? 0) > 0 && (
          <div className="field">
            <label>{t('jobs.task.account')}</label>
            {/* 슬롯 하나씩. 첫 칸은 '지정 안 함'(빈 값)을 가질 수 있고, 뒤 칸은 고른 것만 남는다 —
                빈 뒤 칸은 뜻이 없으므로 값을 비우면 그 칸이 사라진다. 이미 고른 계정은 다른 칸의
                항목에서 빠진다(같은 계정을 두 칸에 넣으면 롤링이 두 계정인 줄 알고 같은 계정으로
                "갈아탄다" — task-create 도 그 조합을 거절한다). 맨 뒤의 빈 칸은 고를 것이 남았을
                때만 붙는다(canAddSlot). */}
            {(canAddSlot ? [...accountIds, ''] : accountIds).map((slot, i) => (
              <AccountSelect
                key={i}
                className="stack-item"
                accounts={(accounts ?? []).filter(
                  (a) => a.id === slot || !accountIds.includes(a.id)
                )}
                value={slot}
                onChange={(id) =>
                  setAccountIds((prev) => {
                    const next = [...prev]
                    if (id === '') next.splice(i) // 이 칸부터 뒤를 버린다 — 위 주석
                    else next[i] = id
                    return next.filter((x) => x !== '')
                  })
                }
                allLabel={i === 0 ? t('jobs.task.accountDefault') : t('jobs.task.accountNone')}
              />
            ))}
            <p className="modal-hint">{t('jobs.task.accountHint')}</p>
            {accountIds.length > 0 && <p className="warn-text">{t('jobs.task.accountTrust')}</p>}
          </div>
        )}
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
