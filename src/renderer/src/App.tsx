import { useEffect, useRef, useState } from 'react'
import type { Account, CliStatus, HistoryEntry, RollStateEvent, SchedStateEvent, ScheduleConfig, SessionInfo, SessionUsage, UpdateStatus, UpdateCampaignInfo } from '../../core/types'
import type { Lang, MessageKey } from '../../core/i18n'
import { CATALOGS, LANGS } from '../../core/i18n'
import logoUrl from './assets/logo.png'
import { AccountPanel } from './components/AccountPanel'
import { AccountSettings } from './components/AccountSettings'
import { HistorySettings } from './components/HistorySettings'
import { HistoryBrowser } from './components/HistoryBrowser'
import { Select } from './components/Select'
import { type FileTab } from './components/WorkbenchTabs'
import { FileEditor } from './components/FileEditor'
import { MarkdownSplit } from './components/MarkdownSplit'
import { invalidateImageCache } from './components/MarkdownPreview'
import type { EditorState, StateEffect } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { EditorStateCache } from './lib/editorStateCache'
import { FileExplorer, type ExplorerTreeState } from './components/FileExplorer'
import { JobsView } from './components/JobsView'
import { RunDetail } from './components/RunDetail'
import { NewRunModal } from './components/NewRunModal'
import { NewSessionDialog } from './components/NewSessionDialog'
import { WorktreePanel } from './components/WorktreePanel'
import { RunToolbar } from './components/RunToolbar'
import { RunConfigManager } from './components/RunConfigManager'
import { BottomPanel } from './components/BottomPanel'
import { ToastHost } from './components/ToastHost'
import { UpdateGate } from './components/UpdateGate'
import { ShortcutSettings } from './components/ShortcutSettings'
import { TerminalFontSettings } from './components/TerminalFontSettings'
import { ConfirmHost } from './components/ConfirmHost'
import type {
  OrchSnapshot,
  RunConfig,
  RunContext,
  // 컴포넌트 이름과 겹친다 — 이 창이 그리는 값의 타입이고, 그리는 것은 위의 RunDetail 이다
  RunDetail as RunDetailData,
  RunStatus,
  TerminalBuffer
} from '../../core/types'
import { slackMode } from '../../core/slack/ready'
import { findActionForEvent, formatChord, resolveBindings, type Bindings } from '../../core/keys/binding'
import { ACTIONS } from './lib/actions'
import {
  MIN_CHECKING_MS,
  formatCheckedAt,
  isCheckResult,
  shouldNotifyDownloaded,
  showChecking
} from '../../core/update/checkFeedback'
import { applyEol, classifyExternalChange, detectEol, toLf, type Eol } from '../../core/files/edit'
import { isSubPath, rebasePath } from '../../core/files/ops'
import { parentDir } from '../../core/files/paths'
import { cycleViewMode, isMdViewMode, type MdViewMode } from '../../core/files/markdownView'
import type { UndoEntry } from '../../core/files/undo'
import * as sessionBus from './lib/sessionBus'
import * as sticky from './lib/stickyProject'
import { toast } from './lib/toast'
import { confirmModal, isConfirmOpen } from './lib/confirm'
import { worktreeErrorMessage } from './lib/worktreeErrors'
import { notifyCreated as notifyWorktreeCreated } from './lib/worktreeBus'
import { useI18n } from './i18n/I18nProvider'
import {
  MAX_PANES,
  activateTab,
  addTab,
  countLeaves,
  createGroup,
  findNeighbor,
  firstLeaf,
  groupOfTab,
  leafOf,
  leaves,
  moveTab,
  removeTab,
  replaceTabId,
  setRatio,
  splitAndMove,
  unsplit,
  type DropZone,
  type MoveDir,
  type PaneDir,
  type PaneNode
} from '../../core/panes/tree'
import { fileTab, parseTab, sessionTab } from '../../core/panes/tabId'
import { placeTab } from '../../core/panes/place'
import { PaneGrid } from './components/PaneGrid'
import { ContextMenu, type MenuItem } from './components/ContextMenu'

sessionBus.init()

// The shortcut list for the settings modal. When a binding changes (the TerminalView key handler or
// the global listener in App), update this list along with it.
// group and desc are kept as MessageKeys and translated with t() at render time (the shortcuts tab of
// the settings modal) — this array is a module-level constant, so t() cannot be called here.
// keys are literal keyboard combinations (e.g. 'Ctrl+C') and are not translated. Two entries are mouse
// gestures rather than key combinations, though, and leaving them as-is would strand text in the
// wrong language — those two clear keys and render a translated label from gestureKey (a MessageKey)
// inside the <kbd> instead.
// Most of the Ctrl-labelled entries below are actually platform-dependent: terminal copy/paste,
// explorer save/select-all/cut/copy/paste/undo are all Cmd on macOS (see MOD below), so they are
// built with MOD rather than a literal 'Ctrl'. The one deliberate exception is 'Ctrl+Enter' (terminal
// newline) — TerminalView.tsx leaves that one alone on both platforms because Claude Code reads
// Ctrl+Enter as a newline regardless of OS. F2 and Delete are also unchanged across platforms.
const MOD = window.api.platform === 'darwin' ? 'Cmd' : 'Ctrl'
const SHORTCUTS: Array<{
  group: MessageKey
  items: Array<{ keys: string[]; desc: MessageKey; gestureKey?: MessageKey }>
}> = [
  {
    group: 'shortcut.group.terminal',
    items: [
      { keys: ['Ctrl+Enter'], desc: 'shortcut.terminal.newline' },
      { keys: [`${MOD}+C`], desc: 'shortcut.terminal.copyOrInterrupt' },
      { keys: [`${MOD}+V`], desc: 'shortcut.paste' }
    ]
  },
  {
    group: 'shortcut.group.sessionTab',
    items: [
      { keys: [], gestureKey: 'shortcut.gesture.tabDrag', desc: 'shortcut.sessionTab.reorder' }
    ]
  },
  {
    group: 'shortcut.group.pane',
    items: [
      { keys: [], gestureKey: 'shortcut.gesture.tabDrag', desc: 'shortcut.pane.dragSplit' }
    ]
  },
  {
    group: 'shortcut.group.explorer',
    items: [
      { keys: [`${MOD}+S`], desc: 'shortcut.explorer.saveFile' },
      { keys: ['F2'], desc: 'shortcut.explorer.rename' },
      { keys: ['Delete'], desc: 'shortcut.explorer.delete' },
      { keys: [`${MOD}+A`], desc: 'shortcut.explorer.selectAll' },
      { keys: [`${MOD}+X`], desc: 'shortcut.explorer.cut' },
      { keys: [`${MOD}+C`], desc: 'shortcut.explorer.copy' },
      { keys: [`${MOD}+V`], desc: 'shortcut.paste' },
      { keys: [], gestureKey: 'shortcut.gesture.itemDrag', desc: 'shortcut.explorer.move' },
      { keys: [`${MOD}+Z`], desc: 'shortcut.explorer.undo' }
    ]
  }
]

function UpdateIndicator({ update }: { update: UpdateStatus | null }): React.JSX.Element | null {
  const { t } = useI18n()
  if (!update || update.state === 'init' || update.state === 'uptodate') return null
  if (update.state === 'downloaded')
    return (
      <button className="tb-update-btn" onClick={() => void window.api.update.install()}>
        {t('update.tb.restartInstallVersion', { version: update.version ?? '' })}
      </button>
    )
  const text =
    update.state === 'checking'
      ? t('update.tb.checking')
      : update.state === 'available'
        ? t('update.tb.available', { version: update.version ?? '' })
        : update.state === 'downloading'
          ? t('update.tb.downloading', { percent: update.percent ?? 0 })
          : t('update.tb.error')
  return (
    <span
      className={update.state === 'error' ? 'tb-update tb-update-err' : 'tb-update'}
      title={update.message}
    >
      {text}
    </span>
  )
}

function Titlebar({
  isMax,
  update,
  runningCount,
  runSlot
}: {
  isMax: boolean
  update: UpdateStatus | null
  /** Only the close button reads it, and only on Linux — see closeWindow below */
  runningCount: number
  /** 타이틀바 줄에 함께 놓이는 것 — 지금은 실행 구성 툴바다. 프롭 열넷을 내려보내는 대신 슬롯으로
   *  받아, 타이틀바는 무엇이 들어오는지 모른 채 자리만 내준다 */
  runSlot?: React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  // On macOS, window controls are handled by the OS traffic-light buttons. Drawing our own controls
  // too would put the same functionality at both ends of the window. .titlebar--mac reserves the
  // left-hand margin the traffic lights sit in.
  const isMac = window.api.platform === 'darwin'
  /** On Linux the X really quits the app (there is no tray to hide in — main/index.ts win.on('close')),
   *  and will-quit kills every running session. That is the same outcome the update install asks about,
   *  so it asks the same way. On win32/macOS the window only hides, so nothing is asked. */
  const closeWindow = async (): Promise<void> => {
    if (window.api.platform === 'linux' && runningCount > 0) {
      const ok = await confirmModal({
        title: t('common.quitConfirm.title'),
        body: t('common.quitConfirm.body', { count: runningCount }),
        confirmLabel: t('common.close')
      })
      if (!ok) return
    }
    window.api.win.close()
  }
  return (
    <div
      className={isMac ? 'titlebar titlebar--mac' : 'titlebar'}
      onDoubleClick={() => window.api.win.maximizeToggle()}
    >
      <div className="tb-brand" aria-hidden="true">
        <img className="tb-logo" src={logoUrl} alt="" />
        <span className="tb-name">Astera</span>
      </div>
      {runSlot}
      <UpdateIndicator update={update} />
      {!isMac && (
        <div className="tb-controls" onDoubleClick={(e) => e.stopPropagation()}>
          <button
            className="tb-btn"
            aria-label={t('common.minimize')}
            title={t('common.minimize')}
            onClick={() => window.api.win.minimize()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <line x1="1" y1="5" x2="9" y2="5" />
            </svg>
          </button>
          <button
            className="tb-btn"
            aria-label={isMax ? t('common.restore') : t('common.maximize')}
            title={isMax ? t('common.restore') : t('common.maximize')}
            onClick={() => window.api.win.maximizeToggle()}
          >
            {isMax ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                <rect x="1" y="2.5" width="6" height="6" />
                <rect x="2.5" y="1" width="6" height="6" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                <rect x="1" y="1" width="8" height="8" />
              </svg>
            )}
          </button>
          <button
            className="tb-btn close"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={() => void closeWindow()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <line x1="1" y1="1" x2="9" y2="9" />
              <line x1="9" y1="1" x2="1" y2="9" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}

/** Time left until the reset, as a relative countdown: '47m', '3h 54m', '2d 3h', '5d'.
 *  (Minutes round up; null once it has passed.) */
function formatResetHud(resetsAt: string | null | undefined): string | null {
  if (!resetsAt) return null
  const t = new Date(resetsAt).getTime()
  if (Number.isNaN(t)) return null
  const ms = t - Date.now()
  if (ms <= 0) return null
  const diffMins = Math.ceil(ms / 60_000)
  if (diffMins < 60) return `${diffMins}m`
  const hours = Math.floor(diffMins / 60)
  const mins = diffMins % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remHours = hours % 24
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

/** The status bar usage chip — a mini progress bar plus n%. Colours: green below 70, yellow 70–84,
 *  red at 85 and above. With no value, an empty bar and '–'. Given resetsAt, a dim '(resets in N)'
 *  sits next to it. */
function UsageChip({
  label,
  percent,
  resetsAt,
  title
}: {
  label: string
  percent?: number
  resetsAt?: string | null
  title?: string
}): React.JSX.Element {
  const has = typeof percent === 'number'
  const pct = has ? Math.max(0, Math.min(100, percent as number)) : 0
  const level = !has ? 'na' : pct >= 85 ? 'crit' : pct >= 70 ? 'warn' : 'ok'
  const reset = has ? formatResetHud(resetsAt) : null
  return (
    <span className="status-metric" title={title}>
      <span className="metric-label">{label}</span>
      <span className="usage-bar" aria-hidden="true">
        <span className={`usage-bar-fill ${level}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="metric-pct">{has ? `${percent}%` : '–'}</span>
      {reset && <span className="metric-reset">({reset})</span>}
    </span>
  )
}

/** The value the "System" row carries. Empty string, because Select keys rows by string and null is
 *  not one — it is mapped back to null on the way out. Same convention as TerminalFontSettings. */
const SYSTEM_LANG = ''

export default function App(): React.JSX.Element {
  const { t, lang, storedLang, systemLang, setLang } = useI18n()
  const [accounts, setAccounts] = useState<Account[]>([])
  // Unregistered config dirs, account-shaped, for history display only. Deliberately a separate state
  // from `accounts`: mixed in, NewSessionDialog would offer them as spawn targets and AccountPanel /
  // AccountSettings would present them as manageable, and every one of those actions fails on a source
  // that cannot authenticate. Only HistoryBrowser and ResumeDialog receive them.
  const [ghostAccounts, setGhostAccounts] = useState<Account[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  // The pane layout tree. It replaces the old single split-slot state — up to 4 panes.
  const [layout, setLayout] = useState<PaneNode | null>(null)
  const [activePaneId, setActivePaneId] = useState<string | null>(null)
  // The session whose tab is being dragged (for PaneGrid's drop preview)
  const [dragTabId, setDragTabId] = useState<string | null>(null)
  // Position of the tab context menu
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  // 지금 보고 있는 탭은 트리가 정한다 — 활성 페인의 활성 탭. 두 종류가 한 트리에 있으므로 별도의
  // activeTabId 상태를 두면 트리와 어긋난다(다른 페인의 탭을 클릭하거나 페인 포커스를 옮기는 순간
  // 갈라진다). 파일 탭 id는 전부터 `file:<path>` 형식이었으므로 파일 관련 코드는 그대로 쓴다
  const activeTabId = (layout && activePaneId ? leafOf(layout, activePaneId)?.activeTabId : null) ?? null
  const activeTab = activeTabId ? parseTab(activeTabId) : null
  /** 활성 탭이 파일일 때만 그 id */
  const activeFileId = activeTab?.kind === 'file' ? activeTabId : null
  const activeSessionId = activeTab?.kind === 'session' ? activeTab.id : null
  // 활성 탭이 파일일 수 있게 되면서 "지금 보고 있는 것"과 "작업 중인 세션"이 갈라졌다. 세션에 딸린
  // 표시(상태 바, 사용량 폴링)는 마지막으로 활성이었던 세션 탭을 따른다 — 파일을 읽는 동안 상태 바가
  // 비고 컨텍스트·한도 칩이 사라지지 않게. 파일 트리 루트는 여기서 나오지 않고 활성 탭에서 나온다.
  // 렌더 중 갱신은 이 파일의 다른 ref들과 같은 관례이고, 세션이 사라졌는지는 아래 `active`의
  // sessions 조회가 판정하므로 여기서 따로 청소하지 않는다.
  const lastSessionIdRef = useRef<string | null>(null)
  if (activeSessionId) lastSessionIdRef.current = activeSessionId
  const [showNew, setShowNew] = useState(false)
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null) // prefill for WorktreePanel's 'start session'
  const [cli, setCli] = useState<{ claude: CliStatus; codex: CliStatus } | null>(null)
  const [appVersion, setAppVersion] = useState('')
  // The moment the check finished has to be held alongside the state so the "checked at 17:43" line
  // can carry it. Events that are not results (checking, downloading) have no time.
  const [update, setUpdate] = useState<(UpdateStatus & { checkedAt: number | null }) | null>(null)
  const [checkClickedAt, setCheckClickedAt] = useState<number | null>(null)
  // The version a toast already announced. Re-checking reuses the cache and delivers downloaded again, so each version is announced once.
  const notifiedUpdateRef = useRef<string | null>(null)
  // The update campaign. A value is present only when this app is in the target range. It is a ref
  // because the onStatus subscription — registered once at mount — has to see the latest campaign (a
  // plain state would leave the closure stale).
  const [campaign, setCampaign] = useState<UpdateCampaignInfo | null>(null)
  const campaignRef = useRef<UpdateCampaignInfo | null>(null)
  // Keybindings. The global key handler is registered once at mount so it reads through a ref, and it
  // is also held as state so the settings screen can draw the list.
  const [keyOverrides, setKeyOverrides] = useState<Record<string, string[]>>({})
  const bindingsRef = useRef<Bindings>(resolveBindings({}, ACTIONS))
  bindingsRef.current = resolveBindings(keyOverrides, ACTIONS)
  /** 레일의 탐색기 버튼 툴팁. 사용자가 키를 바꿨으면 바꾼 키가 나와야 하므로 기본값이 아니라 해석된
   *  바인딩에서 읽는다. 그 액션의 키를 모두 지운 사용자에게는 이름만 남는다 */
  const explorerChord = bindingsRef.current['explorer.toggleMode']?.[0]
  const explorerShortcutLabel = explorerChord
    ? `${t('explorer.rail.toggle')} (${formatChord(explorerChord)})`
    : t('explorer.rail.toggle')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [explorerOpen, setExplorerOpen] = useState(false)
  // 키 핸들러는 []로 한 번만 등록되어 첫 렌더의 클로저를 붙잡는다. toggleExplorer 가 렌더 값을 읽으면
  // 단축키가 늘 같은 방향으로만 계산되므로, 최신 값을 이 ref 로 읽는다(이 파일의 다른 ref 들과 같은 이유)
  const explorerOpenRef = useRef(explorerOpen)
  explorerOpenRef.current = explorerOpen // the file explorer toggle
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<
    'general' | 'accounts' | 'info' | 'shortcuts' | 'slack' | 'worktree' | 'history'
  >('info') // the settings sidebar, with general and accounts added
  const [slackUrl, setSlackUrl] = useState('') // the Slack Webhook URL in the settings modal
  const [slackSaved, setSlackSaved] = useState(false)
  // Bot configuration. appToken is for Socket Mode receiving only, so for now it is merely stored
  const [slackBotToken, setSlackBotToken] = useState('')
  const [slackChannelId, setSlackChannelId] = useState('')
  const [slackAppToken, setSlackAppToken] = useState('')
  // The one Slack Member ID allowed to reply into sessions. Left empty, every reply is blocked
  const [slackMemberId, setSlackMemberId] = useState('')
  // Saving is blocked until getConfig has returned — the save button sends all five fields
  // explicitly, so pressing it while they are still empty strings would overwrite an already-stored
  // token, channel, and webhook with null in one go. (When there was a single field, patch()
  // preserving undefined protected the rest; that is no longer the case.)
  const [slackLoaded, setSlackLoaded] = useState(false)
  const [wtRoot, setWtRoot] = useState('') // the worktree root in the settings modal
  const [orchEnabled, setOrchEnabled] = useState(false) // the agent orchestration toggle
  // Whether the Jobs sidebar view is showing — same convention as explorerOpen (toggleJobs mirrors
  // toggleExplorer below), just for the read-only orchestration view instead of the file tree.
  const [jobsOpen, setJobsOpen] = useState(false)
  const [isMax, setIsMax] = useState(false)
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const [rollStates, setRollStates] = useState<Record<string, RollStateEvent>>({})
  const [schedStates, setSchedStates] = useState<Record<string, SchedStateEvent>>({}) // the schedule banner
  const [busy, setBusy] = useState<Record<string, boolean>>({}) // whether each session is working — the tab spinner
  const [fileTabs, setFileTabs] = useState<FileTab[]>([]) // file viewer tabs
  interface FileBuffer {
    /** 항상 LF다. CodeMirror가 문서를 LF로 정규화하므로 버퍼도 같은 모양이어야 에디터 상태와 비교되고
     *  재사용된다. 디스크의 줄바꿈은 eol에 따로 들고 있다가 쓸 때 되돌린다 */
    content: string
    savedContent: string
    /** 이 파일이 디스크에서 쓰는 줄바꿈. 저장할 때 되돌려 주지 않으면 CRLF 파일이 첫 저장에 LF로 바뀌고
     *  git에는 전 줄이 변경으로 잡힌다 */
    eol: Eol
    readOnly: boolean
    loading: boolean
    error: string | null
    conflict: boolean
  }
  const [fileBuffers, setFileBuffers] = useState<Record<string, FileBuffer>>({}) // file buffers — editing, saving, external changes
  /** 파일 탭별 마크다운 뷰 모드. fileTabs·fileBuffers 와 같은 자리에 두는 이유는 탭이 닫힐 때
   *  함께 지워져야 하기 때문이다. 마지막으로 고른 모드는 localStorage 에 남아 새로 여는 .md 탭의
   *  기본값이 된다 — cm.sidebarWidth 와 같은 관례다 */
  const [mdModes, setMdModes] = useState<Record<string, MdViewMode>>({})
  const mdModesRef = useRef(mdModes)
  mdModesRef.current = mdModes
  /** 페인별 EditorView — 파일 탭별이 아니다. FileEditor 는 페인 하나당 하나이고 그 페인 안에서
   *  파일이 바뀌어도(같은 마크다운 파일 사이든, 마크다운·비-마크다운 사이든) 재사용되며, onViewChange
   *  는 그 인스턴스의 마운트·언마운트에서만 불린다 — 파일 탭 id 로 저장했다면 한 페인에서 두 번째로
   *  여는 마크다운 파일은 영원히 null 을 받았을 것이다(뷰는 그대로인데 map 의 키만 새 파일 것이길
   *  기다리므로). 뷰가 생기는 시점은 FileEditor 의 마운트라 ref 로는 렌더가 다시 돌지 않는다 —
   *  그래서 상태다. */
  const [mdViews, setMdViews] = useState<Record<string, EditorView | null>>({})
  // 죽은 페인의 항목을 지운다 — PaneGrid 의 lastFileOfPane 이 자기 것을 정리하는 것과 같은 이유
  // (그 파일의 주석 참고)다. FileEditor 의 언마운트가 이미 onViewChange(null) 을 부르므로 이 정리가
  // 없어도 죽은 참조가 남지는 않지만(destroy() 된 EditorView 를 계속 붙잡지는 않는다), 다시 쓰이지
  // 않을 페인 id 키가 사라진 페인마다 하나씩 map 에 영원히 쌓이는 것은 그것과는 별개의 문제라 이
  // effect 로 정리한다.
  useEffect(() => {
    const livePanes = new Set(layout ? leaves(layout).map((l) => l.id) : [])
    setMdViews((prev) => {
      let changed = false
      const next: Record<string, EditorView | null> = {}
      for (const [paneId, view] of Object.entries(prev)) {
        if (livePanes.has(paneId)) next[paneId] = view
        else changed = true
      }
      return changed ? next : prev
    })
  }, [layout])
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    // 500 rather than the original 280. Account rows carry a provider badge, the label, the `default`
    // badge and a login dot, and the history and worktree panels below them hold paths, so the default
    // opens wide enough to read all three without dragging. It sits just under the 520 clamp — the user
    // can only narrow it from here, which is the cheap direction.
    // Only applies with no stored width; a width the user dragged is theirs and is never overridden.
    const v = Number(localStorage.getItem('cm.sidebarWidth'))
    return v >= 160 && v <= 520 ? v : 500
  })
  const sidebarRef = useRef<HTMLElement>(null)

  // A reference to the latest value for keyboard tab switching — the global listener registers once and reads without going stale
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const activeFileIdRef = useRef(activeFileId)
  activeFileIdRef.current = activeFileId
  const MD_MODE_KEY = 'cm.md.viewMode'
  const defaultMdMode = (): MdViewMode => {
    const stored = localStorage.getItem(MD_MODE_KEY)
    return isMdViewMode(stored) ? stored : 'split'
  }
  const setMdMode = (tabId: string, mode: MdViewMode): void => {
    localStorage.setItem(MD_MODE_KEY, mode)
    setMdModes((prev) => ({ ...prev, [tabId]: mode }))
  }
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const activePaneIdRef = useRef(activePaneId)
  activePaneIdRef.current = activePaneId
  const modalOpenRef = useRef(false)
  modalOpenRef.current = showNew || showSettings
  const fileTabsRef = useRef(fileTabs)
  fileTabsRef.current = fileTabs
  // 탭 순환이 쓰는 것 — 클릭과 같은 경로를 타야 종류에 상관없이 같은 일이 일어난다
  const selectWorkbenchTabRef = useRef<(tabId: string) => void>(() => {})
  const fileBuffersRef = useRef(fileBuffers) // keeps the external-change handler from going stale
  fileBuffersRef.current = fileBuffers
  // 파일별 에디터 상태 캐시. FileEditor보다 오래 살아야 하므로 여기서 소유한다 (editorStateCache.ts의 주석)
  const editorCacheRef = useRef(new EditorStateCache())
  // onKey is registered once at mount, so values and callbacks recreated on every render are read through refs
  const tRef = useRef(t)
  tRef.current = t
  const cliRef = useRef(cli)
  cliRef.current = cli
  // The install button on the toast is pressed later — it has to see the real number of running sessions at that moment
  const runningCountRef = useRef(0)

  /** Installs the update right away. The app quits immediately, so it asks first when sessions are still running. */
  const installUpdate = async (): Promise<void> => {
    const running = runningCountRef.current
    if (running > 0) {
      const ok = await confirmModal({
        title: tRef.current('update.confirm.title'),
        body: tRef.current('update.confirm.body', { count: running }),
        confirmLabel: tRef.current('update.toast.installNow')
      })
      if (!ok) return
    }
    await window.api.update.install()
  }
  // When Ctrl+\ had no spare session and opened the new-session dialog instead, the split goes in this
  // direction once creation succeeds. Cancelling the dialog discards it, so no empty pane is left.
  const pendingSplitRef = useRef<PaneDir | null>(null)
  // Per-root tree snapshots. Toggling the explorer unmounts FileExplorer, and the tree root is about to
  // follow the active tab, so it will change far more often than it does today — a map keyed by root
  // means each project's expansion comes back with it instead of collapsing on every switch.
  const explorerTreesRef = useRef<Map<string, ExplorerTreeState>>(new Map())
  // The clipboard exists precisely to cross project boundaries, so it is not kept inside the per-root
  // map above — it is its own ref so pasting across projects keeps working.
  const explorerClipboardRef = useRef<ExplorerTreeState['clipboard']>(null)
  // The Ctrl+Z undo journal. It is deliberately not inside ExplorerTreeState — that holds a per-root
  // tree snapshot and is rightly cleared on every root change (the [root] effect in FileExplorer),
  // whereas the journal's lifetime differs (it has to survive an explorer toggle, and is cleared
  // separately on a full close — see closeExplorer below).
  const explorerUndoRef = useRef<UndoEntry[]>([])

  // showSession(sessionId)은 사라졌다 — 탭을 화면에 올리는 경로가 종류를 가리지 않는 selectWorkbenchTab
  // 하나로 합쳐졌고, 그것이 유일한 호출자였다. 세션이 없는 상태에서 새로 만드는 경로는 place()가 맡는다.

  useEffect(() => {
    void window.api.accounts.list().then(setAccounts)
    void window.api.accounts.ghosts().then(setGhostAccounts)
    void window.api.system.checkCli().then(setCli)
    void window.api.system.appVersion().then(setAppVersion)
    // The rail draws the Jobs button only while this is on, so it has to be read at startup. Reading it
    // only when the settings modal opens (the showSettings effect below) meant the button was missing
    // from a cold start until someone opened settings once — not late, absent.
    void window.api.settings.getOrchestrationEnabled().then(setOrchEnabled)
    // Re-adopts sessions that are still running after a renderer reload as tabs (scrollback is lost, by design)
    void window.api.sessions.list().then((list) => {
      setSessions(list)
      if (list.length === 0) return
      // Every session belongs to exactly one group (invariant 1) — all re-adopted sessions go into the
      // first group, and a running session (or the first one, if none) becomes the active tab
      const g = createGroup(sessionTab(list[0].id))
      let root: PaneNode = g
      for (const s of list.slice(1)) root = addTab(root, g.id, sessionTab(s.id))
      const wanted = (list.find((s) => s.status === 'running') ?? list[0]).id
      const act = activateTab(root, sessionTab(wanted))
      if (!act) return
      setLayout(act.root)
      setActivePaneId(act.paneId)
    })
    const offAccounts = window.api.on('accounts:changed', (p) => setAccounts(p.accounts))
    const offGhosts = window.api.on('accounts:ghostsChanged', (p) => setGhostAccounts(p.accounts))
    const offExit = window.api.on('session:exit', ({ sessionId, exitCode }) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, status: 'exited', exitCode } : s))
      )
    })
    // Receives sessions main created on its own (orchestration workers) as tabs. The user path builds a
    // tab from the return value of sessions.spawn, but the coordinator path creates the session inside
    // main so that return value never reaches here — this event is the only channel.
    // Placement uses the same place() as spawn but with background=true: placeTab drops it in as a
    // new tab of the active group (intoGroupBackground in core/panes/place.ts) without making it the
    // active tab.
    const offCreated = window.api.on('session:created', (info) => {
      // A session we already know about does nothing — right after a reload, the sessions.list()
      // re-adoption above can overlap with this event. **This is not the guard that prevents a
      // duplicate tab**: intoGroupBackground in place.ts filters on its first line with groupOfTab
      // and makes the second placement a no-op. What this guard buys is not triggering the setSessions
      // and setLayout re-render that comes along with that no-op.
      if (sessionsRef.current.some((s) => s.id === info.id)) return
      setSessions((prev) => (prev.some((s) => s.id === info.id) ? prev : [...prev, info]))
      // background=true: the tab appears but takes neither the active tab nor focus. If a worker
      // appeared while the user was typing into their own session, the keys after that would go into
      // the worker's PTY (a permission prompt in the worker's TUI would consume them as its answer).
      // So orchestration terminals open as inactive background tabs.
      place(layoutRef.current, info.id, null, null, true)
    })
    // The campaign verdict comes after the policy lookup — it can arrive later or earlier than the mount, so both paths are taken
    const offCampaign = window.api.update.onCampaign((c) => {
      campaignRef.current = c
      setCampaign(c)
    })
    // In dev the updater block is not wired, so this channel has no handler — the rejection is swallowed (there is no campaign either).
    void window.api.update
      .campaignState()
      .then((c) => {
        if (!c) return
        campaignRef.current = c
        setCampaign(c)
      })
      .catch(() => {})
    const offUpdate = window.api.update.onStatus((s) => {
      setUpdate({ ...s, checkedAt: isCheckResult(s.state) ? Date.now() : null })
      // There are two notification points:
      //  - available: only when this app is a campaign target, "a new version is out + [Download]".
      //    With no campaign, the title bar indicator saying so is enough
      //  - downloaded: the install prompt appears regardless of campaigns
      const campaign = campaignRef.current
      if (s.state === 'available' && campaign?.mode === 'notify') {
        if (!shouldNotifyDownloaded(s.version, notifiedUpdateRef.current)) return
        notifiedUpdateRef.current = s.version ?? null
        toast.info(tRef.current('update.toast.available', { version: s.version ?? '' }), {
          action: {
            label: tRef.current('update.toast.download'),
            onClick: () => void window.api.update.download()
          },
          onDismiss: () => void window.api.update.dismissCampaign(campaign.id)
        })
        return
      }
      if (s.state !== 'downloaded') return
      // In block mode the gate already shows the same install button — a toast would only hide behind the gate.
      if (campaign?.mode === 'block') return
      toast.info(tRef.current('update.toast.ready', { version: s.version ?? '' }), {
        action: {
          label: tRef.current('update.toast.installNow'),
          onClick: () => void installUpdate()
        }
      })
    })
    return () => {
      offAccounts()
      offGhosts()
      offExit()
      offCreated()
      offUpdate()
      offCampaign()
    }
  }, [])

  // Redraws once the minimum display window ends — before that, 'Checking…' stays even if a response has arrived.
  useEffect(() => {
    if (checkClickedAt === null) return
    const id = window.setTimeout(() => setCheckClickedAt(null), MIN_CHECKING_MS)
    return () => window.clearTimeout(id)
  }, [checkClickedAt])

  useEffect(() => {
    // Loads the user's overridden shortcuts. It still works on the default bindings if this fails.
    void window.api.keys
      .get()
      .then(setKeyOverrides)
      .catch(() => {})
    void window.api.win.isMaximized().then(setIsMax)
    const off = window.api.win.onMaximizeChange(setIsMax)
    return () => off()
  }, [])

  // Blocks external (OS) drag and drop — when a file is dropped on the window, Chromium navigates to
  // that file and the app screen is gone (only a restart brings it back). Why it is registered in the
  // capture phase: React 19 attaches listeners to the #root container, and
  // SyntheticEvent.stopPropagation() also calls nativeEvent.stopPropagation(), cutting native
  // propagation at #root (so it never reaches body, document, or window). The explorer tree's
  // dropHandlers call stopPropagation unconditionally on the first line of onDragOver
  // (FileExplorer.tsx) — meaning it is not that the app's own DnD handlers "dodge" this guard, but
  // that a bubble-phase guard could never fire above them at all. Capture runs before #root, so no
  // React handler can hide this guard.
  // Why the no-drop cursor and internal drops still work: preventDefault on dragover in the capture
  // phase only makes that dragover cancellable; the tree's onDragOver, running afterwards, overwrites
  // dropEffect with the final value ('none' for an invalid or external drag, 'copy'/'move' for a valid
  // internal one), and that is what decides the actual drag operation. With dropEffect='none' the
  // no-drop cursor appears and the drop is suppressed; with 'copy'/'move' the tree's onDrop fires
  // normally — both independent of the capture-phase preventDefault.
  // Drag and drop between the OS and the app is a non-goal.
  useEffect(() => {
    const block = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', block, true)
    window.addEventListener('drop', block, true)
    return () => {
      window.removeEventListener('dragover', block, true)
      window.removeEventListener('drop', block, true)
    }
  }, [])

  useEffect(() => {
    if (!showSettings) return
    setSlackSaved(false)
    setSlackLoaded(false)
    void window.api.slack.getConfig().then((c) => {
      setSlackUrl(c.webhookUrl ?? '')
      setSlackBotToken(c.botToken ?? '')
      setSlackChannelId(c.channelId ?? '')
      setSlackAppToken(c.appToken ?? '')
      setSlackMemberId(c.memberId ?? '')
      setSlackLoaded(true)
    })
    void window.api.worktrees.getRoot().then(setWtRoot)
    // Re-syncs the orchestration toggle whenever the modal opens. The initial value comes from the mount
    // effect above (the rail needs it before anyone opens this modal); this is what keeps the checkbox
    // honest if the stored value ever diverges from what the renderer is holding.
    void window.api.settings.getOrchestrationEnabled().then(setOrchEnabled)
  }, [showSettings])

  // Keyboard session tab switching: a global capture listener, so it works regardless of where focus
  // is. Being in the capture phase, it catches keys before xterm and blocks the residual sequence with
  // preventDefault plus stopPropagation. Ctrl+PageUp/Down cycles tabs within the active group, while
  // Ctrl+Shift+arrow moves focus to a neighbouring group. Both wrap around.
  // Switching only changes activeSessionId (or activeFileId); focusing the newly active terminal is
  // done by TerminalView's active effect.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // The bindings come from the registry. Keys the user changed in settings arrive here too, so no
      // key is hardcoded in a condition. Matching is on e.code, so it is unaffected by IME state or Shift.
      const action = findActionForEvent(bindingsRef.current, e, ACTIONS)
      if (!action) return
      if (modalOpenRef.current || isConfirmOpen()) return
      const focusEl = document.activeElement as HTMLElement | null
      const inXterm = !!focusEl?.closest('.xterm')
      const editable =
        !!focusEl &&
        (focusEl.tagName === 'INPUT' ||
          focusEl.tagName === 'TEXTAREA' ||
          focusEl.tagName === 'SELECT' ||
          focusEl.isContentEditable)
      // Each action has its own rule about yielding to the terminal — the registry holds it (so it follows a rebind)
      if (inXterm && ACTIONS.find((a) => a.id === action)?.yieldsToTerminal) return

      // Toggling explorer mode. The exceptions are xterm and CodeMirror. Both are text areas the app
      // owns and neither has this feature inside it, so the mode toggle wins. CM6 sets
      // contenteditable=true on .cm-content for an editable file, so without this exception the toggle
      // would be blocked entirely while the editor has focus.
      if (action === 'explorer.toggleMode') {
        if (editable && !focusEl?.closest('.xterm, .cm-editor')) return
        e.preventDefault()
        e.stopPropagation()
        if (e.repeat) return
        toggleExplorer()
        return
      }
      // Closing a file tab, same as closing a browser tab. When dirty, closeFileTab raises a
      // confirmation modal. The only condition is that the active tab is a file — a file tab lives in a
      // pane now, so whether the explorer sidebar is showing says nothing about it. It is still not
      // intercepted while xterm has focus — in a terminal, Ctrl+W deletes the previous word, which is
      // needed while typing to Claude (see yieldsToTerminal above).
      // closeFileTab is recreated on every render, but its body is all refs and setters, so it works
      // against the latest state even when stale (the same convention as toggleExplorer above).
      if (action === 'explorer.closeFileTab') {
        const id = activeFileIdRef.current
        if (!id) return // no file tab is open — unlike a browser, this does not close the window
        e.preventDefault()
        e.stopPropagation()
        if (e.repeat) return // stops tabs closing in a chain while the key is held
        void closeFileTab(id)
        return
      }
      // 마크다운 프리뷰 모드 순환. 활성 탭이 .md 일 때만 의미가 있다. 툴바 버튼은 모드를 직접
      // 지정하고 이 키만 순환한다 — 두 진입점의 역할이 다르다.
      // CM6 안에서도 동작해야 한다(explorer.toggleMode 와 같은 예외): 편집하다가 결과를 보려고
      // 누르는 키인데 에디터에 포커스가 있을 때 막히면 쓸 수 없다
      if (action === 'explorer.cyclePreview') {
        const id = activeFileIdRef.current
        if (!id) return
        const tab = fileTabsRef.current.find((tb) => tb.id === id)
        if (!tab || !isMarkdownPath(tab.path)) return
        e.preventDefault()
        e.stopPropagation()
        if (e.repeat) return
        const cur = mdModesRef.current[id] ?? defaultMdMode()
        setMdMode(id, cycleViewMode(cur))
        return
      }
      // Pane splitting — by default Ctrl+\ to the right, Ctrl+Shift+\ below. The same place VS Code
      // puts them. Neither the Claude Code nor the Codex TUI uses Ctrl+\, so terminal input is unaffected.
      if (action === 'pane.splitRight' || action === 'pane.splitDown') {
        e.preventDefault()
        e.stopPropagation()
        if (e.repeat) return
        const cur = layoutRef.current
        const dir: PaneDir = action === 'pane.splitDown' ? 'col' : 'row'
        if (cur && countLeaves(cur) >= MAX_PANES) {
          toast.info(tRef.current('session.pane.maxReached'))
          return
        }
        // With 2 or more tabs in the active group, the active tab moves into a new group — whichever
        // kind it is. A file on one side and a session on the other is the arrangement this keyboard
        // path exists for, so the tab id goes to the tree unread.
        const target =
          cur && ((activePaneIdRef.current && leafOf(cur, activePaneIdRef.current)) || firstLeaf(cur))
        if (target && target.tabIds.length >= 2) {
          splitActiveRef.current(dir, false, target.activeTabId)
          return
        }
        // With only one tab, splitting would change nothing, so a new session is created first —
        // cancelling leaves the layout untouched. pendingSplitRef is set only when the dialog actually
        // opens: if it does not, no cleanup path runs, the value lingers, and some later unrelated
        // session picks it up and splits unexpectedly.
        if (cliRef.current?.claude.ok === true || cliRef.current?.codex.ok === true) {
          pendingSplitRef.current = dir
          setShowNew(true)
        }
        return
      }
      // The remaining actions are tab cycling (sessionTab.*) and moving focus to a neighbouring pane (pane.focus*).
      const focusMove = action.startsWith('pane.focus')
      const delta = action === 'sessionTab.prev' || action === 'pane.focusLeft' || action === 'pane.focusUp' ? -1 : 1
      const vertical = action === 'pane.focusUp' || action === 'pane.focusDown'
      // Ignored while a normal input field — not a terminal — has focus (preserves its own Ctrl+Shift+arrow selection).
      // Tab cycling is the exception inside our own editor: the tab bar is reachable from the terminal
      // but would otherwise be unreachable from the editor, which is where you sit while reading a file.
      // The exception is scoped to .cm-editor rather than to every input, so a rebind onto an arrow chord
      // still leaves a settings field's own selection alone. Same shape as explorer.toggleMode's exception.
      const tabCycle = action === 'sessionTab.prev' || action === 'sessionTab.next'
      if (editable && !inXterm && !(tabCycle && focusEl?.closest('.cm-editor'))) return
      // With Shift, move focus to a neighbouring group; otherwise cycle tabs within the
      // active group. Global session cycling is gone: sessions are scattered across groups, so there is
      // no such thing as a "global order". To reach a session in another group, move groups with
      // Ctrl+Shift+arrow and pick the tab with Ctrl+PageUp/Down (the same division of labour as
      // IntelliJ's Goto Next Splitter plus Select Next Tab).
      const cur = layoutRef.current
      const curPane = activePaneIdRef.current
      if (focusMove && cur && curPane && countLeaves(cur) >= 2) {
        const dir: MoveDir = vertical ? (delta < 0 ? 'up' : 'down') : delta < 0 ? 'left' : 'right'
        const next = findNeighbor(cur, curPane, dir)
        // With no neighbour, do nothing and let it flow through to the terminal — putting
        // preventDefault before the next check would swallow a key like Ctrl+Shift+↓ with no neighbour
        // before it ever reached the terminal
        if (!next) return
        e.preventDefault()
        e.stopPropagation()
        if (e.repeat) return
        setActivePaneId(next)
        return
      }
      if (vertical) return // unsplit, there is no cycling up or down
      // Unsplit, there is only one group, so this effectively cycles every session — the same as it always felt
      const group = cur && ((curPane && leafOf(cur, curPane)) || firstLeaf(cur))
      if (!group || group.tabIds.length < 2) return
      const i = group.tabIds.indexOf(group.activeTabId)
      if (i < 0) return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      const n = group.tabIds.length
      // 종류를 가리지 않고 그 페인의 탭 줄에 그려진 순서대로 돈다 — 파일 탭과 세션 탭 사이에 경계가
      // 없다. 클릭과 같은 경로(selectWorkbenchTab)를 타야 세션 탭을 지날 때 활성 세션도 함께 맞춰진다
      selectWorkbenchTabRef.current(group.tabIds[(i + delta + n) % n])
    }
    window.addEventListener('keydown', onKey, true) // capture
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    // Rolling: swap the session in place in the same tab, plus the progress banner state
    const offRolled = window.api.on('session:rolled', ({ oldSessionId, info }) => {
      sessionBus.discard(oldSessionId)
      setSessions((prev) => prev.map((s) => (s.id === oldSessionId ? info : s)))
      // Swaps only the id while keeping the tab's position, order, and active state — the same function as a restart
      setLayout((cur) =>
        cur ? replaceTabId(cur, sessionTab(oldSessionId), sessionTab(info.id)) : cur
      )
      setRollStates((prev) => {
        const { [oldSessionId]: _dropped, ...rest } = prev
        return rest
      })
      // The new session after a roll is judged afresh from its own OSC — the old id's busy state is discarded
      setBusy((prev) => {
        const { [oldSessionId]: _dropped, ...rest } = prev
        return rest
      })
    })
    const offBusy = window.api.on('session:busy', ({ sessionId, busy: b }) =>
      setBusy((prev) => (prev[sessionId] === b ? prev : { ...prev, [sessionId]: b }))
    )
    const offRollState = window.api.on('session:rollState', (ev) => {
      // A failed auto-resume is announced with a toast. Why not a banner: a banner only disappears once
      // 'none' arrives, and nothing publishes that after stalled, so it would stay forever. And a
      // rolling session with Slack turned off has no record in SlackNotifier (see register in
      // slack.ts), so this is the only path that reaches a person — hook injection was widened to those
      // sessions but the notification was missing.
      // The error kind does not auto-dismiss — missing it leaves a session sitting stopped.
      if (ev.state === 'stalled') {
        // This listener registers once (deps []), so reading sessions directly would capture the empty
        // array from mount time and always stamp a UUID into the title — the latest value comes from a ref
        const title = sessionsRef.current.find((s) => s.id === ev.sessionId)?.title ?? ev.sessionId
        toast.error(t('session.toast.stalled', { title }))
        return // a momentary event, so it is not kept as banner state
      }
      setRollStates((prev) => {
        if (ev.state === 'none') {
          const { [ev.sessionId]: _dropped, ...rest } = prev
          return rest
        }
        return { ...prev, [ev.sessionId]: ev }
      })
    })
    const offSchedState = window.api.on('session:schedState', (ev) => {
      setSchedStates((prev) => {
        if (ev.state === 'off') {
          const { [ev.sessionId]: _dropped, ...rest } = prev
          return rest
        }
        return { ...prev, [ev.sessionId]: ev }
      })
    })
    return () => {
      offRolled()
      offBusy()
      offRollState()
      offSchedState()
    }
  }, [])

  // When a shell dies on its own (the user typed exit) its tab is removed — a dead shell tab is noise.
  // If it was the active tab, we go back to Run (the panel itself stays).
  useEffect(() => {
    const off = window.api.on('terminal:exit', ({ id }) => {
      setTerminals((prev) => prev.filter((x) => x.id !== id))
      setBottomTab((cur) => (cur === id ? 'run' : cur))
    })
    return off
  }, [])

  /** Places a new session. Which group it goes into is decided by placeTab, a pure function in core
   *  (covering four cases: a restart swap, a reserved split, an already-open session, and the active
   *  group), and all this does is move that result into state.
   *  A null paneId leaves the active pane alone — a restart merely inherits the tab's position.
   *  StrictMode can invoke an updater twice, so nothing is computed inside the setLayout callback. */
  const place = (cur: PaneNode | null, sessionId: string, splitDir?: PaneDir | null,
    replaces?: string | null, background?: boolean): void => {
    const res = placeTab(cur, sessionTab(sessionId), {
      activePaneId: activePaneIdRef.current,
      splitDir,
      // 트리에 담기는 값이 탭 id이므로 교체 대상도 같은 형식으로 감싼다 — 날 세션 id를 넘기면
      // 트리에서 찾지 못해 조용히 일반 배치로 떨어지고, 탭이 자기 자리를 잃는다
      replaces: replaces ? sessionTab(replaces) : replaces,
      background
    })
    setLayout(res.root)
    if (res.paneId) setActivePaneId(res.paneId)
    // Only reported when a split was requested but hit the cap and landed in the active group — the
    // case where the target group's only tab makes splitting a no-op is not a failure, so it stays quiet
    if (res.splitFellBack && cur && countLeaves(cur) >= MAX_PANES)
      toast.info(t('session.pane.maxReached'))
  }

  const spawn = async (opts: {
    accountIds: string[]
    cwd: string
    saveDefault: boolean
    resumeSessionId?: string
    resumeTranscriptPath?: string
    roll?: boolean
    rollPrompt?: string
    slackNotify?: boolean
    bypassPermissions?: boolean
    useWorktree?: boolean
    worktreeName?: string
    worktreeBaseRef?: string
    repoRoot?: string | null
    schedule?: ScheduleConfig
    /** The old session id, for when an existing tab's session id has to be swapped, as on a restart */
    replacesSessionId?: string
  }): Promise<void> => {
    // Once creation succeeds, the worktree is not rolled back even if a later step fails (the registry
    // is persistent by design) — kept outside the try so the catch can tell the user it is still there
    let createdWorktreeName: string | null = null
    try {
      let cwd = opts.cwd
      // Splitting off into a worktree: on a creation failure the session is not started
      if (opts.useWorktree && opts.repoRoot) {
        const created = await window.api.worktrees.create({
          repoPath: opts.repoRoot,
          name: opts.worktreeName,
          baseRef: opts.worktreeBaseRef
        })
        createdWorktreeName = created.info.name
        created.warnings.forEach((w) => toast.info(t(w.key, w.params)))
        cwd = created.info.path
        notifyWorktreeCreated() // WorktreePanel in the sidebar is subscribed — tell it now instead of waiting for the next expand or refresh
      }
      // Rolling is on when the roll flag is set (the modal always sets it for multiple accounts; for a
      // single one it is the checkbox). When on, every selected account is passed as rollAccountIds —
      // a single one (auto-resume) is [that account], multiple are [a,b,c].
      // A user-specified resume prompt (rollPrompt) travels with it — empty means main uses the default.
      const rolling = opts.roll === true
      const info = await window.api.sessions.spawn({
        accountId: opts.accountIds[0],
        cwd,
        resumeSessionId: opts.resumeSessionId,
        resumeTranscriptPath: opts.resumeTranscriptPath, // the transcript copy source when resuming under a different account
        rollAccountIds: rolling ? opts.accountIds : undefined,
        rollPrompt: rolling ? opts.rollPrompt : undefined,
        slackNotify: opts.slackNotify, // Slack progress notifications
        bypassPermissions: opts.bypassPermissions, // start without permission prompts
        schedule: opts.schedule
      })
      // The default account mapping is keyed on the original repo — a worktree path is new every time and mappings must not pile up
      if (opts.saveDefault)
        await window.api.projects.setDefaultAccount(opts.repoRoot ?? opts.cwd, opts.accountIds[0])
      // When the rolling resume guard hits, main returns the existing live session → focus it without
      // adding a tab. The verdict is made outside the setSessions callback, through sessionsRef: a state
      // updater has to be pure, and StrictMode may run it twice, so raising a toast inside risks firing
      // twice.
      const guardHit = Boolean(opts.resumeSessionId) && sessionsRef.current.some((s) => s.id === info.id)
      setSessions((prev) => (prev.some((s) => s.id === info.id) ? prev : [...prev, info]))
      if (guardHit) toast.info(t('session.spawn.resumeLiveIgnored')) // tells the user the resume modal's options were quietly discarded
      const cur = layoutRef.current
      const pending = pendingSplitRef.current
      pendingSplitRef.current = null
      place(cur, info.id, pending, opts.replacesSessionId)
      setShowNew(false)
      setNewSessionCwd(null)
    } catch (err) {
      // If session creation fails while a split is pending, only the dialog closes and the layout stays
      // as it was — no empty pane is left behind
      pendingSplitRef.current = null
      // When a restart has already removed the old session from sessions and the spawn then fails, a
      // dead id would be left in the tree alone. If a group empties, removeTab promotes its sibling
      // (invariant 2) — the cleanup that took 25 lines in the old model is now one.
      const gone = opts.replacesSessionId
      if (gone) {
        const cur = layoutRef.current
        if (cur && !sessionsRef.current.some((s) => s.id === gone)) {
          const next = removeTab(cur, sessionTab(gone))
          if (next) {
            const p = activePaneIdRef.current
            setActivePaneId(p && leafOf(next, p) ? p : firstLeaf(next).id)
            setLayout(next)
          } else {
            setActivePaneId(null)
            setLayout(null)
          }
        }
      }
      const msg = worktreeErrorMessage(err instanceof Error ? err.message : String(err))
      const message = t(msg.key, msg.params)
      // On a failure after the worktree was created, the user is also told that it remains, unrolled-back
      toast.error(
        createdWorktreeName
          ? t('session.spawn.failedWorktreeKept', { message, name: createdWorktreeName })
          : t('session.spawn.failed', { message })
      )
    }
  }

  // Opening a file tab: clicking the same path again focuses the existing tab (VS Code's behaviour).
  // The buffer starts as loading and gets filled by files.read.
  const openFile = (path: string): void => {
    const id = fileTab(path)
    if (fileTabsRef.current.some((t) => t.id === id)) {
      selectWorkbenchTabRef.current(id)
      return
    }
    const root = currentProjectRef.current
    if (!root) return // 트리가 없는 상태에서는 파일을 열 수 없다 — 열 수단 자체가 트리다
    const title = path.split(/[\\/]/).pop() || path
    setFileTabs((prev) => [...prev, { id, path, title, projectRoot: root }])
    // 파일 탭도 세션 탭과 같은 트리에 들어간다 — 활성 페인의 새 탭으로 열린다. 세션을 놓을 때와 같은
    // 함수를 쓰므로 배치 규칙이 한 벌뿐이다. StrictMode 대비로 setLayout 콜백 밖에서 계산한다
    const placed = placeTab(layoutRef.current, id, { activePaneId: activePaneIdRef.current })
    setLayout(placed.root)
    if (placed.paneId) setActivePaneId(placed.paneId)
    setFileBuffers((prev) => ({ ...prev, [id]: { content: '', savedContent: '', eol: '\n', readOnly: false, loading: true, error: null, conflict: false } }))
    // mdModes 를 여기서 바로 채운다 — fileBuffers 와 같은 자리(탭이 생기는 시점). 그렇지 않으면
    // 이 탭의 모드는 사용자가 그 탭에서 직접 모드를 바꾸기 전까지 mdModes 에 아예 없고, 렌더가
    // `mdModes[f.id] ?? defaultMdMode()` 로 매번 localStorage 를 다시 읽어 "마지막으로 고른 모드"를
    // 대신 쓴다 — 그러면 다른 탭에서 모드를 바꾸는 순간 이 탭도 함께 바뀐 것처럼 보인다(탭별이어야
    // 할 모드가 사실상 전역이 된다). 여기서 한 번 못박아 두면 `??` 는 이 탭이 실제로 아직 없을 때만
    // 쓰이는 안전망으로 되돌아간다.
    if (isMarkdownPath(path)) setMdModes((prev) => ({ ...prev, [id]: defaultMdMode() }))
    window.api.files.read(path).then(
      (d) => setFileBuffers((prev) => (prev[id] ? { ...prev, [id]: { content: toLf(d.content), savedContent: toLf(d.content), eol: detectEol(d.content), readOnly: d.truncated || d.binary, loading: false, error: d.binary ? t('files.editor.binaryUnsupported') : null, conflict: false } } : prev)),
      (err) => setFileBuffers((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], loading: false, error: err instanceof Error ? err.message : String(err) } } : prev))
    )
  }

  /** 에디터가 사라질 때 그 상태를 캐시에 넘겨받는다. 세션 모드로 나가면 .run-host가 통째로
   *  언마운트되므로, 이 경로가 없으면 되돌리기 이력이 거기서 끊긴다(세션 탭은 숨기기만 해서 안 끊긴다).
   *
   *  탭이 아직 열려 있을 때만 보관한다. 탭을 닫는 경로는 이미 cache.drop을 했고 그 뒤에 언마운트가
   *  오므로, 무조건 저장하면 방금 버린 항목이 되살아난다. closeExplorer도 같은 이유로 이 가드에
   *  걸린다 — 거기서는 clear() 뒤에 언마운트가 오고, 그때 fileTabs는 이미 비어 있다. */
  const retireEditorState = (
    path: string,
    state: EditorState,
    scroll: StateEffect<unknown> | null
  ): void => {
    if (!fileTabsRef.current.some((t) => t.path === path)) return
    editorCacheRef.current.save(path, state, scroll)
  }

  const setBufferContent = (id: string, content: string): void => {
    setFileBuffers((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], content } } : prev))
  }

  const saveFile = (id: string): void => {
    const buf = fileBuffersRef.current[id]
    const tab = fileTabsRef.current.find((t) => t.id === id)
    if (!buf || !tab || buf.readOnly || buf.content === buf.savedContent) return
    // 디스크에는 그 파일 본래의 줄바꿈으로 되돌려 쓴다. savedContent는 LF 그대로 둔다 — 버퍼끼리의
    // 비교(더티 판정)는 전부 LF 기준이고, 디스크와의 비교는 읽어 올 때 toLf를 거친다
    window.api.files.write(tab.path, applyEol(buf.content, buf.eol)).then(
      () => setFileBuffers((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], savedContent: buf.content, conflict: false } } : prev)),
      (err) => toast.error(t('files.save.failed', { detail: err instanceof Error ? err.message : String(err) }))
    )
  }

  const reloadBufferFromDisk = (id: string): void => {
    const tab = fileTabsRef.current.find((t) => t.id === id)
    if (!tab) return
    window.api.files.read(tab.path).then(
      (d) =>
        setFileBuffers((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], content: toLf(d.content), savedContent: toLf(d.content), eol: detectEol(d.content), readOnly: d.truncated || d.binary, conflict: false, error: d.binary ? t('files.editor.binaryUnsupported') : null } } : prev)),
      (err) => toast.error(t('files.reload.failed', { detail: err instanceof Error ? err.message : String(err) }))
    )
  }

  const closeFileTab = async (id: string): Promise<void> => {
    // Decided outside the updater — avoids StrictMode double-invocation side effects (the existing convention)
    const buf = fileBuffersRef.current[id]
    if (buf && !buf.readOnly && buf.content !== buf.savedContent) {
      const title = fileTabsRef.current.find((t) => t.id === id)?.title
      const ok = await confirmModal({
        title: t('files.unsaved.title'),
        body: title ? t('files.unsaved.bodyWithTitle', { title }) : t('files.unsaved.body'),
        confirmLabel: t('common.close')
      })
      if (!ok) return
    }
    // An await boundary was crossed, so state is read from the ref again
    const closedTab = fileTabsRef.current.find((t) => t.id === id)
    const next = fileTabsRef.current.filter((t) => t.id !== id)
    if (closedTab) editorCacheRef.current.drop(closedTab.path)
    // Mirrored immediately, before the render — when clean tabs close in a chain (a folder deletion),
    // await only yields a microtask and the React commit (render) does not fit in between, so this
    // stops the ref being read stale on the next iteration
    fileTabsRef.current = next
    setFileTabs(next)
    setFileBuffers((prev) => {
      const { [id]: _drop, ...rest } = prev
      return rest
    })
    setMdModes((prev) => {
      const { [id]: _drop, ...rest } = prev
      return rest
    })
    // 트리에서도 뺀다. 다음에 무엇이 활성이 되는지는 removeTab이 정한다(세션 탭을 닫을 때와 같은 규칙),
    // 그러면 activeFileId는 파생값이므로 저절로 따라온다. 여기서 ref를 직접 맞춰 두는 것은 연쇄로 닫힐
    // 때(폴더 삭제) 다음 반복이 렌더 전의 낡은 값을 읽지 않게 하기 위해서다 — closeFileTab 위쪽의
    // fileTabsRef 미러링과 같은 이유다
    if (activeFileIdRef.current === id) activeFileIdRef.current = null
    const cur = layoutRef.current
    if (cur && groupOfTab(cur, id)) {
      const nextLayout = removeTab(cur, id)
      layoutRef.current = nextLayout
      const p = activePaneIdRef.current
      const nextPane = nextLayout ? (p && leafOf(nextLayout, p) ? p : firstLeaf(nextLayout).id) : null
      activePaneIdRef.current = nextPane
      setActivePaneId(nextPane)
      setLayout(nextLayout)
    }
  }

  /** 탭 줄에서 탭을 골랐다. 종류에 상관없이 트리에서 그 탭을 활성으로 만들고 그 페인에 포커스를 준다 —
   *  다른 페인의 탭을 눌렀을 때 그 페인으로 옮겨 가는 것도 이 한 줄이 한다 */
  const selectWorkbenchTab = (tabId: string): void => {
    const cur = layoutRef.current
    if (!cur) return
    const act = activateTab(cur, tabId)
    if (!act) return
    setLayout(act.root)
    setActivePaneId(act.paneId)
  }
  // 탭 순환 단축키가 클릭과 같은 경로를 타도록 — 이 함수는 매 렌더 새로 만들어지지만 본문이 setter와
  // ref뿐이라 최신 상태에 대해 동작한다(toggleExplorer와 같은 관례)
  selectWorkbenchTabRef.current = selectWorkbenchTab

  /** 파일 탭은 기존 경로(더티면 확인 모달), 세션 탭은 세션 모드의 탭 닫기와 같은 경로로 종료한다 */
  const closeWorkbenchTab = (tabId: string): void => {
    const ref = parseTab(tabId)
    if (!ref) return
    if (ref.kind === 'file') {
      void closeFileTab(tabId)
      return
    }
    closeSession(ref.id)
  }

  // Adjusting open tabs after a file operation. A watcher event does not say 'what became what', so the
  // renderer adjusts them itself right after the operation succeeds. A tab id is literally
  // `file:${path}`, so the buffer map's key moves with it.
  const handlePathRenamed = (from: string, to: string): void => {
    const affected = fileTabsRef.current.filter((t) => isSubPath(from, t.path))
    if (affected.length === 0) return
    const remap = new Map(affected.map((t) => [t.id, `file:${rebasePath(t.path, from, to)}`]))
    setFileTabs((prev) =>
      prev.map((t) => {
        const nid = remap.get(t.id)
        if (!nid) return t
        const npath = nid.slice('file:'.length)
        return { id: nid, path: npath, title: npath.split(/[\\/]/).pop() || npath, projectRoot: t.projectRoot }
      })
    )
    setFileBuffers((prev) => {
      const next: typeof prev = {}
      for (const [k, v] of Object.entries(prev)) next[remap.get(k) ?? k] = v
      return next
    })
    // mdModes도 같은 모양으로 옮긴다 — 옮기지 않으면 이 탭의 모드가 사라져(openFile이 세운 "모든
    // 마크다운 탭은 mdModes 항목을 가진다"는 불변식이 깨짐) 다음 렌더가 `?? defaultMdMode()`로
    // 떨어지고, 방금까지 split/editor였던 탭이 이름만 바뀌었을 뿐인데 모드가 리셋된 것처럼 보인다
    setMdModes((prev) => {
      const next: typeof prev = {}
      for (const [k, v] of Object.entries(prev)) next[remap.get(k) ?? k] = v
      return next
    })
    // 트리에도 같은 id가 들어 있으므로 함께 갈아끼운다 — 위치·순서·활성 여부가 그대로 유지된다
    // (계정 롤링이 세션 id를 바꿀 때 쓰는 것과 같은 함수). 세션 탭은 remap에 없으므로 건드려지지 않는다
    setLayout((cur) => {
      if (!cur) return cur
      let next = cur
      for (const [from, to] of remap) if (groupOfTab(next, from)) next = replaceTabId(next, from, to)
      return next
    })
  }

  const handlePathDeleted = (deleted: string[]): void => {
    // Closes that tab and anything below it. Dirty tabs are confirmed individually by closeFileTab — if
    // the user chooses to keep one, that tab stays along with a 'this file was deleted' banner (from the
    // watcher's unlink). Why they are awaited sequentially: confirmModal returns false immediately when
    // a modal is already open, so calling them in parallel would close the second and later dirty tabs
    // without asking.
    const affected = fileTabsRef.current.filter((t) =>
      deleted.some((d) => isSubPath(d, t.path))
    )
    if (affected.length === 0) return
    void (async () => {
      for (const t of affected) await closeFileTab(t.id)
    })()
  }

  // Subscribing to external changes: only change/add on the paths of open buffers are handled.
  // classifyExternalChange separates our own save (ignore), unmodified (reload), and mid-edit (a
  // conflict banner).
  // The same event also invalidates MarkdownPreview's local-image cache — unconditionally, ahead of the
  // open-buffer check below, since a referenced image is almost never itself an open file tab. A miss is
  // cheap (invalidateImageCache's own comment), so nothing here needs to guess whether c.path is actually
  // an image before calling it.
  useEffect(() => {
    const off = window.api.on('files:changed', (c) => {
      if (c.kind === 'add' || c.kind === 'change' || c.kind === 'unlink') invalidateImageCache(c.path)
      const id = `file:${c.path}`
      const buf = fileBuffersRef.current[id]
      if (!buf) return
      if (c.kind === 'unlink') {
        setFileBuffers((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], error: t('files.editor.deletedExternally') } } : prev))
        return
      }
      if (c.kind !== 'change' && c.kind !== 'add') return
      void window.api.files.read(c.path).then(
        (d) => {
          const b = fileBuffersRef.current[id]
          if (!b) return
          const verdict = classifyExternalChange(toLf(d.content), b.savedContent, b.content !== b.savedContent && !b.readOnly)
          if (verdict === 'ignore') {
            // Clears a lingering 'deleted' notice when the file was deleted and recreated (disk === savedContent)
            if (b.error) setFileBuffers((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], error: null } } : prev))
            return
          }
          if (verdict === 'reload')
            setFileBuffers((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], content: toLf(d.content), savedContent: toLf(d.content), eol: detectEol(d.content), readOnly: d.truncated || d.binary, conflict: false, error: d.binary ? t('files.editor.binaryUnsupported') : null } } : prev))
          else setFileBuffers((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], conflict: true, error: null } } : prev))
        },
        () => {
          // A failed re-read (permissions, a race) is quietly ignored — the next event retries
        }
      )
    })
    return off
  }, [])

  // Fully closing the explorer — the header ✕. Returns to session mode, clearing file tabs and the pin
  const closeExplorer = async (): Promise<void> => {
    // The header ✕ means a full close. With dirty tabs, confirm once and then clear the file tabs and buffers too
    const hasDirty = fileTabsRef.current.some((t) => {
      const b = fileBuffersRef.current[t.id]
      return b && !b.readOnly && b.content !== b.savedContent
    })
    if (
      hasDirty &&
      !(await confirmModal({
        title: t('files.unsaved.title'),
        body: t('explorer.closeConfirm.body'),
        confirmLabel: t('common.close')
      }))
    )
      return
    setExplorerOpen(false)
    // 트리에 들어 있는 파일 탭도 함께 뺀다 — 남겨 두면 파일이 없는데 탭만 남는다. 하나씩 빼는 것은
    // removeTab이 빈 그룹 정리와 다음 활성 탭 선택까지 맡고 있기 때문이다
    let nextLayout = layoutRef.current
    for (const tab of fileTabsRef.current)
      if (nextLayout && groupOfTab(nextLayout, tab.id)) nextLayout = removeTab(nextLayout, tab.id)
    layoutRef.current = nextLayout
    const p = activePaneIdRef.current
    const nextPane = nextLayout ? (p && leafOf(nextLayout, p) ? p : firstLeaf(nextLayout).id) : null
    activePaneIdRef.current = nextPane
    setActivePaneId(nextPane)
    setLayout(nextLayout)
    fileTabsRef.current = []
    setFileTabs([])
    setFileBuffers({})
    setMdModes({})
    explorerTreesRef.current.clear()
    explorerClipboardRef.current = null
    // This is the point where the explorer is abandoned entirely, so the undo journal and the per-file
    // EditorState cache are cleared as well — unlike the tree snapshot, no screen remains to reuse them
    // (that is the difference from a plain toggleExplorer). Left behind, the journal would let Ctrl+Z
    // undo operations that are not on screen the next time the explorer opens (possibly on a different
    // project), and the cache would hold every document and undo history of every file ever opened for
    // the lifetime of the process (drop is per file tab, and no tab is left to close).
    explorerUndoRef.current = []
    editorCacheRef.current.clear()
  }

  // 탐색기 토글 — 파일 탭과 루트별 펼침 상태는 그대로 유지된다
  /** 탐색기를 켤 때는 사이드바도 함께 편다. 레일의 탐색기 버튼과 같은 규칙이다 — 켰는데 사이드바가
   *  접혀 있으면 파일 트리가 어디에도 나타나지 않는다.
   *
   *  사이드바의 표시 여부는 sidebarOpen 하나가 정한다. 예전에는 sidebarOpen || explorerOpen 이라
   *  탐색기가 켜져 있는 동안 사이드바 토글이 아무 반응도 없었다 — OR 가 언제나 참이었기 때문이다. */
  const toggleExplorer = (): void => {
    // 켜는 경우인지는 갱신자 밖에서 정한다. setState 갱신자는 StrictMode 에서 두 번 불릴 수 있으므로
    // 그 안에서 다른 setState 를 부르지 않는다는 것이 이 파일의 규약이다(setLayout 쪽 주석들과 같은 이유)
    const opening = !explorerOpenRef.current
    if (opening) {
      setSidebarOpen(true)
      setJobsOpen(false) // 사이드바는 한 번에 한 뷰만 보여준다
    }
    setExplorerOpen(opening)
  }

  /** Jobs 사이드바 토글 — 탐색기 토글과 같은 규칙이다: 켤 때 사이드바가 접혀 있으면 함께 펴고, 세
   *  뷰 중 하나만 보이므로 탐색기가 열려 있었다면 닫는다. 키보드 단축키가 없으므로 toggleExplorer와
   *  달리 ref가 아니라 최신 렌더의 jobsOpen을 그대로 읽는다 — 전역 리스너에 한 번만 등록되는 함수가
   *  아니라 매 렌더 새로 만들어져 레일 버튼의 onClick에 바로 연결되기 때문이다. */
  const toggleJobs = (): void => {
    const opening = !jobsOpen
    if (opening) {
      setSidebarOpen(true)
      setExplorerOpen(false)
    }
    setJobsOpen(opening)
  }

  // A setState updater can be invoked twice under StrictMode (in development), so setActivePaneId and
  // createGroup are never called inside the setLayout callback — the current values are read from refs
  // to compute the next ones, then setLayout and setActivePaneId are each called once.
  const closeSession = (id: string): void => {
    // State cleanup runs synchronously first — with no await boundary there is no stale closure
    sessionBus.discard(id)
    const rest = sessionsRef.current.filter((s) => s.id !== id)
    setSessions(rest)
    const cur = layoutRef.current
    if (cur) {
      const next = removeTab(cur, sessionTab(id))
      if (next) {
        // If the active group is gone, focus moves to the first remaining group
        const p = activePaneIdRef.current
        setActivePaneId(p && leafOf(next, p) ? p : firstLeaf(next).id)
        setLayout(next)
      } else {
        // Under invariant 1, null means "not a single tab is left in the tree" — that is, there are no
        // sessions. The old model had "sessions outside a pane" and needed a fallback group.
        setActivePaneId(null)
        setLayout(null)
      }
    }
    // kill is best-effort in the background — the tab cleanup is already done even if it fails (the same trade-off as before)
    void window.api.sessions.kill(id).catch(() => {})
  }

  /** Splits the active group and moves tabId into the new one. Past the cap, only a toast.
   *  The tab id goes straight to the tree, so a file tab splits exactly as a session tab does. */
  const splitActive = (dir: PaneDir, placeBefore: boolean, tabId: string): void => {
    const cur = layoutRef.current
    if (!cur) {
      const g = createGroup(tabId)
      setLayout(g)
      setActivePaneId(g.id)
      return
    }
    if (countLeaves(cur) >= MAX_PANES) {
      toast.info(t('session.pane.maxReached'))
      return
    }
    const target = (activePaneIdRef.current && leafOf(cur, activePaneIdRef.current)) || firstLeaf(cur)
    const res = splitAndMove(cur, tabId, target.id, dir, placeBefore)
    // null means the group had only one tab — splitting would change nothing. Not a failure, so no toast either
    if (!res) return
    setLayout(res.root)
    setActivePaneId(res.paneId)
  }
  // A ref so onKey (useEffect([])) can call the latest splitActive without a stale closure
  const splitActiveRef = useRef(splitActive)
  splitActiveRef.current = splitActive

  /** A drop aimed at a specific group's body (coming from PaneGrid). The tab id arrives as it is and goes
   *  straight to the tree, so which kind it is does not matter here.
   *  An edge means Split and Move; the centre means Move To Group. */
  const dropOnPane = (paneId: string, zone: DropZone, tabId: string): void => {
    const cur = layoutRef.current
    if (!cur) return
    if (zone === 'center') {
      // Already in that group means nothing happens — moving onto itself is meaningless rather than a failure
      if (groupOfTab(cur, tabId)?.id === paneId) {
        setActivePaneId(paneId)
        return
      }
      const next = moveTab(cur, tabId, paneId)
      if (!next) return
      setLayout(next)
      setActivePaneId(paneId)
      return
    }
    if (countLeaves(cur) >= MAX_PANES) {
      toast.info(t('session.pane.maxReached'))
      return
    }
    const dir: PaneDir = zone === 'left' || zone === 'right' ? 'row' : 'col'
    const before = zone === 'left' || zone === 'up'
    const res = splitAndMove(cur, tabId, paneId, dir, before)
    if (!res) return
    setLayout(res.root)
    setActivePaneId(res.paneId)
  }

  // Either CLI is enough to work with the app — someone who only uses Codex has no reason to install
  // Claude Code. Which of the two an individual session needs depends on its account's provider, and
  // that call belongs to the new-session dialog, which knows the account.
  const anyCliOk = cli?.claude.ok === true || cli?.codex.ok === true

  /** A group's + button — moves the active group there first so the new session becomes that group's tab.
   *  spawn's placement reads activePaneIdRef, so this one line is enough. */
  const newInGroup = (paneId: string): void => {
    setActivePaneId(paneId)
    if (anyCliOk) setShowNew(true)
  }

  /** A drop on the tab bar — reorder within the same group, or move to that position in another group */
  const dropTabInGroup = (paneId: string, tabId: string, insertBefore: number): void => {
    const cur = layoutRef.current
    if (!cur) return
    const next = moveTab(cur, tabId, paneId, insertBefore)
    if (!next) return
    setActivePaneId(paneId)
    setLayout(next)
  }

  /** Removes that group and merges its tabs into a sibling (IntelliJ's Unsplit). Sessions are not killed.
   *  As with closeSession, it computes from refs without side effects and then calls the two setStates separately. */
  const unsplitPane = (paneId: string): void => {
    const cur = layoutRef.current
    if (!cur) return
    // The group is captured before it is removed — once gone, g.activeTabId is the only way to
    // trace where its tabs were absorbed
    const g = leafOf(cur, paneId)
    const next = unsplit(cur, paneId)
    if (next === cur) return // unsplit — there is no sibling to merge into
    // firstLeaf(next) is the first group of the *whole* tree — unlike closeSession (where the vanished
    // group itself is gone and any group will do), here we have to land on the sibling that absorbed
    // g's tabs. Otherwise, unsplitting G1 in G0 | (G1 / G2) bounces focus to G0 on the left instead of
    // to G2, which absorbed them.
    setActivePaneId((g && groupOfTab(next, g.activeTabId)?.id) ?? firstLeaf(next).id)
    setLayout(next)
  }

  const restart = (old: SessionInfo): void => {
    // A restarted session inherits the tab position the old one held — it neither steals the active
    // group nor leaves a tab pointing at a dead session id
    setSessions((prev) => prev.filter((s) => s.id !== old.id))
    void spawn({
      accountIds: [old.accountId],
      cwd: old.cwd,
      saveDefault: false,
      slackNotify: old.slackNotify,
      bypassPermissions: old.bypassPermissions,
      replacesSessionId: old.id
    })
  }

  const resumeFromHistory = (
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
  ): void => {
    void spawn({
      // Resume under the selected account — the original account resumes as-is, a different one has the
      // transcript copied by ipc. With rolling on, the chain the modal computed follows [0].
      accountIds: opts.accountIds,
      cwd,
      saveDefault: false,
      resumeSessionId: entry.sessionId,
      resumeTranscriptPath: entry.filePath, // the source transcript to copy into the target account's configDir
      roll: opts.roll,
      rollPrompt: opts.rollPrompt,
      slackNotify: opts.slackNotify,
      bypassPermissions: opts.bypassPermissions,
      schedule: opts.schedule
    })
  }

  // 마지막으로 활성이었던 세션. 그 세션이 이미 닫혔으면 find가 못 찾아 null이 되므로 별도의 청소가 없다
  const active = sessions.find((s) => s.id === (activeSessionId ?? lastSessionIdRef.current)) ?? null
  const runningCount = sessions.filter((s) => s.status === 'running').length
  runningCountRef.current = runningCount // the toast's install button has to see the value at click time
  // A check round trip is around 350ms, so watching only the real state would make 'Checking…' invisible
  const updateChecking = showChecking(update?.state, checkClickedAt, Date.now())

  const dirtyIds = new Set(
    fileTabs.filter((t) => { const b = fileBuffers[t.id]; return b && !b.readOnly && b.content !== b.savedContent }).map((t) => t.id)
  )

  // Project Run/Stop: run configurations, the active run, the list of all active runs, and whether the panel is open
  const [runConfigs, setRunConfigs] = useState<RunConfig[]>([])
  const [runSelectedId, setRunSelectedId] = useState<string | null>(null)
  const [runActive, setRunActive] = useState<RunStatus | null>(null)
  const [activeRuns, setActiveRuns] = useState<RunStatus[]>([])
  const [runPanelOpen, setRunPanelOpen] = useState(false)
  // Project terminals. They share the bottom panel with the Run tab.
  const [terminals, setTerminals] = useState<TerminalBuffer[]>([])
  const [bottomTab, setBottomTab] = useState<string>('run') // 'run' | terminalId
  const [runPanelHeight, setRunPanelHeight] = useState<number>(() => {
    const v = Number(localStorage.getItem('cm.runPanelHeight'))
    return v >= 120 && v <= 800 ? v : 220
  })
  // Whether to show the Spring profile field — run.list decides from the build file bodies and sends it down
  const [runIsSpringBoot, setRunIsSpringBoot] = useState(false)
  // Whether RunTypePicker should show 'python'/'pytest' as detected — run.list decides this from the
  // project root's file list (hasPythonProject) and sends it down the same way as isSpringBoot
  const [runIsPythonProject, setRunIsPythonProject] = useState(false)
  // Whether RunTypePicker should show 'dockerfile' as detected — run.list decides this from the project
  // root's file list (hasDockerfile) and sends it down the same way as isPythonProject
  const [runHasDockerfile, setRunHasDockerfile] = useState(false)
  // The two-pane run configuration manager (Task 6). context is the assembly context run.list also
  // sends down — the manager's preview calls buildCommand(config, context) so it shows exactly what
  // run.start would run, and it starts null until the first run.list response arrives.
  const [runManagerOpen, setRunManagerOpen] = useState(false)
  const [runContext, setRunContext] = useState<RunContext | null>(null)
  // The Jobs sidebar snapshot for the open project — orch.list's initial payload, then every
  // 'orch:state' push after it (see the subscription effect below). null until orch.list first resolves.
  const [orchSnapshot, setOrchSnapshot] = useState<OrchSnapshot | null>(null)
  /** 상세 창이 열려 있는 Run. null 이면 닫혀 있다.
   *
   *  **runId 만 들지 않고 프로젝트를 함께 든다.** 프로젝트가 바뀌는 커밋에서는 리셋 효과의
   *  setOpenRun(null) 이 그 렌더의 값을 바꾸지 못하므로(효과 단계다) 재조회는 옛 runId 로 한 번
   *  발사되고, 그러면 main 이 `run X does not belong to Y` 를 orchLog 에 쓴다 — 진짜 크로스 프로젝트
   *  접근 시도가 남기는 줄과 한 글자도 다르지 않아 그 로그를 감사에 쓸 수 없게 된다. 짝을 한 값으로
   *  들면 재조회가 발사 지점에서 스스로 거를 수 있다(효과 선언 순서를 바꾸는 것으로는 고쳐지지 않는다). */
  const [openRun, setOpenRun] = useState<{ projectPath: string; runId: string } | null>(null)
  /** 그 Run 의 이벤트와 의존 그래프. null 은 아직 도착하지 않았다는 뜻이고 빈 배열과 다르다 — 모달은
   *  전자에 아무것도 그리지 않고 후자에만 빈 상태를 그린다. 읽는 효과는 currentProject 선언 아래에 있다. */
  const [detail, setDetail] = useState<RunDetailData | null>(null)
  /** 홈 디렉터리 — 프로젝트가 없을 때 아래쪽 패널의 터미널이 열릴 자리. 프로세스 수명 동안 바뀌지
   *  않으므로 한 번만 읽는다. 도착하기 전에는 null 이고, 그동안 패널은 그려지지 않는다. */
  const [homeDir, setHomeDir] = useState<string | null>(null)
  useEffect(() => {
    void window.api.system.homeDir().then(setHomeDir, () => setHomeDir(null))
  }, [])

  /** Run 콘솔의 자리. 리사이저가 --run-panel-h 를 이 노드에 직접 쓴다 */
  const runHostRef = useRef<HTMLDivElement>(null)

  /** 활성 탭이 말하는 루트 — 파일 탭이면 그 파일의 프로젝트, 세션 탭이면 그 세션의 cwd.
   *  탭이 없으면 null이고, 그 자리는 아래에서 stickyRoot 가 채운다.
   *
   *  히스토리와 worktree 목록에 있던 '탐색기에서 열기'는 이 규칙과 양립하지 않아 없앴다. 그 버튼들은
   *  루트를 핀으로 고정하려 했는데, 활성 탭이 언제나 이기므로 다른 프로젝트를 지정해도 화면은 보고
   *  있던 프로젝트를 계속 보여줬다 — 아무 일도 하지 않는 버튼이었다. **그 규칙은 그대로다** —
   *  stickyRoot 는 활성 탭을 이기지 않고 빈 자리만 채우므로 같은 모순이 생기지 않는다. */
  const activeTabRoot =
    (activeTab?.kind === 'file'
      ? fileTabs.find((t) => t.id === activeTabId)?.projectRoot
      : sessions.find((s) => s.id === activeTab?.id)?.cwd) ?? null

  /** 탭이 하나도 없을 때의 현재 프로젝트. 마운트에서 한 번 복원하고, 그 뒤로는 활성 탭이 갱신한다.
   *  영속 규칙은 lib/stickyProject.ts 에 있다(렌더러에 테스트가 없어 App.tsx 안에서는 확인할 수 없다). */
  const [stickyRoot, setStickyRoot] = useState<string | null>(null)
  useEffect(() => {
    const stored = sticky.read()
    if (!stored) return
    // 저장된 값을 그대로 채택하지 않는다. 폴더가 사라졌거나 이름이 바뀌었을 수 있고, main 의 경로
    // 가드가 더는 허용하지 않을 수도 있다 — 메시지를 하나도 남기지 않은 세션의 프로젝트는
    // provider 의 JSONL 이 없어 history 에 없고, 따라서 knownProjectPaths() 에도 없다. files.list 는
    // 탐색기가 이 루트로 어차피 부르는 호출이라, 존재와 허용을 한 번에 답한다. 거부되면 키를 버린다
    // — 그러지 않으면 사이드바의 네 가지가 켤 때마다 '허용되지 않은 경로입니다'를 받는다.
    void window.api.files.list(stored).then(
      // 복원이 도착하기 전에 활성 탭이 정한 값이 있으면 그쪽이 이긴다 (탭이 있는 채로 시작한 경우)
      () => setStickyRoot((prev) => prev ?? stored),
      () => sticky.clear()
    )
  }, [])
  // 활성 탭이 루트를 말할 때마다 그것이 다음의 기억이 된다. 탭이 사라져도(null) 지우지 않는 것이
  // 이 슬라이스의 전부다
  useEffect(() => {
    if (!activeTabRoot) return
    setStickyRoot(activeTabRoot)
    sticky.write(activeTabRoot)
  }, [activeTabRoot])

  /** 사이드바와 실행 구성이 '어느 프로젝트인가'로 읽는 값 — 활성 탭이 이기고, 없으면 마지막 기억. */
  const currentProject = activeTabRoot ?? stickyRoot

  /** NewRunModal 이 열려 있는지. currentProject 아래에 두는 것은 이 파일이 지켜 온 자리 규칙이다 —
   *  바로 아래 두 효과의 주석이 기록하듯, 이 파일은 currentProject 보다 위에서 그 값을 참조해 TDZ
   *  ReferenceError 로 죽은 전례가 있고(타입체크는 잡지 못한다) 그 사고를 되풀이하지 않으려는
   *  자리다. currentProject 가 있을 때만 모달을 그리므로(아래 렌더) 이 값 자체는 프로젝트가 없어도
   *  true 로 남을 수 있지만, 프로젝트를 잃으면 그릴 자리가 없어 조용히 닫힌 것과 같다. */
  const [newRunOpen, setNewRunOpen] = useState(false)

  // 기록 모달이 열려 있는 동안 이벤트를 다시 읽는다. **이 자리에 있어야 한다** — 의존성 배열은
  // 렌더 중에 평가되므로, currentProject 선언보다 위에 두면 TDZ ReferenceError 로 죽는다(타입체크는
  // 잡지 못한다).
  //
  // orchSnapshot 을 의존성에 두는 것이 요점이다: 그 값이 바뀌는 것이 곧 "이 프로젝트의 오케스트레이션
  // 상태가 움직였다"이고, JobRun.eventCount 가 스냅샷에 실려 있으므로 Task 상태를 하나도 옮기지 않는
  // 메시지도 그 신호에 포함된다. 폴링을 두지 않는 이유가 그것이다.
  useEffect(() => {
    // 짝이 맞지 않으면 부르지 않는다 — 프로젝트 A→B 커밋에서 이 효과는 아직 A 의 runId 를 들고
    // 돌지만, 그 조합은 main 이 거부할 조합이다. 여기서 거르면 orchLog 에 접근 위반과 똑같이 생긴
    // 줄이 남지 않는다. 모달을 닫는 것은 아래의 리셋 효과다(이 가드는 로그만 지킨다).
    if (!openRun || openRun.projectPath !== currentProject) return
    // 스냅샷에 없는 Run 도 부르지 않는다 — worktree 제거나 astera reset 으로 Run 이 사라지면
    // 프로젝트는 그대로인데 main 은 접근 위반과 똑같이 생긴 `run X does not belong to Y` 를 로그에
    // 남긴다. orchSnapshot 이 아직 null 이면(안 왔다) 없다고 단정하지 않는다 — 그때는 부르는 쪽이
    // 맞다. Run 이 사라진 뒤에 창을 닫는 것은 아래의 새 효과다.
    if (orchSnapshot !== null && !orchSnapshot.runs.some((r) => r.id === openRun.runId)) return
    let cancelled = false
    // 거부 팔을 반드시 둔다 — 위의 가드가 걸러도 main 은 저장소를 읽다 던질 수 있고, 그러면
    // DevTools 에 Uncaught (in promise) 가 뜬다. 빈 모양으로 접으면 모달은 빈 상태를 그린다.
    void window.api.orch.runDetail(openRun.projectPath, openRun.runId).then(
      (d) => {
        if (!cancelled) setDetail(d)
      },
      () => {
        if (!cancelled) setDetail({ events: [], layers: [], deps: {}, cyclic: [] })
      }
    )
    return () => {
      cancelled = true
    }
  }, [openRun, currentProject, orchSnapshot])
  // 프로젝트가 바뀌면 닫는다 — 다른 프로젝트의 Run 을 열어 둔 채로 둘 이유가 없다
  useEffect(() => {
    setOpenRun(null)
    setDetail(null)
  }, [currentProject])
  // Run 이 스냅샷에서 사라지면 닫는다 — 프로젝트는 그대로인데 Run 만 사라지면(worktree 제거,
  // astera reset) 위의 효과는 반응하지 않고, 창은 제목 없이 열린 채 "아직 아무 일도 없었습니다"를
  // 그린다(App.tsx 의 openRun 렌더가 orchSnapshot 에 없는 Run 을 undefined 로 넘긴다). 이 자리에
  // 두는 이유는 openRun·orchSnapshot 선언보다 아래여야 하기 때문이다 — 위로 옮기면 TDZ
  // ReferenceError 로 죽는다(타입체크는 못 잡는다). 여기서도 orchSnapshot === null 은 "없다"가
  // 아니다 — 아직 첫 조회가 오지 않았을 뿐이면 닫지 않는다.
  useEffect(() => {
    if (!openRun || openRun.projectPath !== currentProject || orchSnapshot === null) return
    if (!orchSnapshot.runs.some((r) => r.id === openRun.runId)) setOpenRun(null)
  }, [openRun, currentProject, orchSnapshot])

  // Whether RunConfigManager is actually on screen — gates both its render below and the shortcut
  // suppression right after it. Computed from the same three things that gate the render (open flag,
  // project, context) so switching projects or losing the context drops the suppression in the same
  // render as the unmount, not only when the dialog's own onClose fires.
  const runManagerVisible = runManagerOpen && !!currentProject && !!runContext
  // OR-ed onto the value the other modals already set above — runManagerVisible depends on
  // currentProject, which is not computed yet at that point in the component. The history modal joins
  // the same chain: while it is open the shortcuts must not reach the workbench behind it.
  // newRunOpen joins for the same reason — it has a text input (objective), and without this a global
  // shortcut key would reach the workbench behind the modal while that field has focus.
  modalOpenRef.current = modalOpenRef.current || runManagerVisible || openRun !== null || newRunOpen

  // Mirrors currentProject into a ref — avoids a stale closure in the run:status subscription effect
  const currentProjectRef = useRef(currentProject)
  currentProjectRef.current = currentProject

  /** bottomRoot 를 ref 로 비춘다 — 비동기 흐름 중에 루트가 바뀌었는지 보는 데 쓴다(openTerminal).
   *  currentProjectRef 로는 안 된다: 프로젝트가 없을 때 그쪽은 null 이고 bottomRoot 는 홈이다. */
  const bottomRootRef = useRef<string | null>(null)

  // 탭 줄은 이제 페인마다 있고 그 내용은 트리(leaf.tabIds)가 정한다 — 전역 한 줄과 그 폴백은 사라졌다.
  // 어떤 프로젝트의 세션인지로 거르지도 않는다: 페인에 담긴 것이 곧 그 페인이 보여주는 것이다.

  /** 페인 하나의 에디터 본문. PaneGrid가 페인마다 슬롯을 잡고 그 안에 이것을 그린다.
   *
   *  에디터는 페인당 하나다 — 같은 페인에서 파일 탭을 오갈 때 이 FileEditor가 재사용되고, path만
   *  바뀐다. 되돌리기와 스크롤을 이어 주는 EditorStateCache는 App이 계속 소유하므로 페인이 여럿이어도
   *  캐시는 하나다.
   *
   *  FileEditor는 로딩·오류 중에도 언마운트되면 안 된다 — 언마운트는 EditorView를 destroy하고 되돌리기
   *  이력을 지운다. 그래서 오버레이는 위에 덮을 뿐이고, 활성 탭이 세션으로 바뀔 때도 슬롯이 display로만
   *  숨는다(PaneGrid의 lastFileOfPane). */
  /** 마크다운으로 다룰 확장자. edit.ts 의 LANG_BY_EXT 가 markdown 으로 잡는 둘과 같다 */
  const isMarkdownPath = (p: string): boolean => /\.(md|markdown)$/i.test(p)
  /** paneId 를 쓰는 이유: FileEditor 는 파일 탭이 아니라 페인 하나당 하나이고(위 주석), path 만
   *  바뀌며 그 페인 안에서 재사용된다 — onViewChange 는 그 인스턴스의 마운트·언마운트에서만 불리고
   *  파일이 바뀔 때는 다시 불리지 않는다. 그래서 이 뷰를 파일 탭 id 로 저장하면(예전 코드) 한 페인에서
   *  두 번째로 여는 마크다운 파일은 영원히 null 을 받는다 — 뷰는 첫 파일에서 그대로인데 map 의 키는
   *  새 파일 것이길 기대하기 때문이다. 페인 id 로 저장하면 "이 페인의 지금 뷰"가 항상 맞다.
   */
  const renderEditor = (paneId: string, fileTabId: string, focused: boolean): React.ReactNode => {
    const f = fileTabs.find((t) => t.id === fileTabId)
    const buf = fileBuffers[fileTabId]
    if (!f || !buf) return null
    const editor = (
      <FileEditor
        path={f.path}
        content={buf.content}
        readOnly={buf.readOnly}
        cache={editorCacheRef.current}
        focused={focused}
        onRetire={retireEditorState}
        onViewChange={(view) => setMdViews((prev) => ({ ...prev, [paneId]: view }))}
        // 에디터가 알려 준 경로로 대상을 찾는다. 그리고 있는 파일과 다르면 그 편집은 뷰가 아직
        // 갈아타지 않은 옛 문서의 것이므로 버린다
        onChange={(fromPath, next) => {
          const target = fileTabsRef.current.find((t) => t.path === fromPath)
          if (!target || target.id !== f.id) return
          setBufferContent(target.id, next)
        }}
        onSave={(fromPath) => {
          const target = fileTabsRef.current.find((t) => t.path === fromPath)
          if (target) saveFile(target.id)
        }}
      />
    )
    return (
      <div className="workbench-body">
        <div className="file-editor-wrap">
          {buf.readOnly && !buf.loading && !buf.error && (
            <div className="file-truncated">{t('files.editor.readOnlyReason')}</div>
          )}
          {buf.conflict && (
            <div className="file-conflict">
              {t('files.editor.conflictChanged')}
              <button onClick={() => reloadBufferFromDisk(f.id)}>{t('files.editor.reload')}</button>
              <button onClick={() => setFileBuffers((prev) => (prev[f.id] ? { ...prev, [f.id]: { ...prev[f.id], conflict: false } } : prev))}>{t('files.editor.keepMine')}</button>
            </div>
          )}
          {/* markdown=false 여도 MarkdownSplit 은 항상 렌더된다 — {md ? <MarkdownSplit/> : editor}
              삼항연산자였을 때는 이 자리의 엘리먼트 타입이 파일을 오갈 때마다 MarkdownSplit↔FileEditor
              로 바뀌어, 같은 페인에서 .md 파일과 비-.md 파일 사이를 전환하기만 해도 리액트가 FileEditor
              를 언마운트·재마운트해 되돌리기 이력을 지웠다(MarkdownSplit.tsx 상단 주석 참고). 이제
              이 위치는 항상 <MarkdownSplit> 이고, 툴바·리사이저·프리뷰를 그리는지는 그 컴포넌트 내부의
              markdown 프롭이 결정한다. */}
          <MarkdownSplit
            markdown={isMarkdownPath(f.path)}
            mode={mdModes[f.id] ?? defaultMdMode()}
            onModeChange={(mode) => setMdMode(f.id, mode)}
            text={buf.content}
            docPath={f.path}
            onOpenFile={(abs) => openFile(abs)}
            onSave={() => saveFile(f.id)}
            editor={editor}
            editorView={mdViews[paneId] ?? null}
          />
          {buf.loading && <div className="file-overlay">{t('files.editor.loading')}</div>}
          {!buf.loading && buf.error && <div className="file-overlay">{buf.error}</div>}
        </div>
      </div>
    )
  }

  // 사이드바에 그릴 뷰 하나 — 세 갈래 삼항보다 이 값 하나가 어느 뷰가 열려 있는지를 더 분명히 읽힌다.
  // 탐색기와 Jobs는 서로 배타적이다(toggleExplorer/toggleJobs가 상대를 끈다). orchEnabled가 꺼지면
  // jobsOpen이 내부적으로 true로 남아 있어도 Jobs를 그리지 않고 세션 목록으로 돌아간다 — 레일의 진입점이
  // 사라지는 시점에 사이드바도 조용히 원래 모습으로 돌아가야 어색해지지 않는다.
  //
  // **아래 효과들과 Run 콘솔의 렌더가 이 값을 공유한다.** 그래서 선언이 렌더 본문 끝이 아니라 여기에
  // 있다 — 효과의 의존성 배열은 렌더 중에 평가되므로 선언이 그보다 아래면 TDZ 로 터진다.
  // 세 자리에 `explorerOpen || jobsOpen` 을 각각 쓰면 사이드바가 실제로 보여주는 것과 어긋날 수 있다.
  const sidebarPane: 'explorer' | 'jobs' | 'sessions' = explorerOpen
    ? 'explorer'
    : jobsOpen && orchEnabled
      ? 'jobs'
      : 'sessions'
  /** 아래쪽 패널이 쓰는 경로. 프로젝트가 없으면 홈으로 떨어진다 — 셸을 직접 띄웠을 때와 같은 곳이고,
   *  그래야 탭이 하나도 없을 때도 터미널을 열 수 있다. 홈에서는 Run 탭이 없다(runAvailable):
   *  실행 구성은 프로젝트 단위이고, 홈의 파일 목록으로 시드를 감지하면 남의 홈 package.json 스크립트를
   *  실행 구성으로 제안하게 된다. main 의 경로 가드도 터미널에만 홈을 열어 준다(assertTerminalPath). */
  const bottomRoot = currentProject ?? homeDir
  bottomRootRef.current = bottomRoot
  const runAvailable = currentProject !== null
  /** 아래쪽 패널에 실제로 넘길 탭. Run 탭이 없는데 bottomTab 이 'run' 에 남아 있으면 본문이 비므로,
   *  그때는 터미널로 떨어뜨린다. 여러 자리(closeTerminal, 터미널 목록 효과, 초기값)가 'run' 을
   *  기본 폴백으로 쓰고 있어 그 하나하나를 고치는 대신 내려보내는 값에서 한 번에 바로잡는다. */
  const bottomTabShown = runAvailable
    ? bottomTab
    : (terminals.find((x) => x.id === bottomTab)?.id ?? terminals[0]?.id ?? 'run')

  // Loads that project's run configurations and active run whenever the host pane or the root changes
  useEffect(() => {
    // 여기는 currentProject 그대로다 — 실행 구성은 프로젝트 단위이므로 홈에서는 읽을 것이 없다.
    if (!currentProject) return
    let cancelled = false
    // 거부를 삼키지 않고 상태를 비운다. 이 호출은 예전에 탐색기가 열려 있을 때만 돌았고 지금은
    // 프로젝트가 있으면 항상 돈다 — 그래서 가드가 거부하는 루트(사라진 워크트리의 파일 탭 등)가
    // 처리되지 않은 거부로 콘솔에 튀어나왔다. 실패하면 이전 프로젝트의 구성이 남는 것이 더 나쁘므로
    // 비운다: 남겨 두면 그 목록의 ▶ 가 다른 프로젝트를 실행한다.
    void window.api.run.list(currentProject).then((r) => {
      if (cancelled) return
      setRunConfigs(r.configs)
      setRunActive(r.active)
      setRunIsSpringBoot(r.isSpringBoot)
      setRunIsPythonProject(r.isPythonProject)
      setRunHasDockerfile(r.hasDockerfile)
      setRunContext(r.context)
      setRunSelectedId((prev) => (r.configs.some((c) => c.id === prev) ? prev : r.active?.configId ?? r.configs[0]?.id ?? null))
      if (r.active?.status === 'running') setRunPanelOpen(true)
    }, () => {
      if (cancelled) return
      setRunConfigs([])
      setRunActive(null)
      setRunSelectedId(null)
      setRunContext(null)
    })
    return () => { cancelled = true }
  }, [currentProject])

  // Turning the setting off makes the rail button — the only control that can close the Jobs view —
  // disappear along with it (it is gated on the same orchEnabled), so a view left open past that point
  // is one the user has no way left to reach the control for. Closing it here is what lets the
  // subscription effect below run its own cleanup (unwatch): that effect does not depend on
  // orchEnabled, and adding it to that dependency list alone would not help — jobsOpen would still be
  // true and the effect would just re-arm. Setting jobsOpen to false here is what actually tears the
  // subscription down, and it does not spring back open when the setting is turned back on (this
  // effect only ever closes, never opens).
  useEffect(() => {
    if (!orchEnabled) setJobsOpen(false)
  }, [orchEnabled])

  // Loads the Jobs sidebar snapshot and subscribes to further changes, the same shape as the run.list
  // effect above. orch.list doubles as the subscription (OrchApi's doc comment): its return value is
  // the initial payload and must be rendered here, because 'orch:state' only carries changes after it —
  // a caller that only awaits list to arm the subscription and discards the result never sees that first
  // state. orch.unwatch on cleanup is the way out, the same pair as files.watch/unwatch and
  // git.watch/unwatch — without it main keeps folding and pushing a snapshot after this view is gone.
  useEffect(() => {
    // Clearing before arming, the shape useGitStatus already uses (hooks/useGitStatus.ts: it clears on
    // a null root and clears again on every root change). Without it orchSnapshot is only ever written
    // and never reset, which shows up twice: on a project switch the previous project's Runs stay on
    // screen for the whole round trip — the flash JobsView's own comment says it avoids is a flash of
    // another project's objectives, which is worse than the "no jobs" frame it was avoiding — and with
    // no active tab nothing ever arrives at all.
    //
    // The two cases want different values. A root change means "not known yet", so null, which is what
    // JobsView's null guard draws nothing for while the request is in flight. A null root means there
    // is no project to ask about and no response is coming, so an empty snapshot goes in instead —
    // that reaches the empty state, where null would leave an unexplained blank sidebar for as long as
    // the view stays open.
    setOrchSnapshot(currentProject === null ? { runs: [] } : null)
    // sidebarOpen belongs in this guard as much as jobsOpen does: collapsing the sidebar unmounts the
    // whole <aside> and JobsView with it, but jobsOpen stays true, so without this no unwatch is sent
    // and main goes on folding a snapshot on every orchestration write — inside the awaited setState,
    // i.e. in the CLI request's critical path — and pushing it to a component that is not mounted.
    // The fourth teardown trigger, after unmount, orch.unwatch and the orchEnabled effect above.
    if (!jobsOpen || !sidebarOpen || !currentProject) return
    let cancelled = false
    void window.api.orch.list(currentProject).then((snapshot) => {
      if (cancelled) return
      setOrchSnapshot(snapshot)
    })
    const off = window.api.on('orch:state', (snapshot) => {
      if (!cancelled) setOrchSnapshot(snapshot)
    })
    return () => {
      cancelled = true
      off()
      void window.api.orch.unwatch()
    }
  }, [jobsOpen, sidebarOpen, currentProject])

  // When the project changes, that project's terminal list is read again — main holds them per project,
  // so another project's terminals stay alive and are simply not shown here
  useEffect(() => {
    // bottomRoot 로 읽는다 — 프로젝트가 없으면 홈의 터미널 목록이다. currentProject 로 걸러 두면
    // 프로젝트 없이 연 터미널이 목록에 잡히지 않아 탭이 빈 껍데기가 된다.
    if (!bottomRoot) {
      setTerminals([])
      return
    }
    let cancelled = false
    void window.api.terminal.list(bottomRoot).then(
      (list) => {
        if (cancelled) return
        setTerminals(list)
        // If a tab that does not belong to this project is still active, fall back to Run
        setBottomTab((cur) => (cur === 'run' || list.some((x) => x.id === cur) ? cur : 'run'))
      },
      () => {
        if (!cancelled) setTerminals([])
      }
    )
    return () => {
      cancelled = true
    }
  }, [bottomRoot])

  // An event subscription (refreshed by run:status) plus one initial query, instead of polling all active runs
  useEffect(() => {
    void window.api.run.listActive().then(setActiveRuns)
    const off = window.api.on('run:status', (s) => {
      void window.api.run.listActive().then(setActiveRuns)
      // If the run belongs to the current workbench project, the local state is updated too
      if (currentProjectRef.current && s.projectPath === currentProjectRef.current) setRunActive(s)
    })
    return off
  }, [])

  // Re-detects run configurations when a seed source at the project root changes.
  // On the JVM side the build file **body** feeds the verdict too — adding the Spring Boot plugin to
  // build.gradle has to produce a bootRun seed, so a content change is as much a trigger as a creation.
  // Wrapper files are included as well: whether they exist changes the launcher choice (gradlew.bat,
  // ./gradlew, or gradle).
  useEffect(() => {
    const SEED_FILES = new Set([
      'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'Cargo.toml', 'go.mod',
      'build.gradle', 'build.gradle.kts', 'gradlew', 'gradlew.bat',
      'pom.xml', 'mvnw', 'mvnw.cmd',
      // These two do not seed a config (python/pytest have none — see hasPythonProject), but their
      // presence is what flips RunTypePicker's "detected" grouping, so they still belong in this set.
      // A root-level *.py file flips it too, but that is any of countless names and does not fit a
      // fixed set — the picker just does not update live for that trigger until the project reopens.
      'pyproject.toml', 'requirements.txt',
      // Same situation for 'dockerfile' — no seed, but its presence flips the picker's detection (hasDockerfile)
      'Dockerfile'
    ])
    const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
    const off = window.api.on('files:changed', (c) => {
      const root = currentProjectRef.current
      if (!root) return
      const base = c.path.split(/[\\/]/).pop() ?? ''
      if (!SEED_FILES.has(base) || norm(parentDir(c.path)) !== norm(root)) return
      void window.api.run.list(root).then((r) => {
        setRunConfigs(r.configs)
        setRunIsSpringBoot(r.isSpringBoot)
        setRunIsPythonProject(r.isPythonProject)
        setRunHasDockerfile(r.hasDockerfile)
        setRunContext(r.context)
        setRunSelectedId((prev) => (r.configs.some((cc) => cc.id === prev) ? prev : r.active?.configId ?? r.configs[0]?.id ?? null))
      })
    })
    return off
  }, [])

  const runStart = (): void => {
    if (!currentProject || !runSelectedId) return
    const root = currentProject
    void window.api.run.start(root, runSelectedId).then(
      async (st) => {
        setRunActive(st)
        // Starting a Run may be what opens the panel for the first time — and that also mounts this
        // project's existing terminal tabs (in a hidden state). TerminalBody replays initialBuffer only
        // once, at mount, and ignores later updates, so the latest buffer has to be read *before* the
        // setRunPanelOpen(true) that causes the mount — the same reason as in openTerminal.
        if (terminals.length > 0) {
          const list = await window.api.terminal.list(root).catch(() => terminals)
          // If the project changes while this is in flight, the result is discarded — currentProjectRef is
          // the same idiom the other async callbacks in this file use against stale closures. Without
          // discarding, the screen shows the new project while the panel holds the previous project's
          // terminal tabs, and input goes to that shell.
          if (currentProjectRef.current !== root) return
          setTerminals(list)
        }
        setRunPanelOpen(true)
      },
      (err) => toast.error(t('run.start.failed', { detail: err instanceof Error ? err.message : String(err) }))
    )
  }
  const runStop = (): void => {
    if (currentProject) void window.api.run.stop(currentProject)
  }
  const runDeleteConfig = (id: string): void => {
    if (!currentProject) return
    void window.api.run.deleteConfig(currentProject, id).then(() => {
      void window.api.run.list(currentProject).then((r) => {
        setRunConfigs(r.configs)
        setRunContext(r.context)
        setRunSelectedId((prev) => (r.configs.some((c) => c.id === prev) ? prev : r.configs[0]?.id ?? null))
      })
    })
  }
  /** RunConfigManager's onSave. It always hands over an assembled RunConfig of whatever kind — there
   *  is no per-field signature to match, so this one handler covers add, edit, and the promotion of a
   *  seed into a user configuration copy (RunConfigManager.tsx's handleFormChange).
   *
   *  Answers whether the configuration reached the store: run.saveConfig refuses a value the command
   *  gate rejects, and the dialog has to take a refused new configuration back out of its tree rather
   *  than leave a row nothing is behind. */
  const runManagerSave = (config: RunConfig): Promise<boolean> => {
    if (!currentProject) return Promise.resolve(false)
    return window.api.run.saveConfig(currentProject, config).then(
      () => {
        void window.api.run.list(currentProject).then((r) => {
          setRunConfigs(r.configs)
          setRunContext(r.context)
          // The same reconciliation as the three siblings above. It is not optional here either:
          // promoting a seed *removes* an id — mergeConfigs stops emitting seed:npm:dev the moment a
          // stored config shares its seedKeyOf — so without this the toolbar keeps a seed id that no
          // longer resolves, ▶ stays enabled (disabled={!selectedId}, and a stale string is truthy)
          // and pressing it fails with NO_CONFIG.
          setRunSelectedId((prev) => (r.configs.some((c) => c.id === prev) ? prev : r.configs[0]?.id ?? null))
        })
        return true
      },
      (err) => {
        toast.error(t('run.config.saveFailed', { detail: err instanceof Error ? err.message : String(err) }))
        return false
      }
    )
  }
  /** 실행 중 목록에서 다른 프로젝트로 점프. 트리 루트는 활성 탭이 정하므로, 그 프로젝트에 속한 탭을
   *  활성으로 만드는 것이 곧 '그리로 간다'는 뜻이다. 세션을 먼저 찾고 없으면 그 프로젝트의 파일 탭을
   *  쓴다.
   *
   *  **둘 다 없으면 sticky 루트를 그 프로젝트로 옮긴다.** 이 폴백은 탭이 하나도 없는 상태에서만
   *  무언가를 한다 — runSlot 이 explorerRoot 에서 currentProject 로 옮겨 오면서 처음 생긴 상태이고,
   *  그 상태에서는 이 툴바가 그려지는데도(전역 실행 목록이 거기 있다) 활성화할 탭이 없어 점프 버튼이
   *  조용히 아무 일도 하지 않았다.
   *
   *  이것이 없앤 '탐색기에서 열기' 버튼들의 모순을 되살리지 않는 이유: 그 버튼들은 **탭이 있는
   *  상태에서** 루트를 핀으로 바꾸려 했고, activeTabRoot 가 언제나 stickyRoot 를 이기므로
   *  (currentProject 참고) 화면이 움직이지 않아 무력했다. 여기서는 탭이 있으면 위의 두 분기가 먼저
   *  탭 활성화로 끝나므로 이 줄에 도달하지 않는다 — 즉 이기지 못하는 자리에서 이기려 하지 않는다.
   *  경로는 run.listActive 가 준 것이라 main 의 가드가 이미 허용한 값이다. */
  const runJump = (projectPath: string): void => {
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const target = norm(projectPath)
    const session = sessionsRef.current.find((s) => norm(s.cwd) === target)
    if (session) {
      selectWorkbenchTabRef.current(sessionTab(session.id))
      return
    }
    const file = fileTabsRef.current.find((t) => norm(t.projectRoot) === target)
    if (file) {
      selectWorkbenchTabRef.current(file.id)
      return
    }
    // 탭이 하나도 없다 — 기억을 옮기면 화면이 실제로 움직인다. 다만 **복원과 같은 확인을 거친다.**
    // 검증 없이 채택하면 경로 가드가 허용하지 않는 프로젝트가 currentProject 가 되고, 그것을 읽는
    // 네 소비자(탐색기·실행 구성·Jobs·터미널)가 전부 거부를 받는다 — 그리고 그 값이 localStorage 에
    // 남아 다음 실행까지 간다. files.list 를 쓰는 이유도 복원과 같다: 탐색기가 이 루트로 어차피 부르는
    // 호출이라 존재와 허용을 한 번에 답한다.
    void window.api.files.list(projectPath).then(
      () => {
        setStickyRoot(projectPath)
        sticky.write(projectPath)
      },
      // 조용히 아무 일도 하지 않으면 이 버튼이 다시 '눌리는데 안 되는' 컨트롤이 된다 — 그것을 없애려고
      // 이 폴백을 만들었으므로, 갈 수 없는 이유를 말한다
      () => toast.error(t('run.jump.notAllowed'))
    )
  }
  const runStopProject = (projectPath: string): void => { void window.api.run.stop(projectPath) }

  // openTerminal calls newTerminal below, so it is declared first to match reading order — an arrow
  // function is not hoisted, but this is only definition order rather than execution, so no order can
  // produce a runtime reference error (both are created when the component body runs, and the actual
  // call happens later on a click, by which time openTerminal's closure over newTerminal is initialised).
  const newTerminal = async (): Promise<void> => {
    // bottomRoot — openTerminal 과 같은 경로여야 한다. currentProject 로 두면 프로젝트가 없을 때
    // 여기서 조용히 빠지고, 패널만 열린 채 터미널이 만들어지지 않는다.
    if (!bottomRoot) return
    try {
      const info = await window.api.terminal.open(bottomRoot)
      setTerminals((prev) => [...prev, { id: info.id, buffer: '' }])
      setBottomTab(info.id)
      setRunPanelOpen(true)
    } catch (err) {
      toast.error(
        t('terminal.open.failed', { detail: err instanceof Error ? err.message : String(err) })
      )
    }
  }

  // The rail terminal button: opens the panel, creates a terminal if this project has none, and otherwise just focuses
  const openTerminal = async (): Promise<void> => {
    // bottomRoot — 프로젝트가 없으면 홈에서 연다
    if (!bottomRoot) return
    const root = bottomRoot
    if (terminals.length > 0) {
      // Collapsing unmounts BottomPanel and every TerminalBody inside it (the runPanelOpen gate).
      // TerminalBody replays initialBuffer only once, at mount, and ignores later updates, so the latest
      // buffer has to be read *before* the setRunPanelOpen(true) that causes the remount — updating
      // terminals after the mount does not reach an xterm that is already mounted.
      const list = await window.api.terminal.list(root).catch(() => terminals)
      // If the root changes while this is in flight, the result is discarded — the list effect has
      // already set the new root's list, so overwriting with the old result would leave the screen on
      // the new root while the active tab is the previous one's terminal, sending input to that shell.
      // bottomRootRef, not currentProjectRef: with no project those two differ (null vs the home
      // directory), so comparing against the project ref bailed on every call.
      if (bottomRootRef.current !== root) return
      setTerminals(list)
      if (list.length === 0) {
        // If a missed terminal:exit means the re-query really does come back empty, create one instead
        // of merely opening the Run tab — that is what this rail terminal button is for
        setRunPanelOpen(true)
        await newTerminal()
        return
      }
      setBottomTab(list[0].id)
      setRunPanelOpen(true)
      return
    }
    setRunPanelOpen(true)
    await newTerminal()
  }

  const closeTerminal = (id: string): void => {
    void window.api.terminal.close(id).catch(() => {})
    setTerminals((prev) => prev.filter((x) => x.id !== id))
    setBottomTab((cur) => (cur === id ? 'run' : cur))
  }

  // Usage for the active session (context, 5-hour, weekly) — read from the statusLine capture file.
  // Claude refreshes it every turn, so it is re-queried periodically (cheap, being a file read), and
  // immediately on a session switch.
  // (Separate from the activeSessionId state — only an id whose session existence was confirmed by
  // active is used.)
  const usageSessionId = active?.id
  useEffect(() => {
    if (!usageSessionId) {
      setUsage(null)
      return
    }
    let cancelled = false
    const load = (): void => {
      void window.api.usage
        .session(usageSessionId)
        .then((u) => {
          if (!cancelled) setUsage(u)
        })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, 3_000)
    const onFocus = (): void => load()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [usageSessionId])

  // Only when neither CLI is present is there nothing to launch. With one of the two installed the app
  // opens as usual, and the new-session dialog blocks the accounts whose CLI is missing.
  //
  // Deliberately English-only, and deliberately not routed through t(). This screen replaces the whole
  // workbench, so the rail is never rendered — and the settings modal that holds the language switch
  // lives on that rail. Someone stuck here cannot change the language, so the text stays in the one
  // language every reader of an npm install command already has to read. Do not move these strings
  // into the i18n catalog: following the stored language is exactly the behaviour being avoided.
  if (cli && !cli.claude.ok && !cli.codex.ok) {
    return (
      <div className="app">
        {/* 0, not runningCount: this screen renders no ConfirmHost, so a close confirmation would
            never be answered and the close button would stop working entirely. */}
        <Titlebar isMax={isMax} update={update} runningCount={0} />
        <div className="cli-missing">
          <h1>No CLI found to run</h1>
          <p>
            This app is a launcher that runs the installed <code>claude</code> or <code>codex</code>{' '}
            CLI. Install either one, then restart the app.
          </p>
          <p>
            Install: <code>npm install -g @anthropic-ai/claude-code</code>
          </p>
          <p>
            Install: <code>npm install -g @openai/codex</code>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      {/* 실행 구성은 타이틀바 줄에 놓인다(IntelliJ와 같은 자리). 별도의 띠를 두면 탐색기를 여닫을
          때마다 그 띠가 생겼다 사라지며 아래 페인이 위아래로 튄다. 프로젝트가 정해졌을 때만 그리므로
          Ctrl/Cmd+Shift+E 와는 무관하다 */}
      <Titlebar
        isMax={isMax}
        update={update}
        runningCount={runningCount}
        runSlot={
          currentProject ? (
            <div className="tb-run">
              <RunToolbar
                configs={runConfigs}
                selectedId={runSelectedId}
                onSelect={setRunSelectedId}
                active={runActive}
                onRun={runStart}
                onStop={runStop}
                onOpenManager={() => setRunManagerOpen(true)}
                activeRuns={activeRuns}
                onJump={runJump}
                onStopProject={runStopProject}
              />
            </div>
          ) : null
        }
      />
      {/* Only a block-mode campaign covers the workbench. notify is announced with a toast */}
      {campaign?.mode === 'block' && (
        <UpdateGate
          update={update}
          onDownload={() => void window.api.update.download()}
          onInstall={() => void installUpdate()}
          onRetry={() => void window.api.update.check()}
        />
      )}
      <div className="workbench">
        <nav className="rail">
          <button
            className={sidebarOpen ? 'rail-btn on' : 'rail-btn'}
            aria-label={t('session.rail.toggleSidebar')}
            title={t('session.rail.toggleSidebar')}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            ◱
          </button>
          {/* 탐색기 토글. 폴더 아이콘과 컨텍스트 메뉴 항목을 걷어내면서 탐색기로 들어가는 길이 단축키
              하나만 남았는데, 처음 쓰는 사람은 그 키를 알 수 없다. 툴팁에 실제 바인딩을 함께 띄우므로
              한 번 눌러 본 사람은 다음부터 키를 쓴다 — 발견과 학습이 같은 자리에서 끝난다.
              사이드바가 접혀 있으면 함께 편다. 안 그러면 눌러도 아무것도 나타나지 않는다 */}
          <button
            className={explorerOpen ? 'rail-btn on' : 'rail-btn'}
            aria-label={explorerShortcutLabel}
            title={explorerShortcutLabel}
            onClick={toggleExplorer}
          >
            {/* 파일 트리 — 폴더 하나와 그 안의 줄 둘. 앱의 SVG 관례대로 16 viewBox 에 currentColor 하나 */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            >
              <path d="M1.8 4.1a1 1 0 0 1 1-1h3.1l1.4 1.6h5.9a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" />
              <g strokeWidth="1.2" strokeLinecap="round">
                <line x1="5" y1="8.2" x2="11" y2="8.2" />
                <line x1="5" y1="10.6" x2="9" y2="10.6" />
              </g>
            </svg>
          </button>
          {/* Jobs 사이드바 토글. 오케스트레이션 설정이 꺼져 있으면 아예 그리지 않는다 — 뒤에 아무것도
              없는 진입점을 보여줄 이유가 없다(App.tsx:381의 orchEnabled, 설정 모달의 토글이 mirror한다) */}
          {orchEnabled && (
            <button
              className={jobsOpen ? 'rail-btn on' : 'rail-btn'}
              aria-label={t('jobs.rail.open')}
              title={t('jobs.rail.open')}
              onClick={toggleJobs}
            >
              {/* Jobs — 체크리스트. 앱의 SVG 관례대로 16 viewBox 에 currentColor 하나, 바깥 사각형은
                  1.4, 안쪽 체크와 줄은 1.2 */}
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              >
                <rect x="2.6" y="1.8" width="10.8" height="12.4" rx="1.4" />
                <g strokeWidth="1.2" strokeLinecap="round">
                  <path d="M4.8 5.2 5.7 6.1 7.3 4.3" />
                  <line x1="9" y1="5.4" x2="11.4" y2="5.4" />
                  <path d="M4.8 9.6 5.7 10.5 7.3 8.7" />
                  <line x1="9" y1="9.8" x2="11.4" y2="9.8" />
                </g>
              </svg>
            </button>
          )}
          {/* 아래쪽 패널을 여는 입구. 페인을 가리지 않는다 — 프로젝트가 없으면 홈에서 열리므로 어느
              화면에서든 셸을 하나 띄울 수 있다. 예전에는 explorerOpen 이었고 주석도 "파일·에디터 모드
              전용"이라고 적혀 있었는데, 이 패널이 탐색기의 것이 아니게 된 뒤로는 둘 다 거짓이 됐다.
              터미널과 ⚙ 은 .rail-bottom 으로 감싸고 그 wrapper 가 margin-top:auto 를 지므로 둘이 함께
              아래에 붙는다 — 터미널 버튼에 따로 auto 마진을 주면(auto 형제가 둘) 남은 공간이 균등
              분배되어 버튼들이 벌어진다. */}
          <span className="rail-bottom">
            {bottomRoot && (
              <button
                className="rail-btn"
                aria-label={t('terminal.rail.open')}
                title={t('terminal.rail.open')}
                onClick={() => void openTerminal()}
              >
                {/* The same window-plus-prompt shape as IntelliJ's terminal icon. Per the app's SVG
                    convention it is a 16 viewBox in a single currentColor, with only the inner >_
                    dropped to stroke 1.2 — two elements sit inside a 12.8×10.8 window, and at the same
                    1.4 as the outline the ink merges on a 30px button. */}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                >
                  <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6" />
                  <g strokeWidth="1.2" strokeLinecap="round">
                    <path d="M4.5 7.2 6.1 8.8 4.5 10.4" />
                    <line x1="7.8" y1="10.5" x2="11.4" y2="10.5" />
                  </g>
                </svg>
              </button>
            )}
            <button
              className="rail-btn rail-settings"
              aria-label={t('settings.title')}
              title={t('settings.title')}
              onClick={() => setShowSettings(true)}
            >
              ⚙
            </button>
          </span>
        </nav>
        {sidebarOpen && (
          <aside className="sidebar" ref={sidebarRef} style={{ width: sidebarWidth }}>
            {sidebarPane === 'explorer' ? (
              <FileExplorer
                root={currentProject}
                onOpenFile={openFile}
                onClose={() => void closeExplorer()}
                stateRef={explorerTreesRef}
                clipboardRef={explorerClipboardRef}
                undoRef={explorerUndoRef}
                onPathRenamed={handlePathRenamed}
                onPathDeleted={handlePathDeleted}
              />
            ) : sidebarPane === 'jobs' ? (
              <JobsView
                snapshot={orchSnapshot}
                // JobTask.sessionId only says main still has the session record, and main never drops
                // one — SessionManager.kill flips the status and list() keeps exited sessions on
                // purpose. closeSession, on the other hand, takes the tab out of this tree. So after a
                // user closes a finished worker's tab the row would keep full opacity and its click
                // would reach activateTab, find no group, and return null: a silent no-op that only
                // heals on a window reload. The tree is the renderer's, so this is the one condition
                // the fold in main cannot make, and it is exactly what selectWorkbenchTab needs.
                canOpenSession={(sessionId) => !!layout && !!groupOfTab(layout, sessionTab(sessionId))}
                onOpenSession={(sessionId) => selectWorkbenchTab(sessionTab(sessionId))}
                onOpenRun={(runId) => {
                  setDetail(null) // 이전 Run 의 상세가 한 프레임 보이지 않게 한다
                  // 여는 시점의 프로젝트를 runId 와 함께 든다 — 이 스냅샷을 준 프로젝트가 그것이다
                  if (currentProject) setOpenRun({ projectPath: currentProject, runId })
                }}
                onNewRun={() => setNewRunOpen(true)}
              />
            ) : (
              <>
                <AccountPanel accounts={accounts} />
                <WorktreePanel
                  onStartSession={(p) => {
                    setNewSessionCwd(p)
                    setShowNew(true)
                  }}
                />
                <HistoryBrowser
                  accounts={accounts}
                  ghostAccounts={ghostAccounts}
                  onResume={resumeFromHistory}
                />
              </>
            )}
          </aside>
        )}
        {sidebarOpen && (
          <div
            className="resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('common.resizeSidebar')}
            onPointerDown={(e) => {
              e.preventDefault()
              const startId = e.pointerId
              const startX = e.clientX
              const startW = sidebarRef.current?.getBoundingClientRect().width ?? sidebarWidth
              let latestX = startX
              let rafId = 0
              const clamp = (x: number): number => Math.min(520, Math.max(160, startW + x - startX))
              const apply = (): void => {
                rafId = 0
                if (sidebarRef.current) sidebarRef.current.style.width = `${clamp(latestX)}px`
              }
              // MarkdownSplit 의 md-resizer 와 같은 이유로 pointerId 를 확인한다 — window 리스너는
              // 이 드래그를 시작한 포인터가 아닌 다른 포인터(예: 화면 다른 곳의 두 번째 터치 접점)의
              // pointermove/pointerup/pointercancel 도 그냥 받는다. 그 이벤트를 걸러내지 않으면 무관한
              // 포인터가 드래그를 조기에 끝내거나(onUp) 폭을 엉뚱한 좌표로 끌고 간다(onMove).
              const onMove = (ev: PointerEvent): void => {
                if (ev.pointerId !== startId) return
                latestX = ev.clientX
                if (!rafId) rafId = requestAnimationFrame(apply)
              }
              const onUp = (ev: PointerEvent): void => {
                if (ev.pointerId !== startId) return
                if (rafId) cancelAnimationFrame(rafId)
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
                window.removeEventListener('pointercancel', onUp)
                document.body.classList.remove('resizing')
                const w = clamp(latestX)
                setSidebarWidth(w) // React state is synchronised here, once only
                localStorage.setItem('cm.sidebarWidth', String(w))
              }
              document.body.classList.add('resizing')
              window.addEventListener('pointermove', onMove)
              window.addEventListener('pointerup', onUp)
              window.addEventListener('pointercancel', onUp)
            }}
          />
        )}
        <main className="content">
          {/* The container everything shares. Always mounted — .session-view must live inside it so
              opening or closing the explorer does not remount it (same rule as PaneGrid's slots).
              Named .surfaces, not .workbench: the app shell above already uses that class, and giving
              this one the same name silently overrode the shell's flex direction. */}
          <div className="surfaces">
            {/* 페인 격자. 이제 파일 탭과 세션 탭을 함께 담으므로 탐색기를 켜도 물러나지 않는다 —
                에디터는 이 안의 페인 슬롯에 있다 */}
            <div className="session-view">
              <PaneGrid
                layout={layout}
                activePaneId={activePaneId}
                sessions={sessions}
                accounts={accounts}
                fileTabs={fileTabs}
                dirtyFileIds={dirtyIds}
                renderEditor={renderEditor}
                rollStates={rollStates}
                schedStates={schedStates}
                busy={busy}
                draggingTabId={dragTabId}
                newDisabled={!anyCliOk}
                onFocusPane={setActivePaneId}
                onSetRatio={(splitId, ratio) =>
                  setLayout((cur) => (cur ? setRatio(cur, splitId, ratio) : cur))
                }
                onDropTabIntoPane={dropOnPane}
                onRestart={restart}
                onSelectTab={selectWorkbenchTab}
                onCloseTab={closeWorkbenchTab}
                onNewInGroup={newInGroup}
                onTabContextMenu={(tabId, x, y) => setTabMenu({ tabId, x, y })}
                onDragTabChange={setDragTabId}
                onDropTabInBar={dropTabInGroup}
              />
              {/* When the layout is empty (not one group in the tree) there is no group tab bar, so there
                  is no '+' anywhere on screen — this placeholder becomes the sole entry point in its
                  place. Same guard as a group's '+' (newInGroup): with no CLI, pressing it does not open
                  the dialog */}
              {!layout && (
                <button
                  className="placeholder primary"
                  disabled={!anyCliOk}
                  onClick={() => {
                    if (anyCliOk) setShowNew(true)
                  }}
                >
                  {t('session.placeholder.start')}
                </button>
              )}
            </div>
            {/* 아래쪽 패널의 자리. 예전에는 탐색기 페인 안에 있었고 이름도 그랬지만, 이 패널은 탐색기의
                것이 아니다 — Jobs 를 보면서도 빌드를 돌려야 하고, 프로젝트가 아예 없을 때도 셸은 필요하다.
                그래서 페인을 가리지 않고, 경로는 bottomRoot(프로젝트가 없으면 홈)를 쓴다.
                (.run-host 가 flex:none 인 이유는 styles.css 에 있다) */}
            {bottomRoot && (
              <div
                className="run-host"
                ref={runHostRef}
                style={
                  {
                    // Run 콘솔이 이 화면 안에 있으므로 --run-panel-h 는 계속 여기에 둔다(run-resizer가
                    // runHostRef로 이 값을 직접 갱신한다).
                    ['--run-panel-h']: `${runPanelHeight}px`
                  } as React.CSSProperties
                }
              >
                {runPanelOpen && (
                  <div
                    className="run-resizer"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label={t('run.resizeConsole')}
                    onPointerDown={(e) => {
                      e.preventDefault()
                      const startY = e.clientY
                      const startH = runPanelHeight
                      let latestY = startY
                      let rafId = 0
                      const clamp = (y: number): number => Math.min(800, Math.max(120, startH + (startY - y)))
                      const apply = (): void => {
                        rafId = 0
                        runHostRef.current?.style.setProperty('--run-panel-h', `${clamp(latestY)}px`)
                      }
                      const onMove = (ev: PointerEvent): void => {
                        latestY = ev.clientY
                        if (!rafId) rafId = requestAnimationFrame(apply)
                      }
                      const onUp = (): void => {
                        if (rafId) cancelAnimationFrame(rafId)
                        window.removeEventListener('pointermove', onMove)
                        window.removeEventListener('pointerup', onUp)
                        window.removeEventListener('pointercancel', onUp)
                        document.body.classList.remove('resizing-row')
                        const h = clamp(latestY)
                        setRunPanelHeight(h) // React state is synchronised here, once only
                        localStorage.setItem('cm.runPanelHeight', String(h))
                      }
                      document.body.classList.add('resizing-row')
                      window.addEventListener('pointermove', onMove)
                      window.addEventListener('pointerup', onUp)
                      window.addEventListener('pointercancel', onUp)
                    }}
                  />
                )}
                {runPanelOpen && (
                  <BottomPanel
                    projectPath={bottomRoot}
                    runAvailable={runAvailable}
                    runStatus={runActive}
                    terminals={terminals}
                    activeTab={bottomTabShown}
                    onSelectTab={setBottomTab}
                    onNewTerminal={() => void newTerminal()}
                    onCloseTerminal={closeTerminal}
                    onStopRun={runStop}
                    onCollapse={() => setRunPanelOpen(false)}
                  />
                )}
              </div>
            )}
          </div>
        </main>
      </div>
      <div className="statusbar">
        {active ? (
          <>
            <span className="status-account">
              <span
                className="status-dot"
                style={{ background: accounts.find((a) => a.id === active.accountId)?.color ?? '#888' }}
              />
              {accounts.find((a) => a.id === active.accountId)?.label}
            </span>
            <span className="status-item">{active.title}</span>
            <span className="status-item status-path">{active.cwd}</span>
            <span className="status-metrics">
              <UsageChip
                label="Context"
                percent={usage?.context?.usedPercent}
                title={
                  usage?.context
                    ? usage.context.usedTokens != null && usage.context.windowSize != null
                      ? t('session.usage.contextTitleWithTokens', {
                          used: usage.context.usedTokens.toLocaleString(),
                          window: usage.context.windowSize.toLocaleString()
                        })
                      : t('session.usage.contextTitle')
                    : t('session.usage.contextEmpty')
                }
              />
              <UsageChip
                label={t('session.usage.fiveHourLabel')}
                percent={usage?.session?.usedPercent}
                resetsAt={usage?.session?.resetsAt}
                title={t('session.usage.fiveHourTitle')}
              />
              <UsageChip
                label={t('session.usage.weekly')}
                percent={usage?.weekly?.usedPercent}
                resetsAt={usage?.weekly?.resetsAt}
                title={t('session.usage.weekly')}
              />
            </span>
            <span className="sp">{t('session.statusbar.count', { count: sessions.length })}</span>
          </>
        ) : (
          <>
            <span>{t('session.statusbar.none')}</span>
            <span className="sp">{t('session.statusbar.accountCount', { count: accounts.length })}</span>
          </>
        )}
      </div>
      {showNew && (
        <NewSessionDialog
          accounts={accounts}
          runningCount={runningCount}
          initialCwd={newSessionCwd}
          // The promise is passed straight through — the dialog awaits it to show a start-pending state
          // (discarding it with void would make the wait look instantly over)
          onSpawn={spawn}
          onCancel={() => {
            // Cancels the split Ctrl+\ reserved — closing the dialog leaves no empty pane
            pendingSplitRef.current = null
            setShowNew(false)
            setNewSessionCwd(null)
          }}
        />
      )}
      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal settings" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <h2>{t('settings.title')}</h2>
              <button
                className="settings-close"
                aria-label={t('common.close')}
                title={t('common.close')}
                onClick={() => setShowSettings(false)}
              >
                ✕
              </button>
            </div>
            <div className="settings-body">
              <nav className="settings-nav">
                {(
                  [
                    ['general', t('settings.tab.general')],
                    ['accounts', t('settings.tab.accounts')],
                    ['info', t('settings.tab.info')],
                    ['shortcuts', t('settings.tab.shortcuts')],
                    ['slack', 'Slack'],
                    ['worktree', 'Worktree'],
                    ['history', t('settings.tab.history')]
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    className={`settings-nav-item ${settingsTab === key ? 'active' : ''}`}
                    onClick={() => setSettingsTab(key)}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              <div className="settings-content">
                {settingsTab === 'general' && (
                  <>
                    <div className="settings-row">
                      <span>{t('settings.general.language')}</span>
                      <Select
                        className="settings-lang-select"
                        items={[
                          {
                            value: SYSTEM_LANG,
                            label: t('settings.general.language.system', {
                              lang: CATALOGS[systemLang].nativeName
                            })
                          },
                          // Each language is written in its own language, so it can be found without
                          // knowing the current one. Not a translation target.
                          ...LANGS.map((l) => ({ value: l, label: CATALOGS[l].nativeName }))
                        ]}
                        value={storedLang ?? SYSTEM_LANG}
                        onChange={(v) => setLang(v === SYSTEM_LANG ? null : (v as Lang))}
                        ariaLabel={t('settings.general.language')}
                      />
                    </div>
                    {/* Agent orchestration — reuses the same settings-row plus settings-hint
                        combination as the language row. Turning it on starts the server immediately, but
                        sessions that are already running do not get the CLI path (environment variables
                        are fixed at spawn time) — the hint text says so.
                        Why the container is a label rather than a div: pressing the text has to toggle it
                        too (the same wrapping approach the checkboxes in NewSessionDialog use). The flex
                        and colour rules of settings-row apply regardless of the tag. */}
                    <label className="settings-row">
                      <span>{t('settings.orchestration.label')}</span>
                      <input
                        type="checkbox"
                        checked={orchEnabled}
                        onChange={(e) => {
                          const next = e.target.checked
                          setOrchEnabled(next) // an optimistic update — reverted below on failure
                          void window.api.settings.setOrchestrationEnabled(next).catch((err) => {
                            setOrchEnabled(!next)
                            toast.error(
                              t('settings.orchestration.saveFailed', {
                                detail: err instanceof Error ? err.message : String(err)
                              })
                            )
                          })
                        }}
                      />
                    </label>
                    <span className="settings-hint">{t('settings.orchestration.hint')}</span>
                    <TerminalFontSettings />
                  </>
                )}
                {settingsTab === 'accounts' && <AccountSettings accounts={accounts} />}
                {settingsTab === 'info' && (
                  <>
                    <div className="settings-row">
                      <span>{t('settings.info.appName')}</span>
                      <span>Astera</span>
                    </div>
                    <div className="settings-row">
                      <span>{t('settings.info.version')}</span>
                      <span>{appVersion || '…'}</span>
                    </div>
                    <div className="settings-row">
                      <span>Claude CLI</span>
                      <span>{cli?.claude.version ?? t('settings.info.cliNotDetected')}</span>
                    </div>
                    <div className="settings-row">
                      <span>Codex CLI</span>
                      <span>{cli?.codex.version ?? t('settings.info.cliNotDetected')}</span>
                    </div>
                    <div className="settings-row">
                      <span>{t('settings.info.registeredAccounts')}</span>
                      <span>{accounts.length}</span>
                    </div>
                    <div className="settings-row">
                      {/* When the check time widens the cell, the label used to break across lines in a narrow modal */}
                      <span className="update-label">{t('settings.info.update')}</span>
                      <span className="update-cell">
                        {update?.state === 'downloading' ? (
                          <span className="update-note">{t('update.info.downloading', { percent: update.percent ?? 0 })}</span>
                        ) : (
                          <>
                            {/* The check button stays even with a version already downloaded — when a
                                newer one appears you have to be able to skip the staged build and go to
                                that instead. If a re-check finds a newer version, autoDownload replaces
                                the staged file and this button's version changes with it. */}
                            {update?.state === 'downloaded' && (
                              <button onClick={() => void window.api.update.install()}>
                                {t('update.info.restartInstallVersion', { version: update.version ?? '' })}
                              </button>
                            )}
                            <button
                              disabled={updateChecking}
                              onClick={() => {
                                setCheckClickedAt(Date.now())
                                void window.api.update.check()
                              }}
                            >
                              {updateChecking ? t('update.info.checking') : t('update.info.checkButton')}
                            </button>
                            {/* The result text is hidden while checking — 'Checking…' and the previous
                                result showing at once contradict each other. Even when the result is
                                always the same because it is up to date, the check time changes, so the
                                press is visible. */}
                            {!updateChecking && update?.state === 'uptodate' && update.checkedAt !== null && (
                              <span className="update-note">
                                {t('update.info.upToDateAt', { time: formatCheckedAt(update.checkedAt) })}
                              </span>
                            )}
                            {/* autoDownload normally carries 'available' straight on to 'downloading',
                                so this button covers the window before that starts and a download that
                                failed. It is the only such trigger that does not depend on a campaign —
                                the other two callers of update.download(), the toast and UpdateGate,
                                open only when policy.json carries one. */}
                            {!updateChecking && update?.state === 'available' && (
                              <>
                                <button onClick={() => void window.api.update.download()}>
                                  {t('update.info.downloadVersion', { version: update.version ?? '' })}
                                </button>
                                <span className="update-note">{t('update.info.available', { version: update.version ?? '' })}</span>
                              </>
                            )}
                            {!updateChecking && update?.state === 'error' && (
                              <span className="update-note update-err" title={update.message}>
                                {t('update.info.checkFailed')}
                              </span>
                            )}
                          </>
                        )}
                      </span>
                    </div>
                  </>
                )}
                {settingsTab === 'shortcuts' && (
                  <ShortcutSettings overrides={keyOverrides} onChanged={setKeyOverrides} />
                )}
                {settingsTab === 'shortcuts' &&
                  SHORTCUTS.map((g) => (
                    <div className="shortcut-group" key={g.group}>
                      <div className="shortcut-group-title">{t(g.group)}</div>
                      {g.items.map((it) => (
                        <div className="shortcut-row" key={it.desc}>
                          <span className="shortcut-keys">
                            {it.gestureKey ? (
                              <kbd>{t(it.gestureKey)}</kbd>
                            ) : (
                              it.keys.map((k, i) => (
                                <span key={k}>
                                  {i > 0 && <span className="shortcut-or">{t('common.or')}</span>}
                                  <kbd>{k}</kbd>
                                </span>
                              ))
                            )}
                          </span>
                          <span className="shortcut-desc">{t(it.desc)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                {settingsTab === 'slack' && (
                  <div className="settings-slack">
                    <label className="settings-field-label">Slack Webhook URL</label>
                    <input
                      type="text"
                      className="slack-url-input"
                      value={slackUrl}
                      placeholder="https://hooks.slack.com/services/…"
                      onChange={(e) => {
                        setSlackUrl(e.target.value)
                        setSlackSaved(false)
                      }}
                    />
                    {/* Bot configuration. Tokens are password inputs — it reduces exposure over a shared
                        screen or a shoulder. Once filled, a password shows only ●●●, so every field needs
                        a label to say what it is */}
                    <label className="settings-field-label">{t('settings.slack.botSection')}</label>
                    <label className="settings-field-label">Bot Token</label>
                    <input
                      type="password"
                      className="slack-url-input"
                      value={slackBotToken}
                      placeholder="xoxb-…"
                      onChange={(e) => {
                        setSlackBotToken(e.target.value)
                        setSlackSaved(false)
                      }}
                    />
                    <label className="settings-field-label">Channel ID</label>
                    <input
                      type="text"
                      className="slack-url-input"
                      value={slackChannelId}
                      placeholder="C0123456789"
                      onChange={(e) => {
                        setSlackChannelId(e.target.value)
                        setSlackSaved(false)
                      }}
                    />
                    <span className="settings-hint">{t('settings.slack.channelIdHint')}</span>
                    <label className="settings-field-label">App Token</label>
                    <input
                      type="password"
                      className="slack-url-input"
                      value={slackAppToken}
                      placeholder="xapp-…"
                      onChange={(e) => {
                        setSlackAppToken(e.target.value)
                        setSlackSaved(false)
                      }}
                    />
                    <span className="settings-hint">{t('settings.slack.appTokenHint')}</span>
                    {/* The one member allowed to reply into sessions. The channel alone is not a
                        permission boundary — anyone invited there could push input into a session — so
                        replies are matched against this ID. Left empty, every reply is blocked rather
                        than allowed (core/slack/inbound.ts), which is why the warning below is loud. */}
                    <label className="settings-field-label">Member ID</label>
                    <input
                      type="text"
                      className="slack-url-input"
                      value={slackMemberId}
                      placeholder="U0123456789"
                      onChange={(e) => {
                        setSlackMemberId(e.target.value)
                        setSlackSaved(false)
                      }}
                    />
                    <span className="settings-hint">{t('settings.slack.memberIdHint')}</span>
                    {/* Gated on bot mode, not on the full intake condition (which also needs the app
                        token): slackMode() is the verdict core already owns, so no third place gets to
                        judge "is the bot on" and drift from it. In bot mode without an app token there
                        is no intake at all, and the warning still reads true there. */}
                    {slackMode({
                      webhookUrl: slackUrl.trim() || null,
                      botToken: slackBotToken.trim() || null,
                      channelId: slackChannelId.trim() || null
                    }) === 'bot' &&
                      slackMemberId.trim() === '' && (
                        <span className="update-note update-err">
                          {t('settings.slack.memberIdRequired')}
                        </span>
                      )}
                    <div className="slack-cell">
                      <button
                        disabled={!slackLoaded}
                        onClick={() =>
                          void window.api.slack
                            .setConfig({
                              webhookUrl: slackUrl.trim() || null,
                              botToken: slackBotToken.trim() || null,
                              channelId: slackChannelId.trim() || null,
                              appToken: slackAppToken.trim() || null,
                              memberId: slackMemberId.trim() || null
                            })
                            .then(() => setSlackSaved(true))
                            // A rejection means the store refused to overwrite values it could not read —
                            // the settings on disk survived. Saying so beats a silently dead button, since
                            // "Saved" never appears either way.
                            .catch((err) =>
                              toast.error(
                                t('settings.slack.saveFailed', {
                                  detail: err instanceof Error ? err.message : String(err)
                                })
                              )
                            )
                        }
                      >
                        {t('settings.slack.save')}
                      </button>
                      {slackSaved && <span className="update-note">{t('settings.slack.saved')}</span>}
                    </div>
                    {/* Shows immediately which transport the current input adds up to — filling in a bot
                        token but leaving out the channel ID falls back to the Webhook silently, so that
                        has to be visible. The verdict uses slackMode() from core: it has to be the same
                        function that applyConfig (in main) and the notification checkbox gating use, so
                        one side cannot drift from the other */}
                    <span className="settings-hint">
                      {t(
                        (
                          {
                            bot: 'settings.slack.modeBot',
                            webhook: 'settings.slack.modeWebhook',
                            off: 'settings.slack.modeOff'
                          } as const
                        )[
                          slackMode({
                            webhookUrl: slackUrl.trim() || null,
                            botToken: slackBotToken.trim() || null,
                            channelId: slackChannelId.trim() || null
                          })
                        ]
                      )}
                    </span>
                    <span className="settings-hint">{t('settings.slack.hint')}</span>
                    <span className="settings-hint">{t('settings.slack.setupGuide')}</span>
                  </div>
                )}
                {settingsTab === 'worktree' && (
                  <div className="settings-worktree">
                    <label className="settings-field-label">{t('settings.worktree.createLocation')}</label>
                    <div className="worktree-root-cell">
                      <span className="worktree-root-path" title={wtRoot}>
                        {wtRoot || '…'}
                      </span>
                      <button
                        onClick={() =>
                          void window.api.system.pickFolder().then(async (dir) => {
                            if (!dir) return
                            await window.api.worktrees.setRoot(dir)
                            setWtRoot(dir)
                          })
                        }
                      >
                        {t('settings.worktree.change')}
                      </button>
                    </div>
                    <span className="settings-hint">
                      {t('settings.worktree.hint')}
                    </span>
                  </div>
                )}
                {settingsTab === 'history' && <HistorySettings />}
              </div>
            </div>
          </div>
        </div>
      )}
      {/* The pane tab context menu — the entry point for split and unsplit. It serves both kinds of tab:
          the id goes to the tree unread, and Close takes the same path the tab's × does (a dirty file
          still asks for confirmation, a session is still ended). What gets split is the group the
          right-clicked tab belongs to, not the active pane — so right-clicking a tab in another group
          does not split the wrong one (the same as IntelliJ). */}
      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          onClose={() => setTabMenu(null)}
          items={((): MenuItem[] => {
            const cur = layout
            const tid = tabMenu.tabId
            const group = cur ? groupOfTab(cur, tid) : null
            const atMax = cur != null && countLeaves(cur) >= MAX_PANES
            // With only one tab in the group, splitting changes nothing (splitAndMove returns null) — shown as disabled
            const cantSplit = !group || atMax || group.tabIds.length < 2
            const split = (dir: PaneDir): void => {
              if (!cur || !group) return
              const res = splitAndMove(cur, tid, group.id, dir, false)
              if (!res) return
              setLayout(res.root)
              setActivePaneId(res.paneId)
            }
            return [
              {
                label: t('session.pane.splitRight'),
                disabled: cantSplit,
                onSelect: () => split('row')
              },
              {
                label: t('session.pane.splitDown'),
                disabled: cantSplit,
                onSelect: () => split('col')
              },
              {
                label: t('session.pane.unsplit'),
                disabled: cur == null || countLeaves(cur) < 2,
                onSelect: () => group && unsplitPane(group.id)
              },
              'separator',
              { label: t('common.close'), danger: true, onSelect: () => closeWorkbenchTab(tid) }
            ]
          })()}
        />
      )}
      {/* Re-checks currentProject/runContext directly (rather than just runManagerVisible) so TypeScript
          narrows them to non-null here, instead of an assertion */}
      {runManagerOpen && currentProject && runContext && (
        <RunConfigManager
          configs={runConfigs}
          context={runContext}
          isSpringBoot={runIsSpringBoot}
          isPythonProject={runIsPythonProject}
          hasDockerfile={runHasDockerfile}
          projectPath={currentProject}
          onSave={runManagerSave}
          onDelete={runDeleteConfig}
          onClose={() => setRunManagerOpen(false)}
        />
      )}
      {openRun && (
        <RunDetail
          // 그래프의 노드는 제목·상태·세션을 스냅샷에서 읽는다(detail 의 layers 는 id 뿐이다).
          // 그 Run 이 스냅샷에서 사라졌으면(다른 프로젝트로 갔거나 지워졌다) undefined 다.
          run={orchSnapshot?.runs.find((r) => r.id === openRun.runId)}
          detail={detail}
          // Verbatim the pair JobsView is handed above, and for the reason its comment there records:
          // the tab tree is the only place that knows whether the worker's tab is still open, so a
          // sessions.some(...) check would keep saying yes after the user closed it and the ↗ would
          // silently do nothing.
          canOpenSession={(sessionId) => !!layout && !!groupOfTab(layout, sessionTab(sessionId))}
          onOpenSession={(sessionId) => {
            setOpenRun(null) // 탭으로 가면서 닫는다
            selectWorkbenchTab(sessionTab(sessionId))
          }}
          onClose={() => setOpenRun(null)}
        />
      )}
      {/* currentProject 가 있을 때만 그린다 — 없으면 run-create 에 넘길 cwd 가 없어 만들 자리가
          없다(JobsView 의 jobs 사이드바 자체도 currentProject 없이는 열리지 않는다). */}
      {newRunOpen && currentProject && (
        <NewRunModal
          projectPath={currentProject}
          onClose={() => setNewRunOpen(false)}
          onCreated={(runId) => {
            setNewRunOpen(false)
            // 만들자마자 상세 창을 열어 Task 를 짤 수 있게 한다 — onOpenRun 이 하는 것과 같은 짝
            setOpenRun({ projectPath: currentProject, runId })
          }}
        />
      )}
      <ConfirmHost />
      <ToastHost />
    </div>
  )
}
