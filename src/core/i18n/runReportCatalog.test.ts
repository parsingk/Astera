// The Run report speaks in every language the app does (run report design §4): ko is the source, a runReport. key ko
// has, every language has, and no dash is used as punctuation inside a sentence.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'

// The three switches live under their screens' own prefixes (Settings › GitHub, New Job, Settings › Slack)
const SWITCH_KEYS = [
  'github.settings.lifecycle.postRunReport',
  'github.settings.lifecycle.postRunReportHint',
  'jobs.new.githubReportHint',
  'settings.slack.runReports',
  'settings.slack.runReportsHint'
]
// The external reviewers' Settings group (settings.reviewer.) is checked the same way
const koKeys = [
  ...Object.keys(CATALOGS.ko.messages).filter((k) => k.startsWith('runReport.') || k.startsWith('settings.reviewer.')),
  ...SWITCH_KEYS
]

describe('the Run report catalog', () => {
  it('has every runReport key in every language', () => {
    expect(koKeys.length).toBeGreaterThan(40)
    expect(koKeys).toEqual(expect.arrayContaining(['runReport.review.by', 'settings.reviewer.title', 'settings.reviewer.saveFailed']))
    for (const lang of LANGS) {
      const messages = CATALOGS[lang].messages as Record<string, string | undefined>
      expect(koKeys.filter((k) => !messages[k]), lang).toEqual([])
    }
  })

  it('uses no dash as punctuation', () => {
    for (const lang of LANGS) {
      const messages = CATALOGS[lang].messages as Record<string, string | undefined>
      const bad = koKeys.filter((k) => / [-–—] /.test(messages[k] ?? ''))
      expect(bad, lang).toEqual([])
    }
  })
})
