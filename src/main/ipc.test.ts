import { describe, it, expect } from 'vitest'
import { parseAllowedExternalUrl } from './ipc'

// parseAllowedExternalUrl is the scheme allowlist shared by system.openExternal (the markdown
// preview's external-link IPC) and main/index.ts's setWindowOpenHandler/will-navigate guards — see
// its doc comment in ipc.ts for why the two must not drift apart.
describe('parseAllowedExternalUrl — 외부 URL 스킴 화이트리스트', () => {
  it('http/https/mailto는 통과시키고 파싱된 URL을 돌려준다', () => {
    expect(parseAllowedExternalUrl('http://example.com')?.toString()).toBe('http://example.com/')
    expect(parseAllowedExternalUrl('https://example.com/a?b=c')?.toString()).toBe(
      'https://example.com/a?b=c'
    )
    expect(parseAllowedExternalUrl('mailto:a@b.com')?.toString()).toBe('mailto:a@b.com')
  })

  it('허용 목록 밖의 스킴은 null을 돌려준다 — javascript:/file: 모두', () => {
    expect(parseAllowedExternalUrl('javascript:alert(1)')).toBeNull()
    expect(parseAllowedExternalUrl('file:///etc/passwd')).toBeNull()
    expect(parseAllowedExternalUrl('ftp://example.com')).toBeNull()
  })

  it('파싱 자체가 실패하는 문자열은 예외 없이 null을 돌려준다', () => {
    expect(parseAllowedExternalUrl('not a url')).toBeNull()
    expect(parseAllowedExternalUrl('')).toBeNull()
  })

  it('반환값의 toString()은 검증에 쓴 문자열과 같다 — 원래 url을 그대로 다시 쓰지 않기 위해서', () => {
    // new URL이 탭·개행을 걷어내므로, 걷어낸 결과가 그대로 나와야 한다
    expect(parseAllowedExternalUrl('https://example.com/\t')?.toString()).toBe(
      'https://example.com/'
    )
  })
})
