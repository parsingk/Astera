import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
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
// 않는다. 실행 콘솔의 링크 문법이 그런 경우이며, 그 두 파일은 아래 CITATION_DATA_FILES 에 이름이 적혀 있다.
//
// "이게 주석인가"는 판별하지 않고 모든 줄을 그냥 스캔한다. 단순하고 튼튼한 편이 똑똑한 편보다
// 낫다: 오탐이 실제로 나오면 그때 좁히는 것이 comment-detection을 제대로 하려는 것보다 작은 변경이다.
//
// 그 오탐이 실제로 나와서 한 번 좁혔다: 파일 이름이 우리 .ts·.tsx 파일(git 이 추적하는 전부와 아직 올리지 않은 src
// 의 새 파일, ourFileNames) 어느 것과도 맞지 않는 인용은 우리 파일 인용이 아니므로 넘어간다. 발견 문구(`error
// src/a.ts:3 Lint: ...`)나 테스트 보고서의 실패 위치처럼 지어낸 경로를 데이터로 담은 fixture 가 열 곳 넘게 생겼고,
// 그 파일들을 CITATION_DATA_FILES 에 다 올리면 orch.test.ts 같은 큰 파일이 통째로 검사에서 빠진다. 비교는 파일
// 이름만으로 한다: 디렉터리가 바뀌어도 이름이 같으면 여전히 인용으로 잡힌다. 진짜 인용은 쓰는 순간 그 파일이 있으니
// 그때 잡혀서 들어올 수 없다. 그래서 나중에 그 파일 이름이 바뀌어도 잡을 인용이 남아 있지 않다. 남는 대가는
// fixture 가 우리 파일과 같은 흔한 이름(types.ts 뒤에 줄 번호)을 쓰면 여전히 걸린다는 것이고, 그때는 fixture 의
// 이름을 바꾼다.
//
// 파일 이름 없이 "(:줄번호)"만 남기는 자기 자신 참조(같은 파일 안에서 "저 위 그 지점"을 가리키는
// 형태)도 잡는다. 콜론 바로 앞에 "("가 오는 모양만 잡으므로 삼항 연산자나 비율 표기와는 오탐이 나지
// 않는다 — 삼항의 콜론 앞은 공백, 비율의 콜론 앞은 숫자이지 "("가 아니다. node_modules 예외는 여기엔
// 적용하지 않는다: 자기 자신을 가리키는 인용이 남의 코드를 향할 일은 없다.

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

// 파일 이름 없는 자기 자신 참조: "(:NN)"이나 "(:NN-MM)"처럼 콜론 바로 앞에 "("가 오는 형태만 잡는다.
const BARE_CITATION_RE = /\(:\d+(?:-\d+)?(?:\s*부근)?\)/g

/** node_modules 경로를 담은 인용은 유일하게 허용된 형태이므로 걸러낸다. */
function isAllowed(citation: string): boolean {
  return citation.includes('node_modules/')
}

/** 콘솔 링크 문법을 다루는 두 파일. 여기서 `이름.ts:줄번호` 는 인용이 아니라 **데이터**다 — 실행 출력에서
 *  경로를 찾아내는 것이 그 코드의 일이고, 테스트 fixture 는 그 출력을 그대로 담아야 한다. 이 파일
 *  첫머리가 예고한 "스택 트레이스를 그대로 담은 테스트 fixture" 가 실제로 나온 자리이므로, 옵트아웃
 *  구멍을 파는 대신 두 파일을 여기 이름으로 적어 허용한다. 파일 단위인 이유는 이 파일의 방침과 같다:
 *  문자열 리터럴 안인지 주석 안인지 가려내는 것보다 단순한 편이 낫다 — 대가는 이 두 파일 안의 진짜
 *  줄 번호 인용은 잡히지 않는다는 것이고, 둘 다 작아서 눈으로 읽힌다. */
const CITATION_DATA_FILES = new Set([
  'src/core/run/consoleLinks.ts',
  'src/core/run/consoleLinks.test.ts',
  // Design Mode's `sourceFile` carries a React `_debugSource` location, which is literally
  // `path.tsx:line:column`. These two handle and format that value, so their fixtures have to hold the
  // real shape — the same reason the two console-link files above are here.
  'src/core/preview/pick/payload.test.ts',
  'src/core/preview/pick/prompt.test.ts',
  // A ContextRef's label is what the context preview shows as the source, literally `path:start-end` (core/context/
  // contextRef.ts), so the fixtures that build and check refs hold that shape — the same reason as the two above.
  'src/core/context/contextRef.test.ts',
  'src/renderer/src/lib/contextSources.test.ts'
])

/** 인용의 파일 이름(마지막 `/` 뒤, 줄 번호 앞)이 우리 src 파일 이름 가운데 하나인가. 아니면 지어낸 경로다. */
function citesOurs(citation: string, ours: ReadonlySet<string>): boolean {
  const file = citation.replace(/:\d+(?:-\d+)?$/, '')
  return ours.has(file.slice(file.lastIndexOf('/') + 1))
}

/** 우리 .ts·.tsx 파일 이름들: git 이 추적하는 전부(src 밖의 빌드 설정, packages, examples 까지)와 아직 git 에 올리지 않은
 *  src 의 새 파일. git 이 답하지 않으면 검사가 몰래 약해지지 않도록 실패한다. */
function ourFileNames(): Set<string> {
  const listed = spawnSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: path.dirname(SRC_ROOT), encoding: 'utf8' })
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr || listed.error?.message}`)
  const names = listed.stdout.split('\n').filter(Boolean).map((f) => path.posix.basename(f))
  return new Set([...names, ...collect(SRC_ROOT, []).map((f) => path.basename(f))])
}

function findViolations(): string[] {
  const violations: string[] = []
  const files = collect(SRC_ROOT, [])
  const ours = ourFileNames()
  for (const file of files) {
    const rel = path.relative(path.dirname(SRC_ROOT), file).replace(/\\/g, '/')
    if (CITATION_DATA_FILES.has(rel)) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const citation of line.match(CITATION_RE) ?? []) {
        if (isAllowed(citation) || !citesOurs(citation, ours)) continue
        violations.push(`${rel}:${i + 1}: ${citation}`)
      }
      // 파일 이름이 없으니 node_modules 예외가 적용될 여지가 없다 — 전부 위반이다.
      for (const citation of line.match(BARE_CITATION_RE) ?? []) {
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

  it('src 에 없는 파일 이름은 우리 파일 인용이 아니고, 있는 파일 이름은 디렉터리가 달라도 인용이다', () => {
    // 이 파일도 검사 대상이라 인용 모양은 이어 붙여 만든다
    const ours = new Set(['ipc.ts', 'App.tsx'])
    expect(citesOurs('src/a.ts' + ':3', ours)).toBe(false)
    expect(citesOurs('file:///work/proj/src/b.test.ts' + ':7', ours)).toBe(false)
    expect(citesOurs('main/ipc.ts' + ':12', ours)).toBe(true)
    expect(citesOurs('ipc.ts' + ':12-14', ours)).toBe(true)
    expect(citesOurs('renderer/src/App.tsx' + ':40', ours)).toBe(true)
  })

  it('우리 파일에는 src 밖의 것(빌드 설정, packages, examples)도 들어간다', () => {
    const ours = ourFileNames()
    expect(ours.has('electron.vite.config.ts')).toBe(true)
    expect(ours.has('lineNumberCitations.test.ts')).toBe(true)
    expect(citesOurs('electron.vite.config.ts' + ':12', ours)).toBe(true)
  })
})
