import { useEffect, useState } from 'react'
import * as hiddenProjects from '../lib/hiddenProjects'
import { viewOf } from '../lib/hiddenProjectsView'
import { confirmModal } from '../lib/confirm'
import { toast } from '../lib/toast'
import { useI18n } from '../i18n/I18nProvider'

/** 한 페이지에 그릴 줄 수. 설정 모달 본문 높이에 맞춘 값으로, 이보다 적으면 검색도 페이지 이동도
 *  붙이지 않는다 — 세 줄짜리 목록 위의 검색창은 도움이 아니라 잡음이다. */
const PAGE_SIZE = 8

/** 확인 창에 늘어놓을 경로의 최대 줄 수. 스무 개를 고르고 확인 창을 열면 목록이 화면을 넘겨 버튼이
 *  밀려나므로, 넘는 만큼은 줄 수로만 알린다. */
const CONFIRM_LIST_MAX = 8

/** The History tab of the settings modal — the only place a hidden project comes back. Hiding happens
 *  from a project row's context menu in HistoryBrowser; the two screens share lib/hiddenProjects, so
 *  unhiding here makes the row reappear in the sidebar right away.
 *  Full paths rather than folder names: two projects can share a basename, and the store keeps no
 *  display name to go stale. */
export function HistorySettings(): React.JSX.Element {
  const { t } = useI18n()
  const [hidden, setHidden] = useState<string[]>(() => hiddenProjects.list())
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  // 고른 경로들. 페이지를 넘겨도 유지되지만 검색어가 바뀌면 비운다 — 화면에 없는 선택이 남아 있는
  // 것이 이 화면에서 가장 위험하다(지우는 버튼이 그 개수를 세므로).
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)

  useEffect(() => hiddenProjects.subscribe(() => setHidden(hiddenProjects.list())), [])

  // 검색·페이지 계산은 lib/hiddenProjectsView 가 갖는다. 범위를 벗어난 page 도 거기서 잡아 주므로
  // (마지막 페이지의 마지막 항목이 사라진 직후가 그렇다) 여기서 effect 로 되돌릴 것이 없다.
  const view = viewOf(hidden, query, page, PAGE_SIZE)
  const paged = view.total > PAGE_SIZE
  // 지울 대상. matchedAll 로 한 번 거르는 이유는 목록에서 사라진 항목(해제했거나 방금 지운 것)이
  // 선택에 남아 삭제 대상으로 따라 들어가지 않게 하기 위해서다.
  const chosen = view.matchedAll.filter((p) => picked.has(p))
  // 머리의 체크박스는 페이지가 아니라 목록 전체를 다룬다. 검색 중이라면 '전체'는 좁혀진 결과
  // 전체다 — 걸러 놓고 누른 것이 걸러지기 전까지 고른다면 좁힌 뜻이 없다.
  const allPicked = view.matchedAll.length > 0 && chosen.length === view.matchedAll.length

  const toggle = (p: string): void => {
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }

  /** 목록 전체(검색 중이면 좁혀진 결과 전체)를 켜고 끈다. 페이지에 보이지 않는 것까지 고르므로,
   *  그 총계는 삭제 버튼의 숫자와 확인 창의 목록으로 확인한다. */
  const toggleAll = (): void => {
    setPicked(allPicked ? new Set() : new Set(view.matchedAll))
  }

  const removeHistory = async (): Promise<void> => {
    const targets = chosen
    if (targets.length === 0) return
    const shown = targets.slice(0, CONFIRM_LIST_MAX).join('\n')
    const rest = targets.length - CONFIRM_LIST_MAX
    const ok = await confirmModal({
      title: t('settings.history.deleteTitle'),
      // 무엇이 지워지고 **무엇이 남는지**를 함께 적는다. 폴더가 지워진다고 오해하면 되돌릴 수 없다
      body: t('settings.history.deleteBody', {
        count: targets.length,
        list: rest > 0 ? `${shown}\n… +${rest}` : shown
      }),
      confirmLabel: t('settings.history.deleteConfirm')
    })
    if (!ok) return
    setDeleting(true)
    try {
      const r = await window.api.history.deleteProjects(targets)
      // 기록이 사라졌으면 숨겨 둘 이유도 없다 — 목록에서 함께 뺀다. 지우지 못한 것은 남긴다
      if (r.deleted.length > 0) {
        hiddenProjects.unhideMany(r.deleted)
        toast.success(t('settings.history.deleteDone', { count: r.deleted.length }))
      }
      setPicked(new Set())
      // 이유는 태그로 온다(SESSION:<제목> / RUN:<이름> / FAILED) — 문장은 여기서 만든다
      const busy = r.skipped.filter((s) => s.reason !== 'FAILED')
      const failed = r.skipped.filter((s) => s.reason === 'FAILED')
      if (busy.length > 0)
        toast.error(
          t('settings.history.deleteBusy', {
            count: busy.length,
            name: busy[0].reason.slice(busy[0].reason.indexOf(':') + 1)
          })
        )
      if (failed.length > 0)
        toast.error(t('settings.history.deleteFailed', { count: failed.length }))
    } catch {
      toast.error(t('settings.history.deleteFailed', { count: targets.length }))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="settings-history">
      <label className="settings-field-label">{t('settings.history.hiddenProjects')}</label>
      {paged && (
        <input
          type="text"
          className="settings-history-search"
          placeholder={t('settings.history.search')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setPage(0) // 좁힌 결과의 첫 페이지부터 보여준다 — 3페이지에 머물면 대개 빈 화면이 된다
            setPicked(new Set())
          }}
        />
      )}
      {view.matchedAll.length > 0 && (
        <div className="settings-history-bulk">
          <label className="settings-history-check">
            <input type="checkbox" checked={allPicked} onChange={toggleAll} />
            {t('settings.history.selectAll')}
          </label>
          <button
            type="button"
            className="danger"
            disabled={chosen.length === 0 || deleting}
            onClick={() => void removeHistory()}
          >
            {t('settings.history.deleteSelected', { count: chosen.length })}
          </button>
        </div>
      )}
      {view.total === 0 ? (
        <span className="settings-hint">{t('settings.history.empty')}</span>
      ) : view.matched === 0 ? (
        <span className="settings-hint">{t('settings.history.noMatch')}</span>
      ) : (
        view.rows.map((p) => (
          <div className="settings-row" key={p}>
            <input
              type="checkbox"
              aria-label={p}
              checked={picked.has(p)}
              onChange={() => toggle(p)}
            />
            <span className="hidden-project-path" title={p}>
              {p}
            </span>
            {/* 해제에 확인 모달을 두지 않는다 — 파괴적이지 않고, 되돌리려면 다시 숨기면 된다 */}
            <button onClick={() => hiddenProjects.unhide(p)}>{t('settings.history.unhide')}</button>
          </div>
        ))
      )}
      {paged && (
        <div className="settings-history-nav">
          {view.pages > 1 && (
            <>
              {/* 글리프뿐인 버튼이라 이름은 aria-label 로만 준다 */}
              <button
                type="button"
                aria-label={t('settings.history.prevPage')}
                disabled={view.page === 0}
                onClick={() => setPage(view.page - 1)}
              >
                ‹
              </button>
              <span className="settings-history-page">
                {view.page + 1} / {view.pages}
              </span>
              <button
                type="button"
                aria-label={t('settings.history.nextPage')}
                disabled={view.page >= view.pages - 1}
                onClick={() => setPage(view.page + 1)}
              >
                ›
              </button>
            </>
          )}
          <span className="settings-hint">
            {t('settings.history.total', { count: view.total })}
          </span>
        </div>
      )}
    </div>
  )
}
