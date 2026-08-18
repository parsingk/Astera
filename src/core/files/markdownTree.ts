/** 마크다운 원문 → 렌더링용 중간 표현.
 *
 *  파서는 @lezer/markdown 이다. 새 의존성이 아니라 @codemirror/lang-markdown 이 이미 쓰고 있는
 *  것을 그대로 재사용한다 — 그래서 에디터의 구문 강조와 프리뷰가 **같은 문법 해석**을 쓴다.
 *
 *  왜 HTML 문자열을 만들지 않는가: 이 결과는 React 엘리먼트로 그려진다. HTML 문자열이 브라우저에
 *  닿는 지점이 없으므로 sanitizer 가 필요 없고, 스크립트를 "막는" 것이 아니라 넣을 자리가 없다.
 *  이 렌더러는 window.api(파일 쓰기·터미널 실행)가 살아 있는 프로세스 안에서 돌기 때문에 그 차이가
 *  중요하다. 자세한 근거는 docs/superpowers/specs/2026-08-18-markdown-preview-design.md 참고.
 *
 *  입력은 항상 LF 다. App 이 버퍼를 toLf 로 정규화해 들고 있고(edit.ts), line 계산이 그 전제에
 *  기댄다. */

import { parser as baseParser, GFM } from '@lezer/markdown'
import type { SyntaxNode } from '@lezer/common'
import { langForFence } from './markdownView'
import type { LangKey } from './edit'

/** 모듈 상수 — 파서 구성은 한 번만 한다. configure 는 새 파서를 만들므로 매 호출 반복하면 낭비다 */
const mdParser = baseParser.configure(GFM)

export type MdAlign = 'left' | 'center' | 'right' | null

/** 우리가 허용하는 스타일 세 가지. core 는 React 를 import 하지 않으므로 CSSProperties 를 쓰지
 *  않는다. 사용자가 준 CSS 문자열은 절대 담기지 않는다 — 값만 읽어 우리가 짓는다 (Task 4) */
export interface MdStyle {
  textAlign?: 'left' | 'center' | 'right' | 'justify'
  width?: string
  height?: string
}

/** 허용 속성만 담는 닫힌 형태. 인덱스 시그니처를 두지 않는 것이 핵심이다 — 통과 목록에 없는
 *  속성이 타입 차원에서 들어오지 못한다 */
export interface MdAttrs {
  href?: string
  src?: string
  alt?: string
  title?: string
  colspan?: string
  rowspan?: string
  start?: string
  open?: boolean
  style?: MdStyle
}

export type MdInline =
  | { k: 'text'; text: string }
  | { k: 'strong'; children: MdInline[] }
  | { k: 'em'; children: MdInline[] }
  | { k: 'del'; children: MdInline[] }
  | { k: 'code'; text: string }
  | { k: 'br' }

export interface MdItem {
  line: number
  /** 체크박스 상태. null 은 체크박스가 없는 보통 항목 */
  task: boolean | null
  children: MdBlock[]
}

/** ATX·Setext 제목이 공유하는 수준. 리터럴 유니온이라 `Number(...) as HeadingLevel` 캐스트가
 *  실제로 6 을 넘는 값이 섞여 들어오는 실수를 잡아낼 여지를 남긴다 — `as 1` 로 뭉개면 그 여지가
 *  사라진다 */
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

export type MdBlock =
  | { k: 'heading'; line: number; level: HeadingLevel; inline: MdInline[] }
  | { k: 'para'; line: number; inline: MdInline[] }
  | { k: 'code'; line: number; lang: LangKey | null; text: string }
  | { k: 'list'; line: number; ordered: boolean; start: number; items: MdItem[] }
  | { k: 'quote'; line: number; children: MdBlock[] }
  | { k: 'hr'; line: number }
  | { k: 'table'; line: number; align: MdAlign[]; header: MdInline[][]; rows: MdInline[][][] }

/** 문서를 한 번 훑어 만드는 줄 시작 offset 표. lineAt 이 이진탐색한다 */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

interface Ctx {
  text: string
  starts: number[]
}

/** 인라인 순회에서 건너뛰는 구분자 노드들. 이들은 원문에 글자로 남아 있지만 화면에는 나오지 않는다
 *  (`*`, `` ` ``, `~~`, `#`, `>`, `-`, `[ ]`) */
const INLINE_SKIP = new Set([
  'EmphasisMark', 'CodeMark', 'StrikethroughMark', 'HeaderMark', 'QuoteMark', 'ListMark',
  'TaskMarker', 'CodeInfo', 'TableDelimiter', 'Comment', 'ProcessingInstruction'
])

function pushText(out: MdInline[], text: string): void {
  if (!text) return
  const last = out[out.length - 1]
  // 인접한 텍스트를 합친다 — 이스케이프와 개행 처리가 조각을 여럿 만들기 때문
  if (last && last.k === 'text') last.text += text
  else out.push({ k: 'text', text })
}

/** 앞뒤 텍스트 노드의 공백을 다듬고 빈 텍스트를 버린다. 제목과 링크 본문이 쓴다 */
function trimEnds(nodes: MdInline[]): MdInline[] {
  const out = [...nodes]
  const first = out[0]
  if (first && first.k === 'text') out[0] = { k: 'text', text: first.text.replace(/^\s+/, '') }
  // 첫 항목을 갈아치운 **뒤에** 마지막을 읽는다 — 항목이 하나뿐일 때 앞 다듬기가 덮이지 않게
  const lastIdx = out.length - 1
  const last = out[lastIdx]
  if (last && last.k === 'text') out[lastIdx] = { k: 'text', text: last.text.replace(/\s+$/, '') }
  return out.filter((n) => !(n.k === 'text' && n.text === ''))
}

/** 노드의 자식들을 인라인 목록으로 만든다. 자식 사이의 빈 구간은 평문이다.
 *
 *  **limit 이 왜 필요한가**: 이 함수는 자식 노드 *사이*의 원문을 평문으로 취한다. 그래서 범위를
 *  주지 않으면 `# one` 의 `#` 뒤 공백과 `[a](url "t")` 의 URL·제목 사이 공백이 본문에 섞인다.
 *  화면에 나오는 구간만 넘기는 것이 유일한 해법이다 — 마크 노드를 건너뛰는 것으로는 부족하다.
 *
 *  **limit 의 전제**: lo·hi 는 반드시 형제 노드의 경계에 떨어져야 한다. 경계를 걸치는 자식은
 *  잘라내지 않고 통째로 포함한다 — `c.to <= lo || c.from >= hi` 는 완전히 밖에 있는 자식만
 *  걸러내지, 걸친 자식을 자르지는 않는다. 지금은 이 조건이 항상 지켜진다(제목의 HeaderMark, Task 3
 *  의 링크 경계 모두 형제 사이 틈에 놓인다). 어긋나는 limit 을 넘기면 자식이 그대로 새어 나온다.
 *
 *  Task 3 이 Link/Image 갈래를, Task 4 가 HTMLTag 갈래를 여기에 더한다. */
function inlineOf(node: SyntaxNode, ctx: Ctx, limit?: { from: number; to: number }): MdInline[] {
  const lo = limit ? limit.from : node.from
  const hi = limit ? limit.to : node.to
  const out: MdInline[] = []
  let pos = lo
  for (let c = node.firstChild; c; c = c.nextSibling) {
    // 범위 밖의 자식은 건너뛴다 — 제목의 `#`, 링크의 URL·제목처럼 화면에 나오지 않는 부분이다
    if (c.to <= lo || c.from >= hi) continue
    if (c.from > pos) pushText(out, ctx.text.slice(pos, c.from))
    pos = c.to
    switch (c.name) {
      case 'StrongEmphasis':
        out.push({ k: 'strong', children: inlineOf(c, ctx) })
        break
      case 'Emphasis':
        out.push({ k: 'em', children: inlineOf(c, ctx) })
        break
      case 'Strikethrough':
        out.push({ k: 'del', children: inlineOf(c, ctx) })
        break
      case 'InlineCode': {
        // CodeMark 자식(백틱)을 벗겨 낸 안쪽만 취한다
        const first = c.firstChild
        const last = c.lastChild
        const from = first && first.name === 'CodeMark' ? first.to : c.from
        const to = last && last.name === 'CodeMark' ? last.from : c.to
        out.push({ k: 'code', text: ctx.text.slice(from, to) })
        break
      }
      case 'HardBreak':
        out.push({ k: 'br' })
        break
      case 'Escape':
        // `\*` 는 두 글자 노드다. 백슬래시를 버리고 뒤 글자만 남긴다
        pushText(out, ctx.text.slice(c.from + 1, c.to))
        break
      case 'Entity':
        // &amp; 같은 것. 지금은 원문 그대로 둔다 — 엔티티 표를 들이는 것은 이 범위가 아니다
        pushText(out, ctx.text.slice(c.from, c.to))
        break
      default:
        if (!INLINE_SKIP.has(c.name)) pushText(out, ctx.text.slice(c.from, c.to))
    }
  }
  if (pos < hi) pushText(out, ctx.text.slice(pos, hi))
  return out
}

const ATX = /^ATXHeading([1-6])$/
const SETEXT = /^SetextHeading([12])$/

/** 제목의 본문 인라인. HeaderMark 를 뺀 범위만 넘긴다.
 *
 *  ATX(`# one`, `## two ##`)는 여는 `#` 이 첫 자식이고 닫는 `#` 은 있을 수도 없을 수도 있다.
 *  Setext(`one
===`)는 HeaderMark 가 밑줄이라 본문보다 **뒤**에 온다. 그래서 이름이 아니라
 *  위치로 가른다 — 노드 시작에 붙은 마크가 여는 것이고, 노드 끝에 붙은 마크가 닫는 것이다. */
function headingInline(node: SyntaxNode, ctx: Ctx): MdInline[] {
  const marks = node.getChildren('HeaderMark')
  const opening = marks.find((m) => m.from === node.from)
  const closing = marks.find((m) => m.to === node.to)
  return trimEnds(
    inlineOf(node, ctx, {
      from: opening ? opening.to : node.from,
      to: closing && closing !== opening ? closing.from : node.to
    })
  )
}

/** 펜스/들여쓰기 코드의 본문. CodeText 자식들을 이어붙인 것이 본문이다 — 자식이 없으면(빈 펜스)
 *  빈 문자열이다.
 *
 *  왜 원문을 통째로 슬라이스해 손으로 들여쓰기를 벗기지 않는가: 파서가 이미 그 일을 줄 단위로 해
 *  놓았다. 들여쓰기 코드 블록은 노드 자체가 첫 줄의 필수 4-스페이스 뒤에서 시작하고, 이어지는
 *  줄들은 형제 사이의 "틈"(그 줄의 필수 들여쓰기)이 CodeText 조각 밖으로 빠지면서 각 조각에는
 *  그 줄의 내용만 남는다 — 초과 들여쓰기나 탭도 그 안에 그대로 보존된다. 인용문 안의 펜스도
 *  QuoteMark 가 같은 방식으로 줄마다 CodeText 를 쪼갠다. 그래서 원문을 한 번에 슬라이스해
 *  `{1,4}` 스페이스만 정규식으로 벗기는 방식은 이미 벗겨진 첫 줄을 이중으로 깎고, 탭 들여쓰기와
 *  인용문 안 펜스에서는 벗겨야 할 들여쓰기를 아예 놓친다.
 *
 *  CodeText 는 자기 뒤의 개행을 이미 포함하고 있으므로 이어붙일 때 구분자를 넣지 않는다 —
 *  `'\n'` 으로 이으면 개행이 중복된다. */
function codeText(node: SyntaxNode, ctx: Ctx): string {
  return node.getChildren('CodeText').map((t) => ctx.text.slice(t.from, t.to)).join('')
}

function fenceLang(node: SyntaxNode, ctx: Ctx): LangKey | null {
  const info = node.getChild('CodeInfo')
  return info ? langForFence(ctx.text.slice(info.from, info.to)) : null
}

/** 표의 구분행(`|:--|-:|`)에서 열 정렬을 읽는다.
 *
 *  Table 의 **직접 자식**인 TableDelimiter 가 구분행 전체다. 같은 이름이 TableHeader·TableRow
 *  안에서는 파이프 한 글자로도 쓰이므로, 직접 자식이면서 길이가 1보다 큰 것을 찾는다. */
function tableAlign(table: SyntaxNode, ctx: Ctx): MdAlign[] {
  for (const d of table.getChildren('TableDelimiter')) {
    if (d.to - d.from <= 1) continue
    return ctx.text
      .slice(d.from, d.to)
      .split('|')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const l = s.startsWith(':')
        const r = s.endsWith(':')
        return l && r ? 'center' : l ? 'left' : r ? 'right' : null
      })
  }
  return []
}

function tableCells(row: SyntaxNode, ctx: Ctx): MdInline[][] {
  return row.getChildren('TableCell').map((c) => inlineOf(c, ctx))
}

/** 목록 항목의 체크박스. TaskMarker 는 GFM TaskList 확장이 Task 노드 안에 넣는다 */
function itemTask(item: SyntaxNode, ctx: Ctx): boolean | null {
  const task = item.getChild('Task') ?? item
  const marker = task.getChild('TaskMarker')
  if (!marker) return null
  return /x/i.test(ctx.text.slice(marker.from, marker.to))
}

/** 번호 목록의 시작 번호. ListMark 는 `3.` 또는 `3)` 꼴이다 */
function listStart(list: SyntaxNode, ctx: Ctx): number {
  const first = list.getChild('ListItem')
  const mark = first?.getChild('ListMark')
  if (!mark) return 1
  const n = parseInt(ctx.text.slice(mark.from, mark.to), 10)
  return Number.isFinite(n) ? n : 1
}

/** 한 노드의 자식들을 블록 목록으로 만든다. Document·Blockquote·ListItem 이 모두 이것을 쓴다.
 *
 *  Task 5 가 여기에 문서 수준 HTML 컨테이너 스택을 더한다. */
function blocksOf(parent: SyntaxNode, ctx: Ctx): MdBlock[] {
  const out: MdBlock[] = []
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    const line = lineAt(ctx.starts, c.from)
    const atx = ATX.exec(c.name)
    if (atx) {
      out.push({
        k: 'heading', line, level: Number(atx[1]) as HeadingLevel, inline: headingInline(c, ctx)
      })
      continue
    }
    const setext = SETEXT.exec(c.name)
    if (setext) {
      out.push({
        k: 'heading', line, level: Number(setext[1]) as HeadingLevel, inline: headingInline(c, ctx)
      })
      continue
    }
    switch (c.name) {
      case 'Paragraph':
        out.push({ k: 'para', line, inline: inlineOf(c, ctx) })
        break
      case 'FencedCode':
        out.push({ k: 'code', line, lang: fenceLang(c, ctx), text: codeText(c, ctx) })
        break
      case 'CodeBlock':
        // 들여쓰기 코드 블록. codeText 가 CodeText 조각을 이어붙여 이미 벗겨진 본문을 준다
        out.push({ k: 'code', line, lang: null, text: codeText(c, ctx) })
        break
      case 'BulletList':
      case 'OrderedList': {
        const ordered = c.name === 'OrderedList'
        const items = c.getChildren('ListItem').map((it) => ({
          line: lineAt(ctx.starts, it.from),
          task: itemTask(it, ctx),
          children: blocksOf(it, ctx)
        }))
        out.push({ k: 'list', line, ordered, start: ordered ? listStart(c, ctx) : 1, items })
        break
      }
      case 'Blockquote':
        out.push({ k: 'quote', line, children: blocksOf(c, ctx) })
        break
      case 'HorizontalRule':
        out.push({ k: 'hr', line })
        break
      case 'Table': {
        const header = c.getChild('TableHeader')
        out.push({
          k: 'table',
          line,
          align: tableAlign(c, ctx),
          header: header ? tableCells(header, ctx) : [],
          rows: c.getChildren('TableRow').map((r) => tableCells(r, ctx))
        })
        break
      }
      default:
        // LinkReference 정의(Task 3), HTMLBlock(Task 5), 그리고 공백류. 여기서는 버린다
        break
    }
  }
  return out
}

/** 마크다운 원문을 블록 목록으로 바꾼다. 입력은 LF 여야 한다 */
export function parseMarkdown(text: string): MdBlock[] {
  const ctx: Ctx = { text, starts: lineStarts(text) }
  return blocksOf(mdParser.parse(text).topNode, ctx)
}
