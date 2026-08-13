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
import type { EditorState, StateEffect } from '@codemirror/state'
import { EditorStateCache } from './lib/editorStateCache'
import { FileExplorer, type ExplorerTreeState } from './components/FileExplorer'
import { NewSessionDialog } from './components/NewSessionDialog'
import { WorktreePanel } from './components/WorktreePanel'
import { RunToolbar } from './components/RunToolbar'
import { BottomPanel } from './components/BottomPanel'
import { ToastHost } from './components/ToastHost'
import { UpdateGate } from './components/UpdateGate'
import { ShortcutSettings } from './components/ShortcutSettings'
import { TerminalFontSettings } from './components/TerminalFontSettings'
import { ConfirmHost } from './components/ConfirmHost'
import type { RunConfig, RunStatus, TerminalBuffer } from '../../core/types'
import { slackMode } from '../../core/slack/ready'
import { findActionForEvent, resolveBindings, type Bindings } from '../../core/keys/binding'
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
import type { UndoEntry } from '../../core/files/undo'
import * as sessionBus from './lib/sessionBus'
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
  runSlot
}: {
  isMax: boolean
  update: UpdateStatus | null
  /** 타이틀바 줄에 함께 놓이는 것 — 지금은 실행 구성 툴바다. 프롭 열넷을 내려보내는 대신 슬롯으로
   *  받아, 타이틀바는 무엇이 들어오는지 모른 채 자리만 내준다 */
  runSlot?: React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  // On macOS, window controls are handled by the OS traffic-light buttons. Drawing our own controls
  // too would put the same functionality at both ends of the window. .titlebar--mac reserves the
  // left-hand margin the traffic lights sit in.
  const isMac = window.api.platform === 'darwin'
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
            onClick={() => window.api.win.close()}
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
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [explorerOpen, setExplorerOpen] = useState(false) // the file explorer toggle
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
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const activePaneIdRef = useRef(activePaneId)
  activePaneIdRef.current = activePaneId
  // The run configuration modal (its state lives inside RunToolbar) also suppresses global shortcuts.
  // The setter is passed through directly because RunToolbar uses this callback as a useEffect
  // dependency — recreating it on every render would flicker the suppression between false and true.
  // A useState setter has a stable identity.
  const [runModalOpen, setRunModalOpen] = useState(false)
  const modalOpenRef = useRef(false)
  modalOpenRef.current = showNew || showSettings || runModalOpen
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
    void window.api.settings.getOrchestrationEnabled().then(setOrchEnabled) // orchestration toggle's initial state
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
    const root = explorerRootRef.current
    if (!root) return // 트리가 없는 상태에서는 파일을 열 수 없다 — 열 수단 자체가 트리다
    const title = path.split(/[\\/]/).pop() || path
    setFileTabs((prev) => [...prev, { id, path, title, projectRoot: root }])
    // 파일 탭도 세션 탭과 같은 트리에 들어간다 — 활성 페인의 새 탭으로 열린다. 세션을 놓을 때와 같은
    // 함수를 쓰므로 배치 규칙이 한 벌뿐이다. StrictMode 대비로 setLayout 콜백 밖에서 계산한다
    const placed = placeTab(layoutRef.current, id, { activePaneId: activePaneIdRef.current })
    setLayout(placed.root)
    if (placed.paneId) setActivePaneId(placed.paneId)
    setFileBuffers((prev) => ({ ...prev, [id]: { content: '', savedContent: '', eol: '\n', readOnly: false, loading: true, error: null, conflict: false } }))
    window.api.files.read(path).then(
      (d) => setFileBuffers((prev) => (prev[id] ? { ...prev, [id]: { content: toLf(d.content), savedContent: toLf(d.content), eol: detectEol(d.content), readOnly: d.truncated || d.binary, loading: false, error: d.binary ? t('files.editor.binaryUnsupported') : null, conflict: false } } : prev)),
      (err) => setFileBuffers((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], loading: false, error: err instanceof Error ? err.message : String(err) } } : prev))
    )
  }

  /** 에디터가 사라질 때 그 상태를 캐시에 넘겨받는다. 세션 모드로 나가면 .explorer-view가 통째로
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
  useEffect(() => {
    const off = window.api.on('files:changed', (c) => {
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

  // Toggling explorer mode — Ctrl+Tab or Ctrl+Shift+E. Explorer state (file tabs, pin, expansion) is preserved
  const toggleExplorer = (): void => {
    setExplorerOpen((v) => !v)
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
  const explorerViewRef = useRef<HTMLDivElement>(null)

  /** 트리 루트는 활성 탭을 따른다 — 활성 탭이 파일이면 그 파일의 프로젝트, 세션이면 그 세션의 cwd.
   *  탭이 없으면 null이다. 보고 있는 것과 트리가 항상 일치하는 것이 이 규칙의 목적이다.
   *
   *  히스토리와 worktree 목록에 있던 '탐색기에서 열기'는 이 규칙과 양립하지 않아 없앴다. 그 버튼들은
   *  루트를 핀으로 고정하려 했는데, 활성 탭이 언제나 이기므로 다른 프로젝트를 지정해도 화면은 보고
   *  있던 프로젝트를 계속 보여줬다 — 아무 일도 하지 않는 버튼이었다. */
  const explorerRoot =
    (activeTab?.kind === 'file'
      ? fileTabs.find((t) => t.id === activeTabId)?.projectRoot
      : sessions.find((s) => s.id === activeTab?.id)?.cwd) ?? null

  // Mirrors explorerRoot into a ref — avoids a stale closure in the run:status subscription effect
  const explorerRootRef = useRef(explorerRoot)
  explorerRootRef.current = explorerRoot

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
  const renderEditor = (_paneId: string, fileTabId: string): React.ReactNode => {
    const f = fileTabs.find((t) => t.id === fileTabId)
    const buf = fileBuffers[fileTabId]
    if (!f || !buf) return null
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
          <FileEditor
            path={f.path}
            content={buf.content}
            readOnly={buf.readOnly}
            cache={editorCacheRef.current}
            onRetire={retireEditorState}
            onChange={(next) => setBufferContent(f.id, next)}
            onSave={() => saveFile(f.id)}
          />
          {buf.loading && <div className="file-overlay">{t('files.editor.loading')}</div>}
          {!buf.loading && buf.error && <div className="file-overlay">{buf.error}</div>}
        </div>
      </div>
    )
  }

  // Loads that project's run configurations and active run whenever the explorer root or open state changes
  useEffect(() => {
    if (!explorerOpen || !explorerRoot) return
    let cancelled = false
    void window.api.run.list(explorerRoot).then((r) => {
      if (cancelled) return
      setRunConfigs(r.configs)
      setRunActive(r.active)
      setRunIsSpringBoot(r.isSpringBoot)
      setRunSelectedId((prev) => (r.configs.some((c) => c.id === prev) ? prev : r.active?.configId ?? r.configs[0]?.id ?? null))
      if (r.active?.status === 'running') setRunPanelOpen(true)
    })
    return () => { cancelled = true }
  }, [explorerOpen, explorerRoot])

  // When the project changes, that project's terminal list is read again — main holds them per project,
  // so another project's terminals stay alive and are simply not shown here
  useEffect(() => {
    if (!explorerOpen || !explorerRoot) {
      setTerminals([])
      return
    }
    let cancelled = false
    void window.api.terminal.list(explorerRoot).then(
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
  }, [explorerOpen, explorerRoot])

  // An event subscription (refreshed by run:status) plus one initial query, instead of polling all active runs
  useEffect(() => {
    void window.api.run.listActive().then(setActiveRuns)
    const off = window.api.on('run:status', (s) => {
      void window.api.run.listActive().then(setActiveRuns)
      // If the run belongs to the current workbench project, the local state is updated too
      if (explorerRootRef.current && s.projectPath === explorerRootRef.current) setRunActive(s)
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
      'pom.xml', 'mvnw', 'mvnw.cmd'
    ])
    const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
    const off = window.api.on('files:changed', (c) => {
      const root = explorerRootRef.current
      if (!root) return
      const base = c.path.split(/[\\/]/).pop() ?? ''
      if (!SEED_FILES.has(base) || norm(parentDir(c.path)) !== norm(root)) return
      void window.api.run.list(root).then((r) => {
        setRunConfigs(r.configs)
        setRunIsSpringBoot(r.isSpringBoot)
        setRunSelectedId((prev) => (r.configs.some((cc) => cc.id === prev) ? prev : r.active?.configId ?? r.configs[0]?.id ?? null))
      })
    })
    return off
  }, [])

  const runStart = (): void => {
    if (!explorerRoot || !runSelectedId) return
    const root = explorerRoot
    void window.api.run.start(root, runSelectedId).then(
      async (st) => {
        setRunActive(st)
        // Starting a Run may be what opens the panel for the first time — and that also mounts this
        // project's existing terminal tabs (in a hidden state). TerminalBody replays initialBuffer only
        // once, at mount, and ignores later updates, so the latest buffer has to be read *before* the
        // setRunPanelOpen(true) that causes the mount — the same reason as in openTerminal.
        if (terminals.length > 0) {
          const list = await window.api.terminal.list(root).catch(() => terminals)
          // If the project changes while this is in flight, the result is discarded — explorerRootRef is
          // the same idiom the other async callbacks in this file use against stale closures. Without
          // discarding, the screen shows the new project while the panel holds the previous project's
          // terminal tabs, and input goes to that shell.
          if (explorerRootRef.current !== root) return
          setTerminals(list)
        }
        setRunPanelOpen(true)
      },
      (err) => toast.error(t('run.start.failed', { detail: err instanceof Error ? err.message : String(err) }))
    )
  }
  const runStop = (): void => {
    if (explorerRoot) void window.api.run.stop(explorerRoot)
  }
  const runAddConfig = (name: string, command: string, env?: Record<string, string>, cwd?: string): void => {
    if (!explorerRoot) return
    const config: RunConfig = { id: `user:${name}:${command}`, name, command, env, cwd }
    void window.api.run.saveConfig(explorerRoot, config).then(
      () => {
        void window.api.run.list(explorerRoot).then((r) => { setRunConfigs(r.configs); setRunSelectedId(config.id) })
      },
      // The cwd validation in run.saveConfig rejects a working folder outside the project here — before
      // the JDK and working-folder fields existed there was effectively no way to fail on this path, so
      // the error handling was missing.
      (err) => toast.error(t('run.config.saveFailed', { detail: err instanceof Error ? err.message : String(err) }))
    )
  }
  const runEditConfig = (
    id: string,
    name: string,
    command: string,
    env?: Record<string, string>,
    cwd?: string
  ): void => {
    if (!explorerRoot) return
    void window.api.run.saveConfig(explorerRoot, { id, name, command, env, cwd }).then(
      () => {
        void window.api.run.list(explorerRoot).then((r) => { setRunConfigs(r.configs); setRunSelectedId(id) })
      },
      (err) => toast.error(t('run.config.saveFailed', { detail: err instanceof Error ? err.message : String(err) }))
    )
  }
  const runDeleteConfig = (id: string): void => {
    if (!explorerRoot) return
    void window.api.run.deleteConfig(explorerRoot, id).then(() => {
      void window.api.run.list(explorerRoot).then((r) => {
        setRunConfigs(r.configs)
        setRunSelectedId((prev) => (r.configs.some((c) => c.id === prev) ? prev : r.configs[0]?.id ?? null))
      })
    })
  }
  /** 실행 중 목록에서 다른 프로젝트로 점프. 트리 루트는 활성 탭이 정하므로, 그 프로젝트에 속한 탭을
   *  활성으로 만드는 것이 곧 '그리로 간다'는 뜻이다. 세션을 먼저 찾고 없으면 그 프로젝트의 파일 탭을
   *  쓴다. 둘 다 없으면 갈 곳이 없으므로 아무 일도 하지 않는다 — 예전처럼 루트만 핀으로 바꿔 두면
   *  활성 탭이 그대로라 화면은 움직이지 않는다. */
  const runJump = (projectPath: string): void => {
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const target = norm(projectPath)
    const session = sessionsRef.current.find((s) => norm(s.cwd) === target)
    if (session) {
      selectWorkbenchTabRef.current(sessionTab(session.id))
      return
    }
    const file = fileTabsRef.current.find((t) => norm(t.projectRoot) === target)
    if (file) selectWorkbenchTabRef.current(file.id)
  }
  const runStopProject = (projectPath: string): void => { void window.api.run.stop(projectPath) }

  // openTerminal calls newTerminal below, so it is declared first to match reading order — an arrow
  // function is not hoisted, but this is only definition order rather than execution, so no order can
  // produce a runtime reference error (both are created when the component body runs, and the actual
  // call happens later on a click, by which time openTerminal's closure over newTerminal is initialised).
  const newTerminal = async (): Promise<void> => {
    if (!explorerRoot) return
    try {
      const info = await window.api.terminal.open(explorerRoot)
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
    if (!explorerRoot) return
    const root = explorerRoot
    if (terminals.length > 0) {
      // Collapsing unmounts BottomPanel and every TerminalBody inside it (the runPanelOpen gate).
      // TerminalBody replays initialBuffer only once, at mount, and ignores later updates, so the latest
      // buffer has to be read *before* the setRunPanelOpen(true) that causes the remount — updating
      // terminals after the mount does not reach an xterm that is already mounted.
      const list = await window.api.terminal.list(root).catch(() => terminals)
      // If the project changes while this is in flight, the result is discarded — the project-load
      // effect has already set the new project's list, so overwriting with the old result would leave
      // the screen on the new project while the active tab is the previous project's terminal, sending
      // input to that shell.
      if (explorerRootRef.current !== root) return
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
        <Titlebar isMax={isMax} update={update} />
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
        runSlot={
          explorerRoot ? (
            <div className="tb-run">
              <RunToolbar
                configs={runConfigs}
                selectedId={runSelectedId}
                onSelect={setRunSelectedId}
                active={runActive}
                onRun={runStart}
                onStop={runStop}
                onAddConfig={runAddConfig}
                onEditConfig={runEditConfig}
                onDeleteConfig={runDeleteConfig}
                activeRuns={activeRuns}
                onJump={runJump}
                onStopProject={runStopProject}
                onModalOpenChange={setRunModalOpen}
                projectPath={explorerRoot}
                isSpringBoot={runIsSpringBoot}
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
          {/* The bottom panel is for file and editor mode only, so the terminal is exposed only in that
              mode. The terminal and ⚙ are wrapped in .rail-bottom and that wrapper carries
              margin-top:auto so the two stick to the bottom together — giving the terminal button its
              own auto margin as well (two auto siblings) would distribute the free space evenly and
              push the buttons apart. */}
          <span className="rail-bottom">
            {explorerOpen && (
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
        {(sidebarOpen || explorerOpen) && (
          <aside className="sidebar" ref={sidebarRef} style={{ width: sidebarWidth }}>
            {explorerOpen ? (
              <FileExplorer
                root={explorerRoot}
                onOpenFile={openFile}
                onClose={() => void closeExplorer()}
                stateRef={explorerTreesRef}
                clipboardRef={explorerClipboardRef}
                undoRef={explorerUndoRef}
                onPathRenamed={handlePathRenamed}
                onPathDeleted={handlePathDeleted}
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
        {(sidebarOpen || explorerOpen) && (
          <div
            className="resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('common.resizeSidebar')}
            onPointerDown={(e) => {
              e.preventDefault()
              const startX = e.clientX
              const startW = sidebarRef.current?.getBoundingClientRect().width ?? sidebarWidth
              let latestX = startX
              let rafId = 0
              const clamp = (x: number): number => Math.min(520, Math.max(160, startW + x - startX))
              const apply = (): void => {
                rafId = 0
                if (sidebarRef.current) sidebarRef.current.style.width = `${clamp(latestX)}px`
              }
              const onMove = (ev: PointerEvent): void => {
                latestX = ev.clientX
                if (!rafId) rafId = requestAnimationFrame(apply)
              }
              const onUp = (): void => {
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
            {/* 탐색기 계통의 아래쪽 — 에디터 본문이 페인으로 옮겨 갔으므로 이제 Run 콘솔과 그 리사이저만
                들어 있다 (.explorer-view가 flex:none인 이유가 styles.css에 있다) */}
            {explorerOpen && (
              <div
                className="explorer-view"
                ref={explorerViewRef}
                style={
                  {
                    // Run 콘솔이 이 화면 안에 있으므로 --run-panel-h 는 계속 여기에 둔다(run-resizer가
                    // explorerViewRef로 이 값을 직접 갱신한다).
                    ['--run-panel-h']: `${runPanelHeight}px`
                  } as React.CSSProperties
                }
              >
                {runPanelOpen && explorerRoot && (
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
                        explorerViewRef.current?.style.setProperty('--run-panel-h', `${clamp(latestY)}px`)
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
                {runPanelOpen && explorerRoot && (
                  <BottomPanel
                    projectPath={explorerRoot}
                    runStatus={runActive}
                    terminals={terminals}
                    activeTab={bottomTab}
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
      <ConfirmHost />
      <ToastHost />
    </div>
  )
}
