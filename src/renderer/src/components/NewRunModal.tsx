import { useState } from 'react'
import type { Account, ScheduleRule } from '../../../core/types'
import { providerOf } from '../../../core/providers/meta'
import { useI18n } from '../i18n/I18nProvider'
import { AccountSelect } from './AccountSelect'
import { ScheduleRuleFields } from './ScheduleRuleFields'

/** 코디네이터 계정 슬롯 상한. NewTaskModal 의 MAX_TASK_ACCOUNTS 와 같은 값이지만 **상수를
 *  공유하지 않는다** — 저쪽은 한 Task 의 워커 체인이고 이쪽은 Run 하나의 관리자 체인이다.
 *  한쪽을 늘릴 때 다른 쪽이 따라 움직이면 안 된다(그 파일의 같은 판단). */
const MAX_COORDINATOR_ACCOUNTS = 3

/** 사이드바의 '+ 새 작업'이 여는 폼. 여기서 만든 Run 은 앱이 스스로 돌린다 — 워커를 붙이고
 *  검증·병합까지 미는 스케줄러는 이미 있고(Task 1~6), 이 컴포넌트는 그 스케줄러가 볼 첫 Run 하나를
 *  만들 뿐이다.
 *
 *  RunConfigForm 과 같은 관례로 로컬 draft 를 들지만, 이 폼은 '저장'이 아니라 '한 번 제출하고
 *  끝'이라 flush/onBlur 배선은 없다 — 제출 버튼 하나가 전부다. */
export function NewRunModal({
  projectPath,
  projectFolderBusy,
  accounts,
  onClose,
  onCreated
}: {
  /** 이 프로젝트 폴더에서 이미 일하는 워커가 있는가(OrchSnapshot.projectFolderBusy). 동시 실행 1 을
   *  고르면 이 Run 의 워커도 그 폴더로 가므로 둘이 한 작업 트리를 나눠 쓰게 된다 — 그때 경고한다.
   *  **막지 않는다**: 파일을 안 건드리는 워커끼리는 충돌할 것이 없고 앱은 그것을 알 수 없다. */
  projectFolderBusy: boolean
  projectPath: string
  /** 고를 수 있는 계정 전부. null 은 아직 안 온 것 — NewTaskModal 의 같은 prop 과 같은 뜻이다 */
  accounts: Account[] | null
  onClose: () => void
  /** 만들어진 Run 의 id — 부르는 쪽이 곧바로 상세 창을 열어 Task 를 짜게 한다 */
  onCreated: (runId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [objective, setObjective] = useState('')
  const [concurrency, setConcurrency] = useState(3)
  /** 이 Run 을 관리할 코디네이터 세션의 계정들, 순서대로. **비어 있으면 코디네이터를 띄우지
   *  않는다** — 그때는 앱이 직접 돌린다(server.ts 의 run-start). 그 갈림을 조용히 두지 않고
   *  아래 힌트가 말한다. */
  const [coordinatorAccountIds, setCoordinatorAccountIds] = useState<string[]>([])
  const [scheduled, setScheduled] = useState(false)
  const [schedule, setSchedule] = useState<ScheduleRule | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 첫 계정이 정한 provider. 아직 없으면 null — 그때는 모든 칸이 전부 보여 준다. */
  const head = (accounts ?? []).find((a) => a.id === coordinatorAccountIds[0])
  const headProvider = head ? providerOf(head) : null

  /** 그 칸에서 고를 수 있는 계정. **둘째 칸부터는 첫 계정과 같은 provider 만** — 코디네이터도 한
   *  CLI 이고, 섞인 목록은 run-create 가 거절한다(server.ts 의 parseAccountList). 고를 수 없게
   *  두는 것이 거절보다 낫다(NewTaskModal 의 같은 판단). */
  const choicesFor = (index: number, slot: string): Account[] =>
    (accounts ?? []).filter(
      (a) =>
        (a.id === slot || !coordinatorAccountIds.includes(a.id)) &&
        (index === 0 || headProvider === null || providerOf(a) === headProvider)
    )

  const canAddSlot =
    coordinatorAccountIds.length < MAX_COORDINATOR_ACCOUNTS &&
    choicesFor(coordinatorAccountIds.length, '').length > 0

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
        // **provider 를 보내지 않는다** — Run 은 더 이상 그것을 정하지 않고, Task 의 계정이
        // 정한다(orchestration/types.ts 의 Task.accountIds). run-create 는 이 플래그를 이제
        // 거절한다(server.ts).
        concurrency,
        // 비어 있으면 칸 자체를 보내지 않는다 — "지정 없음"이고, 그때 앱이 직접 돌린다
        ...(coordinatorAccountIds.length > 0
          ? { coordinatorAccount: coordinatorAccountIds.join(',') }
          : {}),
        // **`auto` 는 예약에도 보낸다.** 뜻은 "앱이 이것을 돌린다" 이고, 예약도 앱이 돌린다 —
        // 발화가 앱의 ticker 다. 이 UI 로 만든 Run 은 언제나 자동이므로 사용자에게 스위치를 주지
        // 않는다(스펙 5절).
        //
        // 한때 예약에는 보내지 않았다. 이유는 맞았지만 막는 자리가 틀렸다: 템플릿이 자기 Task 를
        // 스스로 배치하면 정의 자체를 돌려 버리는데, 그것을 막는 것은 `autoDispatch` 이고
        // run-create 가 이미 `schedule === undefined` 로 그 칸을 따로 withhold 한다. 그런데
        // `pendingStart`("아직 시작하지 않았다")도 같은 깃발을 타고 있어서, 보내지 않으면 예약
        // 템플릿에 **'실행' 버튼이 아예 붙지 않았다** — 실제로 그렇게 보고됐다.
        ...(scheduled && schedule ? { schedule } : {}),
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
        {/* 계정이 하나도 없으면 접는다 — 고를 것이 없는 컨트롤은 감춘다(NewTaskModal 의 같은 규칙).
            null 은 아직 안 온 것이라 같이 접힌다. */}
        {(accounts?.length ?? 0) > 0 && (
          <div className="field">
            <label>{t('jobs.new.coordinator')}</label>
            {/* 슬롯 하나씩. 첫 칸을 비우면 뒤 칸도 함께 사라진다 — 첫 계정이 provider 를 정하므로
                그것 없이 "두 번째 계정" 만 있는 상태는 뜻이 없다(NewTaskModal 의 같은 판단). */}
            {(canAddSlot ? [...coordinatorAccountIds, ''] : coordinatorAccountIds).map((slot, i) => (
              <AccountSelect
                key={i}
                className="stack-item"
                accounts={choicesFor(i, slot)}
                value={slot}
                onChange={(id) =>
                  setCoordinatorAccountIds((prev) => {
                    const next = [...prev]
                    if (id === '') next.splice(i)
                    else next[i] = id
                    return next.filter((x) => x !== '')
                  })
                }
                allLabel={i === 0 ? t('jobs.new.coordinatorNone') : t('jobs.task.accountNone')}
              />
            ))}
            <p className="modal-hint">{t('jobs.new.coordinatorHint')}</p>
          </div>
        )}
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
