import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * "일하는 중"을 말하는 회전의 CSS 계약. scrollbarCss.test.ts 와 같은 형태로 styles.css 를 직접 읽어
 * 규칙을 단언한다 — 스타일은 런타임에 검증할 수 없어 조용히 어긋나면 화면에서만 드러난다.
 * src/renderer 가 아니라 여기 두는 이유도 같다: tsconfig.web.json 에는 types:["node"] 가 없어
 * renderer 트리에서 node:fs 를 임포트하면 typecheck 가 깨진다.
 *
 * **이 파일이 있는 이유**: Jobs 사이드바의 Task 아이콘(.job-arc)이 실제로 도는 워커 옆에서 멈춰 있는
 * 것으로 보고됐다. 원인은 `@media (prefers-reduced-motion: reduce) { .job-arc { animation: none } }`
 * 였고, Windows 에서 "애니메이션 효과"가 꺼져 있으면(SPI_GETCLIENTAREAANIMATION = 0) Chromium 이 그
 * 미디어 쿼리를 참으로 보고한다 — 실측했다.
 *
 * 그 규칙을 되돌린 근거 둘:
 *  - **앱의 다른 "일하는 중" 회전은 애초에 끄지 않았다.** cm-spin(.tab-dot.busy, .loading-spinner)은
 *    어떤 reduced-motion 블록에도 없다. 즉 .job-arc 하나만 예외였고, 정책이 아니라 이탈이었다.
 *  - **이 글리프에서 멈춤은 다른 뜻을 이미 갖고 있다.** JobIcons 의 still 은 "워커가 멈춰 세워졌다"
 *    (isStoppedWorker)를 말한다. 회전을 미디어 쿼리로 끄면 *도는 Task* 와 *워커가 멈춘 Task* 가
 *    똑같이 그려져, 코드가 일부러 구별하는 두 상태가 화면에서 하나가 된다.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.join(here, '../../renderer/src/styles.css'), 'utf8')

/** `@media (prefers-reduced-motion: reduce)` 블록들의 본문.
 *
 *  중괄호를 세어 자른다 — 정규식으로 `\{[^}]*\}` 를 쓰면 안쪽에 규칙이 있는 이 블록에서 첫 닫는
 *  괄호에 걸려 앞부분만 잘린다. 그리고 **주석이 아니라 블록만 봐야 한다**: 이 계약을 설명하는 주석이
 *  styles.css 안에서 `.job-arc` 와 `cm-spin` 을 문장으로 언급하므로, 파일을 통째로 훑으면 설명이
 *  규칙으로 잘못 읽힌다(실제로 그렇게 썼다가 이 테스트가 자기 주석에 걸렸다). */
const reducedMotionBlocks = (): string[] => {
  const out: string[] = []
  const re = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    let depth = 0
    let i = m.index + m[0].length - 1
    const start = i
    do {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
      i++
    } while (depth > 0 && i < css.length)
    out.push(css.slice(start, i))
  }
  return out
}

describe('"일하는 중" 회전 ↔ CSS', () => {
  it('reduced-motion 블록을 실제로 찾아낸다 — 못 찾으면 아래 단언들이 공허해진다', () => {
    expect(reducedMotionBlocks().length).toBeGreaterThan(0)
  })

  it('.job-arc 가 job-spin 으로 돈다', () => {
    expect(css).toMatch(/\.job-arc\s*\{[^}]*animation:\s*job-spin/)
  })

  // 이 단언이 이 파일의 요점이다. 되살아나면 도는 워커 옆의 아이콘이 다시 멈춘다.
  it('.job-arc 의 회전을 reduced-motion 으로 끄지 않는다', () => {
    for (const b of reducedMotionBlocks()) expect(b).not.toMatch(/\.job-arc/)
  })

  // 회전으로 "일하는 중"을 말하는 나머지 둘도 같은 대우여야 한다 — 하나만 예외였던 것이 이 결함이다
  it('cm-spin 을 쓰는 회전들도 reduced-motion 으로 끄지 않는다', () => {
    expect(css).toMatch(/\.tab-dot\.busy\s*\{[^}]*animation:\s*cm-spin/)
    expect(css).toMatch(/\.loading-spinner\s*\{[^}]*animation:\s*cm-spin/)
    for (const b of reducedMotionBlocks()) {
      expect(b).not.toMatch(/cm-spin/)
      expect(b).not.toMatch(/\.tab-dot/)
      expect(b).not.toMatch(/\.loading-spinner/)
    }
  })
})
