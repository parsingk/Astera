import { describe, it, expect } from 'vitest'
import { copyTextFor } from './copy'

describe('copyTextFor', () => {
  // 이 버그 자체다. xterm 의 선택은 화면 좌표를 가리킬 뿐 글자를 붙잡지 않는다. claude 같은
  // full-screen TUI 는 매 프레임 화면을 다시 그리므로, 드래그한 글자는 Cmd+C 를 누를 때쯤
  // 그 좌표에 없다 — 측정해 보면 getSelection() 이 공백만 돌려준다. hasSelection() 은 여전히
  // true 라 하이라이트는 그대로 보이고, 사람은 자기가 고른 글자가 거기 있다고 믿는다.
  it('화면이 다시 그려져 지금 좌표가 비었어도 고른 순간의 글자를 쓴다', () => {
    expect(copyTextFor('npm run dev', '   \n  \n')).toBe('npm run dev')
  })

  // 붙잡아 둔 것이 없을 때는 지금 읽히는 것을 쓴다 — 고치기 전의 동작이고, 선택이 갓
  // 만들어져 아직 onSelectionChange 가 오지 않은 순간이 이쪽이다.
  it('붙잡아 둔 것이 없으면 지금 읽히는 글자를 쓴다', () => {
    expect(copyTextFor('', 'fresh selection')).toBe('fresh selection')
  })

  // **클립보드를 공백으로 덮어쓰지 않는다.** 이것이 사람이 본 증상의 마지막 조각이다 —
  // 공백도 빈 문자열이 아니라서 예전 코드의 `if (sel)` 을 통과했고, 그대로 클립보드에 쓰여
  // 다른 앱에 붙여넣어도 아무것도 없는 것처럼 보였다. 쓸 것이 없으면 건드리지 않는다.
  it('양쪽 모두 공백뿐이면 아무것도 쓰지 않는다', () => {
    expect(copyTextFor('  \n ', '\n\n\n')).toBeNull()
  })

  it('양쪽 모두 비어 있으면 아무것도 쓰지 않는다', () => {
    expect(copyTextFor('', '')).toBeNull()
  })

  // 고른 글자의 생김새는 그대로 간다. 판단에만 trim 을 쓰고, 돌려주는 것은 원본이다 —
  // 들여쓰기를 지우고 붙여넣으면 코드 조각이 망가진다.
  it('앞뒤 공백을 지우지 않고 고른 그대로 돌려준다', () => {
    expect(copyTextFor('    indented code\n', '')).toBe('    indented code\n')
  })
})
