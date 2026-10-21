// Settings › Extensions speaks in every language the app does (Agent Control Plane release 1 design §4.10). ko is the
// source: a key it has under these prefixes, every language has, so a new string cannot fall back to English.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'

const PREFIXES = ['settings.extensions.', 'settings.tab.extensions', 'account.sync.codexMergeNote', 'account.sync.extensionsNote']

describe('the Extensions catalog', () => {
  it('has every Extensions key in every language', () => {
    const ko = Object.keys(CATALOGS.ko.messages).filter((k) => PREFIXES.some((p) => k.startsWith(p)))
    expect(ko.length).toBeGreaterThan(40)
    for (const lang of LANGS) {
      const messages = CATALOGS[lang].messages as Record<string, string | undefined>
      expect(ko.filter((k) => !messages[k]), lang).toEqual([])
    }
  })

  // The person's rule for what the app says: a sentence is rewritten rather than broken with a dash
  it('has no dash inside a sentence in the English strings', () => {
    const en = CATALOGS.en.messages as Record<string, string>
    const dashed = Object.keys(en)
      .filter((k) => PREFIXES.some((p) => k.startsWith(p)))
      .filter((k) => /\s[—–-]\s/.test(en[k]))
    expect(dashed).toEqual([])
  })

  it('names the tab the account import note points at, in every language', () => {
    for (const lang of LANGS) {
      const m = CATALOGS[lang].messages as Record<string, string>
      expect(m['account.sync.extensionsNote'], lang).toContain(m['settings.tab.extensions'])
    }
  })
})
