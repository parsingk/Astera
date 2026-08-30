// 에이전트에게 줄 **재료를 우리가 고른다** — 스펙 §29.
//
// **왜 이것이 필요한가.** 처음에는 "저장소를 보고 기능을 찾아라"라고만 시켰다. 이 저장소(572개
// 파일)에서 실제로 돌려 보니 **10분을 넘겨도 끝나지 않았다** — 에이전트가 파일을 하나씩 열어
// 보는 것을 우리가 막지 않았기 때문이다. 스펙 §29 가 그것을 미리 금지하고 있었다:
// "전체 repository 를 prompt 에 넣지 않는다 … 관련 source selection 은 처음에는 deterministic
// heuristic 으로 충분하다."
//
// 그래서 이 모듈이 **디렉터리 뼈대와 문서 몇 줄**을 값으로 만들고, 에이전트는 그것을 읽고
// 판단만 한다. 탐색이 필요하면 그때 파일을 더 열 수 있지만, 아무것도 없이 시작하지 않는다.
//
// node: import 없음 — 파일을 읽는 것은 main 이고 여기는 읽어 온 값을 다듬는다.

/** 결정적 재료. 파일 내용 전체가 아니라 **모양**이다 */
export interface ProjectSketch {
  /** 저장소 상대 디렉터리 경로들 — 깊이 제한을 걸어 모은 것 */
  directories: string[]
  /** 눈에 띄는 문서 몇 개의 앞부분 */
  docs: { path: string; head: string }[]
}

/** 스케치를 프롬프트에 실을 문자열로. **길이를 여기서 자른다** — 재료가 프롬프트를 삼키면
 *  계약(§24)이 뒤로 밀려 지켜지지 않는다 */
export function sketchText(s: ProjectSketch, limit = 6000): string {
  const dirs = s.directories.length > 0 ? `Directories:\n${s.directories.map((d) => `- ${d}`).join('\n')}` : ''
  const docs = s.docs.map((d) => `--- ${d.path} ---\n${d.head}`).join('\n\n')
  const all = [dirs, docs].filter((x) => x !== '').join('\n\n')
  return all.length <= limit ? all : all.slice(0, limit) + '\n…(잘림)'
}

/** 이 이름의 디렉터리는 훑지 않는다. 빌드 산출물과 의존성은 기능이 아니고, 그것을 세면
 *  "node_modules 관리"가 기능 목록에 오른다 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-installer',
  'out',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'target',
  'vendor',
  '.idea',
  '.vscode'
])

/** 첫 분석이 읽을 문서 후보. 있으면 앞부분을 싣는다 — README 가 이 프로젝트가 무엇인지
 *  가장 짧게 말해 주는 곳이다 */
export const DOC_CANDIDATES: readonly string[] = [
  'README.md',
  'readme.md',
  'README.ko.md',
  'docs/README.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
  'CLAUDE.md'
]

/** 디렉터리 목록을 보기 좋게 — 깊이순, 그다음 이름순. 너무 많으면 자른다.
 *  **얕은 것이 먼저다**: `src/core` 가 `src/core/understanding/messages` 보다 기능을 잘 말한다 */
export function orderDirectories(dirs: readonly string[], limit = 120): string[] {
  const depth = (d: string): number => d.split('/').length
  return [...dirs].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)).slice(0, limit)
}
