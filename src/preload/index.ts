import { contextBridge, ipcRenderer, clipboard } from 'electron'
import type {
  RendererApi,
  CoreEventChannel,
  CoreEvents,
  UpdateCampaignInfo,
  UpdateStatus
} from '../core/types'

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)
const fire =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.send(channel, ...args)

const EVENT_CHANNELS = [
  'session:data',
  'session:exit',
  'session:created',
  'session:rolled',
  'session:rollState',
  'session:busy',
  'session:schedState',
  'history:updated',
  'accounts:changed',
  'accounts:ghostsChanged',
  'files:changed',
  'git:changed',
  'run:data',
  'run:status',
  'terminal:data',
  'terminal:exit'
]

const api = {
  accounts: {
    list: invoke('accounts.list'),
    create: invoke('accounts.create'),
    import: invoke('accounts.import'),
    remove: invoke('accounts.remove'),
    loginStatus: invoke('accounts.loginStatus'),
    detect: invoke('accounts.detect'),
    ghosts: invoke('accounts.ghosts'),
    email: invoke('accounts.email'),
    emailOfDir: invoke('accounts.emailOfDir'),
    logout: invoke('accounts.logout'),
    syncSettings: invoke('accounts.syncSettings')
  },
  sessions: {
    spawn: invoke('sessions.spawn'),
    write: fire('sessions.write'),
    resize: fire('sessions.resize'),
    ack: fire('sessions.ack'),
    kill: invoke('sessions.kill'),
    list: invoke('sessions.list'),
    resumeDefaults: invoke('sessions.resumeDefaults')
  },
  history: {
    page: invoke('history.page'),
    projectsPage: invoke('history.projectsPage'),
    preview: invoke('history.preview'),
    refresh: invoke('history.refresh')
  },
  projects: {
    getDefaultAccount: invoke('projects.getDefaultAccount'),
    setDefaultAccount: invoke('projects.setDefaultAccount')
  },
  worktrees: {
    list: invoke('worktrees.list'),
    create: invoke('worktrees.create'),
    listBranches: invoke('worktrees.listBranches'),
    remove: invoke('worktrees.remove'),
    isGitRepo: invoke('worktrees.isGitRepo'),
    getRoot: invoke('worktrees.getRoot'),
    setRoot: invoke('worktrees.setRoot')
  },
  usage: {
    session: invoke('usage.session')
  },
  localHistory: {
    list: invoke('localHistory.list'),
    restore: invoke('localHistory.restore')
  },
  scheduler: {
    disable: invoke('scheduler.disable')
  },
  slack: {
    getConfig: invoke('slack.getConfig'),
    setConfig: invoke('slack.setConfig')
  },
  settings: {
    getLang: invoke('settings.getLang'),
    setLang: invoke('settings.setLang'),
    getOrchestrationEnabled: invoke('settings.getOrchestrationEnabled'),
    setOrchestrationEnabled: invoke('settings.setOrchestrationEnabled'),
    getTerminalFont: invoke('settings.getTerminalFont'),
    setTerminalFont: invoke('settings.setTerminalFont')
  },
  files: {
    list: invoke('files.list'),
    read: invoke('files.read'),
    write: invoke('files.write'),
    watch: invoke('files.watch'),
    unwatch: invoke('files.unwatch'),
    create: invoke('files.create'),
    rename: invoke('files.rename'),
    move: invoke('files.move'),
    remove: invoke('files.remove'),
    copy: invoke('files.copy'),
    reveal: invoke('files.reveal'),
    countEntries: invoke('files.countEntries')
  },
  git: {
    status: invoke('git.status'),
    watch: invoke('git.watch'),
    unwatch: invoke('git.unwatch')
  },
  run: {
    list: invoke('run.list'),
    listActive: invoke('run.listActive'),
    start: invoke('run.start'),
    stop: invoke('run.stop'),
    write: fire('run.write'),
    resize: fire('run.resize'),
    saveConfig: invoke('run.saveConfig'),
    deleteConfig: invoke('run.deleteConfig'),
    listJdks: invoke('run.listJdks')
  },
  terminal: {
    open: invoke('terminal.open'),
    list: invoke('terminal.list'),
    write: fire('terminal.write'),
    resize: fire('terminal.resize'),
    close: invoke('terminal.close')
  },
  system: {
    pickFolder: invoke('system.pickFolder'),
    pickFile: invoke('system.pickFile'),
    pathExists: invoke('system.pathExists'),
    checkCli: invoke('system.checkCli'),
    appVersion: invoke('system.appVersion')
  },
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text: string) => clipboard.writeText(text)
  },
  update: {
    onStatus: (cb: (s: UpdateStatus) => void) => {
      const l = (_e: unknown, s: UpdateStatus): void => cb(s)
      ipcRenderer.on('update:status', l)
      return (): void => {
        ipcRenderer.removeListener('update:status', l)
      }
    },
    onCampaign: (cb: (c: UpdateCampaignInfo) => void) => {
      const l = (_e: unknown, c: UpdateCampaignInfo): void => cb(c)
      ipcRenderer.on('update:campaign', l)
      return (): void => {
        ipcRenderer.removeListener('update:campaign', l)
      }
    },
    campaignState: () => ipcRenderer.invoke('update:campaignState'),
    dismissCampaign: (id: string) => ipcRenderer.invoke('update:dismissCampaign', id),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install')
  },
  rolling: {
    forceRoll: invoke('rolling.forceRoll')
  },
  app: {
    // The 'quit app' of the forced-update gate. win.close cannot be used because it minimises to the tray
    quit: () => ipcRenderer.send('app.quit')
  },
  keys: {
    get: invoke('keys.get'),
    set: invoke('keys.set'),
    reset: invoke('keys.reset')
  },
  platform: process.platform,
  win: {
    minimize: () => ipcRenderer.send('win.minimize'),
    maximizeToggle: () => ipcRenderer.send('win.maximizeToggle'),
    close: () => ipcRenderer.send('win.close'),
    isMaximized: () => ipcRenderer.invoke('win.isMaximized'),
    onMaximizeChange: (cb) => {
      const l = (_e: unknown, isMax: boolean): void => cb(isMax)
      ipcRenderer.on('win:maximized', l)
      return () => ipcRenderer.removeListener('win:maximized', l)
    }
  },
  on<C extends CoreEventChannel>(channel: C, cb: (payload: CoreEvents[C]) => void): () => void {
    if (!EVENT_CHANNELS.includes(channel)) throw new Error(`unknown event channel: ${channel}`)
    const listener = (_e: unknown, payload: CoreEvents[C]): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
} satisfies RendererApi

contextBridge.exposeInMainWorld('api', api)
