import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isLang, type Lang } from '../core/i18n'
import { sanitizeFontFamily } from '../core/terminal/font'
import type { TerminalFont } from '../core/terminal/font'
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from '../core/theme/themes'
import type { AgentPermissionMode, ResumeStrategy, SessionKind } from '../core/types'
import { applyContinuityToggle } from '../core/continuity/settings'
import {
  readGeneratorSettings,
  writableGeneratorSettings,
  type GeneratorSettings
} from '../core/understanding/generatorSettings'
import {
  DESKTOP_NOTIFY_DEFAULTS,
  readDesktopNotify,
  writableDesktopNotify,
  type DesktopNotifySettings
} from '../core/notify/settings'

/** App-wide settings persistence. Holds the language, the id of the dismissed update campaign, the
 *  work unit tracking toggle, the agent browser toggle, the Job Continuity
 *  toggle, the resume strategy, the terminal font, the theme, the default session kind, and the
 *  desktop notification flags.
 *  A null lang means the user has never picked one explicitly — the caller derives it with
 *  pickInitialLang(app.getLocale()). The derived value is not stored. */
export class AppSettingsStore {
  private lang: Lang | null = null
  /** The update campaign the user dismissed. The basis for not showing the same campaign again. */
  private dismissedCampaignId: string | null = null
  private workUnitTrackingEnabled = false
  private agentBrowserEnabled = false
  /** Ruling F62 — whether the one-time pause for work the old orchestration toggle had parked has
   *  already run on this profile. Written once and never cleared; see `orchAlwaysOnPauseDue`. */
  private orchAlwaysOnMigrated = false
  /** **Not persisted — it is what the file said when it was last read.** True when the settings file
   *  existed and did *not* carry `orchestrationEnabled: true`, which is how a profile that had
   *  orchestration switched off is recognised now that nothing reads the field. False for a profile
   *  with no settings file and for one recovered from corruption: neither can say what the toggle
   *  was, and this codebase does not act on absent evidence. */
  private orchestrationWasOff = false
  /** Job Continuity (spec §3). Off by default; enabling it can also set resumeStrategy — see
   *  setJobContinuityEnabled. */
  private jobContinuityEnabled = false
  /** PR-status background polling (design doc §4, the fallback lever). Default on; the narrowing
   *  is inverted from the toggles above — the file is user-editable, so only an explicit false
   *  reads as off, and anything else (absent, corrupt) reads as on. */
  private githubPolling = true
  /** 설명을 누가·무엇으로 만드는가. 비어 있으면 생성하지 않는다 (설계 D2) */
  private generator: GeneratorSettings = {}
  private resumeStrategy: ResumeStrategy = 'original'
  /** 에이전트를 권한 확인 없이 띄우는가. **기본은 'yolo'** — 그 근거는 AgentPermissionMode 에 있다.
   *  githubPolling 과 같은 방향의 좁히기다: 기본이 켜짐인 값이라 파일에 명시된 'manual' 만 끈다. */
  private agentPermissionMode: AgentPermissionMode = 'yolo'
  private terminalFont: TerminalFont = { latin: null, hangul: null }
  private theme: ThemeId = DEFAULT_THEME_ID
  /** Which kind the new-session and resume dialogs open on — a terminal session or a 대화 one. It
   *  seeds the dialog's own selection and nothing more: changing the kind inside the dialog applies
   *  to that session alone and is not written back here.
   *
   *  It replaces `conversationDefault`, which decided what a *terminal* session's tab showed first
   *  (the terminal or the conversation view). Both were labelled with the same two words, and the
   *  one people reached for when they wanted new sessions to be 대화 was this one — so the old key is
   *  carried over on load rather than asked again, and the per-tab toggle in the tab bar is what now
   *  chooses a terminal session's view. */
  private defaultSessionKind: SessionKind = 'terminal'
  /**
   * Whether this person has already been asked, once, what a new session should open on.
   *
   * **True by default, and the file says so only when it is false** — the same one-sided narrowing
   * githubPolling and agentPermissionMode use, and here it is what tells a new install from an old
   * one. An installation that predates this question has a settings file with no such key, and
   * reading that absence as "already asked" is the whole point: someone who has been using the app
   * for months must not be interrupted by a first-run question. Only the absence of the **file**
   * means a first run.
   */
  private firstRunAsked = true
  /** Desktop notifications, one flag per event. Written and read as one object, so the four move
   *  together and there is one place that knows what a missing file means. */
  private desktopNotify: DesktopNotifySettings = { ...DESKTOP_NOTIFY_DEFAULTS }

  constructor(private filePath: string) {}

  async load(): Promise<{ recovered: boolean }> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      // Same guard as the sibling stores (ProjectSettings, RunConfigStore) — typeof [] === 'object', so an array
      // would otherwise pass straight through
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid schema')
      const v = (parsed as { lang?: unknown }).lang
      this.lang = isLang(v) ? v : null
      const dismissed = (parsed as { dismissedCampaignId?: unknown }).dismissedCampaignId
      this.dismissedCampaignId =
        typeof dismissed === 'string' && dismissed.trim() ? dismissed : null
      // Narrowed to === true — values like 'yes' or 1 must not slip through as truthy and turn an
      // experimental feature on. It is the whole point of this toggle: default (and any untrusted
      // file content) reads as off, so detection stays off until the user explicitly turns it on.
      this.workUnitTrackingEnabled =
        (parsed as { workUnitTrackingEnabled?: unknown }).workUnitTrackingEnabled === true
      this.agentBrowserEnabled =
        (parsed as { agentBrowserEnabled?: unknown }).agentBrowserEnabled === true
      // **The absence of the key is what says "off"**, not a stored `false`: `persist` omitted falsy
      // values, so `orchestrationEnabled` was only ever written when it was on. A profile that never
      // used the feature at all reads the same way, which costs nothing — the pause finds no parked
      // work there and writes the marker.
      this.orchestrationWasOff =
        (parsed as { orchestrationEnabled?: unknown }).orchestrationEnabled !== true
      this.orchAlwaysOnMigrated =
        (parsed as { orchAlwaysOnMigrated?: unknown }).orchAlwaysOnMigrated === true
      this.jobContinuityEnabled =
        (parsed as { jobContinuityEnabled?: unknown }).jobContinuityEnabled === true
      this.githubPolling = (parsed as { githubPolling?: unknown }).githubPolling !== false
      // Narrowed on read, like generator and terminalFont and for the same reason: the file is
      // user-editable, and the narrowing is per flag's own default (see readDesktopNotify).
      this.desktopNotify = readDesktopNotify((parsed as { desktopNotify?: unknown }).desktopNotify)
      // Sanitised on read like terminalFont, and for the same reason: the file is user-editable and
      // these values become CLI arguments. Anything that does not survive reads as "not set", which
      // means the CLI default (or, for the account, no generation at all).
      this.generator = readGeneratorSettings((parsed as { generator?: unknown }).generator)
      // Narrowed to === 'smart' — the file is user-editable, so anything else ('ask', 42, null) reads as 'original'
      this.resumeStrategy =
        (parsed as { resumeStrategy?: unknown }).resumeStrategy === 'smart' ? 'smart' : 'original'
      // Narrowed the other way round, because the default is the other way round: only the explicit
      // 'manual' turns the bypass off, and anything else the user-editable file holds reads as 'yolo'.
      this.agentPermissionMode =
        (parsed as { agentPermissionMode?: unknown }).agentPermissionMode === 'manual'
          ? 'manual'
          : 'yolo'
      // Sanitised on read as well as on write: the file is user-editable, and the value ends up in a
      // CSS font-family string. Anything that does not survive is treated as unset.
      const font = (parsed as { terminalFont?: unknown }).terminalFont
      this.terminalFont =
        font !== null && typeof font === 'object' && !Array.isArray(font)
          ? {
              latin: sanitizeFontFamily((font as { latin?: unknown }).latin),
              hangul: sanitizeFontFamily((font as { hangul?: unknown }).hangul)
            }
          : { latin: null, hangul: null }
      const theme = (parsed as { theme?: unknown }).theme
      this.theme = isThemeId(theme) ? theme : DEFAULT_THEME_ID
      // Narrowed to === 'chat' — the file is user-editable, so anything else reads as the default
      // 'terminal', the same one-sided narrowing agentPermissionMode uses above. With the new key
      // absent the old one it replaced is read instead: its 'conversation' meant "open on the
      // conversation, not the terminal", which is what picking 대화 here now does.
      const kindRaw = parsed as { defaultSessionKind?: unknown; conversationDefault?: unknown }
      this.defaultSessionKind =
        kindRaw.defaultSessionKind === undefined
          ? kindRaw.conversationDefault === 'conversation'
            ? 'chat'
            : 'terminal'
          : kindRaw.defaultSessionKind === 'chat'
            ? 'chat'
            : 'terminal'
      // A file that exists is an app that has been used before — unless it says outright that the
      // question is still open, which is what a first run that wrote settings before answering leaves
      // behind. See the field's own note for why the absence means the opposite here.
      this.firstRunAsked = (parsed as { firstRunAsked?: unknown }).firstRunAsked !== false
      return { recovered: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.lang = null
        this.dismissedCampaignId = null
        this.workUnitTrackingEnabled = false
        this.agentBrowserEnabled = false
        // No file means no toggle to have been off, and no orchestration state to have parked —
        // this profile has never run anything. The F62 pause must not fire here.
        this.orchestrationWasOff = false
        this.orchAlwaysOnMigrated = false
        this.jobContinuityEnabled = false
        this.githubPolling = true
        this.desktopNotify = { ...DESKTOP_NOTIFY_DEFAULTS }
        this.generator = {}
        this.resumeStrategy = 'original'
        this.agentPermissionMode = 'yolo'
        this.terminalFont = { latin: null, hangul: null }
        this.theme = DEFAULT_THEME_ID
        this.defaultSessionKind = 'terminal'
        // No settings file at all: nobody has used this app on this machine yet. The one state the
        // first-run question is for.
        this.firstRunAsked = false
        return { recovered: false }
      }
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.lang = null
      this.dismissedCampaignId = null
      // The failure branch resets these too — otherwise, on a reload through the same instance, the previous value
      // survives the corrupt-file recovery and leaves a setting enabled that the file does not contain
      this.workUnitTrackingEnabled = false
      this.agentBrowserEnabled = false
      // A file this could not read cannot say what the toggle was, and the F62 pause is not something
      // to do on a guess — it stops Runs the person may be watching. Both stay false, so a recovered
      // profile is left alone in either direction.
      this.orchestrationWasOff = false
      this.orchAlwaysOnMigrated = false
      this.jobContinuityEnabled = false
      this.githubPolling = true
      this.desktopNotify = { ...DESKTOP_NOTIFY_DEFAULTS }
      this.generator = {}
      this.resumeStrategy = 'original'
      this.agentPermissionMode = 'yolo'
      this.terminalFont = { latin: null, hangul: null }
      this.theme = DEFAULT_THEME_ID
      this.defaultSessionKind = 'terminal'
      // A file that could not be read is still a file: this person has used the app before, and a
      // corrupt settings file is not a reason to put a first-run question in front of them.
      this.firstRunAsked = true
      return { recovered: true }
    }
  }

  getLang(): Lang | null {
    return this.lang
  }

  /** null is System: it clears the stored choice so the OS locale decides again. */
  async setLang(lang: Lang | null): Promise<void> {
    this.lang = lang
    await this.persist()
  }

  getDismissedCampaignId(): string | null {
    return this.dismissedCampaignId
  }

  async setDismissedCampaignId(id: string): Promise<void> {
    this.dismissedCampaignId = id
    await this.persist()
  }

  getWorkUnitTrackingEnabled(): boolean {
    return this.workUnitTrackingEnabled
  }

  async setWorkUnitTrackingEnabled(enabled: boolean): Promise<void> {
    this.workUnitTrackingEnabled = enabled
    await this.persist()
  }

  /** Ruling F62 — whether this launch owes the one-time pause for work the old orchestration toggle
   *  was holding still. True exactly once, on the first launch of a build where orchestration is no
   *  longer a setting, for a profile whose settings file did not say the toggle was on.
   *
   *  **Keyed on a marker of its own, not on erasing the old field.** The old field was only ever
   *  written when the toggle was *on* (persist omits falsy values), so its absence is what says off —
   *  there is nothing to erase, and no way to record "done" in a key that was never there.
   *  `orchAlwaysOnMigrated` is that record, and once written the answer is false forever.
   *
   *  A profile that never used orchestration at all answers true once as well. That is deliberate
   *  rather than tolerated: it has nothing parked, so the pause touches nothing and only writes the
   *  marker. Narrowing further would mean asking the orchestration state a question here, before it
   *  has been loaded. */
  orchAlwaysOnPauseDue(): boolean {
    return this.orchestrationWasOff && !this.orchAlwaysOnMigrated
  }

  /** Records that the pause has run, so it never runs twice. **Called only after the state write it
   *  belongs to has landed** — writing this first and then failing to pause would leave the next
   *  launch spending the person's accounts with nothing left to stop it. */
  async markOrchAlwaysOnMigrated(): Promise<void> {
    this.orchAlwaysOnMigrated = true
    await this.persist()
  }

  getAgentBrowserEnabled(): boolean {
    return this.agentBrowserEnabled
  }

  /** The agent browser: sessions get a preview tab of their own to open, check and later click
   *  through this project's dev server, and the astera-browser skill is installed for every account.
   *  Off by default because it installs files into the user's skill directories and drives a browser
   *  on their behalf. */
  async setAgentBrowserEnabled(enabled: boolean): Promise<void> {
    this.agentBrowserEnabled = enabled
    await this.persist()
  }

  getAgentPermissionMode(): AgentPermissionMode {
    return this.agentPermissionMode
  }

  /** 워커와 코디네이터를 띄우는 배선이 이 값을 읽어 bypassPermissions 로 넘긴다(src/main/ipc.ts). */
  async setAgentPermissionMode(mode: AgentPermissionMode): Promise<void> {
    this.agentPermissionMode = mode
    await this.persist()
  }

  getGithubPolling(): boolean {
    return this.githubPolling
  }

  async setGithubPolling(enabled: boolean): Promise<void> {
    this.githubPolling = enabled
    await this.persist()
  }

  getDesktopNotify(): DesktopNotifySettings {
    return { ...this.desktopNotify }
  }

  /** The four are written together — the settings tab reads the record, flips one flag and sends the
   *  whole thing back, the same convention setGenerator follows. Reuses readDesktopNotify because
   *  this value arrives from the renderer: one narrowing function means the setter and the file
   *  reader can never disagree about what a malformed flag means (exactly what setGenerator does
   *  with readGeneratorSettings). */
  async setDesktopNotify(next: DesktopNotifySettings): Promise<void> {
    this.desktopNotify = readDesktopNotify(next)
    await this.persist()
  }

  getGenerator(): GeneratorSettings {
    return this.generator
  }

  /** 셋을 **함께** 쓴다 — 계정을 바꾸면 그 계정에 없는 모델이, 모델을 바꾸면 그 모델이 안 받는
   *  강도가 남아서는 안 된다. 하나씩 쓰는 setter 를 두면 그 불변식을 지킬 자리가 사라진다. */
  async setGenerator(g: GeneratorSettings): Promise<void> {
    this.generator = readGeneratorSettings(g)
    await this.persist()
  }

  getResumeStrategy(): ResumeStrategy {
    return this.resumeStrategy
  }

  async setResumeStrategy(strategy: ResumeStrategy): Promise<void> {
    this.resumeStrategy = strategy
    await this.persist()
  }

  getJobContinuityEnabled(): boolean {
    return this.jobContinuityEnabled
  }

  /** One persist for both fields: the rule may change resumeStrategy as well (spec §3.2), and
   *  writing them separately would leave a window where the file says on/original. */
  async setJobContinuityEnabled(enabled: boolean): Promise<{ smartResumeTurnedOn: boolean }> {
    const r = applyContinuityToggle(
      { jobContinuity: this.jobContinuityEnabled, resumeStrategy: this.resumeStrategy },
      enabled
    )
    this.jobContinuityEnabled = r.jobContinuity
    this.resumeStrategy = r.resumeStrategy
    await this.persist()
    return { smartResumeTurnedOn: r.smartResumeTurnedOn }
  }

  getTerminalFont(): TerminalFont {
    return this.terminalFont
  }

  async setTerminalFont(font: TerminalFont): Promise<void> {
    this.terminalFont = {
      latin: sanitizeFontFamily(font.latin),
      hangul: sanitizeFontFamily(font.hangul)
    }
    await this.persist()
  }

  getTheme(): ThemeId {
    return this.theme
  }

  async setTheme(id: ThemeId): Promise<void> {
    this.theme = isThemeId(id) ? id : DEFAULT_THEME_ID
    await this.persist()
  }

  getDefaultSessionKind(): SessionKind {
    return this.defaultSessionKind
  }

  /** Whether the first-run question has already been put to this person. */
  getFirstRunAsked(): boolean {
    return this.firstRunAsked
  }

  /** It has been put to them — answered or dismissed, which are the same thing to this flag: it asks
   *  once. */
  async markFirstRunAsked(): Promise<void> {
    this.firstRunAsked = true
    await this.persist()
  }

  async setDefaultSessionKind(kind: SessionKind): Promise<void> {
    this.defaultSessionKind = kind
    await this.persist()
  }

  /** There is more than one field, so the whole object is always written — writing only one of them wipes the other
   *  (the defect from back when setLang wrote JSON.stringify({ lang })).
   *  Falsy values are omitted: leaving lang:null and workUnitTrackingEnabled:false out of the file still gives load the
   *  same result (it checks === true), and the file stays clean. */
  private async persist(): Promise<void> {
    const data: {
      lang?: Lang
      dismissedCampaignId?: string
      workUnitTrackingEnabled?: boolean
      agentBrowserEnabled?: boolean
      orchAlwaysOnMigrated?: boolean
      jobContinuityEnabled?: boolean
      githubPolling?: boolean
      desktopNotify?: DesktopNotifySettings
      generator?: GeneratorSettings
      resumeStrategy?: ResumeStrategy
      agentPermissionMode?: AgentPermissionMode
      terminalFont?: TerminalFont
      theme?: ThemeId
      defaultSessionKind?: SessionKind
      firstRunAsked?: false
    } = {}
    if (this.lang) data.lang = this.lang
    if (this.dismissedCampaignId) data.dismissedCampaignId = this.dismissedCampaignId
    if (this.workUnitTrackingEnabled) data.workUnitTrackingEnabled = true
    if (this.agentBrowserEnabled) data.agentBrowserEnabled = true
    if (this.orchAlwaysOnMigrated) data.orchAlwaysOnMigrated = true
    if (this.jobContinuityEnabled) data.jobContinuityEnabled = true
    if (this.githubPolling === false) data.githubPolling = false
    // Written only while the question is still open, which is the same one-sided rule as the two
    // below — and here it carries the difference between a new install and an old one, so an absent
    // key has to keep meaning "asked". See the field's own note.
    if (this.firstRunAsked === false) data.firstRunAsked = false
    // Written only when it is off, for the same reason githubPolling is: the default belongs in one
    // place, and that place is load's narrowing.
    if (this.agentPermissionMode === 'manual') data.agentPermissionMode = 'manual'
    // Every flag at its default leaves the key out of the file entirely; load reconstructs those
    // defaults from an absent key, so nothing is lost.
    const desktopNotify = writableDesktopNotify(this.desktopNotify)
    if (desktopNotify) data.desktopNotify = desktopNotify
    // 비어 있으면 키 자체를 남기지 않는다 — 위 falsy 규칙 그대로다
    const generator = writableGeneratorSettings(this.generator)
    if (generator) data.generator = generator
    if (this.resumeStrategy === 'smart') data.resumeStrategy = 'smart'
    if (this.terminalFont.latin || this.terminalFont.hangul) data.terminalFont = this.terminalFont
    if (this.theme !== DEFAULT_THEME_ID) data.theme = this.theme
    if (this.defaultSessionKind === 'chat') data.defaultSessionKind = 'chat'
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8')
  }
}
