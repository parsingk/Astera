// Findings speak in every language the app does (lifecycle design §7). ko is the source: a key it has under `findings.`,
// every language has, so a new string cannot fall back to English.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'

const keysOf = (): string[] => Object.keys(CATALOGS.ko.messages).filter((k) => k.startsWith('findings.'))

describe('the findings catalog', () => {
  it('has every key in every language', () => {
    const ko = keysOf()
    expect(ko.length).toBeGreaterThanOrEqual(18)
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

  it('keeps the English the CLI prints and the Korean the person approved', () => {
    const en = CATALOGS.en.messages as Record<string, string>
    const ko = CATALOGS.ko.messages as Record<string, string>
    expect(en['findings.reason.unusedProfile']).toBe('Not used in {days} days.')
    expect(en['findings.reason.failingProfile']).toBe('{failed} of its {total} worker starts in 30 days failed. The last failure was in {run}.')
    expect(en['findings.do.keepOne']).toBe('Keep one and archive the others.')
    expect(ko['findings.reason.unusedProfileNever']).toBe('만든 지 {days}일이 지났지만 한 번도 쓰지 않았습니다.')
    expect(ko['findings.reason.tokenSpike']).toBe('토큰을 {total}개 썼습니다. {group}의 중앙값 {median}의 {times}배입니다.')
    expect(ko['findings.do.repointJob']).toBe('Job이 다른 프로필을 쓰게 바꾸세요.')
  })
})
