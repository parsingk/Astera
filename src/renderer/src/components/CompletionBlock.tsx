import { useEffect, useState } from 'react'
import type { CompletionDetail } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'

/**
 * 고른 Task 가 **왜** 완료 정책을 못 넘었는가 — 칩이 말하지 않는 나머지.
 *
 * 노드의 칩 줄은 "무엇이 몇 개 중 어디서 멈췄나" 까지만 말한다(첫 조각 U6). 그 다음 물음인 "그래서
 * 뭐가 틀렸나" 는 검사가 뱉은 출력과 리뷰어가 적은 이슈에만 있고, 그것은 스냅숏에 실리지 않는다 —
 * 스냅숏은 오케스트레이션이 바뀔 때마다 사이드바로 푸시되기 때문이다(U4). 그래서 **펼칠 때 한 번**
 * 따로 가져온다(2조각 설계 W1).
 *
 * 접힌 채로 시작한다. 이 창을 여는 사람 대부분은 무엇이 도는지를 보러 오고, 꼬리 넷이 펼쳐진 채
 * 기다리면 그래프가 화면 밖으로 밀린다.
 */
export function CompletionBlock({
  projectPath,
  runId,
  taskId
}: {
  projectPath: string
  runId: string
  /** 고른 노드. 바뀌면 다시 가져온다 */
  taskId: string
}): React.JSX.Element | null {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  /** undefined = 아직 안 가져왔다, null = 가져왔는데 보여 줄 것이 없다 */
  const [detail, setDetail] = useState<CompletionDetail | null | undefined>(undefined)
  /** 꼬리를 펼친 검사들 */
  const [tails, setTails] = useState<Set<string>>(new Set())

  // 노드를 바꾸면 접고 비운다 — 안 그러면 새 Task 를 열었는데 이전 Task 의 꼬리가 펼쳐진 채 남는다.
  useEffect(() => {
    setOpen(false)
    setDetail(undefined)
    setTails(new Set())
  }, [taskId])

  // 펼칠 때 한 번. 닫았다 다시 열면 다시 가져온다 — 그 사이 라운드가 한 번 더 돌았을 수 있고,
  // 낡은 꼬리를 현재형으로 보여 주는 것이 이 블록이 피해야 할 바로 그것이다.
  useEffect(() => {
    if (!open) return
    let alive = true
    void window.api.orch.completion(projectPath, runId, taskId).then(
      (d) => {
        if (alive) setDetail(d)
      },
      () => {
        if (alive) setDetail(null)
      }
    )
    return () => {
      alive = false
    }
  }, [open, projectPath, runId, taskId])

  const toggleTail = (configId: string): void =>
    setTails((prev) => {
      const next = new Set(prev)
      if (next.has(configId)) next.delete(configId)
      else next.add(configId)
      return next
    })

  return (
    <div className="detail-completion">
      <button className="detail-completion-head" onClick={() => setOpen((p) => !p)}>
        {open ? t('jobs.completion.hide') : t('jobs.completion.show')}
      </button>
      {open && detail === undefined && <p className="modal-hint">{t('files.editor.loading')}</p>}
      {open && detail === null && <p className="modal-hint">{t('jobs.completion.empty')}</p>}
      {open && detail !== null && detail !== undefined && (
        <>
          {detail.checks.length > 0 && (
            <ul className="detail-completion-checks">
              {detail.checks.map((c) => (
                <li key={c.configId}>
                  <span className={`detail-completion-name detail-completion-name--${c.status}`}>{c.name}</span>
                  <span className="detail-completion-verdict">
                    {c.status === 'passed'
                      ? t('jobs.convergence.check.passed')
                      : c.status === 'failed'
                        ? t('jobs.convergence.check.failed', { code: c.exitCode ?? '?' })
                        : c.status === 'timed-out'
                          ? t('jobs.convergence.check.timedOut')
                          : t('jobs.convergence.check.notRun')}
                    {c.unstable === true && ` · ${t('jobs.convergence.check.unstable')}`}
                  </span>
                  {/* 꼬리는 검사마다 따로 접는다 — 넷이 한꺼번에 펼쳐지면 그중 무엇이 막고 있는지
                      다시 찾아야 한다(설계 §2.3) */}
                  {c.outputTail !== undefined && (
                    <button className="detail-completion-more" onClick={() => toggleTail(c.configId)}>
                      {tails.has(c.configId) ? t('jobs.completion.hideTail') : t('jobs.completion.showTail')}
                    </button>
                  )}
                  {c.outputTail !== undefined && tails.has(c.configId) && (
                    <pre className="detail-completion-tail">{c.outputTail}</pre>
                  )}
                </li>
              ))}
            </ul>
          )}

          {detail.blockingIssues.length > 0 && (
            <>
              <p className="detail-completion-label">
                {t('jobs.completion.blocking', { n: detail.blockingIssues.length })}
              </p>
              <ul className="detail-completion-issues">
                {detail.blockingIssues.map((i) => (
                  <li key={i.id}>
                    <span className={`detail-completion-sev sev-${i.severity}`}>{i.severity}</span>
                    <span className="detail-completion-issue-title">{i.title}</span>
                    {i.file !== undefined && (
                      <span className="detail-completion-where">
                        {i.line !== undefined ? `${i.file}:${i.line}` : i.file}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {/* 막지 않는 이슈는 개수만 — 있다는 사실은 말한다. 리뷰어가 아무 말도 안 한 것과 다르다 */}
          {detail.otherIssueCount > 0 && (
            <p className="modal-hint">{t('jobs.completion.other', { n: detail.otherIssueCount })}</p>
          )}

          {/* 명세 §38 — 검사 설정을 건드린 파일. 리뷰어에게 넘어간 그 목록을 사람도 본다 */}
          {detail.suspiciousFiles.length > 0 && (
            <>
              <p className="detail-completion-label">{t('jobs.completion.suspicious')}</p>
              <ul className="detail-completion-files">
                {detail.suspiciousFiles.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  )
}
