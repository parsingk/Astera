import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from './index'
import { ko } from './messages/ko'

const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

/** Product and command names a translation must not localise: they name things the user sees
 *  elsewhere in the app, in the CLIs, or on disk. */
const LITERALS = [
  'Claude', 'Codex', 'Astera', 'Slack', 'GitHub', 'git', 'npm', 'PATH', 'Gradle', 'Maven', 'cargo', 'go',
  'Python', 'pytest', 'Docker', 'Compose', '.NET', 'Jobs'
]

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

  // 실행 구성의 **종류 이름은 번역하지 않는다** — Shell·npm·Gradle·Docker Compose·.NET 처럼 도구가
  // 부르는 이름 그대로 쓴다. LITERALS 검사로는 못 잡는다: 그쪽은 ko 원문에 그 낱말이 있을 때만 다른
  // 언어에도 있는지 보는데, ko 자체를 번역해 버리면 검사할 낱말이 사라진다. 실제로 compound 가
  // ko '묶음' / ja '複合' / es 'Compuesta' 로 셋 다 다르게 번역돼 있었고, 사용자가 목록에서 보고
  // "이게 뭐지" 라고 물어서야 발견됐다.
  it('실행 구성 종류 이름은 모든 카탈로그에서 같다', () => {
    const typeKeys = Object.keys(ko).filter((k) => k.startsWith('run.type.'))
    expect(typeKeys.length).toBeGreaterThan(0)
    for (const key of typeKeys) {
      for (const lang of LANGS) {
        const value = CATALOGS[lang].messages[key as keyof typeof ko]
        if (value === undefined) continue // 부분 카탈로그는 빠진 키를 ko 로 대체한다
        expect(value, `${lang}:${key}`).toBe(ko[key as keyof typeof ko])
      }
    }
  })
})
