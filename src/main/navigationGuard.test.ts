import { describe, it, expect } from 'vitest'
import { isOwnDocument } from './navigationGuard'

const DEV_SERVER = 'http://localhost:5173/'
const INDEX_FILE = 'file:///C:/app/out/renderer/index.html'

describe('isOwnDocument — will-navigate 가드가 자기 자신의 문서인지 판별', () => {
  it('개발 서버(ELECTRON_RENDERER_URL)와 같은 출처면 통과한다 — 전체 새로고침 포함', () => {
    expect(isOwnDocument(DEV_SERVER, DEV_SERVER, INDEX_FILE)).toBe(true)
    // 같은 출처의 다른 경로/쿼리 — HMR·풀 리로드 트래픽도 여기 해당
    expect(isOwnDocument('http://localhost:5173/src/main.tsx?t=1', DEV_SERVER, INDEX_FILE)).toBe(true)
  })

  it('개발 서버가 켜져 있을 때 다른 출처는 막는다', () => {
    expect(isOwnDocument('http://evil.example.com', DEV_SERVER, INDEX_FILE)).toBe(false)
    expect(isOwnDocument('https://localhost:5173/', DEV_SERVER, INDEX_FILE)).toBe(false) // 스킴이 달라 출처가 다르다
  })

  it('프로덕션(devServerUrl 없음)에서는 정확히 같은 file:// 문서만 통과한다 — 전체 새로고침 포함', () => {
    expect(isOwnDocument(INDEX_FILE, undefined, INDEX_FILE)).toBe(true)
    expect(isOwnDocument('file:///C:/app/out/renderer/other.html', undefined, INDEX_FILE)).toBe(false)
    expect(isOwnDocument('file:///etc/passwd', undefined, INDEX_FILE)).toBe(false)
  })

  it('프로덕션에서는 file: 이외의 스킴도 자기 문서로 보지 않는다', () => {
    expect(isOwnDocument('https://example.com', undefined, INDEX_FILE)).toBe(false)
  })

  it('개발 서버 분기에서 파싱 자체가 실패하는 url은 예외 없이 false를 돌려준다', () => {
    expect(isOwnDocument('not a url', DEV_SERVER, INDEX_FILE)).toBe(false)
  })
})
