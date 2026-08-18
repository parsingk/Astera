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
  it('정의의 꺾쇠 목적지도 벗겨서 판정한다 — 허용 스킴이면 외부 링크', () => {
    const md = '[a][b]\n\n[b]: <https://c.com> "t"\n'
    const p = parseMarkdown(md)[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline[0] as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('https://c.com')
    expect(link.title).toBe('t')
    expect(classifyHref(link.href)).toEqual({ kind: 'external', url: 'https://c.com' })
  })
  it('정의의 꺾쇠 목적지가 허용되지 않는 스킴이면 링크를 만들지 않는다', () => {
    const md = '[a][b]\n\n[b]: <file:///C:/secret.txt>\n'
    const p = parseMarkdown(md)[0] as Extract<MdBlock, { k: 'para' }>
    expect(p.inline.every((n) => n.k !== 'link')).toBe(true)
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

describe('링크 표시부의 자동링크가 목적지를 가리지 않는다', () => {
  it('표시부의 www. 자동링크가 진짜 목적지 대신 쓰이지 않는다', () => {
    const p = parseMarkdown('[www.paypal.com](https://evil.example/phish)\n')[0] as Extract<
      MdBlock, { k: 'para' }
    >
    const link = p.inline[0] as Extract<MdInline, { k: 'link' }>
    expect(link.k).toBe('link')
    expect(link.href).toBe('https://evil.example/phish')
    expect(plain(link.children)).toBe('www.paypal.com')
    // 링크 안에 링크가 없다 — <a> 안에 <a> 가 들어가는 잘못된 구조를 만들지 않는다
    expect(link.children.every((n) => n.k !== 'link')).toBe(true)
  })
  it('표시부의 맨 URL 자동링크도 목적지를 가리지 않는다', () => {
    const p = parseMarkdown('[see https://a.com](https://b.com)\n')[0] as Extract<
      MdBlock, { k: 'para' }
    >
    const link = p.inline[0] as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('https://b.com')
    expect(link.children.every((n) => n.k !== 'link')).toBe(true)
    // unwrapLinks 가 펼치면서 인접 텍스트도 합친다 — 'see '와 펼쳐진 'https://a.com'가
    // 두 개의 형제 텍스트 노드로 남지 않고 하나로 합쳐진다(pushText 가 지키는 불변식과 동일)
    expect(link.children).toEqual([{ k: 'text', text: 'see https://a.com' }])
  })
  it('표시부의 이메일 자동링크도 목적지를 가리지 않는다', () => {
    const p = parseMarkdown('[mail me@b.com](./local.md)\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline[0] as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('./local.md')
    expect(link.children.every((n) => n.k !== 'link')).toBe(true)
  })
})

describe('자동링크의 www. 판정이 이메일 판정보다 먼저다', () => {
  it('경로에 @ 가 있는 www. 링크(유튜브 손잡이)를 mailto 로 잘못 묶지 않는다', () => {
    const p = parseMarkdown('see www.youtube.com/@chan now\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline.find((n) => n.k === 'link') as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('http://www.youtube.com/@chan')
  })
  it('경로에 @ 가 있는 www. 링크(마스토돈 손잡이)도 마찬가지다', () => {
    const p = parseMarkdown('see www.mastodon.social/@alice now\n')[0] as Extract<
      MdBlock, { k: 'para' }
    >
    const link = p.inline.find((n) => n.k === 'link') as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('http://www.mastodon.social/@alice')
  })
  it('조각(#) 뒤에 @ 가 있는 www. 링크도 마찬가지다', () => {
    const p = parseMarkdown('see www.a.com/#@x now\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline.find((n) => n.k === 'link') as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('http://www.a.com/#@x')
  })
  it('이미 스킴이 있는 이메일형 자동링크(mailto:a@b.com)는 스킴을 겹쳐 붙이지 않는다', () => {
    // autolinkHref 가 www. 를 먼저 보고 나서도 이미 스킴이 있는 경우를 또 걸러야 한다는 회귀
    // 가드 — `@` 앞에 `:` 가 있으면 GFM 이 스킴까지 통째로 묶어준 것이니 다시 붙이지 않는다
    const p = parseMarkdown('send mailto:a@b.com now\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline.find((n) => n.k === 'link') as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('mailto:a@b.com')
  })
  it('www.a.com?x=1@2 — 쿼리 문자열은 리터럴 URL 매칭에서 빠진다(실제 파서 동작을 고정한다)', () => {
    // 실제 트리 덤프로 확인: URL 노드는 "www.a.com" 까지만이고 "?x=1@2" 는 노드 밖의 평문이다.
    // 그래서 이 입력은 www./이메일 판정 순서 버그를 실제로는 겪지 않는다 — @ 가 URL 노드 안에
    // 들어 있지 않기 때문이다. 여기서는 그 실제 동작을 고정한다: 링크는 "www.a.com" 만 갖고,
    // 뒤에 남은 "?x=1@2" 는 잘리거나 삼켜지지 않은 평문으로 남는다.
    const p = parseMarkdown('see www.a.com?x=1@2 now\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline.find((n) => n.k === 'link') as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('http://www.a.com')
    expect(plain(link.children)).toBe('www.a.com')
    const trailingText = p.inline
      .filter((n): n is Extract<MdInline, { k: 'text' }> => n.k === 'text')
      .map((n) => n.text)
      .join('')
    expect(trailingText).toContain('?x=1@2')
  })
})

describe('GFM 리터럴 URL 이 userinfo 만 떼어 잡을 때는 링크를 만들지 않는다', () => {
  // @lezer/markdown 이 `scheme://user@host` 꼴에서 스킴+`://` 를 평문으로 남기고 이메일 규칙으로
  // `user@host` 만 URL 노드로 잡는다(GFM 스펙과 다른 동작, 실제 트리 덤프로 확인 — 이 파일의
  // 문제가 아니다). 이걸 그대로 mailto: 로 링크화하면 "host" 라는 잘못된 수신자로 메일을 보내는
  // 링크가 생긴다 — 링크를 아예 안 만드는 쪽을 택한다(리뷰 결정).
  it('https://user@host.com/path — 스킴+userinfo 오분할은 링크를 만들지 않고 원문을 그대로 남긴다', () => {
    const p = parseMarkdown('see https://user@host.com/path now\n')[0] as Extract<
      MdBlock, { k: 'para' }
    >
    expect(p.inline.every((n) => n.k !== 'link')).toBe(true)
    expect(plain(p.inline)).toBe('see https://user@host.com/path now')
  })
  it('git 스타일 URL(https://me@github.com/a/b.git)도 마찬가지다', () => {
    const p = parseMarkdown('run https://me@github.com/a/b.git now\n')[0] as Extract<
      MdBlock, { k: 'para' }
    >
    expect(p.inline.every((n) => n.k !== 'link')).toBe(true)
    expect(plain(p.inline)).toBe('run https://me@github.com/a/b.git now')
  })
  it('@ 가 없는 보통 https 자동링크는 앞에 스킴이 없으므로 그대로 링크가 된다(회귀 가드)', () => {
    const p = parseMarkdown('see https://host.com/path now\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline.find((n) => n.k === 'link') as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('https://host.com/path')
  })
  // 'mail me@b.com now' → mailto:me@b.com 유지 회귀는 '자동링크의 암시 스킴' describe 의
  // 기존 테스트가 이미 지킨다 — 앞에 스킴+`://` 가 없으니 이 새 검사가 끼어들지 않는다.
})

describe('꺾쇠로 감싼 링크 목적지', () => {
  it('허용 스킴이면 꺾쇠를 벗기고 외부 링크로 만든다', () => {
    const p = parseMarkdown('[a](<https://b.com>)\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline[0] as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('https://b.com')
    expect(classifyHref(link.href)).toEqual({ kind: 'external', url: 'https://b.com' })
  })
  it('허용되지 않는 스킴이면 꺾쇠에 숨어도 링크를 만들지 않는다', () => {
    const p = parseMarkdown('[a](<file:///C:/secret.txt>)\n')[0] as Extract<MdBlock, { k: 'para' }>
    expect(p.inline.every((n) => n.k !== 'link')).toBe(true)
  })
  it('공백이 든 상대경로(표준 꺾쇠 표기)는 꺾쇠를 벗긴 파일 경로가 된다', () => {
    const p = parseMarkdown('[a](<b c.md>)\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline[0] as Extract<MdInline, { k: 'link' }>
    expect(link.href).toBe('b c.md')
    expect(classifyHref(link.href)).toEqual({ kind: 'file', path: 'b c.md' })
  })
})

describe('참조링크 정의가 중복되면 첫 정의가 이긴다', () => {
  it('같은 라벨을 뒤에서 다시 정의해도 무시한다', () => {
    const md = '[a][b]\n\n[b]: https://c.com "t"\n[b]: https://evil.example\n'
    const p = parseMarkdown(md)[0] as Extract<MdBlock, { k: 'para' }>
    expect(p.inline[0]).toMatchObject({ k: 'link', href: 'https://c.com', title: 't' })
  })
})

describe('프로토콜-상대 URL 과 UNC 경로는 링크가 되지 않는다', () => {
  it('// 로 시작하면 null', () => {
    expect(classifyHref('//evil.example/x')).toBe(null)
  })
  it('\\\\ 로 시작하면 null (UNC 경로)', () => {
    expect(classifyHref('\\\\host\\share')).toBe(null)
  })
  it('구분자가 세 개 이상이어도 null', () => {
    expect(classifyHref('///evil.example/x')).toBe(null)
  })
  it('슬래시·백슬래시가 섞여도 null — startsWith 두 번으로는 못 잡는 변형', () => {
    expect(classifyHref('/\\evil.example/x')).toBe(null)
    expect(classifyHref('\\/evil.example/x')).toBe(null)
  })
  it('맨 앞 제어문자로 이 검사를 피해가지 못한다', () => {
    // trim() 은 공백만 지우고 제어문자는 그대로 둔다 — probe(스킴 판정과 같은 것)로 검사해야
    // \u0001 처럼 앞에 붙은 제어문자를 뚫고 // 를 잡아낼 수 있다
    expect(classifyHref('\u0001//evil.example/x')).toBe(null)
  })
  it('Windows 드라이브 경로는 여전히 null', () => {
    expect(classifyHref('C:\\Windows')).toBe(null)
    expect(classifyHref('c:/x')).toBe(null)
  })
  it('맨 앞 구분자가 하나뿐이면 여전히 파일 경로다 — 지나치게 넓히지 않았다', () => {
    expect(classifyHref('/etc/passwd')).toEqual({ kind: 'file', path: '/etc/passwd' })
    expect(classifyHref('./a.md')).toEqual({ kind: 'file', path: './a.md' })
    expect(classifyHref('docs/d.md')).toEqual({ kind: 'file', path: 'docs/d.md' })
  })
})

describe('빈 표시부', () => {
  it('표시부가 없는 링크는 빈 텍스트 노드를 만들지 않는다', () => {
    const p = parseMarkdown('[](https://a.com)\n')[0] as Extract<MdBlock, { k: 'para' }>
    const link = p.inline[0] as Extract<MdInline, { k: 'link' }>
    expect(link.k).toBe('link')
    expect(link.children).toEqual([])
  })
})

import { lexHtml, policyFor } from './markdownTree'

describe('policyFor', () => {
  it('통과 목록의 태그는 allow', () => {
    for (const tag of ['div', 'span', 'a', 'img', 'details', 'summary', 'kbd', 'sub', 'h3', 'td'])
      expect(policyFor(tag)).toBe('allow')
  })
  it('위험 태그는 drop', () => {
    for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'input'])
      expect(policyFor(tag)).toBe('drop')
  })
  it('그 밖은 unwrap', () => {
    expect(policyFor('picture')).toBe('unwrap')
    expect(policyFor('source')).toBe('unwrap')
    expect(policyFor('marquee')).toBe('unwrap')
  })
  it('대소문자를 무시한다', () => {
    expect(policyFor('DIV')).toBe('allow')
    expect(policyFor('ScRiPt')).toBe('drop')
  })
})

describe('lexHtml', () => {
  it('여는 태그·닫는 태그·자체 종결을 구분한다', () => {
    expect(lexHtml('<div>x</div>')).toEqual([
      { t: 'open', tag: 'div', attrs: {} },
      { t: 'text', text: 'x' },
      { t: 'close', tag: 'div', attrs: {} }
    ])
    expect(lexHtml('<br/>')).toEqual([{ t: 'self', tag: 'br', attrs: {} }])
    // void 요소는 슬래시가 없어도 자체 종결이다
    expect(lexHtml('<br>')).toEqual([{ t: 'self', tag: 'br', attrs: {} }])
    expect(lexHtml('<img src="a.png">')).toEqual([
      { t: 'self', tag: 'img', attrs: { src: 'a.png' } }
    ])
  })
  it('허용 속성만 남긴다', () => {
    expect(lexHtml('<img src="a.png" alt="b" title="c" width="10" height="20">')[0]).toEqual({
      t: 'self',
      tag: 'img',
      attrs: { src: 'a.png', alt: 'b', title: 'c', style: { width: '10px', height: '20px' } }
    })
  })
  it('style·class·id·on* 을 버린다', () => {
    const tok = lexHtml('<div style="background:url(https://x)" class="c" id="i" onclick="x()">')[0]
    expect(tok).toEqual({ t: 'open', tag: 'div', attrs: {} })
  })
  it('target 을 버린다 — 링크는 항상 외부 브라우저로 열린다', () => {
    const tok = lexHtml('<a href="https://a.com" target="_blank">')[0]
    expect(tok).toEqual({ t: 'open', tag: 'a', attrs: { href: 'https://a.com' } })
  })
  it('align 을 textAlign 스타일로 옮기고 이상한 값은 버린다', () => {
    expect(lexHtml('<div align="center">')[0]).toEqual({
      t: 'open', tag: 'div', attrs: { style: { textAlign: 'center' } }
    })
    expect(lexHtml('<div align="sideways">')[0]).toEqual({ t: 'open', tag: 'div', attrs: {} })
  })
  it('width/height 는 숫자와 퍼센트만 받는다', () => {
    expect(lexHtml('<img width="640">')[0]).toMatchObject({ attrs: { style: { width: '640px' } } })
    expect(lexHtml('<img width="50%">')[0]).toMatchObject({ attrs: { style: { width: '50%' } } })
    expect(lexHtml('<img width="calc(100% - 1px)">')[0]).toEqual({
      t: 'self', tag: 'img', attrs: {}
    })
  })
  it('href 가 허용 스킴이 아니면 버린다', () => {
    expect(lexHtml('<a href="javascript:alert(1)">')[0]).toEqual({
      t: 'open', tag: 'a', attrs: {}
    })
  })
  it('colspan/rowspan/start 는 정수만 받는다', () => {
    expect(lexHtml('<td colspan="2">')[0]).toMatchObject({ attrs: { colspan: '2' } })
    expect(lexHtml('<td colspan="x">')[0]).toEqual({ t: 'open', tag: 'td', attrs: {} })
  })
  it('불리언 속성 open 을 읽는다', () => {
    expect(lexHtml('<details open>')[0]).toEqual({ t: 'open', tag: 'details', attrs: { open: true } })
    expect(lexHtml('<details>')[0]).toEqual({ t: 'open', tag: 'details', attrs: {} })
  })
  it('따옴표 없는 값과 홑따옴표를 모두 읽는다', () => {
    expect(lexHtml("<img src='a.png' width=10>")[0]).toMatchObject({
      attrs: { src: 'a.png', style: { width: '10px' } }
    })
  })
  it('주석과 처리 명령은 버린다', () => {
    expect(lexHtml('<!-- hi -->')).toEqual([])
    expect(lexHtml('<?php echo 1; ?>')).toEqual([])
    expect(lexHtml('a<!-- c -->b')).toEqual([{ t: 'text', text: 'a' }, { t: 'text', text: 'b' }])
  })
  it('태그가 아닌 < 는 텍스트로 남는다', () => {
    expect(lexHtml('a < b')).toEqual([{ t: 'text', text: 'a < b' }])
  })
  it('닫히지 않은 태그는 텍스트로 남는다', () => {
    expect(lexHtml('<div')).toEqual([{ t: 'text', text: '<div' }])
  })
})

describe('인라인 HTML', () => {
  it('통과 태그를 htmlEl 로 만든다', () => {
    const p = parseMarkdown('press <kbd>Ctrl</kbd> now\n')[0] as Extract<MdBlock, { k: 'para' }>
    const el = p.inline.find((n) => n.k === 'htmlEl') as Extract<MdInline, { k: 'htmlEl' }>
    expect(el).toMatchObject({ k: 'htmlEl', tag: 'kbd' })
    expect(plain(el.children)).toBe('Ctrl')
  })
  it('위험 태그는 내용까지 사라진다', () => {
    const p = parseMarkdown('a <script>alert(1)</script> b\n')[0] as Extract<MdBlock, { k: 'para' }>
    expect(plain(p.inline)).not.toContain('alert')
    expect(p.inline.every((n) => n.k !== 'htmlEl')).toBe(true)
  })
  it('모르는 태그는 벗기고 내용은 남긴다', () => {
    const p = parseMarkdown('a <marquee>b</marquee> c\n')[0] as Extract<MdBlock, { k: 'para' }>
    expect(plain(p.inline)).toBe('a b c')
    expect(p.inline.every((n) => n.k !== 'htmlEl')).toBe(true)
  })
  it('인라인 img 를 image 가 아닌 htmlEl 로 만든다', () => {
    // 태그가 한 줄에 단독으로 있으면 CommonMark 의 HTML 블록(type 7)이 되어 Task 5 의 몫으로
    // 빠진다(실제 트리 덤프로 확인: `<img ...>` 한 줄만 있으면 HTMLBlock, `blocksOf` 가 지금은
    // 버린다) — 그래서 같은 줄에 평문을 둘러 인라인 컨텍스트를 강제한다. 의도(인라인 img 는
    // image 가 아니라 htmlEl)는 브리프와 같다.
    const p = parseMarkdown('a <img src="a.png" alt="x"> b\n')[0] as Extract<MdBlock, { k: 'para' }>
    const el = p.inline.find((n) => n.k === 'htmlEl') as Extract<MdInline, { k: 'htmlEl' }>
    expect(el).toMatchObject({ k: 'htmlEl', tag: 'img', attrs: { src: 'a.png', alt: 'x' } })
  })
})
