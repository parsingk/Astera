import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isLang, type Lang } from '../core/i18n'
import { sanitizeFontFamily } from '../core/terminal/font'
import type { TerminalFont } from '../core/terminal/font'
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from '../core/theme/themes'
import type { ResumeStrategy } from '../core/types'

/** App-wide settings persistence. Holds the language, the id of the dismissed update campaign, the
 *  orchestration toggle, the work unit tracking toggle, the resume strategy, the terminal font, and the theme.
 *  A null lang means the user has never picked one explicitly — the caller derives it with
 *  pickInitialLang(app.getLocale()). The derived value is not stored. */
export class AppSettingsStore {
  private lang: Lang | null = null
  /** The update campaign the user dismissed. The basis for not showing the same campaign again. */
  private dismissedCampaignId: string | null = null
  private orchestrationEnabled = false
  private workUnitTrackingEnabled = false
  private resumeStrategy: ResumeStrategy = 'original'
  private terminalFont: TerminalFont = { latin: null, hangul: null }
  private theme: ThemeId = DEFAULT_THEME_ID

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
      resumeStrategy?: ResumeStrategy
      terminalFont?: TerminalFont
      theme?: ThemeId
    } = {}
    if (this.lang) data.lang = this.lang
    if (this.dismissedCampaignId) data.dismissedCampaignId = this.dismissedCampaignId
    if (this.orchestrationEnabled) data.orchestrationEnabled = true
    if (this.workUnitTrackingEnabled) data.workUnitTrackingEnabled = true
    if (this.resumeStrategy === 'smart') data.resumeStrategy = 'smart'
    if (this.terminalFont.latin || this.terminalFont.hangul) data.terminalFont = this.terminalFont
    if (this.theme !== DEFAULT_THEME_ID) data.theme = this.theme
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8')
  }
}
