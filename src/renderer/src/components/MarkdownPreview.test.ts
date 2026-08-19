import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownPreview, sameAbsPath } from './MarkdownPreview'

// MarkdownPreview reaches useI18n() unconditionally (the toolbar-less preview itself has no i18n need
// for most nodes, but LocalImage/RemoteImage do). There is no I18nProvider here — its own effect never
// settles without a real window.api, and even if it did, effects do not run under renderToStaticMarkup.
// Mocking the hook directly is what lets a real MarkdownPreview render happen in a plain Node test, with
// no jsdom and no new dependency (react-dom is already one).
vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'en',
    storedLang: null,
    systemLang: 'en',
    setLang: () => {},
    t: (key: string) => key,
    tm: (msg: unknown) => (msg === null ? null : String(msg))
  })
}))

/** Renders MarkdownPreview for `text` to a static HTML string. renderToStaticMarkup runs real React
 *  reconciliation (hooks included) with no DOM and no effects — plenty for the structural questions these
 *  tests ask (is there an href on this element, is it a <button> or a <span>), and effects never firing
 *  is not a gap for them: LocalImage/RemoteImage's own IPC calls live inside effects and are not what is
 *  under test here. */
function renderPreview(text: string): string {
  return renderToStaticMarkup(
    React.createElement(MarkdownPreview, {
      text,
      docPath: 'C:/doc/README.md',
      onOpenFile: () => {},
      onSave: () => {},
      scrollRef: null
    })
  )
}

describe('MarkdownPreview — raw-HTML <a> (Finding 1)', () => {
  it('인라인 raw-HTML <a href> 는 href 를 지킨다', () => {
    const html = renderPreview('press <a href="https://a.com">here</a> now\n')
    expect(html).toContain('href="https://a.com"')
  })

  // <div align>/<p align> 로 감싼 <a href><img></a> 는 README 에서 가장 흔한 raw-HTML idiom이다.
  // 빈 줄 없이 한 줄짜리 문단 안에 있지 않고 그 자체로 HTML 블록이 되므로(parseMarkdown 으로 직접
  // 확인: <p align> 이 CommonMark type-6 HTML 블록을 시작해 안의 <a>·<img> 도 모두 block-level
  // htmlEl 이 된다) renderBlocks 의 htmlEl 'a' 분기를 탄다 — 고치기 전에는 이 href 가 통째로
  // attrsToProps 에 씹혀 사라졌다(attrsToProps 는 일부러 href 를 옮기지 않는다).
  it('block-level raw-HTML <a href><img></a> 도 href 를 지킨다', () => {
    const md = [
      '<p align="center">',
      '<a href="https://github.com/x/y/actions"><img src="https://img.shields.io/badge.svg" alt="CI"></a>',
      '</p>',
      ''
    ].join('\n')
    const html = renderPreview(md)
    expect(html).toContain('href="https://github.com/x/y/actions"')
  })

  // renderInline·renderBlocks 양쪽 다 href 가 없으면(attrsFor 가 이미 걸러낸 경우) renderHtmlAnchor
  // 가 null 을 돌려주고 일반 Tag 분기로 떨어진다 — <a> 는 여전히 그려지지만 href·onClick 은 없다.
  // 이 낙방 경로가 여전히 동작하는지 지켜본다(회귀 방지).
  it('href 없는 raw-HTML <a> 는 여전히 비활성 엘리먼트로 그려진다', () => {
    const html = renderPreview('<a name="anchor-only">text</a>\n')
    expect(html).not.toContain('href=')
    expect(html).toContain('text')
  })
})

// 원격 이미지는 원래 자리표시로만 그렸다가(문서를 여는 것만으로 외부에 신호가 나가므로) 실제로
// 불러오도록 바꿨다 — README 의 배지 줄이 원격 이미지의 가장 흔한 쓰임이고, 그 자리에 자리표시가
// 늘어선 화면은 고장으로 읽힌다. 아래 세 케이스가 지키는 것은 두 가지다: 실제 <img> 가 나온다는 것,
// 그리고 링크 안이든 밖이든 <button> 이 다시 생기지 않는다는 것 — 링크 안의 button 은 유효하지 않은
// HTML 이고 클릭 한 번에 탭을 두 개 열었던 회귀의 원인이었다.
describe('MarkdownPreview — 원격 이미지', () => {
  it('마크다운 배지([![alt](img)](url))의 원격 이미지를 실제로 불러온다', () => {
    const html = renderPreview('[![CI](https://x.example/badge.svg)](https://github.com/x/y/ci.yml)\n')
    expect(html).toContain('src="https://x.example/badge.svg"')
    expect(html).toContain('alt="CI"')
    expect(html).not.toContain('<button')
    // 감싼 링크는 그대로 살아 있어야 한다 — 배지를 누르면 이미지가 아니라 그 대상으로 간다
    expect(html).toContain('href="https://github.com/x/y/ci.yml"')
  })

  // Finding 1 의 block-level <a><img></a> idiom. 원격 이미지가 그 안에 들어와도 마찬가지다.
  it('block-level <a href><img></a> 안의 원격 이미지도 불러온다', () => {
    const md = [
      '<p align="center">',
      '<a href="https://github.com/x/y/actions"><img src="https://img.shields.io/badge.svg" alt="CI"></a>',
      '</p>',
      ''
    ].join('\n')
    const html = renderPreview(md)
    expect(html).toContain('src="https://img.shields.io/badge.svg"')
    expect(html).not.toContain('<button')
    expect(html).toContain('href="https://github.com/x/y/actions"')
  })

  it('링크 밖의 원격 이미지도 같은 <img> 다', () => {
    const html = renderPreview('![CI](https://x.example/badge.svg)\n')
    expect(html).toContain('src="https://x.example/badge.svg"')
    expect(html).not.toContain('<button')
  })
})

describe('MarkdownPreview — <img src="mailto:...">', () => {
  // classifyHref 는 mailto: 를 'external' 로 분류한다(링크에는 맞는 판정이다) — 하지만 이미지
  // src 로는 메일 클라이언트를 열 이유가 없다. isRemoteImage 가 http(s) 만 원격 이미지로 보고,
  // 나머지는 LocalImage 로 떨어져(경로로 풀 수 없어 결국 실패 placeholder 로) 끝나야 한다.
  it('메일 클라이언트를 여는 원격 이미지로 취급하지 않는다', () => {
    const html = renderPreview('![x](mailto:a@b.com)\n')
    expect(html).not.toContain('<button')
    // mailto: 가 <img src> 로 새지 않는다 — LocalImage 로 떨어져 결국 실패 자리표시가 된다
    expect(html).not.toContain('src="mailto:')
  })
})

describe('sameAbsPath — image cache invalidation key comparability (Finding 2)', () => {
  // resolveImageSrc builds the cache key from the literal text a markdown author typed, never from an
  // on-disk directory listing — while a files:changed path (chokidar, via main's FileWatcher) reflects
  // the actual on-disk entry name. On Windows (and default macOS) those can differ only in case for the
  // exact same file, and a case-sensitive comparison would silently fail to invalidate.
  it('Windows 스타일 경로에서 대소문자만 다르면 같은 파일로 본다', () => {
    expect(sameAbsPath('C:\\proj\\assets\\Diagram.PNG', 'C:\\proj\\assets\\diagram.png')).toBe(true)
  })

  it('POSIX 스타일 경로에서도 대소문자만 다르면 같은 파일로 본다', () => {
    expect(sameAbsPath('/proj/assets/Diagram.PNG', '/proj/assets/diagram.png')).toBe(true)
  })

  it('실제로 다른 파일은 다르게 본다', () => {
    expect(sameAbsPath('C:\\proj\\assets\\a.png', 'C:\\proj\\assets\\b.png')).toBe(false)
  })
})

describe('MarkdownPreview — raw-HTML <table>', () => {
  // 마크다운 문법 표는 이미 .md-table-wrap 으로 감싸져 있다(overflow-x: auto). raw-HTML <table> 도
  // 똑같이 감싸지 않으면 넓은 표가 프리뷰 패널 전체를 가로로 밀어낸다.
  it('.md-table-wrap 으로 감싼다', () => {
    const html = renderPreview('<table><tr><td>a</td></tr></table>\n')
    expect(html).toContain('class="md-table-wrap"')
  })
})
