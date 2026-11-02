// Settings › Security & Access and Run detail's token lines speak in every language the app does (observe mode design
// §11). ko is the source: a key it has under these prefixes, every language has, so a new string cannot fall back to
// English.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'

const PREFIXES = ['settings.security.', 'audit.', 'jobs.detail.tokens', 'jobs.detail.coordinatorTokens', 'jobs.detail.taskTokens', 'jobs.detail.wouldDeny', 'jobs.detail.blocked']

const keysOf = (): string[] => Object.keys(CATALOGS.ko.messages).filter((k) => PREFIXES.some((p) => k.startsWith(p)))

describe('the Security & Access catalog', () => {
  it('has every key in every language', () => {
    const ko = keysOf()
    expect(ko.length).toBeGreaterThan(90)
    for (const lang of LANGS) {
      const messages = CATALOGS[lang].messages as Record<string, string | undefined>
      expect(ko.filter((k) => !messages[k]), lang).toEqual([])
    }
  })

  // The person's rule for what the app says: a sentence is rewritten rather than broken with a dash
  it('has no dash inside a sentence in any language', () => {
    for (const lang of LANGS) {
      const m = CATALOGS[lang].messages as Record<string, string>
      expect(keysOf().filter((k) => /\s[—–-]\s/.test(m[k] ?? '')), lang).toEqual([])
    }
  })

  // Design §11: actions are plain phrases, never the action's own name
  it('never shows an action by its own name', () => {
    for (const lang of LANGS) {
      const m = CATALOGS[lang].messages as Record<string, string>
      const phrases = keysOf().filter((k) => k.startsWith('audit.action.'))
      expect(phrases).toHaveLength(14)
      expect(phrases.filter((k) => /\b[a-z]+\.[a-z]+/.test(m[k])), lang).toEqual([])
    }
  })

  it('keeps the English the CLI prints', () => {
    const en = CATALOGS.en.messages as Record<string, string>
    expect(en['audit.action.git.remote.write']).toBe('git push to a remote')
    expect(en['audit.coverageNote.web-tools-only']).toBe('web tools only')
  })

  // Follow-up R-F6, item 5: days dropped to keep under the size limit
  it('says when days of the period were removed for the size limit', () => {
    const en = CATALOGS.en.messages as Record<string, string>
    const ko = CATALOGS.ko.messages as Record<string, string>
    expect(en['settings.security.audit.droppedAtLimit']).toBe('Days of this period were removed to stay under the size limit, so it holds fewer calls than were made.')
    expect(ko['settings.security.audit.droppedAtLimit']).toBe('크기 한도를 넘지 않도록 이 기간의 일부 날을 지워, 실제보다 적은 호출만 남아 있습니다.')
  })
})
