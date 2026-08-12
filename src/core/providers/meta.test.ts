import { describe, it, expect } from 'vitest'
import { PROVIDERS, PROVIDER_META, providerOf, isProvider, metaOf } from './meta'

describe('provider meta', () => {
  it('PROVIDERS는 claude·codex 둘이다', () => {
    expect(PROVIDERS).toEqual(['claude', 'codex'])
  })

  it('providerOf는 provider 부재를 claude로 본다 (기존 accounts.json 하위 호환)', () => {
    expect(providerOf({})).toBe('claude')
    expect(providerOf({ provider: undefined })).toBe('claude')
    expect(providerOf({ provider: 'codex' })).toBe('codex')
    expect(providerOf({ provider: 'claude' })).toBe('claude')
  })

  it('isProvider는 알 수 없는 값을 거부한다 (unknown 입력을 받는다)', () => {
    expect(isProvider('claude')).toBe(true)
    expect(isProvider('codex')).toBe(true)
    expect(isProvider('gemini')).toBe(false)
    expect(isProvider(undefined)).toBe(false)
    expect(isProvider(null)).toBe(false)
    expect(isProvider(1)).toBe(false)
    expect(isProvider({})).toBe(false)
  })

  it('PROVIDER_META는 모든 provider를 덮고 statusLine 사용 여부가 갈린다', () => {
    for (const p of PROVIDERS) expect(PROVIDER_META[p].id).toBe(p)
    expect(PROVIDER_META.claude.usesStatusLine).toBe(true)
    expect(PROVIDER_META.codex.usesStatusLine).toBe(false)
  })

  it('metaOf는 provider 부재를 claude 메타로 본다', () => {
    expect(metaOf({}).displayName).toBe('Claude')
    expect(metaOf({ provider: 'codex' }).displayName).toBe('Codex')
  })
})
