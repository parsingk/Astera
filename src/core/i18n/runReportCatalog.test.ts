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

  // Final fix wave E1: the hint says what the code holds, not that the agent cannot change files
  it('says the external reviewer is asked to read and stopped when it changes a file, not that it cannot', () => {
    expect(CATALOGS.en.messages['settings.reviewer.externalHint']).toBe(
      'An external reviewer is another agent that speaks ACP. Astera asks it only to read: anything else it asks permission for is refused, and the review stops if it changes a file. A review it cannot finish stops the Task and asks you.'
    )
    expect(CATALOGS.ko.messages['settings.reviewer.externalHint']).not.toMatch(/바꿀 수 없/)
    expect(CATALOGS.ja.messages['settings.reviewer.externalHint']).not.toMatch(/変更できず/)
    expect(CATALOGS.es.messages['settings.reviewer.externalHint']).not.toMatch(/no puede cambiar/)
  })

  // Final fix wave E2: no particle that depends on the last sound of a name
  it('names the reviewers in Korean without 이(가)', () => {
    expect(CATALOGS.ko.messages['runReport.review.by']).toBe('검토자는 {names}입니다.')
  })

  it('uses no dash as punctuation', () => {
    for (const lang of LANGS) {
      const messages = CATALOGS[lang].messages as Record<string, string | undefined>
      const bad = koKeys.filter((k) => / [-–—] /.test(messages[k] ?? ''))
      expect(bad, lang).toEqual([])
    }
  })
})
