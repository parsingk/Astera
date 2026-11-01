// Remote governance speaks in every language the app does (remote governance design §8.2, §8.4). ko is the source: a
// key it has under these prefixes, every language has, so a new string cannot fall back to English.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'

const PREFIXES = ['settings.remote.revoke.', 'jobs.run.pausedRevoked']
const keysOf = (): string[] => Object.keys(CATALOGS.ko.messages).filter((k) => PREFIXES.some((p) => k.startsWith(p)))

describe('the remote governance catalog', () => {
  it('has every key in every language', () => {
    const ko = keysOf()
    expect(ko).toEqual(expect.arrayContaining(['settings.remote.revoke.paused', 'settings.remote.revoke.notPaused', 'jobs.run.pausedRevoked']))
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

  // Every placeholder ko fills, each language fills, so no value is dropped from a translation
  it('keeps the placeholders of each sentence', () => {
    const holes = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort()
    const ko = CATALOGS.ko.messages as Record<string, string>
    for (const lang of LANGS) {
      const m = CATALOGS[lang].messages as Record<string, string>
      expect(keysOf().filter((k) => holes(m[k] ?? '').join() !== holes(ko[k]).join()), lang).toEqual([])
    }
  })

  // Ruling R8-1: the English the CLI prints and the Korean the person approved
  it('keeps the revoke and paused Job copy', () => {
    const en = CATALOGS.en.messages as Record<string, string>
    const ko = CATALOGS.ko.messages as Record<string, string>
    const copy: Record<string, [string, string]> = {
      'settings.remote.revoke.paused': [
        'Unpaired {name}. Scheduled Jobs it made, now paused: {paused}. Scheduled Jobs with no maker on record, which keep their schedule: {unrecorded}.',
        '{name} 의 페어링을 해제했습니다. 그쪽에서 만들어 일시 중지한 예약 Job: {paused}개. 만든 곳이 기록되지 않아 예약을 그대로 두는 예약 Job: {unrecorded}개.'
      ],
      'settings.remote.revoke.notPaused': ['Could not pause: {jobs}.', '일시 중지하지 못한 Job: {jobs}.'],
      'jobs.run.pausedRevoked': ['Paused: made from {name}, which was unpaired', '일시 중지됨: {name} 에서 만들었고 그 페어링은 해제되었습니다']
    }
    for (const [key, [english, korean]] of Object.entries(copy)) {
      expect(en[key], key).toBe(english)
      expect(ko[key], key).toBe(korean)
    }
  })

  // Ruling R8-3: ja names a schedule 予約, as its Jobs area does, never スケジュール
  it('says 予約 in Japanese, as the Jobs area does', () => {
    const ja = CATALOGS.ja.messages as Record<string, string>
    expect(ja['settings.remote.revoke.paused']).toContain('予約 Job')
    expect(ja['settings.remote.revoke.paused']).toContain('予約をそのまま残す')
    expect(keysOf().filter((k) => (ja[k] ?? '').includes('スケジュール'))).toEqual([])
  })
})
