/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// **주석을 먼저 지운다.** 선택자 그룹이 [^{}]* 라 바로 앞 주석 본문까지 삼키는데, 주석에 색 예시를
// 적는 순간 검사 대상이 아닌 것으로 테스트가 실패한다 — 그런 테스트는 곧 무시된다.
const css = readFileSync(path.join(__dirname, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** 선택자에 `.hiw-` 가 들어간 규칙만 뽑는다.
 *
 *  **앞선 규칙의 닫는 중괄호를 앵커로 쓰지 않는다.** `(^|\})` 로 시작하면 그 중괄호가 매치에
 *  먹히고, 다음 매치는 그 다음 규칙의 닫는 중괄호를 찾아 그 뒤의 선택자를 잡는다 — 결과적으로 한
 *  규칙씩 건너뛰며 절반만 검사한다. 선택자 그룹이 이미 `[^{}]*` 라 중괄호를 넘지 못하므로 앵커
 *  없이도 "직전 중괄호 이후 전부"가 정확히 선택자가 된다. */
const hiwRules = (): string[] =>
  [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter((m) => m[1].includes('.hiw-'))
    .map((m) => `${m[1].trim()}{${m[2]}}`)

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
