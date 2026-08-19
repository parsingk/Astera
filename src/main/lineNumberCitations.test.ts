import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// 줄 번호로 우리 자신의 파일을 인용하는 주석을 금지한다.
//
// 왜: 그런 주석은 쓰는 순간에만 맞다. 인용된 줄보다 위쪽에 무엇이든 추가되면 — 같은 커밋이 다른
// 곳을 고치면서 추가한 것이라도 — 그 순간 틀린 주석이 된다. 실제로 한 기능 브랜치에서 이런 인용이
// 네 곳 발견됐고, 그중 하나는 다른 하나를 고친 바로 그 커밋이 만든 것이었다. 그리고 넷 다 태스크별
// 리뷰 열한 번과 브랜치 전체 리뷰를 그대로 통과했다 — 숫자는 정확해 보이기 때문에 리뷰로 잡히지
// 않는다. 대신 함수/상수/타입 이름으로 인용한다: 이름은 코드가 위아래로 움직여도 grep으로 다시
// 찾을 수 있다. 근거는 knowledge/decisions/ADR-005-cite-by-symbol-not-line.md.
//
// 예외는 하나, node_modules 뿐이다: 그 안의 심볼 이름은 우리가 정한 것이 아니라서 줄 번호가 유일한
// 손잡이일 수 있다. 이건 규칙이지 예외 목록이 아니다 — node_modules 경로를 담은 인용은 전부 허용된다.
//
// 옵트아웃 메커니즘은 만들지 않는다. 스택 트레이스를 그대로 담은 테스트 fixture처럼 정당한 사례가
// 나오면, 그때 이유를 밝히고 이 파일을 의도적으로 고쳐서 허용한다 — 미리 빠져나갈 구멍을 파 두지
// 않는다.
//
// "이게 주석인가"는 판별하지 않고 모든 줄을 그냥 스캔한다. 단순하고 튼튼한 편이 똑똑한 편보다
// 낫다: 오탐이 실제로 나오면 그때 좁히는 것이 comment-detection을 제대로 하려는 것보다 작은 변경이다.

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXTS = /\.tsx?$/

function collect(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) collect(full, out)
    else if (EXTS.test(e.name)) out.push(full)
  }
  return out
}

// path/name.ts 또는 path/name.tsx 뒤에 :줄번호 하나, 또는 :시작-끝 범위가 붙은 형태를 잡는다.
const CITATION_RE = /[\w./-]+\.tsx?:\d+(?:-\d+)?/g

/** node_modules 경로를 담은 인용은 유일하게 허용된 형태이므로 걸러낸다. */
function isAllowed(citation: string): boolean {
  return citation.includes('node_modules/')
}

function findViolations(): string[] {
  const violations: string[] = []
  for (const file of collect(SRC_ROOT, [])) {
    const rel = path.relative(path.dirname(SRC_ROOT), file).replace(/\\/g, '/')
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const citation of line.match(CITATION_RE) ?? []) {
        if (isAllowed(citation)) continue
        violations.push(`${rel}:${i + 1}: ${citation}`)
      }
    })
  }
  return violations
}

describe('줄 번호가 아니라 심볼 이름으로 인용한다', () => {
  it('src 안의 우리 파일을 줄 번호로 인용하는 곳이 없다 (node_modules 는 예외)', () => {
    // 실패하면 각 항목을 심볼 이름으로 — 심볼이 없으면 감싸는 심볼 + 인용부호로 감싼 짧은
    // 문구로 — 바꾼다.
    expect(findViolations()).toEqual([])
  })
})
