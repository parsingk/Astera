import { describe, it, expect } from 'vitest'
import { parseMarkdown, type MdBlock, type MdInline } from './markdownTree'

/** 인라인을 평문으로 되돌린다 — 구조가 아니라 텍스트만 볼 때 쓴다 */
function plain(inline: MdInline[]): string {
  return inline
    .map((n) => {
      switch (n.k) {
        case 'text': return n.text
        case 'code': return n.text
        case 'br': return '\n'
        case 'strong': case 'em': case 'del': return plain(n.children)
        default: return ''
      }
    })
    .join('')
}

describe('제목', () => {
  it('ATX 제목의 수준과 줄번호를 읽는다', () => {
    const b = parseMarkdown('# one\n\n### three\n')
    expect(b).toHaveLength(2)
    expect(b[0]).toMatchObject({ k: 'heading', level: 1, line: 0 })
    expect(b[1]).toMatchObject({ k: 'heading', level: 3, line: 2 })
    expect(plain((b[0] as Extract<MdBlock, { k: 'heading' }>).inline)).toBe('one')
  })
  it('Setext 제목도 1·2 수준으로 읽는다', () => {
    const b = parseMarkdown('one\n===\n\ntwo\n---\n')
    expect(b[0]).toMatchObject({ k: 'heading', level: 1 })
    expect(b[1]).toMatchObject({ k: 'heading', level: 2 })
  })
})

describe('문단과 인라인', () => {
  it('강조·굵게·취소선·인라인코드를 중첩까지 읽는다', () => {
    const b = parseMarkdown('a *b* c **d** e ~~f~~ g `h`\n')
    const p = b[0] as Extract<MdBlock, { k: 'para' }>
    expect(p.k).toBe('para')
    expect(p.inline.map((n) => n.k)).toEqual([
      'text', 'em', 'text', 'strong', 'text', 'del', 'text', 'code'
    ])
    expect(plain(p.inline)).toBe('a b c d e f g h')
  })
  it('강조 안의 굵게가 중첩으로 남는다', () => {
    const b = parseMarkdown('*a **b** c*\n')
    const p = b[0] as Extract<MdBlock, { k: 'para' }>
    const em = p.inline[0] as Extract<MdInline, { k: 'em' }>
    expect(em.k).toBe('em')
    expect(em.children.map((n) => n.k)).toEqual(['text', 'strong', 'text'])
  })
  it('두 칸 공백 줄바꿈은 br 이 된다', () => {
    const b = parseMarkdown('a  \nb\n')
    const p = b[0] as Extract<MdBlock, { k: 'para' }>
    expect(p.inline.some((n) => n.k === 'br')).toBe(true)
  })
  it('이스케이프된 문자는 그 문자 그대로 남는다', () => {
    const b = parseMarkdown('a \\*b\\* c\n')
    expect(plain((b[0] as Extract<MdBlock, { k: 'para' }>).inline)).toBe('a *b* c')
  })
})

describe('코드 블록', () => {
  it('펜스의 언어와 본문을 읽고 info 는 본문에서 빠진다', () => {
    const b = parseMarkdown('```ts\nconst a = 1\n```\n')
    expect(b[0]).toMatchObject({ k: 'code', lang: 'javascript', line: 0 })
    expect((b[0] as Extract<MdBlock, { k: 'code' }>).text).toBe('const a = 1')
  })
  it('info 가 없으면 lang 은 null', () => {
    const b = parseMarkdown('```\nplain\n```\n')
    expect(b[0]).toMatchObject({ k: 'code', lang: null, text: 'plain' })
  })
  it('빈 펜스도 code 블록이다', () => {
    const b = parseMarkdown('```\n```\n')
    expect(b[0]).toMatchObject({ k: 'code', text: '' })
  })
  it('들여쓰기 코드 블록도 읽는다', () => {
    const b = parseMarkdown('    indented\n')
    expect(b[0]).toMatchObject({ k: 'code', lang: null, text: 'indented' })
  })
})

describe('목록', () => {
  it('글머리 목록의 항목을 읽는다', () => {
    const b = parseMarkdown('- a\n- b\n')
    const l = b[0] as Extract<MdBlock, { k: 'list' }>
    expect(l).toMatchObject({ k: 'list', ordered: false, line: 0 })
    expect(l.items).toHaveLength(2)
    expect(l.items[1].line).toBe(1)
  })
  it('번호 목록의 시작 번호를 읽는다', () => {
    const b = parseMarkdown('3. a\n4. b\n')
    expect(b[0]).toMatchObject({ k: 'list', ordered: true, start: 3 })
  })
  it('중첩 목록이 항목의 자식으로 들어간다', () => {
    const b = parseMarkdown('- a\n  - b\n')
    const l = b[0] as Extract<MdBlock, { k: 'list' }>
    const inner = l.items[0].children.find((c) => c.k === 'list')
    expect(inner).toBeDefined()
    expect((inner as Extract<MdBlock, { k: 'list' }>).items).toHaveLength(1)
  })
  it('체크박스를 task 로 읽고, 없으면 null', () => {
    const b = parseMarkdown('- [ ] a\n- [x] b\n- c\n')
    const l = b[0] as Extract<MdBlock, { k: 'list' }>
    expect(l.items.map((i) => i.task)).toEqual([false, true, null])
  })
})

describe('인용', () => {
  it('인용 안의 블록이 children 으로 들어간다', () => {
    const b = parseMarkdown('> # h\n>\n> p\n')
    const q = b[0] as Extract<MdBlock, { k: 'quote' }>
    expect(q.k).toBe('quote')
    expect(q.children.map((c) => c.k)).toEqual(['heading', 'para'])
  })
  it('중첩 인용도 읽는다', () => {
    const b = parseMarkdown('> > deep\n')
    const q = b[0] as Extract<MdBlock, { k: 'quote' }>
    expect(q.children[0].k).toBe('quote')
  })
})

describe('수평선', () => {
  it('hr 로 읽는다', () => {
    const b = parseMarkdown('a\n\n---\n\nb\n')
    expect(b.map((x) => x.k)).toEqual(['para', 'hr', 'para'])
  })
})

describe('표 (GFM)', () => {
  it('머리행·본문행·열 정렬을 읽는다', () => {
    const md = '| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n'
    const t = parseMarkdown(md)[0] as Extract<MdBlock, { k: 'table' }>
    expect(t.k).toBe('table')
    expect(t.align).toEqual(['left', 'center', 'right'])
    expect(t.header.map(plain)).toEqual(['a', 'b', 'c'])
    expect(t.rows).toHaveLength(2)
    expect(t.rows[0].map(plain)).toEqual(['1', '2', '3'])
  })
  it('정렬 표시가 없는 열은 null', () => {
    const t = parseMarkdown('| a |\n|---|\n| 1 |\n')[0] as Extract<MdBlock, { k: 'table' }>
    expect(t.align).toEqual([null])
  })
})

describe('줄번호', () => {
  it('모든 블록이 0-기반 원문 줄번호를 가진다', () => {
    const b = parseMarkdown('# a\n\np\n\n- l\n')
    expect(b.map((x) => x.line)).toEqual([0, 2, 4])
  })
  // 입력이 LF 라는 전제를 고정한다. App 은 버퍼를 toLf 로 정규화해 들고 있다 (edit.ts).
  // 그 전제가 깨지면 CRLF 파일의 줄번호가 전부 어긋나고 스크롤 동기화가 조용히 틀어진다.
  it('CRLF 를 LF 로 정규화해 넘기면 줄번호가 같다', () => {
    const crlf = '# a\r\n\r\np\r\n'
    const lf = crlf.replace(/\r\n?/g, '\n')
    expect(parseMarkdown(lf).map((x) => x.line)).toEqual([0, 2])
  })
})

describe('빈 입력', () => {
  it('빈 문서는 빈 배열', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n\n')).toEqual([])
  })
})
