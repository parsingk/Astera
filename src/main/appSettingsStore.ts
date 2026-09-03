import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isLang, type Lang } from '../core/i18n'
import { sanitizeFontFamily } from '../core/terminal/font'
import type { TerminalFont } from '../core/terminal/font'
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from '../core/theme/themes'
import type { ResumeStrategy } from '../core/types'
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
 *  orchestration toggle, the work unit tracking toggle, the resume strategy, the terminal font, the
 *  theme, and the desktop notification flags.
 *  A null lang means the user has never picked one explicitly — the caller derives it with
 *  pickInitialLang(app.getLocale()). The derived value is not stored. */
export class AppSettingsStore {
  private lang: Lang | null = null
  /** The update campaign the user dismissed. The basis for not showing the same campaign again. */
  private dismissedCampaignId: string | null = null
  private orchestrationEnabled = false
  private workUnitTrackingEnabled = false
  /** PR-status background polling (design doc §4, the fallback lever). Default on; the narrowing
   *  is inverted from the toggles above — the file is user-editable, so only an explicit false
   *  reads as off, and anything else (absent, corrupt) reads as on. */
  private githubPolling = true
  /** 설명을 누가·무엇으로 만드는가. 비어 있으면 생성하지 않는다 (설계 D2) */
  private generator: GeneratorSettings = {}
  private resumeStrategy: ResumeStrategy = 'original'
  private terminalFont: TerminalFont = { latin: null, hangul: null }
  private theme: ThemeId = DEFAULT_THEME_ID
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
      // Narrowed to === true — values like 'yes' or 1 must not slip through as truthy and turn an experimental feature on
      this.orchestrationEnabled =
        (parsed as { orchestrationEnabled?: unknown }).orchestrationEnabled === true
      // Same narrowing, same reason — and it is the whole point of this toggle: default (and any
      // untrusted file content) reads as off, so detection stays off until the user explicitly turns it on.
      this.workUnitTrackingEnabled =
        (parsed as { workUnitTrackingEnabled?: unknown }).workUnitTrackingEnabled === true
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
      return { recovered: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.lang = null
        this.dismissedCampaignId = null
        this.orchestrationEnabled = false
        this.workUnitTrackingEnabled = false
        this.githubPolling = true
        this.desktopNotify = { ...DESKTOP_NOTIFY_DEFAULTS }
        this.generator = {}
        this.resumeStrategy = 'original'
        this.terminalFont = { latin: null, hangul: null }
        this.theme = DEFAULT_THEME_ID
        return { recovered: false }
      }
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.lang = null
      this.dismissedCampaignId = null
      // The failure branch resets this too — otherwise, on a reload through the same instance, the previous value
      // survives the corrupt-file recovery and leaves a setting enabled that the file does not contain
      this.orchestrationEnabled = false
      this.workUnitTrackingEnabled = false
      this.githubPolling = true
      this.desktopNotify = { ...DESKTOP_NOTIFY_DEFAULTS }
      this.generator = {}
      this.resumeStrategy = 'original'
      this.terminalFont = { latin: null, hangul: null }
      this.theme = DEFAULT_THEME_ID
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

  getOrchestrationEnabled(): boolean {
    return this.orchestrationEnabled
  }

  async setOrchestrationEnabled(enabled: boolean): Promise<void> {
    this.orchestrationEnabled = enabled
    await this.persist()
  }

  getWorkUnitTrackingEnabled(): boolean {
    return this.workUnitTrackingEnabled
  }

  async setWorkUnitTrackingEnabled(enabled: boolean): Promise<void> {
    this.workUnitTrackingEnabled = enabled
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

  /** There is more than one field, so the whole object is always written — writing only one of them wipes the other
   *  (the defect from back when setLang wrote JSON.stringify({ lang })).
   *  Falsy values are omitted: leaving lang:null and orchestrationEnabled:false out of the file still gives load the
   *  same result (it checks === true), and the file stays clean. */
  private async persist(): Promise<void> {
    const data: {
      lang?: Lang
      dismissedCampaignId?: string
      orchestrationEnabled?: boolean
      workUnitTrackingEnabled?: boolean
      githubPolling?: boolean
      desktopNotify?: DesktopNotifySettings
      generator?: GeneratorSettings
      resumeStrategy?: ResumeStrategy
      terminalFont?: TerminalFont
      theme?: ThemeId
    } = {}
    if (this.lang) data.lang = this.lang
    if (this.dismissedCampaignId) data.dismissedCampaignId = this.dismissedCampaignId
    if (this.orchestrationEnabled) data.orchestrationEnabled = true
    if (this.workUnitTrackingEnabled) data.workUnitTrackingEnabled = true
    if (this.githubPolling === false) data.githubPolling = false
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
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8')
  }
}
