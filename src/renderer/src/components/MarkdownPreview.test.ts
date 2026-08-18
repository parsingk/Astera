import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownPreview } from './MarkdownPreview'

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

describe('MarkdownPreview — 링크 안/밖의 원격 이미지 (Finding 2)', () => {
  it('마크다운 배지([![alt](img)](url))의 원격 이미지는 button 이 아니라 비활성 span 이다', () => {
    const html = renderPreview('[![CI](https://x.example/badge.svg)](https://github.com/x/y/ci.yml)\n')
    expect(html).not.toContain('<button')
    expect(html).toContain('class="md-img-remote"')
    expect(html).toContain('CI')
  })

  // Finding 1 의 block-level <a><img></a> idiom 은 동시에 Finding 2 의 대상이기도 하다 — img 가
  // 원격이면 그 자리에 button 이 아니라 span 이 나와야 한다(안 그러면 a 안의 button 이 되어 클릭이
  // 두 핸들러 모두를 깨워 탭이 두 번 열린다).
  it('block-level <a href><img></a> 의 원격 이미지도 button 이 아니다', () => {
    const md = [
      '<p align="center">',
      '<a href="https://github.com/x/y/actions"><img src="https://img.shields.io/badge.svg" alt="CI"></a>',
      '</p>',
      ''
    ].join('\n')
    const html = renderPreview(md)
    expect(html).not.toContain('<button')
    expect(html).toContain('class="md-img-remote"')
  })

  // 링크 밖의 원격 이미지는 그 자체가 유일한 클릭 대상이므로 여전히 상호작용 가능한 button 이어야
  // 한다 — insideLink 가 항상 false 로 굳어 있지 않은지 지켜본다.
  it('링크 밖의 원격 이미지는 여전히 클릭 가능한 button 이다', () => {
    const html = renderPreview('![CI](https://x.example/badge.svg)\n')
    expect(html).toContain('<button')
    expect(html).toContain('class="md-img-remote"')
  })
})

describe('MarkdownPreview — <img src="mailto:...">', () => {
  // classifyHref 는 mailto: 를 'external' 로 분류한다(링크에는 맞는 판정이다) — 하지만 이미지
  // src 로는 메일 클라이언트를 열 이유가 없다. isRemoteImage 가 http(s) 만 원격 이미지로 보고,
  // 나머지는 LocalImage 로 떨어져(경로로 풀 수 없어 결국 실패 placeholder 로) 끝나야 한다.
  it('메일 클라이언트를 여는 원격 이미지로 취급하지 않는다', () => {
    const html = renderPreview('![x](mailto:a@b.com)\n')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('md-img-remote')
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
