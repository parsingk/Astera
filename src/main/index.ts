import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  shell,
  webContents,
  Notification,
  // Squirrel.Mac itself, not electron-updater's wrapper around it. Only listened to — see the
  // staging block below for why its verdict has to be read separately from electron-updater's.
  autoUpdater as squirrel
} from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { AppUpdater } from 'electron-updater'
import iconAsset from '../../resources/icon.png?asset'
import trayAsset from '../../resources/tray.png?asset'
import { createCore, type Core } from './core'
import { clearAppRunning, markAppRunning } from '../core/host/pidFile'
import { applyLoginPath } from './loginPath'
import { shouldForceWaylandOzone } from './ozone'
import { registerIpc, parseAllowedExternalUrl, type OrchHandle } from './ipc'
import { isOwnDocument } from './navigationGuard'
import { installPreviewGuards } from './preview/guest'
import { AgentGuestRegistry } from './agentBrowser/registry'
import { registerPreviewDevTools } from './preview/devtools'
import { registerPreviewEmulation } from './preview/emulation'
import { registerPreviewCapture } from './preview/capture'
import { RollingCoordinator } from '../core/rolling/claudeCoordinator'
import { SchedulerCoordinator } from './scheduler'
import { chatDriver, ptyDriver, routedDriver } from '../core/sessions/sessionDriver'
import { CodexRollingCoordinator } from '../core/rolling/codexCoordinator'
import { BlockRegistry } from '../core/rolling/blockRegistry'
import type { RollSnapshot } from '../core/rolling/snapshot'
import { memoiseLoginStatus } from '../core/accounts/loginStatusCache'
import { SlackNotifier, SlackConfigStore } from './slack'
import { SlackInboxController, createSocketClient } from './slackInbox'
import { HookEventWatcher } from '../core/hooks/eventWatcher'
import { fanOutHookEvent } from './hookFanOut'
import { DesktopNotifier } from './desktopNotifier'
import { createAttentionState } from './attention'
import { createPendingPromptState } from './pendingPrompt'
import { CodexRolloutWatcher } from './codexRolloutWatcher'
import { t } from '../core/i18n'
import { loadPolicy, nextCheckDelayMs, parsePolicyUrl, shouldApplyCampaign } from './updatePolicy'
import {
  NOTHING_STAGED,
  extractForManualInstall,
  installRoute,
  reduceStaging,
  type StagingEvent,
  type StagingState
} from './manualInstall'
import type { SessionInfo, RollStateEvent, UpdateCampaignInfo, InstallOutcome } from '../core/types'
import { providerOf } from '../core/providers/meta'
import { USAGE_GATE_MAX_AGE_MS } from '../core/usage/rateLimitFetcher'

// The dev (unpackaged) app uses a different userData folder than the installed one. The installer
// writes to %APPDATA%\Astera, and because Windows is case-insensitive the dev build (app name
// 'astera') would otherwise share that exact folder. When it does, launching dev makes
// createCore -> StatusLineManager.init() recreate the hook-events directory (rm+mkdir), which
// orphans the installed app's HookEventWatcher (fs.watch) on the deleted directory and silently
// stops its Slack notifications. Isolating the folder rules that out. This must run before
// requestSingleInstanceLock and createCore.
//
// The same rule applies on macOS: APFS is case-insensitive by default, so 'Astera' and 'astera'
// resolve to the same folder under ~/Library/Application Support.
if (!app.isPackaged) app.setPath('userData', app.getPath('userData') + '-dev')

// Under WSLg, running on XWayland is what puts the window off the screen edge and makes clicks land
// away from what they are drawn on. ozone.ts carries the measurements, the dead ends, and why this is
// scoped to WSLg alone. A command-line switch has to be appended before the app starts, hence here.
if (shouldForceWaylandOzone(process.platform, process.env['WAYLAND_DISPLAY'], existsSync))
  app.commandLine.appendSwitch('ozone-platform', 'wayland')

// The carriage return the rolling coordinators write to submit a prompt on a pty. The `write` routing
// in their dep blocks below recognises it in order to drop it: a chat session is handed a whole
// message rather than keystrokes, so the Enter that follows the text on a pty has nothing to do there.
const ENTER = String.fromCharCode(13)

let core: Core | null = null
let codexRollingRef: CodexRollingCoordinator | null = null
let schedulerRef: SchedulerCoordinator | null = null
let codexRolloutRef: CodexRolloutWatcher | null = null
let slackInboxControllerRef: SlackInboxController | null = null // Slack inbound socket rebuilder — cut on quit
let rollingRef: RollingCoordinator | null = null // lets the hook callback reach a coordinator created later
let orchRef: OrchHandle | null = null // orchestration shutdown cleanup + the rolling seam
let hostClientStopRef: (() => Promise<void>) | null = null // Astera Host client — closes the socket on quit
// Asks the Host to leave. Only the update path uses it: an installer cannot write over a running
// Host, and killing one this client is still watching only gets a fresh one started.
let hostClientRetireRef: (() => Promise<void>) | null = null
// Whether the Host keeps its sessions through an installer. Only the update path reads it: it decides
// whether the Host has to be retired first, or can simply be left running.
let hostSurvivesUpdateRef: (() => boolean) | null = null
// fix wave 최종, F1: the tab-briefing function, handed over unconditionally (OrchWiring.onTabResumeReady)
// — unlike orchRef above, this is set the moment registerIpc runs, whether or not orchestration ever
// boots. Read by the two rolling coordinators' resumeText dep when orchRef is null (the server did not
// come up), so a plain tab session's Smart Resume briefing does not depend on orchestration having
// started.
let tabResumeTextRef: ((sessionId: string, form: 'handover' | 'update') => Promise<string | null>) | null =
  null
// Work Unit 수집기의 "이 세션은 이어받은 것이다" 알림. `tabResumeTextRef` 와 같은 갈래다 —
// 값은 registerIpc 안에서 만들어지지만 부르는 자리 하나가 이 파일에만 있다(두 롤링 코디네이터의
// send 탭). 수집기가 꺼져 있으면 이 함수는 아무 일도 하지 않으므로 탭 쪽은 토글을 묻지 않는다.
// **`oldSessionId` (the third argument) is passed only by the rolling taps.** It carries the id of
// the session a usage-limit roll just killed, so the collector can re-key that session's open task
// onto the new one (Important 3) — history resume never passes it (collector.ts's `onSessionForked`
// doc explains why).
let workUnitForkRef:
  | ((newSessionId: string, transcriptPath?: string, oldSessionId?: string) => void)
  | null = null

/** The `resumeText` dep both rolling coordinators receive (RollingDeps/CodexRollingDeps). fix wave
 *  최종, F1: tries the Job briefing through `orchRef` when orchestration is up; when it is not
 *  (`orchRef === null`), a Job Dispatch cannot exist at all, so there is nothing to look up there —
 *  this goes straight to `tabResumeTextRef`, guarded by the same `tabFallback` the caller already
 *  computed (F3: the ordinary-path 'handover' ask passes `false` so a tab session's `chain.prompt`
 *  is never replaced by a pointer the process has no use for). When orchestration *is* up, `orchRef
 *  .resumeText` already does the Job-then-maybe-tab fallback internally (ipc.ts), so this does not
 *  retry `tabResumeTextRef` itself — that would call `tabResumeTextFor` a second time for the same
 *  session and form, redoing its file write for nothing. */
const resumeTextDep = (
  sessionId: string,
  form: 'handover' | 'update',
  tabFallback: boolean
): Promise<string | null> =>
  orchRef
    ? orchRef.resumeText(sessionId, form, tabFallback)
    : tabFallback
      ? (tabResumeTextRef?.(sessionId, form) ?? Promise.resolve(null))
      : Promise.resolve(null)
let tray: Tray | null = null
let quitting = false
let mainWindow: BrowserWindow | null = null // focus target for the single-instance second-instance event
// Notifications currently on screen. Electron does not retain a `new Notification()` for you —
// an unreferenced one can be garbage-collected before it is clicked, and a collected notification
// never fires 'click'. That failure mode hits hardest exactly the toast this feature exists for:
// the one that sits unclicked for minutes or hours until someone walks back to the desk, not the
// one clicked within the same tick it was shown.
const liveNotifications = new Set<Notification>()
let updateCampaign: UpdateCampaignInfo | null = null // update campaign verdict. null means no campaign

/**
 * Reads the campaign policy URL out of the packaged app-update.yml. electron-builder generates that
 * file from electron-builder.yml, making it the single source of truth for the release location.
 * Returns null in dev or when the file is missing, and the policy lookup is then skipped entirely.
 */
function readPolicyUrl(): string | null {
  try {
    return parsePolicyUrl(readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8'))
  } catch {
    return null
  }
}

// App icons. electron-vite copies both into out (?asset) for dev and packaged builds alike.
// The tray gets its own asset rather than a downscale of the window icon: at 16-24px the full tile
// loses the mark, so tray.png is generated from a tighter crop (see scripts/gen-icon.ps1).
// **macOS uses this same color asset too.** The menu-bar convention is a template image (a solid
// color with only alpha), which the system tints for dark/light and accent state — but that needs a
// mark-only asset with a transparent background. The current brand asset has the mark sitting on an
// opaque dark tile (logo-source.png is hasAlpha:no), so setting setTemplateImage(true) as-is would
// show a solid rounded square in the menu bar. A color icon only deviates from convention rather than
// looking wrong, so this is the choice until mark-only artwork exists.
const APP_ICON = nativeImage.createFromPath(iconAsset)
const TRAY_ICON = nativeImage.createFromPath(trayAsset)

/**
 * A minimal macOS-only menu. Keeping the item count down is the whole point — everything here is a
 * role that 'kills a keyboard shortcut if absent', and app functionality is handled by the custom
 * titlebar and tray instead.
 * Quit goes through app.quit and rides straight through before-quit's session cleanup.
 */
function buildMacMenu(): Menu {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    // Not the built-in 'windowMenu' role: its Close Window item carries the Cmd+W key equivalent, and
    // NSMenu resolves key equivalents in performKeyEquivalent: before the key ever reaches the web
    // view — so Cmd+W would always close the window instead of reaching explorer.closeFileTab, which
    // this app also binds to Cmd+W on macOS. Rebuilt by hand with the close item omitted; the window
    // is closed via the traffic-light button instead (which hides it to the tray, see win.on('close')).
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    }
  ])
}

/** Which guest is which session's agent browser. Built here rather than inside registerIpc because
 *  two places need the **same** instance and they run at different times: createWindow installs the
 *  navigation guard, which asks on every will-navigate, and registerIpc owns the register/unregister
 *  IPC that fills it. Two instances would mean the guard and the run manager disagree about which
 *  guest belongs to an agent — the guard would let an agent's tab walk off this machine. */
const agentGuests = new AgentGuestRegistry((id) => webContents.fromId(id))

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Astera',
    icon: APP_ICON, // window/taskbar icon (electron-builder win.icon only changes the installed exe icon)
    titleBarStyle: 'hidden',
    // macOS: titleBarStyle:'hidden' leaves the traffic-light buttons floating in the top-left. The
    // default y coordinate sits below our 32px titlebar and gets half-clipped, so this centers them
    // vertically. (button height 12px → (32-12)/2 = 10)
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 10 } } : {}),
    // Linux: the window options are not where the old WSLg geometry problem lived. The window hanging
    // off the right edge and clicks landing away from what they are drawn on were the same bug, and its
    // cause was the Ozone platform, not anything set here — see ozone.ts, which now switches WSLg onto
    // Wayland and records the measurements. Three window configs were tried against those symptoms
    // before the cause was known and none of them changed anything; do not retry them: frame:false
    // (96a9f0a, reverted by 340c2da) — it did remove the duplicate title bar Linux draws under
    // titleBarStyle (a macOS/Windows-only option the WM ignores), but made maximize overshoot the
    // screen so the window controls became unreachable, which is worse than a cosmetic duplicate bar;
    // leaving titleBarStyle unset on Linux (0e45857, reverted by 926a75a) — no change; and
    // --force-device-scale-factor=1 — no change either, and forcing 1.5 instead (tried later, on
    // Wayland) breaks the window geometry outright.
    // The duplicate title bar itself is separate and still open — most likely fixed by
    // hiding this app's own window controls on Linux and letting the native bar be the only chrome.
    // That half cannot ship on its own: this app's own close button is the only thing that runs the
    // Linux quit confirmation (App.tsx's closeWindow raises confirmModal while sessions are
    // running), while the WM's X goes straight to win.on('close') below, which returns immediately
    // on Linux. Hiding the controls without first moving that confirmation into the main process —
    // into win.on('close'), where the WM's close path actually lands — silently kills every running
    // session, which is exactly the regression a217ac1 was written to prevent.
    // webviewTag: the browser tab's <webview> (renderer/components/BrowserPane.tsx). Off by default
    // in Electron; installPreviewGuards below is what makes turning it on safe.
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: false, webviewTag: true }
  })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
  win.maximize()

  // DevTools in development. Its usual accelerators (Ctrl/Cmd+Shift+I, F12) come from Electron's
  // default application menu, and this app replaces that menu with null on win32 (see
  // Menu.setApplicationMenu below) — so without this there is no way to open it at all, which has
  // cost real debugging time. Bound on the window rather than through globalShortcut so it does not
  // reach other applications, and only when unpackaged so a release build keeps them closed.
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type !== 'keyDown') return
      const devToolsKey =
        input.key === 'F12' ||
        ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i')
      if (devToolsKey) win.webContents.toggleDevTools()
    })
  }

  // Arbitrary user-controlled <a href> now reaches the renderer (the markdown preview renders a link
  // whose text and target come from a file the user merely opened, possibly written by someone else).
  // This is defence in depth, not a live hole — every rendered link's click is already intercepted and
  // its target attribute stripped — but a missed interception path must not be able to navigate this
  // window or pop an uncontrolled one.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = parseAllowedExternalUrl(url)
    if (parsed) void shell.openExternal(parsed.toString())
    return { action: 'deny' }
  })
  const indexFileUrl = pathToFileURL(path.join(__dirname, '../renderer/index.html')).toString()
  win.webContents.on('will-navigate', (e, url) => {
    // a reload of the app's own document (dev server or the production file://) — let it through
    if (isOwnDocument(url, process.env['ELECTRON_RENDERER_URL'], indexFileUrl)) return
    e.preventDefault()
    const parsed = parseAllowedExternalUrl(url)
    if (parsed) void shell.openExternal(parsed.toString())
  })
  // The guest id the guard is handed is the webContents id of the <webview>, which is the same number
  // BrowserPane reports through preview.registerAgentGuest — so the agent's tab, and only it, is held
  // to the loopback rule.
  installPreviewGuards(win, (id) => agentGuests.isAgentGuest(id))
  // Hosts the preview's DevTools in a window this app creates, so it carries the app icon and a
  // title naming the page — Electron's own DevTools window carries neither.
  registerPreviewDevTools(APP_ICON)
  // Viewport presets. DevTools does not offer its device toolbar for a <webview>, so the pane's picker
  // goes through this instead — and it uses Electron's own API rather than the debugger, which keeps
  // the debugger free for DevTools.
  registerPreviewEmulation()
  // Element screenshots for Design Mode, saved under userData/preview/shots — the path is what the
  // prompt carries.
  registerPreviewCapture(app.getPath('userData'))

  // Closing the window (X) minimizes to the tray on Windows and macOS — whether or not sessions
  // exist. There the only real quit path is the tray 'Quit' menu (app.quit): app.quit sets
  // quitting=true in before-quit, which is what lets a close through this guard.
  //
  // **Linux closes for real.** A tray icon cannot be relied on there — GNOME shows none without an
  // AppIndicator extension — so hiding the window would leave the app running with nothing to click
  // and no way out but killing the process. Letting the close through reaches the existing
  // window-all-closed handler, which already calls app.quit() on every platform but macOS: this adds
  // no new quit path, it stops blocking the one that was always there, and will-quit's session
  // cleanup still runs. The cost is deliberate — rolling and the scheduler stop when the window
  // closes on Linux, so minimizing is what keeps them alive.
  win.on('close', (e) => {
    if (process.platform === 'linux') return
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })
  return win
}

/** The tray context menu template — pulled out so it can be rebuilt after a language change
 *  (refreshTrayMenu) rather than only once at createTray time. */
function trayMenuTemplate(win: BrowserWindow): Electron.MenuItemConstructorOptions[] {
  return [
    { label: t(core!.lang, 'common.trayOpen'), click: () => win.show() },
    // Quit keeps the Host's sessions running; that is the Host's purpose, and the quit confirmation
    // says so. This is the other intention — end everything — given a place where a person on win32
    // or macOS actually quits from, since there is no dialog there (design §6). Retire first: the
    // will-quit cleanup skips every pty the Host owns, so this is the one path that reaches them.
    { label: t(core!.lang, 'common.trayQuit'), click: () => app.quit() },
    {
      label: t(core!.lang, 'common.trayQuitEnding'),
      click: () => {
        void (async () => {
          try {
            await hostClientRetireRef?.()
          } catch {
            /* nothing to end */
          }
          app.quit()
        })()
      }
    }
  ]
}

function createTray(win: BrowserWindow): void {
  tray = new Tray(TRAY_ICON)
  tray.setToolTip('Astera')
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(win)))
  // win32's convention is double-click; the macOS menu bar's is a single click. On mac, with
  // setContextMenu set, a click opens the menu, so 'click' isn't attached here — window restore is
  // handled by the Dock icon and the menu's 'Open' instead.
  if (process.platform !== 'darwin') tray.on('double-click', () => win.show())
}

/** Rebuilds the tray menu with the current language — called after settings.setLang so Open/Quit
 *  do not stay in the old language until restart. */
function refreshTrayMenu(win: BrowserWindow): void {
  tray?.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(win)))
}

// Single-instance lock — if one is already running, the second instance quits without initializing
// and focuses the existing window. Hiding to the tray and then clicking the icon again can launch
// the installed app twice, and the second process's createCore -> init() recreates the hook-events
// directory, orphaning the first instance's watcher. This lock rules that out at the source. An
// instance that loses the lock returns/quits before createCore, so the will-quit guard
// (core === null) means it kills no sessions either.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

// Brings the main window to the front: restores it if minimized, shows and focuses it. Shared by the
// second-instance handler, the macOS activate handler, and a desktop notification click.
function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

app.on('second-instance', () => {
  focusMainWindow()
})

// macOS: closing the window leaves the app alive (win.on('close') redirects to hide) and the Dock
// icon stays. Clicking that icon fires activate, but the default behavior alone won't bring the
// hidden window back.
app.on('activate', () => {
  focusMainWindow()
})

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return // second instance — waits for quit without initializing
  // Tells a Host this app is not attached to that an app is alive and may be running sessions the
  // Host cannot see, so it refuses to remove a worktree folder under them (core/host/pidFile.ts).
  markAppRunning(app.getPath('userData'), process.pid)
  // Windows delivers a toast against the process's AppUserModelID and silently drops it when that
  // does not match a shortcut's — indistinguishable from the OS-refusal case DesktopNotifierDeps's
  // `show` already expects to swallow (design doc §9). Called unconditionally rather than guarded to
  // win32: Electron makes it a no-op on macOS/Linux. The id matches electron-builder.yml's appId.
  app.setAppUserModelId('io.github.parsingk.astera')
  // win32 doesn't use a menu bar (the custom titlebar takes that spot). macOS is different — edit
  // commands like Cmd+C/V/X/A/Z are provided by Electron's menu roles, so removing the menu would
  // kill those keys in every input field in the renderer. Hence a minimal, role-only menu on mac.
  Menu.setApplicationMenu(process.platform === 'darwin' ? buildMacMenu() : null)
  // macOS takes the Dock icon from the running bundle's Info.plist, not from BrowserWindow's `icon`
  // option (which is win32/linux only). In dev the bundle is node_modules/electron's own Electron.app,
  // so the Dock shows the Electron logo — win32 has no such gap, because there the window icon is
  // what the taskbar draws. Setting it explicitly closes that asymmetry.
  //
  // Only in dev: a packaged build already carries build/icon.icns as its bundle icon, and that file
  // holds resolutions up to 1024 while APP_ICON is the 256px PNG. Overriding there would replace a
  // sharp icon with an upscaled one.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(APP_ICON)
  // Launched from Finder on macOS or from a .desktop entry on Linux, there's no login shell PATH.
  // claude/codex/git/node are all looked up via PATH, so this must be restored before createCore
  // (= StatusLineManager.init, account detection).
  await applyLoginPath((m) => console.log(m))
  core = await createCore(app.getPath('userData'), app.getLocale())
  const win = createWindow()
  mainWindow = win
  // Slack progress notifications: hook events, roll state, limits and exits go out over an Incoming
  // Webhook or a Slack bot (chat.postMessage) — SlackNotifier abstracts both behind a transport, so
  // the wiring here does not know which path is in play. Logs go to userData/slack.log (same pattern
  // as rolling.log) — the webhook URL and bot token are never recorded.
  const slackLogFile = path.join(app.getPath('userData'), 'slack.log')
  const slackLog = (m: string): void => {
    try {
      appendFileSync(slackLogFile, `${new Date().toISOString()} ${m}\n`)
    } catch {
      /* a logging failure must not block the notification */
    }
  }
  const slackStore = new SlackConfigStore(path.join(app.getPath('userData'), 'slack.json'))
  const slack = new SlackNotifier({
    getAccount: (id) => {
      try {
        return core!.accounts.get(id)
      } catch {
        return null
      }
    },
    readStatusPayload: (id) => core!.statusLinePayload(id),
    lang: () => core!.lang,
    log: slackLog
  })
  // The one attention verdict (main/attention.ts): is a session working, or waiting for a person,
  // decided from the same hook stream Slack and the desktop sink already read. Constructed here,
  // beside them, and handed to both — the desktop sink below reads it instead of classifying a
  // Notification payload itself, and ipc.ts's session-exit path forgets a session's entry here too
  // (its own comment there explains the lost-sight exception).
  const attention = createAttentionState()
  // The waiting tool call per session (main/pendingPrompt.ts): what the conversation view draws a
  // question card from. Built here, beside attention, for the same two readers — the fan-out and ipc.
  const pendingPrompt = createPendingPromptState()
  // The second outlet on the same pipe (design doc §6). Electron's Notification was unused in this
  // app until now — only Tray was.
  const desktop = new DesktopNotifier({
    settings: core!.appSettings,
    isFocused: () => !win.isDestroyed() && win.isFocused(),
    getSession: (id) => core!.sessions.list().find((s) => s.id === id) ?? null,
    lang: () => core!.lang,
    attention,
    show: (req) => {
      // If the OS refuses to show it — permission denied, notifications disabled at the system level
      // — it is dropped silently (§9). A notification saying that notifications do not work cannot be
      // delivered by the thing that is broken, and a toast for it would fire in the window the person
      // is not looking at, which is the entire situation this feature exists for.
      if (!Notification.isSupported()) return
      try {
        const n = new Notification({ title: req.title, body: req.body })
        // Held in liveNotifications from before show() until a terminal event removes it — see that
        // set's own comment for why. Windows does not guarantee 'close' fires, so a notification the
        // person neither clicks nor dismisses may outlive this and stay in the set for the app's
        // life — a handful of small objects, and the deliberate price of not losing the click.
        liveNotifications.add(n)
        n.on('click', () => {
          liveNotifications.delete(n)
          // An exception here must not escape into an Electron event handler, the same isolation the
          // taps elsewhere in this file give each other.
          try {
            focusMainWindow()
            // The renderer does the activating, through the path the tab bar already uses — panes and
            // tabs are its structure (§7).
            if (!win.isDestroyed())
              win.webContents.send('notify:activate', { sessionId: req.sessionId })
          } catch {
            /* raising the window must not crash the notification's click handler */
          }
        })
        n.on('close', () => liveNotifications.delete(n))
        n.show()
      } catch {
        /* the OS refused it — see above */
      }
    }
  })
  // Slack thread reply intake. Connects only when an app token is present and bot mode is on — on
  // the webhook path there are no threads, so there is nothing to reply into. SlackInboxController
  // safely rebuilds the socket whenever settings change (reconfigureInbox in registerIpc below) —
  // that fixed a bug where turning bot mode off left the socket attached to the old channel until
  // the next restart.
  const slackInboxController = new SlackInboxController({
    makeDeps: (channelId, memberId) => ({
      channelId,
      // Passed straight through as the getter the controller handed over — only the allowed member's
      // thread replies are injected, and a settings save takes effect without a reconnect.
      memberId,
      lang: () => core!.lang,
      resolveSession: (ts) => slack.resolveSessionByThread(ts),
      // Write only after confirming the session is alive, and hand that result straight back — this
      // used to report a failed injection as a success. SessionManager.write returns silently for an
      // already-exited session (its exited guard), so "did not throw" cannot tell success from
      // failure. Rather than add a new API, this reuses the status core.sessions.list() already
      // returns.
      write: (sessionId, data) => {
        const alive = core!.sessions.list().some((s) => s.id === sessionId && s.status === 'running')
        if (!alive) return false
        core!.sessions.write(sessionId, data)
        return true
      },
      postNote: (ts, text) => slack.postThreadNote(ts, text),
      isOwnMessage: (ts) => slack.isOwnMessage(ts),
      // On a choice prompt, turn the reply into a key sequence and carry it through Submit
      pendingChoiceShape: (sid) => slack.pendingChoiceShape(sid),
      // A chat session has no pty to type into: its reply is read against the card it holds and goes
      // out through the session driver or as the card's answer (slice 4 design §7.3).
      isChat: (sid) => core!.chat.has(sid),
      pendingRequest: (sid) => core!.chat.state(sid)?.request ?? null,
      deliverChat: (sid, text) => sessionDriver.deliver(sid, text),
      answerChat: (sid, requestId, answer) => core!.chat.answer(sid, requestId, answer),
      log: slackLog
    }),
    createClient: (appToken) => createSocketClient(appToken),
    // Guards the race where the config load promise resolves after before-quit — while quitting,
    // do not open a new socket.
    isQuitting: () => quitting
  })
  slackInboxControllerRef = slackInboxController
  void slackStore.load().then((c) => {
    slack.applyConfig(c)
    void slackInboxController.apply(c)
  })
  // codex rollout watcher: codex has neither hooks nor a statusLine mechanism, so this one tail of
  // the rollout jsonl answers both questions — task_complete for turn completion, and the token_count
  // records the usage chips draw. Independent of rolling. Every codex session is watched (the caller
  // registers them all, because the chips follow the active session) and the watcher reports turn
  // completion only for those that asked for Slack. Its logs share slack.log: turn-completion
  // notifications end up on Slack anyway, and the usage side is quiet in normal operation.
  const codexRollout = new CodexRolloutWatcher({
    getAccount: (id) => {
      try {
        return core!.accounts.get(id)
      } catch {
        return null
      }
    },
    onTurnComplete: (sessionId, rolloutPath) => slack.onCodexTurnComplete(sessionId, rolloutPath),
    // The mapping goes into the note the Host keeps for that session's pty, which is the only place it
    // can be read back from after a restart — the scan that made it cannot be run again for a session
    // whose spawn is in the past. With no Host the pty has no note and this does nothing.
    remember: (sessionId, note) => {
      try {
        core!.sessions.remember(sessionId, note)
      } catch {
        /* writing the mapping down must not disturb the poll that produced it */
      }
    },
    log: slackLog
  })
  codexRolloutRef = codexRollout
  const hookWatcher = new HookEventWatcher(
    core.hookEventsDir,
    // The fan-out itself lives in hookFanOut.ts, not here — see that file's own comment for why
    // (in short: this callback used to be an untested closure, and Task 5's review deleted its attention
    // tap and moved it last without a single test noticing, in production or in this suite). `desktop`
    // is not one of these taps: it no longer reads a hook payload directly, it subscribes to `attention`
    // instead (desktopNotifier.ts's constructor) — see hookFanOut.ts's own comment on why `attention`
    // still runs first regardless.
    (sid, payload) => fanOutHookEvent({ attention, pendingPrompt, slack, rolling: rollingRef }, sid, payload),
    slackLog
  )
  hookWatcher.start()

  // Account rolling: progress logs go to userData/rolling.log (same pattern as updater.log)
  const rollLog = path.join(app.getPath('userData'), 'rolling.log')
  // Both coordinators' `log` dep, and the one their chat routing below writes its own refusals to — a
  // named function rather than the two inline copies it replaces, because that routing is in the dep
  // literal and cannot reach the `log` it is declaring.
  const rollingLog = (m: string): void => {
    try {
      appendFileSync(rollLog, `${new Date().toISOString()} ${m}\n`)
    } catch {
      /* a logging failure must not block rolling */
    }
  }
  const schedLog = (m: string): void => {
    try {
      appendFileSync(rollLog, `${new Date().toISOString()} [sched] ${m}\n`)
    } catch {
      /* a logging failure must not block the schedule */
    }
  }
  // Reports the per-entry validation result for scheduler.json — createCore has no logger, so it is
  // logged here instead. The normal path (recovered=false, dropped=0, pruned=0) stays quiet.
  {
    const { recovered, dropped, pruned } = core.schedulerConfigLoad
    // recovered=true covers not only a parse failure (corrupt JSON and the like) but also a failure
    // to read at all (EACCES etc.) — on a read failure the copyFile that follows fails too, so no
    // .bak may exist, which is why this does not claim ".bak kept"
    if (recovered) schedLog('scheduler.json read/parse failed — starting from an empty map')
    else if (dropped > 0 || pruned > 0)
      schedLog(`scheduler.json cleaned up (${dropped} invalid, ${pruned} expired) — .bak kept`)
  }
  // One driver per session kind and a router that asks core which kind an id is, on every call — an id
  // rolling has re-keyed is judged again (chat-sessions slice 4 design §5.4). Shared by the scheduler
  // now; Slack (4b) and rolling (4c) send through it too.
  const sessionDriver = routedDriver(
    (id) => core!.chat.has(id),
    ptyDriver({
      write: (id, d) => {
        core!.sessions.write(id, d) // a throw is the rejection the caller sees
      }
    }),
    // The manager's `send` resolves for an id it does not know, and a silent resolve reads as "delivered"
    // to everything on the other side of this seam — the scheduler zeroes its refusal count on it, and
    // 4b's Slack notice and 4c's rolling prompt are both written against "a rejection means not sent".
    // The driver's own contract says it rejects when the CLI refused the message **or the session is
    // gone**, so the second half is kept here, at the seam, rather than left to the router's `isChat`
    // check a microsecond earlier.
    chatDriver({
      send: (id, text) =>
        core!.chat.has(id) ? core!.chat.send(id, text) : Promise.reject(new Error(`no chat session: ${id}`))
    })
  )
  // Session scheduler: runs periodic commands automatically. Logs share rolling.log ([sched] prefix)
  const scheduler = new SchedulerCoordinator({
    deliver: (id, text) => sessionDriver.deliver(id, text),
    readStatusPayload: (id) => core!.statusLinePayload(id),
    send: (channel, payload) => {
      try {
        if (!win.isDestroyed()) win.webContents.send(channel, payload)
      } catch {
        /* renderer send failures are ignored */
      }
    },
    log: schedLog,
    persistConfig: (sid, cfg) => {
      // fire-and-forget — a persist failure must not block the schedule
      void core!.schedulerConfig.set(sid, cfg).catch(() => {})
    },
    deleteConfig: (sid) => {
      void core!.schedulerConfig.delete(sid).catch(() => {})
    },
    // codex 세션의 scheduler.json 키. claude 가 statusLine 페이로드에서 얻는 것을 codex 는 여기서
    // 얻는다 — rollout 감시자는 모든 codex 세션에 붙고, 그 탐색이 경로와 세션 id 를 함께 낸다.
    // 이 배선이 없던 동안 codex 스케줄은 세션이 사는 동안만 돌고 아무 키로도 저장되지 않았다.
    codexSessionId: (id) => codexRollout.codexSessionIdFor(id),
    // A chat session's scheduler.json key: the protocol thread id the adapter reported (Codex at ready,
    // Claude after the first turn); null until then, and the coordinator asks again next tick.
    chatThreadId: (id) => core!.chat.info(id)?.threadId ?? null
  })
  schedulerRef = scheduler
  // Direct account-usage lookups. It carries its own call coalescing, backoff and 10-second timeout, so
  // a limit phrase re-matching on every chunk still produces very few real requests. The token never
  // leaves this process.
  // Owned by core so the account panel's service and the limit verdict share one cache — see
  // Core.usageFetcher for why that sharing is load-bearing.
  const usageFetcher = core.usageFetcher
  // One registry for both coordinators — the sharing is the feature (SPEC §11.2/6). Two instances
  // would compile and pass every test while sharing nothing.
  const blocks = new BlockRegistry()
  // One memo for both coordinators, for the same reason (ruling 4e-5). Every chain asks this for every
  // account in its roll chain on every 15-second tick, and chains overlap: four chains over three
  // accounts asked twelve times for three answers. On win32 that is a file read each; on darwin
  // claudeLoginProbe can fall through to the Keychain, which spawns a `security` process per ask. The
  // TTL sits under the tick, so a login change is still picked up within a tick or two.
  //
  // `ipcMain.handle('accounts.loginStatus')` is deliberately NOT memoised: the renderer re-queries on
  // window focus exactly because the person just went and logged in somewhere else, and a cached
  // verdict would show them a stale marker. Two paths, two trades — the coordinators run a filter, the
  // panel shows a fact.
  const cachedLoginStatus = memoiseLoginStatus((id) => core!.accounts.loginStatus(id), {
    ttlMs: 10_000
  })
  /** What a roll event costs the app, for both coordinators' `send` and for the Host's rolls (S6 Task
   *  14, design §3.4): the renderer, the Work Unit collector, the scheduler, orchestration, Slack and the
   *  desktop sink, each isolated in its own try so one tap's throw does not block the rest or the roll.
   *  `orchestration` is false for a roll the Host made and pushed: the Host already rekeyed the Dispatch
   *  and the coordinator slot, so the app's tap must not do it a second time over the mirror. `codex`
   *  adds the codex rollout watcher's re-register, which only a codex roll needs. */
  const fanOutRollEvent = (
    channel: 'session:rolled' | 'session:rollState',
    payload: unknown,
    opts: { orchestration: boolean; codex: boolean }
  ): void => {
    try {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    } catch {
      /* renderer send failures are ignored */
    }
    // Work Unit 수집기도 롤을 탭한다. 굴린 세션은 새 세션 id 를 받고, `--resume` 이 그
    // 세션의 트랜스크립트에 이전 대화를 통째로 다시 적는다 — 알리지 않으면 수집기가 처음 보는
    // 세션으로 여겨 그 파일을 0 부터 읽고, 그것이 곧 켜기 전의 대화다(스펙 §16.1).
    // **claude 에서는 경로를 건네지 않는다.** 이 게시의 payload 에는 없고, 굴려서 띄운 프로세스가
    // 어느 파일을 쓸지는 그 세션의 statusLine 이 도착해야 정해진다(rolling.ts 의 applyMeta 가 그것을
    // 기다린다). 추측 대신 세션 id 만 알리고, 파일 끝을 잡는 일은 수집기가 그 세션을 처음 보는
    // 회차로 미룬다. **codex 에서는 건네줄 수 있다**: 재개된 codex 는 새 파일을 만들지 않고 바로 이
    // dest 에 이어 쓰므로(아래 주석) 그 순간의 파일 끝이 곧 되쓰기가 끝난 자리다. 빈 대화로 굴릴 때는
    // `undefined` 이고, 그때는 claude 쪽처럼 수집기가 다음 회차에 끝을 잡는다.
    // **`oldSessionId` goes along too (Important 3).** The killed session's open task has to be
    // re-keyed onto the new one, or that session's exit event — which follows this — would
    // interrupt it for no reason: a usage limit is not a completion. rolling.ts's roll() goes
    // kill → spawn → this publish with no await in between, so the killed session's real
    // (asynchronous) exit event is guaranteed to arrive after this notification. (A Host roll's exit
    // is held until this has run — hostRollView.) **codex sessions do not create a Unit today** (see
    // collector.ts's header comment for why), so passing `oldSessionId` there has nothing to re-key and
    // quietly does nothing for now. Passed anyway, because an asymmetry caught on only one side becomes
    // a silent bug the day codex support arrives.
    try {
      if (channel === 'session:rolled') {
        const p = payload as { oldSessionId: string; info: SessionInfo; dest?: string }
        workUnitForkRef?.(p.info.id, p.dest, p.oldSessionId)
      }
    } catch {
      /* a Work Unit tap failure must not block rolling */
    }
    // The fork above is made once per roll (preflight C10), and the new pty's note records it: the note
    // keeps `rolledFrom` for the pty's life, so the adopter of a later app instance would otherwise fork
    // again and skip the transcript lines written while the app was closed. remember() does nothing for
    // a chat session (no pty note) or a fallback session (no Host).
    try {
      if (channel === 'session:rolled') {
        const p = payload as { oldSessionId: string; info: SessionInfo }
        core!.sessions.remember(p.info.id, { forkSeen: p.oldSessionId })
      }
    } catch {
      /* a note failure must not block rolling */
    }
    // The scheduler taps rolling events too — isolated in its own try, separate from the Slack
    // tap, so a throw out of rekey does not silently swallow the Slack notification (rolled) below.
    try {
      if (channel === 'session:rolled') {
        const p = payload as { oldSessionId: string; info: SessionInfo; dest?: string }
        scheduler.rekey(p.oldSessionId, p.info.id) // the schedule follows the roll chain
        if (opts.codex) {
          // dest: the rollout path copied into the target account just before an ordinary roll
          // (codexRolling.roll() carries it along). The respawn resumes, so codex appends to that very
          // file instead of creating a new one — it is what the watcher has to tail, and searching for a
          // newly created file would find nothing at all. It is handed over directly; the watcher starts
          // at the end of it so the turns from before the roll are not reported again. **`undefined` on
          // a blank-slate roll (Smart Resume)** — that respawn is a fresh `codex` with no rollout to
          // copy or hand over yet, so `register` below falls back to its own search, the same path a
          // brand-new session already takes (codexRolling.ts's `roll()` documents the same fallback at
          // its own `send('session:rolled', ...)` call).
          //
          // When rolling switches accounts the session respawns under a new sessionId and a new
          // rollout file appears — without re-registering, both turn-completion notifications and the
          // usage chips stop for good after the switch. `opts.codex` says this is a codex roll (the
          // codex coordinator's own send, or a Host roll of a codex session — ipc.ts asks the account),
          // so re-checking the provider is unnecessary. Unconditional for a pty session, matching
          // the spawn path: the chips are needed whether or not this session asked for Slack, and the
          // watcher gates the turn callback on info.slackNotify itself.
          //
          // **A chat session is registered here too, not just by its own `ready`.** A rolled chat
          // session's `ready` only fires ~1–3s later, once the respawned CLI completes its handshake,
          // and until then nothing in the watcher knows this session at all. What that costs is not
          // notifications — they are off for a chat session (`{ notifyTurns: false }`, below: it
          // announces its own turn ends from the protocol, so a watcher callback would make it two) —
          // nor the usage chips, which `register` resets along with `limits`/`context` anyway. It is
          // that `codexSessionIdFor` and `rolloutPathFor` have no answer for the new id during that
          // window, and everything that asks them (the history-resume guard, the rollout lookups) is
          // told this session does not exist. Registering here closes exactly that gap. `register`
          // replaces the entry wholesale (codexRolloutWatcher.ts), so `ready`'s later re-register does
          // not drift the flag back to its default; that is why the old Ruling 4c-6 skip is no longer
          // needed here.
          //
          // The old registration's native id is read before it is dropped — `unregister` erases it —
          // **and only when `p.dest` is there**, i.e. when this roll resumed the same thread onto a
          // copied rollout. A blank-slate roll (Smart Resume) starts a *different* thread and
          // codexRolling nulls `chain.codexSessionId` for it, so handing the old id over would have the
          // watcher's own `findRollout` narrow its search to the dead thread and hide the new rollout
          // for the whole handshake window.
          const rolledChatId = core!.chat.has(p.info.id)
            ? p.dest
              ? codexRollout.codexSessionIdFor(p.oldSessionId) ?? undefined
              : undefined
            : null
          codexRollout.unregister(p.oldSessionId)
          if (rolledChatId !== null) codexRollout.register(p.info, p.dest, rolledChatId, { notifyTurns: false })
          else if (!core!.chat.has(p.info.id)) codexRollout.register(p.info, p.dest)
        }
      } else if (channel === 'session:rollState') {
        // Suppress schedule firing during the roll-resume window (switching/trust/waiting/nudged).
        // codex rolling sends session:rollState too (switching/waiting/adopted/none). 'adopted' is not
        // one of the states that suppresses: it says a chain taken back from the Host cannot judge its
        // own limit, which is not a resume window, and the switch in handleRollState leaves it to the
        // default on purpose.
        scheduler.handleRollState(payload as RollStateEvent)
      }
    } catch {
      /* a schedule tap failure must not block rolling or the Slack notification */
    }
    // 오케스트레이션도 롤링 이벤트를 탭한다. 워커 세션이 롤되면 그 Dispatch 의 sessionId 를 새
    // 세션으로 옮겨야 한다 — 그 값이 worker_done 을 되돌려 묶는 유일한 키다. 다른 탭들과 같은
    // 이유로 자기 try 안에 격리한다. Host 가 굴린 롤은 건너뛴다(`opts.orchestration`): Host 가
    // 이미 옮겼다.
    try {
      if (opts.orchestration) {
        if (channel === 'session:rolled') {
          const p = payload as { oldSessionId: string; info: SessionInfo }
          orchRef?.onRolled(p.oldSessionId, p.info)
        } else if (channel === 'session:rollState') {
          // 정지 시점 스냅샷 — 이벤트를 통째로 넘긴다. 어떤 게시가 정지 에피소드의 시작인지
          // 가르는 일과 세션별 기억은 OrchRollTap 이 갖는다(core/orchestration/exec/rollTap.ts).
          orchRef?.onRollState(payload as RollStateEvent)
        }
      }
    } catch {
      /* an orchestration tap failure must not block rolling */
    }
    // Slack notifications tap rolling events too, for both providers. Isolated so a tap exception does
    // not block rolling. Without this the SlackNotifier record stays on the old id, so turn
    // notifications stop after the switch, onRolled cannot cancel the scheduled exit timer so a false
    // session-exit goes out, and limit-reached, account-switch and reset notifications never arrive.
    try {
      if (channel === 'session:rolled') {
        const p = payload as { oldSessionId: string; info: SessionInfo }
        slack.onRolled(p.oldSessionId, p.info)
      } else if (channel === 'session:rollState') {
        slack.onRollState(payload as RollStateEvent)
      }
    } catch {
      /* a Slack tap failure must not block rolling */
    }
    // The desktop sink taps rolling events too, mirroring the Slack tap above. Isolated so an
    // exception here does not block rolling.
    try {
      if (channel === 'session:rollState') desktop.onRollState(payload as RollStateEvent)
    } catch {
      /* a desktop notification failure must not block rolling */
    }
  }
  /** Where a chain's snapshot goes (S6 R4): written into the pty's note, for the Host to carry on if
   *  this app goes away. A chat session has no Host pty note to write into, and a fallback session has
   *  no Host at all: remember() does nothing for either. Shared by both coordinators. */
  const writeRollSnapshot = (id: string, snap: RollSnapshot): void => {
    if (core!.chat.has(id)) return
    core!.sessions.remember(id, { roll: snap })
  }
  const rolling = new RollingCoordinator({
    // A chain's session may be a pty or a chat session (slice 4c); the coordinator says which through
    // `kind` and the rest is routed here, so neither coordinator imports a manager. A chat respawn
    // resumes by thread id — the same value a pty chain resumes by, under the chat manager's name for
    // it — and carries the chain's carry-on prompt as its first turn.
    spawn: (opts) =>
      opts.kind === 'chat'
        ? core!.chat.spawn({
            account: opts.account,
            cwd: opts.cwd,
            resumeThreadId: opts.resumeSessionId,
            initialPrompt: opts.initialPrompt,
            rollAccountIds: opts.rollAccountIds,
            rollPrompt: opts.rollPrompt,
            slackNotify: opts.slackNotify,
            bypassPermissions: opts.bypassPermissions,
            title: opts.title,
            model: opts.model,
            // design F5 fix round 1 (Important 2/3): computed here, the same way ipc.ts's own
            // spawnSession does — synchronously, off the cache core.ts warms once at startup — rather
            // than threaded through RollingDeps.spawn's opts: this is a fact about the *target*
            // account's CLI on this machine's PATH, not about the chain rolling.ts is tracking.
            bypassSignal: core!.bypassSignalFor(providerOf(opts.account)),
            startWithBypass: opts.startWithBypass
          })
        : core!.sessions.spawn(opts),
    // What the roll above carries: the model the person picked, read off the session being rolled
    // before it is killed. Terminal chains never reach this — the manager only knows chat sessions.
    chosenModelOf: (id) => core!.chat.chosenModelOf(id),
    // design F5 fix round 1 (Important 3): same "read before the kill" shape as chosenModelOf, for
    // the toolchain bypass a person already consented to for this chain.
    bypassedOf: (id) => core!.chat.bypassedOf(id),
    // A chat session takes a turn, not keys: the text goes through the session driver and the Enter
    // that follows it on a pty is a no-op here — the driver already sent the message. A refusal is
    // logged rather than thrown, because every caller of this dep is a timer with nobody to tell.
    write: (id, d) => {
      if (!core!.chat.has(id)) {
        core!.sessions.write(id, d)
        return
      }
      if (d === ENTER) return
      void sessionDriver
        .deliver(id, d)
        .catch((err) => rollingLog(`chat write refused session=${id}: ${String(err)}`))
    },
    kill: (id) => (core!.chat.has(id) ? core!.chat.kill(id) : core!.sessions.kill(id)),
    getAccount: (id) => {
      try {
        return core!.accounts.get(id)
      } catch {
        return null
      }
    },
    // The same verdict the account panel and the resume dialog show. A chain asks it on its tick and
    // skips an account that cannot authenticate (spec §15.2) — before this, a roll onto a logged-out
    // account copied the transcript and respawned into a CLI that immediately failed. Memoised: see
    // cachedLoginStatus above for why this path is and the IPC one is not.
    loginStatus: cachedLoginStatus,
    // A chat session writes no statusLine — it never calls the hook at all — so this would poll a file
    // that is never written. ipc pushes the same two facts in through onChatMeta instead.
    readStatusPayload: (id) => (core!.chat.has(id) ? Promise.resolve(null) : core!.statusLinePayload(id)),
    // What the limit evidence gate decides on. The screen phrase is only the trigger; whether to start a
    // roll or a wait is settled by asking the account for its usage — the statusLine snapshot freezes at
    // a stale value once a session halts on a limit, whereas this lookup is independent of session state.
    //
    // maxPercent rather than the max of the two windows: LIMIT_RE also matches the Opus, Sonnet, Fable
    // and credit limits, and those sit in buckets that never appear in five_hour/seven_day — judging on
    // the two windows alone would reject a genuine Opus limit as a false positive. USAGE_GATE_MAX_AGE_MS
    // pierces the default 5-minute cache so a near-threshold reading cannot reject the real limit later.
    //
    // The target is always the account that is running right now, so its accessToken is fresh (Claude
    // Code refreshes it at session start). Querying an account with no session would need the app to
    // refresh the token itself — a separate piece of work.
    readUsage: async (configDir) => {
      const u = await usageFetcher.get(configDir, USAGE_GATE_MAX_AGE_MS)
      // The peak carries maxPercent's own figure plus the reset time of the bucket it came from. That
      // time is what a block record needs when the session is halted — the phrase may never have been
      // printed and the statusLine snapshot is frozen by then (see RateLimitPeak).
      return u.status === 'ok' ? u.peak : null
    },
    send: (channel, payload) => fanOutRollEvent(channel, payload, { orchestration: true, codex: false }),
    // S6 R4: the chain written into the pty's note, for the Host to carry on if this app goes away.
    // A chat session has no Host pty note to write into, and a fallback session has no Host at all:
    // remember() does nothing for either (writeRollSnapshot).
    snapshot: writeRollSnapshot,
    log: rollingLog,
    lang: () => core!.lang,
    blocks,
    persistConfig: (sid, cfg) => {
      // fire-and-forget — a persist failure must not block rolling
      void core!.rollConfig.set(sid, cfg).catch(() => {})
    },
    orchEnv: () => orchRef?.orchEnv(),
    // Job Continuity: binds the native session id to the open Dispatch as soon as the coordinator learns it.
    onNativeSession: (sid, native) => orchRef?.onNativeSession(sid, native),
    // Job 워커의 재개 packet(Task 4b/4c), 없으면(탭 세션이거나 서버가 서지 못했으면) 탭
    // 브리핑으로 저하한다 — resumeTextDep 의 JSDoc(fix wave 최종, F1/F3).
    resumeText: resumeTextDep,
    // 한도에 걸린 세션을 어떻게 이어갈지(Task 1 의 설정) — orchEnv 와 같은 이유로 getter 다: 값이
    // 설정 화면에서 앱 수명 중간에 바뀌고, 이 코디네이터는 그보다 먼저 만들어진다. codexRolling 의
    // 같은 배선과 같은 자리, 같은 값이다.
    resumeStrategy: () => core!.appSettings.getResumeStrategy()
  })
  rollingRef = rolling

  // Codex account rolling. Uses the same log file and event channels as the Claude coordinator, but
  // does not depend on statusLine or Slack.
  const codexRolling = new CodexRollingCoordinator({
    // Routed by kind exactly as the claude coordinator's is, and for the same reason — see its own
    // comment. `resumePrompt` has no counterpart here: it is the argument behind `codex resume <id>`,
    // and a chat session is not started from a command line, so a chat roll carries its prompt as
    // `initialPrompt` (codexRolling.ts's roll() sends only that one for a chat chain).
    spawn: (opts) =>
      opts.kind === 'chat'
        ? core!.chat.spawn({
            account: opts.account,
            cwd: opts.cwd,
            resumeThreadId: opts.resumeSessionId,
            initialPrompt: opts.initialPrompt,
            rollAccountIds: opts.rollAccountIds,
            rollPrompt: opts.rollPrompt,
            slackNotify: opts.slackNotify,
            bypassPermissions: opts.bypassPermissions,
            title: opts.title,
            // design F5 fix round 1 (Important 2/3) — same as the claude coordinator's own callback.
            bypassSignal: core!.bypassSignalFor(providerOf(opts.account)),
            startWithBypass: opts.startWithBypass
          })
        : core!.sessions.spawn(opts),
    // design F5 fix round 1 (Important 3): rolling.ts's own dep, same contract.
    bypassedOf: (id) => core!.chat.bypassedOf(id),
    kill: (id) => (core!.chat.has(id) ? core!.chat.kill(id) : core!.sessions.kill(id)),
    write: (id, d) => {
      if (core!.chat.has(id)) {
        // A chat session takes a turn, not keys — the claude coordinator's write dep carries the whole
        // argument. A chat chain reaches here from one place: `resumeInPlace`, the single-account path
        // where a wait ends on the account the session is already on. Its carry-on text goes through the
        // driver and the Enter that follows it on a pty is a no-op, because the driver has already sent
        // the message. (The coordinator's other write is the answer to the model-switch prompt, which is
        // a pty screen a chat session does not have.)
        if (d === ENTER) return
        void sessionDriver
          .deliver(id, d)
          .catch((err) => rollingLog(`[codex] chat write refused session=${id}: ${String(err)}`))
        return
      }
      try {
        core!.sessions.write(id, d)
      } catch {
        /* a write failure must not break the chain — the prompt just stays up */
      }
    },
    getAccount: (id) => {
      try {
        return core!.accounts.get(id)
      } catch {
        return null
      }
    },
    // The same verdict the account panel and the resume dialog show. A chain asks it on its tick and
    // skips an account that cannot authenticate (spec §15.2) — before this, a roll onto a logged-out
    // account copied the transcript and respawned into a CLI that immediately failed. Memoised: see
    // cachedLoginStatus above for why this path is and the IPC one is not.
    loginStatus: cachedLoginStatus,
    send: (channel, payload) => fanOutRollEvent(channel, payload, { orchestration: true, codex: true }),
    // S6 R4: the chain written into the pty's note, for the Host to carry on if this app goes away.
    // A chat session has no Host pty note to write into, and a fallback session has no Host at all:
    // remember() does nothing for either (writeRollSnapshot).
    snapshot: writeRollSnapshot,
    log: (m) => rollingLog(`[codex] ${m}`),
    lang: () => core!.lang,
    blocks,
    persistConfig: (sid, cfg) => {
      void core!.rollConfig.set(sid, cfg).catch(() => {}) // fire-and-forget
    },
    orchEnv: () => orchRef?.orchEnv(),
    // Job Continuity: binds the native session id to the open Dispatch as soon as the coordinator learns it.
    onNativeSession: (sid, native) => orchRef?.onNativeSession(sid, native),
    // Job 워커의 재개 packet(Task 4b/4c) — rolling.ts 의 같은 필드, 같은 resumeTextDep 이다.
    resumeText: resumeTextDep,
    // 한도에 걸린 세션을 어떻게 이어갈지(Task 1 의 설정) — orchEnv 와 같은 이유로 getter 다: 값이
    // 설정 화면에서 앱 수명 중간에 바뀌고, 이 코디네이터는 그보다 먼저 만들어진다.
    resumeStrategy: () => core!.appSettings.getResumeStrategy()
  })
  codexRollingRef = codexRolling
  // Agent orchestration: an HTTP server embedded in the app plus the astera CLI let an agent spawn
  // worker sessions on another vendor. registerIpc does the startup (spawnSession and busyState,
  // which the coordinator requires, are owned by ipc.ts) — here it gets the same share as every
  // other subsystem: a log file (userData/orchestration.log, same pattern as rolling.log and
  // slack.log) and shutdown cleanup.
  const orchLogFile = path.join(app.getPath('userData'), 'orchestration.log')
  const orchLog = (m: string): void => {
    try {
      appendFileSync(orchLogFile, `${new Date().toISOString()} ${m}\n`)
    } catch {
      /* a logging failure must not block orchestration */
    }
  }
  // The app's side of the Astera Host channel. Its own file, beside rolling.log, slack.log and
  // orchestration.log — one per subsystem. The Host writes host/host.log from its end; this is the
  // other end of the same conversation, and somebody asking why Settings says Not connected has to
  // find it under a name that says Host rather than buried in an unrelated subsystem's log.
  const hostLogFile = path.join(app.getPath('userData'), 'host-client.log')
  const hostLog = (m: string): void => {
    try {
      appendFileSync(hostLogFile, `${new Date().toISOString()} ${m}\n`)
    } catch {
      /* a logging failure must not take the Host client down */
    }
  }
  registerIpc(
    core,
    win,
    attention, // required (ipc.ts's own comment says why it moved ahead of the optional parameters)
    pendingPrompt,
    rolling,
    {
      notifier: slack,
      store: slackStore,
      reconfigureInbox: (cfg) => void slackInboxController.apply(cfg) // rebuild the socket on settings change
    },
    codexRolling,
    scheduler,
    codexRollout,
    {
      log: orchLog,
      logPath: orchLogFile,
      onStarted: (h) => {
        orchRef = h
      },
      // fix wave 최종, F1: called unconditionally, regardless of whether orchestration ever starts —
      // see OrchWiring.onTabResumeReady's JSDoc (ipc.ts) and resumeTextDep above.
      onTabResumeReady: (fn) => {
        tabResumeTextRef = fn
      },
      deliverChat: (sid, text) => sessionDriver.deliver(sid, text)
    },
    () => refreshTrayMenu(win), // rebuild Open/Quit in the new language after settings.setLang
    // 위 두 send 탭이 부를 자리를 받아 둔다. registerIpc 가 돌아오면서 바로 채워지고,
    // 탭은 그보다 훨씬 뒤인 첫 롤에서야 돌므로 순서 문제는 없다(orchRef 와 같은 모양).
    (notify) => {
      workUnitForkRef = notify
    },
    desktop,
    agentGuests,
    {
      log: hostLog,
      // A roll the Host made and pushed (S6 §3.4) costs the app what its own rolls cost, except the
      // orchestration tap: the Host already rekeyed the Dispatch, and hostRollView (ipc.ts) passes
      // `orchestration: false` — pinned by its tests rather than here.
      fanOutRollEvent,
      // Handed over as soon as the client exists, whether or not a Host is ever reached — the same
      // shape as onTabResumeReady above. Read from will-quit.
      onHostClientReady: ({ stop, retire, survivesUpdate }) => {
        hostClientStopRef = stop
        hostClientRetireRef = retire
        hostSurvivesUpdateRef = survivesUpdate
      }
    }
  )
  // No tray on Linux. With close quitting for real there is nothing to hide, so the menu's
  // Open/Quit would only repeat what the window and its close button already do — while tying the
  // app to AppIndicator support the desktop may not have. refreshTrayMenu guards on `tray?.`, so the
  // language-change callback wired just above stays correct with no tray to rebuild.
  if (process.platform !== 'linux') createTray(win)

  // Start the history file watcher in the background once the window is shown (live updates). Not
  // awaited, so it does not block window creation.
  // The unregistered-dir scan comes first, and the watcher is started after it rather than alongside:
  // both of these used to run in parallel, and reload() then closed the watcher startBackground() was
  // still registering — so the watcher was built twice and startBackground()'s promise never settled
  // (nothing awaited it, so the leak was invisible). The scan reads only the home directory, so the
  // sidebar shows registered accounts first and gains the ghosts a moment later; refresh() is what
  // makes the renderer re-query with them included.
  void core
    .refreshGhostAccounts()
    .then(() => core!.history.refresh())
    .then(() => core!.history.startBackground())

  // Registered outside the isPackaged block below, unlike the rest of the update channels, because
  // the renderer asks this on every mount and a dev build has a real answer for it: `updateCampaign`
  // starts as null, and null is "no campaign". Left inside, the handler simply did not exist in dev,
  // and Electron logged "No handler registered for 'update:campaignState'" from the main process on
  // every boot — twice, since StrictMode mounts the effect twice. The renderer's own `.catch()`
  // cannot suppress that: Electron writes it before the rejection is handed back.
  //
  // Its sibling `update:dismissCampaign` stays inside on purpose. Dismissing needs a campaign to
  // have been shown, which cannot happen without the updater, so nothing ever calls it in dev.
  ipcMain.handle('update:campaignState', () => updateCampaign)

  // Auto-update: pulled from public GitHub Releases with no credentials. Progress is surfaced both
  // to a file log (userData/updater.log) and to the renderer (shown in the title bar).
  if (app.isPackaged) {
    const logFile = path.join(app.getPath('userData'), 'updater.log')
    const flog = (m: string): void => {
      try {
        appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`)
      } catch {
        /* a logging failure must not block the update */
      }
    }
    const push = (s: {
      state: string
      version?: string
      percent?: number
      message?: string
    }): void => {
      flog(JSON.stringify(s))
      try {
        if (!win.isDestroyed()) win.webContents.send('update:status', s)
      } catch {
        /* renderer send failures are ignored */
      }
    }
    push({ state: 'init', version: app.getVersion() })
    import('electron-updater')
      .then((mod) => {
        // electron-updater is CommonJS, so depending on the dynamic import's interop autoUpdater can
        // sit under default (0.1.6-0.1.8 destructured it off the top level, got undefined, and failed
        // silently). Try both shapes.
        const autoUpdater: AppUpdater | undefined =
          (mod as { autoUpdater?: AppUpdater }).autoUpdater ??
          (mod as { default?: { autoUpdater?: AppUpdater } }).default?.autoUpdater
        if (!autoUpdater) {
          push({ state: 'error', message: t(core!.lang, 'update.tb.autoUpdaterMissing') })
          return
        }
        // Auto-download is on: a found version starts downloading immediately, so the user only has
        // to press "Install now" once it has arrived. The Download buttons stay in place as the
        // fallback for the window before the download starts and for one that failed.
        autoUpdater.autoDownload = true
        autoUpdater.logger = {
          info: (m) => flog(`INFO ${m}`),
          warn: (m) => flog(`WARN ${m}`),
          error: (m) => flog(`ERROR ${m}`),
          debug: () => {}
        }
        // Failures from the automatic (periodic) check are not surfaced to the user — the backoff is
        // what handles errors that showed up over and over outside the internal network. Only a check
        // the user pressed themselves pushes an error state.
        let userInitiatedCheck = false
        const settleCheck = (): void => {
          userInitiatedCheck = false
        }

        // **Downloaded is not the same as installable on macOS.** electron-updater announces
        // 'update-downloaded' before Squirrel.Mac has looked at the build at all, and on an
        // ad-hoc-signed release Squirrel then refuses it every time — permanently, for the reason
        // manualInstall.ts sets out. Left at that, the app offers "restart and install" for a build
        // that cannot be installed, and pressing it does nothing whatsoever.
        //
        // So the native updater is watched directly for the verdict electron-updater does not pass
        // on. It is the same object electron-updater drives internally, so this only listens; it
        // never drives it. Guarded to darwin because Squirrel.Mac is the only updater with this
        // split, and electron's autoUpdater has no meaning on Linux.
        let staging: StagingState = NOTHING_STAGED
        let downloaded: { version: string; file: string } | null = null
        const advanceStaging = (e: StagingEvent): void => {
          const before = staging
          staging = reduceStaging(staging, e)
          // Announced once, on the edge. The refusal arrives about a second after the download, so
          // without this the person is looking at an install button that already cannot work.
          if (staging.refused && !before.refused)
            push({ state: 'manual', version: downloaded?.version, message: staging.refused })
        }
        if (process.platform === 'darwin') {
          squirrel.on('update-downloaded', () => advanceStaging({ type: 'staged' }))
          squirrel.on('error', (e) => advanceStaging({ type: 'error', message: e?.message ?? String(e) }))
        }

        autoUpdater.on('checking-for-update', () => {
          advanceStaging({ type: 'check' }) // a newer version would replace whatever was judged before
          push({ state: 'checking' })
        })
        autoUpdater.on('update-available', (i) => {
          push({ state: 'available', version: i.version })
          settleCheck()
        })
        autoUpdater.on('update-not-available', (i) => {
          push({ state: 'uptodate', version: i.version })
          settleCheck()
        })
        autoUpdater.on('download-progress', (p) =>
          push({ state: 'downloading', percent: Math.round(p.percent) })
        )
        autoUpdater.on('update-downloaded', (i) => {
          // The file itself, straight from the event, rather than a guess at electron-updater's
          // cache layout — it is what the manual path unpacks, and it has already been checked
          // against the sha512 in the feed by the time this fires.
          downloaded = { version: i.version, file: i.downloadedFile }
          advanceStaging({ type: 'downloaded' })
          push({ state: 'downloaded', version: i.version })
        })
        autoUpdater.on('error', (e) => {
          const message = e?.message ?? String(e)
          if (userInitiatedCheck) push({ state: 'error', message })
          else flog(`WARN automatic check failed (not surfaced to the user): ${message}`)
          settleCheck()
        })

        // Periodic check: 24 hours after a success; as failures pile up, 1h -> 2h -> 4h -> 6h cap.
        // A successful check rolls the failure counter back.
        let checkTimer: NodeJS.Timeout | null = null
        let consecutiveFailures = 0
        const scheduleNextCheck = (): void => {
          if (checkTimer) clearTimeout(checkTimer)
          const delay = nextCheckDelayMs(consecutiveFailures)
          flog(`next auto check: ${Math.round(delay / 60_000)}min (consecutive failures ${consecutiveFailures})`)
          checkTimer = setTimeout(() => void runAutomaticCheck(), delay)
        }
        const runAutomaticCheck = async (): Promise<void> => {
          try {
            await autoUpdater.checkForUpdates()
            consecutiveFailures = 0
          } catch (e) {
            consecutiveFailures += 1
            flog(`WARN automatic check failed ${consecutiveFailures}x: ${(e as Error)?.message ?? String(e)}`)
          }
          scheduleNextCheck()
        }

        ipcMain.handle('update:check', async () => {
          userInitiatedCheck = true
          try {
            await autoUpdater.checkForUpdates()
            consecutiveFailures = 0
          } catch {
            /* the state is delivered through the error event */
          }
          scheduleNextCheck() // a manual check resets the cycle too — 24 hours from now is right
        })
        ipcMain.handle('update:download', async () => {
          try {
            await autoUpdater.downloadUpdate()
          } catch {
            /* the state is delivered through the error event */
          }
        })
        ipcMain.handle('update:install', async (): Promise<InstallOutcome> => {
          // The macOS fallback, taken only once Squirrel has actually refused this build. Nothing is
          // downloaded here: autoDownload already fetched and checksummed the zip, so this unpacks
          // what is on disk, strips the quarantine attribute that would otherwise make Gatekeeper
          // block the new app, and shows it to the person in Finder to drag into /Applications.
          // The app does not quit itself on this path — the renderer asks first, then quits, so the
          // Finder window is not the only thing left explaining what just happened.
          if (installRoute(process.platform, staging) === 'manual') {
            if (!downloaded) {
              // Refused with nothing on disk to offer. Not reachable through the button (the button
              // only appears after a download) but a handler must not lie about what it did.
              flog('ERROR manual install requested with no downloaded file')
              return { mode: 'failed', message: t(core!.lang, 'update.manual.noFile') }
            }
            try {
              const appPath = await extractForManualInstall({
                downloadedFile: downloaded.file,
                version: downloaded.version
              })
              flog(`manual install prepared: ${appPath}`)
              shell.showItemInFolder(appPath)
              return { mode: 'manual', appPath }
            } catch (e) {
              const message = (e as Error)?.message ?? String(e)
              flog(`ERROR manual install failed: ${message}`)
              return { mode: 'failed', message }
            }
          }

          // **The Host is left running wherever it can be.** That is the point of having one: its
          // sessions carry on through the install and the new version takes them back. macOS and
          // Linux replace a running binary without complaint, so this was always true there.
          //
          // On win32 it is true only once the Host runs from its own runtime outside the install
          // directory (docs/superpowers/specs/2026-09-14-host-runtime-design.md). Spawned from the
          // app's own executable — this version's fallback, and every version up to 1.3.19 — it pins
          // `Astera.exe` and the installer cannot write over it; worse, killing one while this app
          // still watches the address only gets a fresh one started a second later, which is what
          // made installing 1.3.18 give up and say the app could not be closed. So on that path the
          // Host still stands down first, and `survivesUpdate` is what tells the two apart.
          //
          // Awaited, and a failure is not one: the point is to be gone, and a Host that never
          // answered is already that. quitAndInstall follows either way — the installer's own
          // customCheckAppRunning (build/installer.nsh) is the net under this.
          if (!(hostSurvivesUpdateRef?.() ?? process.platform !== 'win32')) {
            try {
              await hostClientRetireRef?.()
            } catch {
              /* already gone, or never there */
            }
          }
          autoUpdater.quitAndInstall()
          return { mode: 'auto' }
        })

        // Update campaign. The policy is fetched from the same address with the same token as the
        // feed. Any lookup or parse failure means no campaign — a policy or network problem must not
        // block or nag the user. The verdict can land either before or after the renderer mounts, so
        // both a push and a query are provided — and the query is registered above this block, since
        // it has an answer even where the updater does not run.
        ipcMain.handle('update:dismissCampaign', async (_e, id: unknown) => {
          if (typeof id !== 'string' || !id.trim()) return
          if (updateCampaign?.id === id) updateCampaign = null
          await core!.appSettings.setDismissedCampaignId(id)
          flog(`campaign dismissed: ${id}`)
        })
        void (async () => {
          const policyUrl = readPolicyUrl()
          if (!policyUrl) return
          const campaign = await loadPolicy(policyUrl, fetch)
          const appVersion = app.getVersion()
          const dismissedId = core!.appSettings.getDismissedCampaignId()
          if (!shouldApplyCampaign({ campaign, appVersion, dismissedId })) return
          updateCampaign = { id: campaign!.id, mode: campaign!.mode }
          flog(`campaign applied: id=${campaign!.id} mode=${campaign!.mode} version=${appVersion}`)
          try {
            if (!win.isDestroyed()) win.webContents.send('update:campaign', updateCampaign)
          } catch {
            /* send failures are ignored — the renderer also gets this via update:campaignState */
          }
        })()

        // Check once at startup, then arm the periodic check. With autoDownload=true a found version
        // starts downloading as soon as a check reports it.
        void runAutomaticCheck()
      })
      .catch((e) => push({ state: 'error', message: `updater load failed: ${e?.message ?? String(e)}` }))
  }
})

app.on('before-quit', () => {
  quitting = true
  void slackInboxControllerRef?.stop() // Slack inbound socket cleanup — a failure must not block quit
  slackInboxControllerRef = null
})
// win32 quits once every window is closed. macOS has the opposite convention, and it genuinely fits
// this app — sessions keep running in the background, and rolling and Slack notifications need to
// stay alive. The only real quit paths are the tray's 'Quit', the mac app menu's Cmd+Q, and — on
// Linux, where there's no tray to hide to — an ordinary window close (all three go through app.quit).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('will-quit', () => {
  // Only removes a file naming this process, so the instance that lost the lock leaves the other's.
  clearAppRunning(app.getPath('userData'), process.pid)
  if (!core) return
  // **Whether quitting ends a pty is now a question, and it is asked per pty** (slice 2 design §1).
  // While they were all this process's own children, ending them here was the only honest thing to
  // do: an orphaned agent keeps spending tokens with nobody able to reach it. One the Host owns is
  // its child instead, `sessions.kill` reaches across the socket and ends the real process, and
  // running this cleanup on it would leave the terminals surviving a crash but not an ordinary quit
  // — the exact inverse of what the slice promises.
  //
  // Both kinds can be live at once: the Host takes a moment to start, and a session, Run or terminal
  // made before it answered went to node-pty. Asking "is a Host installed" would sweep those into
  // whichever branch the answer chose, so each manager is asked about its own ptys instead. The
  // router wrote the answer onto each handle at the moment it chose the factory — see
  // `PtyLike.outlivesApp`. With no Host every pty is the app's own and this runs exactly as it did
  // before a Host existed: same teardown, same order.
  for (const s of core.sessions.runningAppOwned()) {
    try {
      core.sessions.kill(s.id)
    } catch {
      /* so one failed kill does not block cleanup of the remaining sessions */
    }
  }
  // The chat sessions' line processes, on exactly the same terms. Their handles carry the same
  // `outlivesApp` the router wrote onto the ptys, so the Host's are left running and the app's own
  // children are ended — an orphaned `codex app-server` would otherwise sit there with nobody able to
  // reach it, which is the same harm the loop above exists to prevent.
  for (const s of core.chat.runningAppOwned()) {
    try {
      core.chat.kill(s.id)
    } catch {
      /* so one failed kill does not block cleanup of the remaining chat sessions */
    }
  }
  try {
    codexRollingRef?.stop()
  } catch {
    /* a coordinator cleanup failure must not block quit */
  }
  try {
    schedulerRef?.stop() // schedule timer cleanup
  } catch {
    /* shutdown cleanup failures are ignored */
  }
  try {
    codexRolloutRef?.stop() // codex rollout watcher polling cleanup
  } catch {
    /* shutdown cleanup failures are ignored */
  }
  // Both of these end ptys, so both skip the Host's for the same reason the session loop above does
  // — a Run's dev server and a project terminal survive a quit exactly as an agent session does.
  // A run the app owns still gets the tree kill it always got, which is the whole reason this is a
  // per-pty question: only that reaches the build's own children (`RunManager.stopAppOwned`).
  try {
    core.run.stopAppOwned()
  } catch {
    /* a run cleanup failure must not block quit */
  }
  try {
    core.terminal.closeAppOwned() // project terminal cleanup
  } catch {
    /* shutdown cleanup failures are ignored */
  }
  try {
    orchRef?.stop() // close the orchestration server + delete the token file
    orchRef = null
  } catch {
    /* shutdown cleanup failures are ignored */
  }
  try {
    // The Host client's socket and its retry timers. Nothing is awaited: `stop()` has done its work
    // by the time it returns, and asynchronous cleanup may not finish before the process ends
    // (OrchWiring.onStarted's JSDoc, ipc.ts, on why these are all synchronous).
    void hostClientStopRef?.()
    hostClientStopRef = null
  } catch {
    /* shutdown cleanup failures are ignored */
  }
})
