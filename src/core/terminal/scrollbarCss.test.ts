import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * 세션 터미널 스크롤바 은닉의 CSS 계약. icons.test.ts의 "IconTone ↔ CSS"와 같은 형태로 styles.css를
 * 직접 읽어 규칙 존재를 단언한다 — 스타일은 런타임에 검증할 수 없어 선택자가 조용히 어긋나면
 * 화면에서만 드러난다. src/renderer가 아니라 여기 두는 이유: tsconfig.web.json에는 types:["node"]가
 * 없어 renderer 트리에서 node:fs를 임포트하면 typecheck가 깨진다(icons.test.ts도 core에 있다).
 *
 * xterm 6.0부터 세로 스크롤바는 네이티브(::-webkit-scrollbar)가 아니라 VS Code 유래 DOM 오버레이
 * (.xterm-scrollable-element > .scrollbar > .slider)로 그려진다. 세션 터미널은 fitTerminalToHost가
 * 폭을 셀 격자로 꽉 채우므로 이 막대가 보이면 마지막 열을 가린다.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(path.join(here, rel), 'utf8')

describe('세션 터미널 스크롤바 은닉 ↔ xterm CSS', () => {
  it('xterm은 .xterm-scrollable-element > .scrollbar 로 스크롤바를 그린다', () => {
    // 업스트림이 이 선택자를 바꾸거나 네이티브 스크롤바로 되돌리면 아래 규칙이 조용히 무효가 된다 —
    // 그때 이 단언이 먼저 깨져 styles.css를 함께 갱신하게 만든다
    expect(read('../../../node_modules/@xterm/xterm/css/xterm.css')).toMatch(
      /\.xterm-scrollable-element\s*>\s*\.scrollbar/
    )
  })

  it('styles.css가 .terminal-host 안의 DOM 스크롤바를 display:none으로 없앤다', () => {
    // display:none이어야 히트테스트에서도 빠진다 — 투명하게만 두면 우측 14px이 드래그 선택을 먹는다
    expect(read('../../renderer/src/styles.css')).toMatch(
      /\.terminal-host\s+\.xterm-scrollable-element\s*>\s*\.scrollbar\s*\{[^}]*display:\s*none/
    )
  })

  it('네이티브 스크롤바 은닉 규칙도 함께 남아 있다', () => {
    expect(read('../../renderer/src/styles.css')).toMatch(
      /\.terminal-host\s+\.xterm-viewport::-webkit-scrollbar\s*\{[^}]*width:\s*0/
    )
  })
})
