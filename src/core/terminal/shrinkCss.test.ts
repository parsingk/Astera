import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * 페인이 좁아질 때 터미널이 따라 줄어드는 CSS 계약. scrollbarCss.test.ts와 같은 형태로 styles.css를
 * 직접 읽어 규칙을 단언한다 — 레이아웃은 node 환경에서 검증할 수 없어, 이 조합이 깨지면 화면에서만
 * 드러난다.
 *
 * .terminal-host는 .terminal-wrap(가로 flex)의 아이템이라 폭이 주축이다. flex 아이템의 min-width:auto는
 * "스크롤 컨테이너가 아니면" 콘텐츠 기반 최소 크기가 되는데, overflow:clip은(hidden과 달리) 스크롤
 * 컨테이너가 아니다. 그래서 clip으로 바꾼 뒤부터 host가 .xterm-screen의 고정 폭(cols × cellWidth)
 * 아래로는 줄어들지 못했고, 탭을 분할해도 host.clientWidth가 그대로라 fitTerminalToHost가 열 수를
 * 다시 계산하지 않았다 — 기존 터미널이 옛 폭 그대로 남아 잘려 보였다.
 * 측정: 슬롯을 1000px → 500px로 줄였을 때 clip만 두면 host가 990px(콘텐츠 폭)에서 멈추고,
 * min-width:0을 더하면 500px로 따라 줄어든다.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const styles = (): string =>
  readFileSync(path.join(here, '../../renderer/src/styles.css'), 'utf8')

describe('페인 축소 ↔ .terminal-host CSS', () => {
  it('.terminal-host가 min-width:0으로 자동 최소 크기를 끈다', () => {
    // 이게 없으면 xterm 화면 폭이 하한이 되어 페인이 좁아져도 host는 줄어들지 않는다
    expect(styles()).toMatch(/\.terminal-host\s*\{[^}]*min-width:\s*0/)
  })

  it('.terminal-host는 overflow:clip을 유지한다', () => {
    // hidden으로 되돌리면 min-width:0 없이도 줄어들지만, 스크롤 컨테이너가 되살아나
    // IME 조합 중 pane이 흔들리던 문제(e011596)가 함께 돌아온다
    expect(styles()).toMatch(/\.terminal-host\s*\{[^}]*overflow:\s*clip/)
  })
})
