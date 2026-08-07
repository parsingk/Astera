import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { AccountRegistry } from '../core/accounts/registry'
import { PROVIDERS, metaOf } from '../core/providers/meta'
import { makeDescriptors, descriptorOf, isAmbientDir, type ProviderDescriptor } from '../core/providers/descriptor'
import { SessionManager } from '../core/sessions/manager'
import { nodePtyFactory } from '../core/sessions/nodePtyFactory'
import { HistoryIndex } from '../core/history/index'
import { ProjectSettings } from '../core/projects/settings'
import { StatusLineManager } from './statusline'
import { parseStatusLinePayload } from '../core/usage/statusline'
import { isDefaultConfigDir, syncSettingsFromDefault } from '../core/accounts/settingsSync'
import { RollConfigStore } from '../core/rolling/config'
import { SchedulerConfigStore } from '../core/scheduler/config'
import { RunConfigStore } from './runConfigStore'
import { RunManager } from './runManager'
import { TerminalManager } from './terminalManager'
import { WorktreeRegistry } from '../core/worktrees/registry'
import { LocalHistoryStore } from '../core/localHistory/store'
import { AppSettingsStore } from './appSettingsStore'
import { KeybindingsStore } from './keybindingsStore'
import { pickInitialLang } from '../core/i18n/locale'
import type { Lang, Message } from '../core/i18n'
import type { DetectCandidate, Provider, SessionUsage } from '../core/types'

export interface Core {
  accounts: AccountRegistry
  sessions: SessionManager
  history: HistoryIndex
  // Provider descriptor table. ipc reads per-provider facts from it without branching —
  // before it was exposed, choosing the transcript path mapper was a hardcoded branch in ipc.ts
  descriptors: Record<Provider, ProviderDescriptor>
  projects: ProjectSettings
  detectAccounts: () => Promise<DetectCandidate[]>
  accountEmail: (id: string) => Promise<string | null>
  accountEmailOfDir: (configDir: string, provider?: Provider) => Promise<string | null>
  accountLogout: (id: string) => Promise<{ ok: boolean; message?: Message }>
  isDefaultAccountDir: (configDir: string) => boolean // Default (ambient) account verdict — for the isDefault decoration
  accountSyncSettings: (id: string) => Promise<{ ok: boolean; message?: Message }> // Import the default account's settings
  usageSession: (sessionId: string) => Promise<SessionUsage | null>
  statusLinePayload: (sessionId: string) => Promise<unknown | null> // Raw payload, for rolling
  hookEventsDir: string // Hook event file directory — watched by index.ts's HookEventWatcher
  // Rolling config persistence. index.ts does the persisting (the rolling.ts persistConfig wiring);
  // ipc.ts no longer restores from here — it only reads (get) for sessions.resumeDefaults
  rollConfig: RollConfigStore
  // Scheduler config persistence. Persisting is shared between index.ts (the scheduler.ts persistConfig
  // wiring) and ipc.ts's resume re-stamp (schedulerConfig.set). ipc.ts no longer auto-restores; it only
  // reads (get) for sessions.resumeDefaults.
  schedulerConfig: SchedulerConfigStore
  // Corruption-recovery result from schedulerConfig.load() — createCore has no logger, so index.ts logs it instead
  // pruned: how many expired (TTL) entries were cleaned up
  schedulerConfigLoad: { recovered: boolean; dropped: number; pruned: number }
  runConfig: RunConfigStore // User run config persistence
  run: RunManager // Project run management
  terminal: TerminalManager // Project terminal management
  worktrees: WorktreeRegistry // git worktree registry for sessions
  localHistory: LocalHistoryStore // Snapshot store written just before a delete
  appSettings: AppSettingsStore // App-wide settings persistence
  keybindings: KeybindingsStore // User keybinding overrides
  // The current language main uses when building user-visible sentences — settings.setLang updates it.
  // Pure core modules only produce a Message (a key); translation happens in this layer, which knows the language
  lang: Lang
}

// An alias narrowed to just the shape accountLogout actually uses — node:child_process's execFile has so many
// overloads that using its type directly causes variance problems at the injection point (same reason as KillRunner in runManager.ts).
type ExecFileFn = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; shell: boolean; timeout: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void

/**
 * Account logout wiring — assembles file/args/env from the descriptor, homeDir and configDir, then runs execFileFn.
 * Why this is split out of createCore() and exported on its own: createCore is heavy with file I/O (loading
 * accounts.json, initialising statusLine), and a test that only checks this wiring (whether the isolation env is
 * injected according to the ambient verdict, whether the per-provider file and args are right) does not need all of
 * that startup. Making execFileFn an injectable last argument, with the real execFile wrapped as its default,
 * follows RunManager's killRunner convention (optional parameter + default) — core.test.ts calls this function
 * directly to cover all four claude/codex x ambient/isolated combinations.
 */
export function runAccountLogout(
  d: ProviderDescriptor,
  homeDir: string,
  configDir: string,
  execFileFn: ExecFileFn = (file, args, options, callback) => execFile(file, args, options, callback)
): Promise<{ ok: boolean; message?: Message }> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // Same rule as SessionManager.spawn — no isolation env is injected when ambient
  if (isAmbientDir(d, homeDir, configDir)) delete env[d.configDirEnv]
  else env[d.configDirEnv] = configDir
  return new Promise((resolve) => {
    execFileFn(d.cliFile, d.logoutArgs, { env, shell: true, timeout: 30_000 }, (err, _out, stderr) => {
      if (err) {
        const detail = (stderr || err.message || '').toString().trim()
        resolve({
          ok: false,
          message: detail
            ? { key: 'account.error.raw', params: { detail } }
            : { key: 'account.error.logoutFailed' }
        })
      } else resolve({ ok: true })
    })
  })
}

export async function createCore(userDataDir: string, osLocale: string): Promise<Core> {
  const descriptors = makeDescriptors(process.platform)
  const accounts = new AccountRegistry(
    path.join(userDataDir, 'accounts.json'),
    path.join(os.homedir(), descriptors.claude.accountsRootName),
    path.join(os.homedir(), descriptors.codex.accountsRootName)
  )
  await accounts.load()
  // One-time repair of labels frozen at DEFAULT_ACCOUNT_PLACEHOLDER_LABEL back when the email could not be read (idempotent)
  await accounts.syncPlaceholderLabels((a) =>
    descriptorOf(descriptors, a).readEmail(a.configDir, os.homedir())
  )
  // statusLine usage hook: prepares the capture script and settings file, and injects a session-scoped
  // statusLine via --settings on every session spawn. The global settings.json is never touched.
  const statusLine = new StatusLineManager(userDataDir)
  await statusLine.init()
  // descriptors is injected explicitly — left unspecified, each of them calls makeDescriptors(process.platform)
  // again, so every instance gets its own table (plus two command builders SessionManager never uses).
  const sessions = new SessionManager(nodePtyFactory, descriptors, undefined, undefined, undefined, (id, account, opts) =>
    statusLine.spawnConfig(id, account, opts)
  )
  // Lazy history: nothing is scanned at startup. The project list comes from a directory listing; sessions are
  // parsed when expanded. index.ts starts the file watcher with startBackground() after the window is up, so window creation never blocks on a scan.
  const history = new HistoryIndex(() => accounts.list(), descriptors)
  const projects = new ProjectSettings(path.join(userDataDir, 'projects.json'))
  await projects.load()
  const rollConfig = new RollConfigStore(path.join(userDataDir, 'rolling.json'))
  await rollConfig.load()
  const schedulerConfig = new SchedulerConfigStore(path.join(userDataDir, 'scheduler.json'))
  const schedulerConfigLoad = await schedulerConfig.load()
  const runConfig = new RunConfigStore(path.join(userDataDir, 'run-configs.json'))
  await runConfig.load()
  const worktrees = new WorktreeRegistry(
    path.join(userDataDir, 'worktrees.json'),
    // The default root uses a brand-neutral name — renaming the app must not move the worktree location in the user's home
    path.join(os.homedir(), 'ai-worktrees')
  )
  await worktrees.load()
  const localHistory = new LocalHistoryStore(path.join(userDataDir, 'local-history'))
  await localHistory.load()
  const appSettings = new AppSettingsStore(path.join(userDataDir, 'app-settings.json'))
  await appSettings.load()
  const keybindings = new KeybindingsStore(path.join(userDataDir, 'keybindings.json'))
  await keybindings.load()
  const run = new RunManager(nodePtyFactory)
  const terminal = new TerminalManager(nodePtyFactory)
  // ipc.ts owns the accounts.onChanged wiring (history.reload included); nothing is wired here because it would be overwritten there
  // Returns both providers' detection results merged — configDirs already registered are excluded from both
  const detectAccounts = async (): Promise<DetectCandidate[]> => {
    const excludeDirs = accounts.list().map((a) => a.configDir)
    const lists = await Promise.all(
      PROVIDERS.map((p) => descriptors[p].detect({ homeDir: os.homedir(), excludeDirs }))
    )
    return lists.flat()
  }
  const accountEmail = (id: string): Promise<string | null> => {
    const account = accounts.get(id)
    return descriptorOf(descriptors, account).readEmail(account.configDir, os.homedir())
  }
  const accountEmailOfDir = (configDir: string, provider?: Provider): Promise<string | null> =>
    descriptorOf(descriptors, { provider }).readEmail(configDir, os.homedir())
  // Runs the logout. The default (home) account gets no isolation env (ambient), isolated accounts do —
  // same rule as SessionManager.spawn. This is destructive: it removes the auth files. The wiring itself
  // lives in runAccountLogout (above) — this closure only looks the account up and hands it over.
  const accountLogout = (id: string): Promise<{ ok: boolean; message?: Message }> => {
    const account = accounts.get(id)
    const d = descriptorOf(descriptors, account)
    return runAccountLogout(d, os.homedir(), account.configDir)
  }
  // Imports settings and MCP from the default account. Rejected when the target is the default (ambient) account — it would be its own source.
  const isDefaultAccountDir = (configDir: string): boolean =>
    isDefaultConfigDir(os.homedir(), configDir)
  const accountSyncSettings = async (id: string): Promise<{ ok: boolean; message?: Message }> => {
    const account = accounts.get(id)
    // Settings sync only applies to the claude settings.json / MCP layout
    if (!metaOf(account).supportsSettingsSync)
      return { ok: false, message: { key: 'account.sync.codexUnsupported' } }
    if (isDefaultAccountDir(account.configDir))
      return { ok: false, message: { key: 'account.sync.isDefaultSource' } }
    try {
      const r = await syncSettingsFromDefault(os.homedir(), account.configDir)
      if (!r.settingsApplied && !r.mcpApplied && r.contentApplied.length === 0)
        return { ok: true, message: { key: 'account.sync.nothingToCopy' } }
      return { ok: true }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, message: { key: 'account.error.raw', params: { detail } } }
    }
  }
  // Live session usage — reads the statusLine capture file (context_window, rate_limits) and maps it. No credential access.
  const usageSession = async (sessionId: string): Promise<SessionUsage | null> => {
    const payload = await statusLine.read(sessionId)
    return payload ? parseStatusLinePayload(payload) : null
  }
  return {
    accounts,
    sessions,
    history,
    descriptors,
    projects,
    detectAccounts,
    accountEmail,
    accountEmailOfDir,
    accountLogout,
    isDefaultAccountDir,
    accountSyncSettings,
    usageSession,
    statusLinePayload: (sessionId: string) => statusLine.read(sessionId),
    hookEventsDir: statusLine.hookEventsDir,
    rollConfig,
    schedulerConfig,
    schedulerConfigLoad,
    runConfig,
    run,
    terminal,
    worktrees,
    localHistory,
    appSettings,
    keybindings,
    lang: appSettings.getLang() ?? pickInitialLang(osLocale)
  }
}
