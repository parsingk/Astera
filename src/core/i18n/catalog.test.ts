import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'
import { ko } from './messages/ko'

const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

/** Product and command names a translation must not localise: they name things the user sees
 *  elsewhere in the app, in the CLIs, or on disk. */
const LITERALS = ['Claude', 'Codex', 'Astera', 'Slack', 'GitHub', 'git', 'npm', 'PATH', 'Gradle', 'Maven', 'cargo', 'go']

describe('카탈로그 불변식', () => {
  it('자리표시자가 한국어 원문과 정확히 일치한다', () => {
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(CATALOGS[lang].messages)) {
        const source = ko[key as keyof typeof ko]
        if (source === undefined) continue
        expect(placeholders(value as string), `${lang}:${key}`).toEqual(placeholders(source))
      }
    }
  })

  it('제품명과 명령어는 번역되지 않고 그대로 남는다', () => {
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(CATALOGS[lang].messages)) {
        const source = ko[key as keyof typeof ko]
        if (source === undefined) continue
        for (const literal of LITERALS) {
          if (!source.toLowerCase().includes(literal.toLowerCase())) continue
          expect((value as string).toLowerCase(), `${lang}:${key} 에 ${literal} 가 없다`).toContain(literal.toLowerCase())
        }
      }
    }
  })

  it('빈 문구가 없다', () => {
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(CATALOGS[lang].messages)) {
        expect((value as string).trim(), `${lang}:${key}`).not.toBe('')
      }
    }
  })

  it('부분 카탈로그가 존재하지 않는 키를 들고 있지 않다', () => {
    for (const lang of LANGS) {
      for (const key of Object.keys(CATALOGS[lang].messages)) {
        expect(Object.prototype.hasOwnProperty.call(ko, key), `${lang}:${key}`).toBe(true)
      }
    }
  })
})
