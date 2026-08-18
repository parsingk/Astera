/** 마크다운 프리뷰의 뷰 상태 계산.
 *
 *  DOM 을 만지지 않는 것만 둔다 — 이 계산들은 전부 단위 테스트 대상이고, 그래서 렌더러 컴포넌트가
 *  아니라 여기에 있다 (edit.ts·icons.ts 와 같은 자리). */

import type { LangKey } from './edit'

export type MdViewMode = 'editor' | 'split' | 'preview'

const CYCLE: readonly MdViewMode[] = ['editor', 'split', 'preview']

/** 키바인딩이 쓰는 모드 순환. 툴바 버튼은 모드를 직접 지정하므로 이것을 쓰지 않는다 — 두 진입점의
 *  역할이 다르다. */
export function cycleViewMode(mode: MdViewMode): MdViewMode {
  return CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length]
}

/** localStorage 에서 읽은 값의 신뢰 경계. */
export const isMdViewMode = (v: unknown): v is MdViewMode =>
  v === 'editor' || v === 'split' || v === 'preview'

export const SPLIT_MIN = 0.15
export const SPLIT_MAX = 0.85
export const SPLIT_DEFAULT = 0.5

/** 분할 비율(왼쪽이 차지하는 비율). localStorage 의 값도, 드래그 중의 계산값도 이곳을 지난다 —
 *  전자는 사람이 고쳤을 수 있고 후자는 컨테이너 폭이 0인 프레임에서 NaN 이 될 수 있다. */
export function clampSplitRatio(v: unknown): number {
  if (v === null || v === undefined) return SPLIT_DEFAULT

  let n: number
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (!trimmed) return SPLIT_DEFAULT
    n = Number(trimmed)
  } else if (typeof v === 'number') {
    n = v
  } else {
    return SPLIT_DEFAULT
  }

  if (!Number.isFinite(n)) return SPLIT_DEFAULT
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, n))
}

/** 코드 펜스 info → 언어 키.
 *
 *  edit.ts 의 LANG_BY_EXT 를 재사용하지 않는 이유: 그 표는 **확장자** 기준이고 펜스에는 확장자가
 *  아닌 별칭이 온다(`typescript`, `golang`, `c++`). 겹치는 항목이 많지만 열이 다른 표다.
 *
 *  없는 언어는 null 이고 프리뷰는 색 없는 <pre> 로 그린다. 셸(`bash`/`sh`/`shell`)과 일반
 *  텍스트(`text`/`plain`)가 일부러 빠져 있다 — 이 저장소에 해당 CM6 언어 패키지가 없다. */
const LANG_BY_FENCE: Record<string, LangKey> = {
  js: 'javascript', jsx: 'javascript', javascript: 'javascript',
  ts: 'javascript', tsx: 'javascript', typescript: 'javascript',
  mjs: 'javascript', cjs: 'javascript',
  py: 'python', python: 'python',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown',
  rs: 'rust', rust: 'rust',
  c: 'cpp', h: 'cpp', cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', hpp: 'cpp', cxx: 'cpp',
  java: 'java', php: 'php', sql: 'sql',
  xml: 'xml', svg: 'xml',
  go: 'go', golang: 'go',
  yml: 'yaml', yaml: 'yaml'
}

export function langForFence(info: string): LangKey | null {
  // ```ts title="foo.ts" 처럼 info 뒤에 메타를 붙이는 관례가 널리 쓰이므로 첫 낱말만 본다
  const first = info.trim().split(/\s+/)[0]?.toLowerCase()
  if (!first) return null
  return LANG_BY_FENCE[first] ?? null
}

/** 프리뷰의 (원문 줄번호, 요소 offsetTop) 짝. 줄번호 오름차순으로 정렬되어 있어야 한다. */
export interface ScrollAnchor {
  line: number
  top: number
}

/** DOM 에서 모은 (줄번호, 요소 offsetTop) 원본 쌍을 topForLine/lineForTop 이 요구하는 전제 —
 *  줄번호 오름차순, 중복 없음 — 로 만든다. DOM 을 만지지 않으므로 여기 있다(이 파일의 다른 함수와
 *  같은 이유).
 *
 *  `line` 이 `data-md-line` 에서 그대로 온 수라 신뢰할 수 없다 — 파싱에 실패한 값(비 유한수)은
 *  버린다. 같은 줄을 여러 요소가 보고하면(중첩 요소, 또는 task 5 의 다중 줄 HTMLBlock 이 여러 자식에게
 *  시작 줄을 물려주는 경우) 문서 순서상 먼저 온 것(바깥 요소, 또는 먼저 만난 요소)을 남긴다 —
 *  `Array.prototype.sort` 가 안정 정렬이라 같은 줄 값을 가진 항목들은 정렬 뒤에도 입력 순서 그대로
 *  인접하게 되므로, 정렬 다음에 인접한 중복만 걸러도 "먼저 만난 것"이 항상 남는다. 이 성질 덕분에
 *  중복이 입력에서 서로 떨어져 있어도(사이에 다른 줄이 끼어 있어도) 정확히 동작한다. */
export function toAnchors(pairs: { line: number; top: number }[]): ScrollAnchor[] {
  const sorted = pairs.filter((p) => Number.isFinite(p.line)).sort((a, b) => a.line - b.line)
  const out: ScrollAnchor[] = []
  for (const p of sorted) {
    if (out.length > 0 && out[out.length - 1].line === p.line) continue
    out.push(p)
  }
  return out
}

/** 원문 줄번호 → 프리뷰 스크롤 위치. 앵커 사이는 선형보간한다.
 *
 *  블록 단위 앵커이므로 긴 코드 블록이나 큰 이미지 **안에서는** 어긋난다. IntelliJ 도 같은 성질을
 *  가진다 — 정확히 맞추려면 인라인 단위 매핑이 필요하고 그것은 이 범위가 아니다. */
export function topForLine(anchors: ScrollAnchor[], line: number): number {
  if (anchors.length === 0) return 0
  if (line <= anchors[0].line) return anchors[0].top
  const last = anchors[anchors.length - 1]
  if (line >= last.line) return last.top
  let i = 0
  while (i < anchors.length - 1 && anchors[i + 1].line <= line) i++
  const a = anchors[i]
  const b = anchors[i + 1]
  const span = b.line - a.line
  return span <= 0 ? a.top : a.top + ((line - a.line) / span) * (b.top - a.top)
}

/** topForLine 의 역방향. 프리뷰 → 에디터 동기화가 쓴다. */
export function lineForTop(anchors: ScrollAnchor[], top: number): number {
  if (anchors.length === 0) return 0
  if (top <= anchors[0].top) return anchors[0].line
  const last = anchors[anchors.length - 1]
  if (top >= last.top) return last.line
  let i = 0
  while (i < anchors.length - 1 && anchors[i + 1].top <= top) i++
  const a = anchors[i]
  const b = anchors[i + 1]
  const span = b.top - a.top
  return span <= 0 ? a.line : Math.round(a.line + ((top - a.top) / span) * (b.line - a.line))
}
