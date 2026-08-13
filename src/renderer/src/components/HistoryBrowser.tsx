import { useEffect, useRef, useState } from 'react'
import type { Account, HistoryEntry, ProjectSummary, ScheduleConfig, TranscriptPreview } from '../../../core/types'
import { ResumeDialog } from './ResumeDialog'
import { AccountSelect } from './AccountSelect'
import { ProviderBadge } from './ProviderBadge'
import { isGhostAccountId } from '../../../core/accounts/ghostId'
import { confirmModal } from '../lib/confirm'
import { useI18n } from '../i18n/I18nProvider'
import { ContextMenu, type MenuItem } from './ContextMenu'
import * as hiddenProjects from '../lib/hiddenProjects'

const PAGE = 50
const SEEN_KEY = 'cm.historySeen'
const SEEN_PRUNE_LIMIT = 500

function loadSeenMap(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

/** One project row plus, when expanded, that project's session list (infinite scroll). Each row owns its own session paging state. */
function ProjectRow({
  project,
  expanded,
  onToggle,
  accountId,
  refreshNonce,
  scrollRootRef,
  accountOf,
  isSeen,
  markSeen,
  onOpenPreview,
  onResume,
  onContextMenu
}: {
  project: ProjectSummary
  expanded: boolean
  onToggle: (projectPath: string) => void
  accountId: string
  refreshNonce: number
  scrollRootRef: React.RefObject<HTMLUListElement | null>
  accountOf: (id: string) => Account | undefined
  isSeen: (e: HistoryEntry) => boolean
  markSeen: (e: HistoryEntry) => void
  onOpenPreview: (e: HistoryEntry) => void
  onResume: (e: HistoryEntry) => void
  onContextMenu: (x: number, y: number, projectPath: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [sessions, setSessions] = useState<HistoryEntry[]>([])
  const [total, setTotal] = useState(0)
  const reqToken = useRef(0)
  const fetchingRef = useRef(false)
  const sentinelRef = useRef<HTMLLIElement>(null)
  const sessionsLenRef = useRef(0)
  sessionsLenRef.current = sessions.length

  const loadMore = (): void => {
    if (fetchingRef.current || sessions.length >= total) return
    fetchingRef.current = true
    const token = reqToken.current
    void window.api.history
      .page({
        accountId: accountId || undefined,
        projectPath: project.projectPath,
        offset: sessions.length,
        limit: PAGE
      })
      .then((p) => {
        fetchingRef.current = false
        if (reqToken.current !== token) return // the window was swapped out in the meantime — ignore
        setSessions((prev) => {
          const seen = new Set(prev.map((e) => e.id))
          return [...prev, ...p.entries.filter((e) => !seen.has(e.id))]
        })
        setTotal(p.total)
      })
  }

  // On expand (and when the refresh nonce changes) re-query the first page at the current window size
  useEffect(() => {
    if (!expanded) return
    const token = ++reqToken.current
    void window.api.history
      .page({
        accountId: accountId || undefined,
        projectPath: project.projectPath,
        offset: 0,
        limit: Math.max(sessionsLenRef.current, PAGE)
      })
      .then((p) => {
        if (reqToken.current !== token) return
        setSessions(p.entries)
        setTotal(p.total)
      })
  }, [expanded, refreshNonce, accountId, project.projectPath])

  // Inner infinite scroll — the scroll root is the outer project list (.history-list)
  useEffect(() => {
    if (!expanded) return
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const io = new IntersectionObserver(
      (ents) => {
        if (ents.some((en) => en.isIntersecting)) loadMore()
      },
      { root: scrollRootRef.current, rootMargin: '120px' }
    )
    io.observe(sentinel)
    return () => io.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, sessions.length, total])

  return (
    <li className="project-group">
      <div
        className="project-row"
        title={`${project.projectPath} · ${new Date(project.updatedAt).toLocaleString()}`}
        onClick={() => onToggle(project.projectPath)}
        onContextMenu={(ev) => {
          ev.preventDefault() // Electron의 기본 메뉴를 막고 앱 메뉴를 띄운다
          onContextMenu(ev.clientX, ev.clientY, project.projectPath)
        }}
      >
        <span className="project-chevron">{expanded ? '▾' : '▸'}</span>
        <span className="project-name">{project.name}</span>
        <span className="project-meta">
          {new Date(project.updatedAt).toLocaleString([], {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
          })}
        </span>
      </div>
      {expanded && (
        <ul
          className="session-sublist"
          // Rail color = the account color of that project's most recent session (while loading, or unknown, the CSS default line color)
          style={{ borderLeftColor: accountOf(sessions[0]?.accountId ?? '')?.color }}
        >
          {sessions.map((e) => (
            <li
              key={e.id}
              className="session-row"
              title={`${e.title} · ${new Date(e.updatedAt).toLocaleString()}`}
              onClick={() => onResume(e)} // clicking the row resumes straight away (markSeen happens inside resume)
            >
              {/* A ghost gets a hollow dot: its colour is a single grey, so colour alone would not separate
                  it from a registered account that happens to be grey */}
              <span
                className={isGhostAccountId(e.accountId) ? 'color-dot ghost' : 'color-dot'}
                style={{ background: accountOf(e.accountId)?.color ?? '#888' }}
              />
              <ProviderBadge provider={accountOf(e.accountId)?.provider} />
              {e.awaitingReply && !isSeen(e) && <span className="unread-dot" />}
              <span className="entry-title">{e.title}</span>
              <span className="entry-sub">
                {new Date(e.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <button
                onClick={(ev) => {
                  ev.stopPropagation() // the button is preview — stops propagation to the row click (resume)
                  markSeen(e)
                  onOpenPreview(e)
                }}
              >
                {t('history.entry.preview')}
              </button>
            </li>
          ))}
          {sessions.length === 0 && <li className="empty">{t('history.project.noSessions')}</li>}
          {sessions.length < total && (
            <li ref={sentinelRef} className="history-sentinel">
              {t('history.loading')}
            </li>
          )}
        </ul>
      )}
    </li>
  )
}

export function HistoryBrowser({
  accounts,
  ghostAccounts,
  onResume
}: {
  accounts: Account[]
  /** Unregistered sources, for display only. Kept apart from `accounts` so nothing here can be picked as
   *  a spawn or rolling target; accountOf() looks through both so dots, badges and the filter keep working. */
  ghostAccounts: Account[]
  onResume: (
    entry: HistoryEntry,
    cwd: string,
    opts: {
      accountIds: string[]
      roll: boolean
      rollPrompt?: string
      slackNotify: boolean
      bypassPermissions: boolean
      schedule?: ScheduleConfig
    }
  ) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [total, setTotal] = useState(0)
  const [accountFilter, setAccountFilter] = useState<string>('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<TranscriptPreview | null>(null)
  const [resumingId, setResumingId] = useState<string | null>(null)
  // Account picker modal for resuming — opens after a row click has resolved the cwd
  const [pendingResume, setPendingResume] = useState<{ entry: HistoryEntry; cwd: string } | null>(null)
  const [seenMap, setSeenMap] = useState<Record<string, string>>(loadSeenMap)
  // Signal that makes the expanded projects re-pull their sessions on history:updated
  const [refreshNonce, setRefreshNonce] = useState(0)
  // 우클릭 메뉴는 한 번에 하나만 열려야 하므로 행이 아니라 여기에 둔다 (FileExplorer와 같은 구조)
  const [menu, setMenu] = useState<{ x: number; y: number; projectPath: string } | null>(null)
  const [hidden, setHidden] = useState<string[]>(() => hiddenProjects.list())
  const previewReq = useRef<string | null>(null)
  const sentinelRef = useRef<HTMLLIElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const reqToken = useRef(0)
  const fetchingRef = useRef(false)
  const projectsLenRef = useRef(0)
  projectsLenRef.current = projects.length
  const accountFilterRef = useRef('')
  accountFilterRef.current = accountFilter
  const hiddenRef = useRef<string[]>(hidden)
  hiddenRef.current = hidden

  const accountOf = (id: string): Account | undefined =>
    accounts.find((a) => a.id === id) ?? ghostAccounts.find((a) => a.id === id)
  const isSeen = (e: HistoryEntry): boolean => seenMap[e.id] === e.updatedAt

  const markSeen = (e: HistoryEntry): void => {
    setSeenMap((prev) => {
      const next: Record<string, string> = { ...prev, [e.id]: e.updatedAt }
      const keys = Object.keys(next)
      if (keys.length > SEEN_PRUNE_LIMIT) {
        // Only trim the excess — drop the keys added longest ago first (by insertion order)
        for (const k of keys.slice(0, keys.length - SEEN_PRUNE_LIMIT)) delete next[k]
      }
      localStorage.setItem(SEEN_KEY, JSON.stringify(next))
      return next
    })
  }

  const loadFirstProjects = (acc: string, limit: number = PAGE): void => {
    const token = ++reqToken.current
    void window.api.history
      .projectsPage({ accountId: acc || undefined, offset: 0, limit, hiddenPaths: hiddenRef.current })
      .then((p) => {
        if (reqToken.current !== token) return // ignore a late response
        setProjects(p.projects)
        setTotal(p.total)
      })
  }

  const loadMoreProjects = (): void => {
    if (fetchingRef.current || projects.length >= total) return
    fetchingRef.current = true
    const token = reqToken.current
    void window.api.history
      .projectsPage({
        accountId: accountFilterRef.current || undefined,
        offset: projects.length,
        limit: PAGE,
        hiddenPaths: hiddenRef.current
      })
      .then((p) => {
        fetchingRef.current = false
        if (reqToken.current !== token) return
        setProjects((prev) => {
          const seen = new Set(prev.map((x) => x.projectPath))
          return [...prev, ...p.projects.filter((x) => !seen.has(x.projectPath))]
        })
        setTotal(p.total)
      })
  }

  useEffect(() => {
    loadFirstProjects('')
    return window.api.on('history:updated', () => {
      // Re-query the project window at its current size, and bump the nonce so the expanded projects re-pull their sessions
      const token = ++reqToken.current
      void window.api.history
        .projectsPage({
          accountId: accountFilterRef.current || undefined,
          offset: 0,
          limit: Math.max(projectsLenRef.current, PAGE),
          hiddenPaths: hiddenRef.current
        })
        .then((p) => {
          if (reqToken.current !== token) return
          setProjects(p.projects)
          setTotal(p.total)
        })
      setRefreshNonce((n) => n + 1)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 숨기기(이 화면)와 해제(설정 모달) 양쪽에서 들어온다. offset을 유지한 부분 갱신이 아니라 첫
  // 페이지부터 다시 받는다 — 목록에서 항목이 빠지면 그 뒤 offset이 전부 밀려 중복이나 누락이 생긴다
  useEffect(
    () =>
      hiddenProjects.subscribe(() => {
        const next = hiddenProjects.list()
        setHidden(next)
        hiddenRef.current = next // setState는 아직 커밋되지 않았고 아래 호출이 ref를 읽는다
        // Unhiding a row should not resurrect it already expanded — that would fire ProjectRow's
        // fetch-on-expand effect for a project the user only asked to make visible again
        setExpanded((prev) => {
          const nextSet = new Set([...prev].filter((p) => !next.includes(p)))
          return nextSet.size === prev.size ? prev : nextSet
        })
        // PAGE가 아니라 현재 로드된 창 크기를 요청한다 — 마운트·계정 필터 변경과 달리 이 경로는
        // 이미 여러 페이지를 스크롤해서 본 목록 중간 한 줄만 빠지는 경우라, PAGE로 자르면
        // 방금 보고 있던 나머지 행들이 통째로 사라진다 (history:updated 핸들러와 같은 이유)
        loadFirstProjects(accountFilterRef.current, Math.max(projectsLenRef.current, PAGE))
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const io = new IntersectionObserver(
      (ents) => {
        if (ents.some((en) => en.isIntersecting)) loadMoreProjects()
      },
      { root: listRef.current, rootMargin: '120px' }
    )
    io.observe(sentinel)
    return () => io.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.length, total])

  const toggle = (projectPath: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(projectPath)) next.delete(projectPath)
      else next.add(projectPath)
      return next
    })
  }

  const closePreview = (): void => {
    previewReq.current = null
    setPreview(null)
  }

  const openPreview = (e: HistoryEntry): void => {
    previewReq.current = e.id
    void window.api.history.preview(e.id).then((p) => {
      if (previewReq.current === e.id) setPreview(p)
    })
  }

  const resume = async (entry: HistoryEntry): Promise<void> => {
    if (resumingId) return
    setResumingId(entry.id)
    markSeen(entry)
    try {
      let cwd = entry.projectPath
      if (!(await window.api.system.pathExists(cwd))) {
        // The cwd is gone → pick a new path. A confirmation modal breaks it up so the folder picker opens only after the explanation has been read
        const ok = await confirmModal({
          title: t('history.resume.folderMissingTitle'),
          body: t('history.resume.folderMissingBody', { cwd }),
          confirmLabel: t('history.resume.pickFolder')
        })
        if (!ok) return
        const picked = await window.api.system.pickFolder()
        if (!picked) return
        cwd = picked
      }
      setPendingResume({ entry, cwd }) // opens the account picker modal — onResume is called once it is confirmed
    } finally {
      setResumingId(null)
    }
  }

  const menuItemsFor = (projectPath: string): MenuItem[] => [
    { label: t('history.menu.hide'), onSelect: () => hiddenProjects.hide(projectPath) }
  ]

  return (
    <section className="history-panel">
      <header className="panel-header">
        <h2>{t('history.panel.title')}</h2>
        <div className="panel-actions">
          <AccountSelect
            className="history-account-filter"
            // Ghosts are filterable too — their sessions are in the list, so the filter has to be able to
            // reach them. suffixOf marks them instead of rewriting the label.
            accounts={[...accounts, ...ghostAccounts]}
            suffixOf={(a) => (isGhostAccountId(a.id) ? t('history.filter.deletedSuffix') : '')}
            value={accountFilter}
            allLabel={t('history.filter.allAccounts')}
            onChange={(v) => {
              setAccountFilter(v)
              setExpanded(new Set()) // reset the expansion when the filter changes
              loadFirstProjects(v)
            }}
          />
          <button title={t('history.refresh.tooltip')} onClick={() => void window.api.history.refresh()}>
            ⟳
          </button>
        </div>
      </header>
      <ul className="history-list" ref={listRef}>
        {projects.map((p) => (
          <ProjectRow
            key={p.projectPath}
            project={p}
            expanded={expanded.has(p.projectPath)}
            onToggle={toggle}
            accountId={accountFilter}
            refreshNonce={refreshNonce}
            scrollRootRef={listRef}
            accountOf={accountOf}
            isSeen={isSeen}
            markSeen={markSeen}
            onOpenPreview={openPreview}
            onResume={(e) => void resume(e)}
            onContextMenu={(x, y, projectPath) => setMenu({ x, y, projectPath })}
          />
        ))}
        {projects.length === 0 && <li className="empty">{t('history.panel.empty')}</li>}
        {projects.length < total && (
          <li ref={sentinelRef} className="history-sentinel">
            {t('history.loading')}
          </li>
        )}
      </ul>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItemsFor(menu.projectPath)}
          onClose={() => setMenu(null)}
        />
      )}
      {preview && (
        <div className="modal-backdrop" onClick={closePreview}>
          <div className="modal preview" onClick={(e) => e.stopPropagation()}>
            <h2>
              {t('history.entry.preview')} {preview.truncated && t('history.preview.truncated')}
            </h2>
            <div className="preview-scroll">
              {preview.messages.map((m, i) => (
                <p key={i} className={`msg ${m.role}`}>
                  <b>{m.role === 'user' ? t('history.preview.me') : 'Claude'}</b> {m.text}
                </p>
              ))}
            </div>
            <div className="row right">
              <button onClick={closePreview}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}
      {pendingResume && (
        <ResumeDialog
          entry={pendingResume.entry}
          cwd={pendingResume.cwd}
          accounts={accounts}
          ghostAccounts={ghostAccounts}
          onConfirm={(opts) => {
            onResume(pendingResume.entry, pendingResume.cwd, opts)
            setPendingResume(null)
          }}
          onCancel={() => setPendingResume(null)}
        />
      )}
    </section>
  )
}
