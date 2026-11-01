// Remote governance speaks in every language the app does (remote governance design §8.2, §8.4). ko is the source: a
// key it has under these prefixes, every language has, so a new string cannot fall back to English.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'

const PREFIXES = ['settings.remote.revoke.', 'jobs.run.pausedRevoked', 'settings.remote.detail.', 'settings.remote.surface.', 'settings.remote.thisMachine.clientSeen']
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

  // Ruling C6: the state words the CLI prints and the detail shows (Task 17), in the plan's English and Korean
  it('keeps the comparison state words', () => {
    const en = CATALOGS.en.messages as Record<string, string>
    const ko = CATALOGS.ko.messages as Record<string, string>
    const copy: Record<string, [string, string]> = {
      'settings.remote.detail.state.missing': ['Not there', '그 컴퓨터에 없음'],
      'settings.remote.detail.state.different': ['Different there', '그 컴퓨터와 다름'],
      'settings.remote.detail.state.off': ['Off there', '그 컴퓨터에서 꺼짐'],
      'settings.remote.detail.state.secretMissing': ['Secret missing there', '그 컴퓨터에 비밀값 없음'],
      'settings.remote.detail.state.same': ['Same', '같음'],
      'settings.remote.detail.state.onlyThere': ['Only there', '그 컴퓨터에만 있음'],
      'settings.remote.detail.updateThere': ['Update Astera on that computer.', '그 컴퓨터의 Astera를 업데이트하세요.']
    }
    for (const [key, [english, korean]] of Object.entries(copy)) {
      expect(en[key], key).toBe(english)
      expect(ko[key], key).toBe(korean)
    }
  })

  // Task 17: the detail's and This computer's copy in the plan's English and Korean, pairing words as the app has them
  // (ruling C11)
  it('keeps the detail and controller surface copy', () => {
    const en = CATALOGS.en.messages as Record<string, string>
    const ko = CATALOGS.ko.messages as Record<string, string>
    const copy: Record<string, [string, string]> = {
      'settings.remote.detail.open': ['Details', '자세히'],
      'settings.remote.detail.identity': ['Identity', '식별 정보'],
      'settings.remote.detail.runtimeId': ['Runtime id {id}', 'Runtime id {id}'],
      'settings.remote.detail.fingerprint': ['Fingerprint {fingerprint}', '지문 {fingerprint}'],
      'settings.remote.detail.copyFingerprint': ['Copy', '복사'],
      'settings.remote.detail.pairedAt': ['Paired {at}', '{at}에 페어링함'],
      'settings.remote.detail.health': ['Health', '상태'],
      'settings.remote.detail.answers': ['Answers now', '지금 응답합니다'],
      'settings.remote.detail.os': ['OS {platform}', 'OS {platform}'],
      'settings.remote.detail.expected': ['Expected there', '그 컴퓨터에도 있어야 함'],
      'settings.remote.detail.installThere': [
        'Install, update, turn on or add the secret on that computer, in its Settings › MCP & Skills.',
        '그 컴퓨터의 설정 › MCP & Skills에서 설치, 업데이트, 켜기 또는 비밀값 추가를 하세요.'
      ],
      'settings.remote.detail.refresh': ['Refresh', '새로 고침'],
      'settings.remote.surface.desktop': ['app', '앱'],
      'settings.remote.surface.cli': ['CLI', 'CLI'],
      'settings.remote.surface.mcp': ['MCP', 'MCP'],
      'settings.remote.thisMachine.clientSeen': ['{surface} · Astera {version} · Last seen {at}', '{surface} · Astera {version} · 마지막 연결 {at}']
    }
    for (const [key, [english, korean]] of Object.entries(copy)) {
      expect(en[key], key).toBe(english)
      expect(ko[key], key).toBe(korean)
    }
  })

  // A settings path in Korean is named by the ko tab names, as the app shows them
  it('names settings paths in Korean as 설정, never Settings', () => {
    const ko = CATALOGS.ko.messages as Record<string, string>
    expect(keysOf().filter((k) => ko[k].includes('Settings ›'))).toEqual([])
  })

  // Ruling R8-3: ja names a schedule 予約, as its Jobs area does, never スケジュール
  it('says 予約 in Japanese, as the Jobs area does', () => {
    const ja = CATALOGS.ja.messages as Record<string, string>
    expect(ja['settings.remote.revoke.paused']).toContain('予約 Job')
    expect(ja['settings.remote.revoke.paused']).toContain('予約をそのまま残す')
    expect(keysOf().filter((k) => (ja[k] ?? '').includes('スケジュール'))).toEqual([])
  })
})
