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
  it('HTML 주석과 처리 지시어는 화면에 나오지 않고 사라진다', () => {
    const comment = parseMarkdown('a <!-- c --> b\n')
    expect(plain((comment[0] as Extract<MdBlock, { k: 'para' }>).inline)).toBe('a  b')
    const pi = parseMarkdown('a <?pi?> b\n')
    expect(plain((pi[0] as Extract<MdBlock, { k: 'para' }>).inline)).toBe('a  b')
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
  it('필수 들여쓰기를 넘는 여분은 본문에 남는다', () => {
    const b = parseMarkdown('      onlyline\n')
    expect((b[0] as Extract<MdBlock, { k: 'code' }>).text).toBe('  onlyline')
  })
  it('여분 들여쓰기가 있는 줄과 없는 줄이 섞여도 줄마다 맞게 벗긴다', () => {
    const b = parseMarkdown('      first\n    second\n')
    expect((b[0] as Extract<MdBlock, { k: 'code' }>).text).toBe('  first\nsecond')
  })
  it('탭으로 들여쓴 이어지는 줄도 읽는다', () => {
    const b = parseMarkdown('    line one\n\tline two\n')
    expect((b[0] as Extract<MdBlock, { k: 'code' }>).text).toBe('line one\nline two')
  })
  it('들여쓰기 코드 블록 안의 빈 줄이 개행을 중복시키지 않는다', () => {
    const b = parseMarkdown('    a\n\n    b\n')
    expect((b[0] as Extract<MdBlock, { k: 'code' }>).text).toBe('a\n\nb')
  })
  it('여러 줄 펜스 코드도 온전히 읽는다', () => {
    const b = parseMarkdown('```ts\nconst a = 1\nconst b = 2\nconst c = 3\n```\n')
    expect((b[0] as Extract<MdBlock, { k: 'code' }>).text).toBe(
      'const a = 1\nconst b = 2\nconst c = 3'
    )
  })
  it('펜스 코드 안의 빈 줄이 개행을 중복시키지 않는다', () => {
    const b = parseMarkdown('```\na\n\nb\n```\n')
    expect((b[0] as Extract<MdBlock, { k: 'code' }>).text).toBe('a\n\nb')
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
  it('인용 안의 펜스 코드는 QuoteMark 로 쪼개진 줄을 다시 이어붙인다', () => {
    const b = parseMarkdown('> ```\n> a\n> b\n> ```\n')
    const q = b[0] as Extract<MdBlock, { k: 'quote' }>
    const code = q.children[0] as Extract<MdBlock, { k: 'code' }>
    expect(code.k).toBe('code')
    expect(code.text).toBe('a\nb')
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

import { classifyHref } from './markdownTree'

describe('classifyHref', () => {
  it('http/https/mailto 는 외부 링크', () => {
    expect(classifyHref('https://a.com/b')).toEqual({ kind: 'external', url: 'https://a.com/b' })
    expect(classifyHref('http://a.com')).toEqual({ kind: 'external', url: 'http://a.com' })
    expect(classifyHref('mailto:a@b.com')).toEqual({ kind: 'external', url: 'mailto:a@b.com' })
  })
  it('대소문자와 앞뒤 공백을 무시한다', () => {
    expect(classifyHref('  HTTPS://a.com  ')).toEqual({ kind: 'external', url: 'HTTPS://a.com' })
  })
  // innerHTML 을 쓰지 않아도 <a href="javascript:..."> 는 그대로 동작한다. 이 검사가 그것을 막는다
  it('위험한 스킴은 링크를 만들지 않는다', () => {
    for (const raw of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      '  javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'blob:https://a.com/x',
      'about:blank'
    ])
      expect(classifyHref(raw)).toBe(null)
  })
  it('상대경로는 파일 링크', () => {
    expect(classifyHref('./a.md')).toEqual({ kind: 'file', path: './a.md' })
    expect(classifyHref('../b/c.md')).toEqual({ kind: 'file', path: '../b/c.md' })
    expect(classifyHref('docs/d.md')).toEqual({ kind: 'file', path: 'docs/d.md' })
  })
  it('# 로 시작하면 앵커', () => {
    expect(classifyHref('#install')).toEqual({ kind: 'anchor', id: 'install' })
  })
  it('빈 문자열은 링크가 아니다', () => {
    expect(classifyHref('')).toBe(null)
    expect(classifyHref('   ')).toBe(null)
  })
})

describe('링크와 이미지', () => {
  it('인라인 링크의 href·title·본문을 읽는다', () => {
    const p = parseMarkdown('[a](https://b.com "t")\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline[0] as Extract<MdInline, { k: 'link' }>
    expect(link).toMatchObject({ k: 'link', href: 'https://b.com', title: 't' })
    expect(plain(link.children)).toBe('a')
  })
  it('title 이 없으면 null', () => {
    const p = parseMarkdown('[a](https://b.com)\n')[0] as Extract<MdBlock, { k: 'para' }>
    expect((p.inline[0] as Extract<MdInline, { k: 'link' }>).title).toBe(null)
  })
  it('링크 안의 강조가 중첩으로 남는다', () => {
    const p = parseMarkdown('[**a**](https://b.com)\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline[0] as Extract<MdInline, { k: 'link' }>
    expect(link.children[0].k).toBe('strong')
  })
  it('위험한 스킴의 링크는 평문으로 남는다', () => {
    const p = parseMarkdown('[click](javascript:alert(1))\n')[0] as Extract<MdBlock, { k: 'para' }>
    expect(p.inline.every((n) => n.k !== 'link')).toBe(true)
    expect(plain(p.inline)).toContain('click')
  })
  it('이미지의 src·alt·title 을 읽는다', () => {
    const p = parseMarkdown('![alt](a.png "t")\n')[0] as Extract<MdBlock, { k: 'para' }>
    expect(p.inline[0]).toEqual({ k: 'image', src: 'a.png', alt: 'alt', title: 't' })
  })
  it('위험한 스킴의 이미지는 만들지 않는다', () => {
    const p = parseMarkdown('![x](javascript:alert(1))\n')[0] as Extract<MdBlock, { k: 'para' }>
    expect(p.inline.every((n) => n.k !== 'image')).toBe(true)
  })
  it('자동링크를 링크로 만든다', () => {
    const p = parseMarkdown('see https://a.com now\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline.find((n) => n.k === 'link') as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('https://a.com')
  })
})

describe('참조링크', () => {
  it('정의를 찾아 잇는다', () => {
    const md = '[a][b]\n\n[b]: https://c.com "t"\n'
    const p = parseMarkdown(md)[0] as Extract<MdBlock, { k: 'para' }>
    expect(p.inline[0]).toMatchObject({ k: 'link', href: 'https://c.com', title: 't' })
  })
  it('라벨은 대소문자를 무시한다', () => {
    const p = parseMarkdown('[a][B]\n\n[b]: https://c.com\n')[0] as Extract<MdBlock, { k: 'para' }>
    expect(p.inline[0]).toMatchObject({ k: 'link', href: 'https://c.com' })
  })
  it('축약형 [a][] 도 잇는다', () => {
    const p = parseMarkdown('[a][]\n\n[a]: https://c.com\n')[0] as Extract<MdBlock, { k: 'para' }>
    expect(p.inline[0]).toMatchObject({ k: 'link', href: 'https://c.com' })
  })
  it('정의가 없으면 원문 그대로 평문', () => {
    const p = parseMarkdown('[a][missing]\n')[0] as Extract<MdBlock, { k: 'para' }>
    expect(p.inline.every((n) => n.k !== 'link')).toBe(true)
    expect(plain(p.inline)).toBe('[a][missing]')
  })
  it('정의 블록 자체는 화면에 남지 않는다', () => {
    expect(parseMarkdown('[b]: https://c.com\n')).toEqual([])
  })
})

describe('자동링크의 암시 스킴', () => {
  it('맨텍스트 이메일 자동링크는 href 에 mailto: 를 붙인다', () => {
    const p = parseMarkdown('mail me@b.com now\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline.find((n) => n.k === 'link') as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('mailto:me@b.com')
    expect(plain(link.children)).toBe('me@b.com')
  })
  it('각괄호 이메일 자동링크도 마찬가지다', () => {
    const p = parseMarkdown('mail <me@b.com> now\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline.find((n) => n.k === 'link') as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('mailto:me@b.com')
    expect(plain(link.children)).toBe('me@b.com')
  })
  it('www. 자동링크는 href 에 http:// 를 붙인다', () => {
    const p = parseMarkdown('see www.example.com now\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline.find((n) => n.k === 'link') as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('http://www.example.com')
    expect(plain(link.children)).toBe('www.example.com')
  })
  it('이미 스킴이 있는 자동링크는 그대로 둔다', () => {
    const p = parseMarkdown('see https://a.com now\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline.find((n) => n.k === 'link') as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('https://a.com')
    expect(plain(link.children)).toBe('https://a.com')
  })
  it('classifyHref 단독 호출은 스킴을 추론하지 않는다 — 추정은 자동링크 갈래에만 머문다', () => {
    expect(classifyHref('me@b.com')).toEqual({ kind: 'file', path: 'me@b.com' })
  })
})
