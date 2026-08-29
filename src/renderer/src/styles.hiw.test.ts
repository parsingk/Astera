/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// **주석을 먼저 지운다.** 선택자 그룹이 [^{}]* 라 바로 앞 주석 본문까지 삼키는데, 주석에 색 예시를
// 적는 순간 검사 대상이 아닌 것으로 테스트가 실패한다 — 그런 테스트는 곧 무시된다.
const css = readFileSync(path.join(__dirname, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** 선택자에 `.hiw-` 가 들어간 규칙만 뽑는다 */
const hiwRules = (): string[] =>
  [...css.matchAll(/(^|\})\s*([^{}]*\.hiw-[^{}]*)\{([^}]*)\}/g)].map((m) => `${m[2]}{${m[3]}}`)

describe('How It Works 의 테마 규약', () => {
  it('색 리터럴을 쓰지 않는다 — 테마가 바꾸지 못하는 자리가 생긴다', () => {
    for (const rule of hiwRules()) {
      expect(rule, rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(rule, rule).not.toMatch(/\b(rgb|hsl)a?\(/)
    }
  })

  it('선택 표시는 배경과 함께 준다 — Umbra·Sirius 는 --marker-w 가 0 이다', () => {
    for (const rule of hiwRules()) {
      if (!rule.includes('--marker-w')) continue
      expect(rule, rule).toMatch(/background:/)
    }
  })
})
