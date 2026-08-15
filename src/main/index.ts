import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from 'electron'
import path from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import type { AppUpdater } from 'electron-updater'
import iconAsset from '../../resources/icon.png?asset'
import trayAsset from '../../resources/tray.png?asset'
import { createCore, type Core } from './core'
import { applyLoginPath } from './loginPath'
import { registerIpc } from './ipc'
import { RollingCoordinator } from './rolling'
import { SchedulerCoordinator } from './scheduler'
import { CodexRollingCoordinator } from './codexRolling'
import { SlackNotifier, SlackConfigStore } from './slack'
import { SlackInboxController, createSocketClient } from './slackInbox'
import { HookEventWatcher } from './hookEvents'
import { CodexTurnWatcher } from './codexTurnWatcher'
import { RateLimitFetcher } from './usage'
import { t } from '../core/i18n'
import { loadPolicy, nextCheckDelayMs, parsePolicyUrl, shouldApplyCampaign } from './updatePolicy'
import type { SessionInfo, RollStateEvent, UpdateCampaignInfo } from '../core/types'

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

// The oldest usage figure the limit gate is allowed to decide on. RateLimitFetcher's default 5-minute
// cache is fine for a status bar but fatal for a verdict — a reading taken just below the threshold
// (96%, say) would reject a genuine limit 90 seconds later. The phrase re-matches on every chunk while
// it is on screen, so this window doubles as the query throttle.
const USAGE_GATE_MAX_AGE_MS = 10_000

let core: Core | null = null
let codexRollingRef: CodexRollingCoordinator | null = null
let schedulerRef: SchedulerCoordinator | null = null
let codexTurnsRef: CodexTurnWatcher | null = null
let slackInboxControllerRef: SlackInboxController | null = null // Slack inbound socket rebuilder — cut on quit
let rollingRef: RollingCoordinator | null = null // lets the hook callback reach a coordinator created later
let orchRef: { stop: () => void } | null = null // orchestration server shutdown cleanup
let tray: Tray | null = null
let quitting = false
let mainWindow: BrowserWindow | null = null // focus target for the single-instance second-instance event
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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Astera',
    icon: APP_ICON, // window/taskbar icon (electron-builder win.icon only changes the installed exe icon)
    // titleBarStyle is documented as macOS/Windows only, and stays load-bearing on both: on win32 it
    // is what lets this app draw its own window controls instead of Windows', and on macOS it is
    // what keeps the traffic-light buttons that trafficLightPosition below then repositions. Left
    // unset on Linux — see that comment below for why.
    ...(process.platform !== 'linux' ? { titleBarStyle: 'hidden' as const } : {}),
    // macOS: titleBarStyle:'hidden' leaves the traffic-light buttons floating in the top-left. The
    // default y coordinate sits below our 32px titlebar and gets half-clipped, so this centers them
    // vertically. (button height 12px → (32-12)/2 = 10)
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 10 } } : {}),
    // Linux — hypothesis under test, not a settled fix: the owner reports the packaged window on
    // Ubuntu 22.04/WSLg sits partly off the right edge of the screen, and clicks land roughly one
    // title-bar-height above the control they visually hit. Both symptoms point at the same cause —
    // titleBarStyle only affects macOS/Windows, but this window manager does not just ignore it: it
    // decorates the window with its own native frame while Electron still sizes/positions it as if it
    // had none, so what's painted and what receives input disagree by about the native bar's height.
    // Leaving titleBarStyle unset here should let Electron and the window manager agree on one frame
    // again. Whether it actually does needs checking by hand on that machine — none of this is
    // reachable from a test. Known, accepted cost: with the native frame back and this app's own
    // titlebar still drawn below it, Linux ends up with two title bars — cosmetic, unlike mis-clicking
    // windows, which is not usable at all. A single Linux title bar is a separate follow-up (most
    // likely hiding this app's own titlebar/buttons on Linux and letting the native frame be the only
    // chrome). See 96a9f0a (frame:false — fixed the duplicate bar but broke maximize) and 340c2da (its
    // revert): frame:false is not that follow-up, and is not being reintroduced here.
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: false }
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
    { label: t(core!.lang, 'common.trayQuit'), click: () => app.quit() }
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
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

// macOS: closing the window leaves the app alive (win.on('close') redirects to hide) and the Dock
// icon stays. Clicking that icon fires activate, but the default behavior alone won't bring the
// hidden window back.
app.on('activate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return // second instance — waits for quit without initializing
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
  // codex turn-completion detection: codex has no hooks, so this reads task_complete out of the
  // rollout jsonl. Independent of rolling, only codex sessions with Slack notifications on are
  // watched (the caller decides that at register time) — the watcher's own logs share slack.log,
  // since turn-completion notifications end up on Slack anyway.
  const codexTurns = new CodexTurnWatcher({
    getAccount: (id) => {
      try {
        return core!.accounts.get(id)
      } catch {
        return null
      }
    },
    onTurnComplete: (sessionId, rolloutPath) => slack.onCodexTurnComplete(sessionId, rolloutPath),
    log: slackLog
  })
  codexTurnsRef = codexTurns
  const hookWatcher = new HookEventWatcher(
    core.hookEventsDir,
    (sid, payload) => {
      slack.onHookEvent(sid, payload)
      // Rolling taps the hooks too — an idle Notification is the signal for the idle nudge.
      // Isolated in its own try, separate from the Slack tap, so an exception on one side does not
      // swallow the other.
      try {
        rollingRef?.onHookEvent(sid, payload)
      } catch {
        /* a rolling tap failure must not block the Slack notification */
      }
    },
    slackLog
  )
  hookWatcher.start()

  // Account rolling: progress logs go to userData/rolling.log (same pattern as updater.log)
  const rollLog = path.join(app.getPath('userData'), 'rolling.log')
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
  // Session scheduler: runs periodic commands automatically. Logs share rolling.log ([sched] prefix)
  const scheduler = new SchedulerCoordinator({
    write: (id, d) => {
      try {
        core!.sessions.write(id, d)
      } catch {
        /* a write failure must not block the schedule timer */
      }
    },
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
    }
  })
  schedulerRef = scheduler
  // Direct account-usage lookups. It carries its own call coalescing, backoff and 10-second timeout, so
  // a limit phrase re-matching on every chunk still produces very few real requests. The token never
  // leaves this process.
  const usageFetcher = new RateLimitFetcher()
  const rolling = new RollingCoordinator({
    spawn: (opts) => core!.sessions.spawn(opts),
    write: (id, d) => core!.sessions.write(id, d),
    kill: (id) => core!.sessions.kill(id),
    getAccount: (id) => {
      try {
        return core!.accounts.get(id)
      } catch {
        return null
      }
    },
    readStatusPayload: (id) => core!.statusLinePayload(id),
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
      return u.status === 'ok' ? u.maxPercent : null
    },
    send: (channel, payload) => {
      try {
        if (!win.isDestroyed()) win.webContents.send(channel, payload)
      } catch {
        /* renderer send failures are ignored */
      }
      // The scheduler taps rolling events too — isolated in its own try, separate from the Slack
      // tap, so a throw out of rekey does not silently swallow the Slack notification (rolled) below.
      try {
        if (channel === 'session:rolled') {
          const p = payload as { oldSessionId: string; info: SessionInfo }
          scheduler.rekey(p.oldSessionId, p.info.id) // the schedule follows the roll chain
        } else if (channel === 'session:rollState') {
          // Suppress schedule firing during the roll-resume window (switching/trust/waiting/nudged)
          scheduler.handleRollState(payload as RollStateEvent)
        }
      } catch {
        /* a schedule tap failure must not block rolling or the Slack notification */
      }
      // Slack notifications tap rolling events too. Isolated so a tap exception does not block rolling.
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
    },
    log: (m) => {
      try {
        appendFileSync(rollLog, `${new Date().toISOString()} ${m}\n`)
      } catch {
        /* a logging failure must not block rolling */
      }
    },
    lang: () => core!.lang,
    persistConfig: (sid, cfg) => {
      // fire-and-forget — a persist failure must not block rolling
      void core!.rollConfig.set(sid, cfg).catch(() => {})
    }
  })
  rollingRef = rolling

  // Codex account rolling. Uses the same log file and event channels as the Claude coordinator, but
  // does not depend on statusLine or Slack.
  const codexRolling = new CodexRollingCoordinator({
    spawn: (opts) => core!.sessions.spawn(opts),
    kill: (id) => core!.sessions.kill(id),
    getAccount: (id) => {
      try {
        return core!.accounts.get(id)
      } catch {
        return null
      }
    },
    send: (channel, payload) => {
      try {
        if (!win.isDestroyed()) win.webContents.send(channel, payload)
      } catch {
        /* renderer send failures are ignored */
      }
      try {
        if (channel === 'session:rolled') {
          // dest: the rollout path copied into the target account just before the roll
          // (codexRolling.roll() carries it along). If that copy is the only candidate on the first
          // polling tick right after re-registering, the watcher latches onto it and misfires on the
          // last turn from before the roll — excludePaths keeps it out.
          const p = payload as { oldSessionId: string; info: SessionInfo; dest?: string }
          scheduler.rekey(p.oldSessionId, p.info.id) // the schedule follows the roll chain
          // When rolling switches accounts the session respawns under a new sessionId and a new
          // rollout file appears — without re-registering, turn-completion notifications stop for
          // good after the switch. codexRolling is the codex-only coordinator (ipc.ts's spawn branch
          // already splits on provider), so every session reaching here is codex — re-checking the
          // provider is unnecessary.
          codexTurns.unregister(p.oldSessionId)
          if (p.info.slackNotify) codexTurns.register(p.info, p.dest ? [p.dest] : undefined)
        } else if (channel === 'session:rollState') {
          // codex rolling sends session:rollState too (switching/waiting/none) — suppress the resume window
          scheduler.handleRollState(payload as RollStateEvent)
        }
      } catch {
        /* a tap failure must not block rolling */
      }
      // Slack notifications tap codex rolling events too (mirroring the claude side) — isolated so a
      // tap exception does not block rolling. Without this the SlackNotifier record stays on the old
      // id, so turn notifications stop after the switch, onRolled cannot cancel the scheduled exit
      // timer so a false session-exit goes out, and limit-reached, account-switch and reset
      // notifications never arrive for codex at all.
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
    },
    log: (m) => {
      try {
        appendFileSync(rollLog, `${new Date().toISOString()} [codex] ${m}\n`)
      } catch {
        /* a logging failure must not block rolling */
      }
    },
    lang: () => core!.lang,
    persistConfig: (sid, cfg) => {
      void core!.rollConfig.set(sid, cfg).catch(() => {}) // fire-and-forget
    }
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
  registerIpc(
    core,
    win,
    rolling,
    {
      notifier: slack,
      store: slackStore,
      reconfigureInbox: (cfg) => void slackInboxController.apply(cfg) // rebuild the socket on settings change
    },
    codexRolling,
    scheduler,
    codexTurns,
    {
      log: orchLog,
      onStarted: (h) => {
        orchRef = h
      }
    },
    () => refreshTrayMenu(win) // rebuild Open/Quit in the new language after settings.setLang
  )
  // No tray on Linux. With close quitting for real there is nothing to hide, so the menu's
  // Open/Quit would only repeat what the window and its close button already do — while tying the
  // app to AppIndicator support the desktop may not have. refreshTrayMenu guards on `tray?.`, so the
  // language-change callback wired just above stays correct with no tray to rebuild.
  if (process.platform !== 'linux') createTray(win)

  // Start the history file watcher in the background once the window is shown (live updates). Not
  // awaited, so it does not block window creation.
  // The unregistered-dir scan rides along for the same reason — it reads the home directory, and the
  // sidebar is allowed to show registered accounts first and gain the rest a moment later. reload()
  // afterwards is what makes the renderer re-query with the ghosts included.
  void core.refreshGhostAccounts().then(() => core!.history.reload())
  void core.history.startBackground()

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
        autoUpdater.on('checking-for-update', () => push({ state: 'checking' }))
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
        autoUpdater.on('update-downloaded', (i) => push({ state: 'downloaded', version: i.version }))
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
        ipcMain.handle('update:install', () => {
          autoUpdater.quitAndInstall()
        })

        // Update campaign. The policy is fetched from the same address with the same token as the
        // feed. Any lookup or parse failure means no campaign — a policy or network problem must not
        // block or nag the user. The verdict can land either before or after the renderer mounts, so
        // both a push and a query are provided.
        ipcMain.handle('update:campaignState', () => updateCampaign)
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
  if (!core) return
  const running = core.sessions.list().filter((s) => s.status === 'running')
  for (const s of running) {
    try {
      core.sessions.kill(s.id)
    } catch {
      /* so one failed kill does not block cleanup of the remaining sessions */
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
    codexTurnsRef?.stop() // codex turn watcher polling cleanup
  } catch {
    /* shutdown cleanup failures are ignored */
  }
  try {
    core.run.stopAll()
  } catch {
    /* a run cleanup failure must not block quit */
  }
  try {
    core.terminal.closeAll() // project terminal cleanup
  } catch {
    /* shutdown cleanup failures are ignored */
  }
  try {
    orchRef?.stop() // close the orchestration server + delete the token file
    orchRef = null
  } catch {
    /* shutdown cleanup failures are ignored */
  }
})
