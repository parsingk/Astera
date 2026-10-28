// Enforce's refusals (enforce design E5) speak in every language the app does, with the CLI, the versions and the way
// back to Observe in each.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'

const KEYS = [
  'session.spawn.enforce.noInterpreter',
  'session.spawn.enforce.cliTooOld',
  'session.spawn.enforce.cliVersionUnknown',
  'session.spawn.enforce.hookMissing',
  'session.spawn.enforce.hooksOff',
  'session.spawn.enforce.hookWriteFailed',
  'session.spawn.enforce.cliMissing',
  'session.spawn.enforce.codexDaemon'
] as const

describe('the enforce refusals', () => {
  it('has every enforce refusal in every language', () => {
    for (const lang of LANGS) {
      const m = CATALOGS[lang].messages as Record<string, string | undefined>
      expect(KEYS.filter((k) => !m[k]), lang).toEqual([])
      expect(m['session.spawn.enforce.cliTooOld'], lang).toMatch(/\{cli\}[\s\S]*\{min\}[\s\S]*\{found\}/)
      expect(m['session.spawn.enforce.cliVersionUnknown'], lang).toContain('{cli}')
      for (const k of ['session.spawn.enforce.noInterpreter', 'session.spawn.enforce.cliTooOld', 'session.spawn.enforce.hookMissing'])
        expect(m[k], `${lang} ${k}`).toContain('Observe')
      expect(KEYS.filter((k) => /\s[—–-]\s/.test(m[k] ?? '')), lang).toEqual([])
    }
  })

  it('says it in Korean as the plan wrote it', () => {
    const ko = CATALOGS.ko.messages as Record<string, string>
    expect(ko['session.spawn.enforce.cliTooOld']).toBe(
      'Enforce 는 {cli} {min} 이상에서만 막을 수 있습니다. 지금은 {found} 입니다. CLI 를 업데이트하거나 Policies 를 Observe 로 바꾸세요.'
    )
    expect(ko['session.spawn.enforce.cliVersionUnknown']).toBe('{cli} 의 버전을 알 수 없어 Enforce 로 시작하지 않았습니다.')
    expect(ko['session.spawn.enforce.noInterpreter']).toBe(
      'Enforce 에 필요한 Astera 실행 파일을 찾지 못해 시작하지 않았습니다. Astera 를 다시 설치하거나 Policies 를 Observe 로 바꾸세요.'
    )
    expect(ko['session.spawn.enforce.hookMissing']).toBe(
      '막는 hook 이 이 세션에서 돌지 않아 세션을 멈췄습니다. Policies 를 Observe 로 바꾸면 막지 않고 기록만 합니다.'
    )
  })
})
