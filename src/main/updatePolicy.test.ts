import { describe, it, expect, vi } from 'vitest'
import {
  CHECK_INTERVAL_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  compareVersions,
  loadPolicy,
  nextCheckDelayMs,
  parsePolicy,
  parsePolicyUrl,
  shouldApplyCampaign,
  versionMatchesRange
} from './updatePolicy'

describe('parsePolicyUrl — app-update.yml에서 정책 주소', () => {
  const real = `provider: github
owner: parsingk
repo: Astera
updaterCacheDirName: astera-updater
`

  it('실제 app-update.yml 모양에서 owner/repo로 정책 주소를 만든다', () => {
    expect(parsePolicyUrl(real)).toBe(
      'https://github.com/parsingk/Astera/releases/latest/download/policy.json'
    )
  })

  it('owner 줄이 없으면 null', () => {
    expect(parsePolicyUrl('provider: github\nrepo: Astera\n')).toBeNull()
  })

  it('repo 줄이 없으면 null', () => {
    expect(parsePolicyUrl('provider: github\nowner: parsingk\n')).toBeNull()
  })

  it('빈 문자열이면 null', () => {
    expect(parsePolicyUrl('')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('숫자 단위로 비교한다 — 문자열 비교로는 틀리는 지점', () => {
    expect(compareVersions('0.3.9', '0.3.10')).toBeLessThan(0)
    expect(compareVersions('0.3.10', '0.3.9')).toBeGreaterThan(0)
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareVersions('0.3.11', '0.3.11')).toBe(0)
  })

  it('semver 3자리가 아니면 null — 판정 불가', () => {
    expect(compareVersions('0.3', '0.3.11')).toBeNull()
    expect(compareVersions('0.3.11-beta.1', '0.3.11')).toBeNull()
    expect(compareVersions('latest', '0.3.11')).toBeNull()
    expect(compareVersions('0.3.11', '')).toBeNull()
  })
})

describe('versionMatchesRange — 대상 범위 판정 (경계 포함)', () => {
  it('범위 안이면 대상이다', () => {
    expect(versionMatchesRange('1.3.43', { minVersion: '1.3.43', maxVersion: '1.3.43' })).toBe(true)
    expect(versionMatchesRange('0.3.10', { minVersion: '0.3.9', maxVersion: '0.3.11' })).toBe(true)
  })

  it('경계는 포함한다', () => {
    expect(versionMatchesRange('0.3.9', { minVersion: '0.3.9', maxVersion: '0.3.11' })).toBe(true)
    expect(versionMatchesRange('0.3.11', { minVersion: '0.3.9', maxVersion: '0.3.11' })).toBe(true)
  })

  it('범위 밖이면 대상이 아니다', () => {
    expect(versionMatchesRange('0.3.8', { minVersion: '0.3.9', maxVersion: '0.3.11' })).toBe(false)
    expect(versionMatchesRange('0.3.12', { minVersion: '0.3.9', maxVersion: '0.3.11' })).toBe(false)
  })

  it('한쪽만 있으면 그쪽만 본다 — min만 있으면 그 이상 전부, max만 있으면 그 이하 전부', () => {
    expect(versionMatchesRange('9.9.9', { minVersion: '0.3.9' })).toBe(true)
    expect(versionMatchesRange('0.3.8', { minVersion: '0.3.9' })).toBe(false)
    expect(versionMatchesRange('0.0.1', { maxVersion: '0.3.9' })).toBe(true)
    expect(versionMatchesRange('0.4.0', { maxVersion: '0.3.9' })).toBe(false)
  })

  it('형식이 어긋나면 대상이 아니다 — 애매하면 아무 일도 하지 않는다', () => {
    expect(versionMatchesRange('0.3', { minVersion: '0.3.9' })).toBe(false)
    expect(versionMatchesRange('0.3.10', { minVersion: '0.4' })).toBe(false)
  })
})

describe('parsePolicy — 캠페인 스키마', () => {
  it('정상 캠페인', () => {
    expect(parsePolicy('{"id":"upgrade-0.3.9","minVersion":"0.3.9","maxVersion":"0.3.9"}')).toEqual({
      id: 'upgrade-0.3.9',
      minVersion: '0.3.9',
      maxVersion: '0.3.9',
      mode: 'notify'
    })
  })

  it('mode를 생략하면 notify', () => {
    expect(parsePolicy('{"id":"c","maxVersion":"0.3.9"}')?.mode).toBe('notify')
  })

  it('mode: block을 받는다 — 우리만의 확장', () => {
    expect(parsePolicy('{"id":"c","maxVersion":"0.3.9","mode":"block"}')?.mode).toBe('block')
  })

  it('알 수 없는 mode는 notify로 떨어진다 — 오타로 사용자를 막지 않는다', () => {
    expect(parsePolicy('{"id":"c","maxVersion":"0.3.9","mode":"BLOCK"}')?.mode).toBe('notify')
    expect(parsePolicy('{"id":"c","maxVersion":"0.3.9","mode":"kill"}')?.mode).toBe('notify')
    expect(parsePolicy('{"id":"c","maxVersion":"0.3.9","mode":true}')?.mode).toBe('notify')
  })

  it('id가 없거나 비면 캠페인 없음', () => {
    expect(parsePolicy('{"maxVersion":"0.3.9"}')).toBeNull()
    expect(parsePolicy('{"id":"  ","maxVersion":"0.3.9"}')).toBeNull()
    expect(parsePolicy('{"id":42,"maxVersion":"0.3.9"}')).toBeNull()
  })

  it('범위가 아예 없으면 캠페인 없음 — 전원 대상은 사고다', () => {
    expect(parsePolicy('{"id":"c"}')).toBeNull()
    expect(parsePolicy('{"id":"c","mode":"block"}')).toBeNull()
  })

  it('범위가 역전됐으면 캠페인 없음', () => {
    expect(parsePolicy('{"id":"c","minVersion":"0.4.0","maxVersion":"0.3.9"}')).toBeNull()
  })

  it('버전 형식이 어긋나면 캠페인 없음', () => {
    expect(parsePolicy('{"id":"c","maxVersion":"0.3"}')).toBeNull()
    expect(parsePolicy('{"id":"c","maxVersion":"0.3.9-rc.1"}')).toBeNull()
    expect(parsePolicy('{"id":"c","minVersion":311}')).toBeNull()
  })

  it('깨진 JSON·배열·null은 캠페인 없음 — 정책 파일 문제로 앱을 막지 않는다', () => {
    expect(parsePolicy('{id:')).toBeNull()
    expect(parsePolicy('')).toBeNull()
    expect(parsePolicy('[]')).toBeNull()
    expect(parsePolicy('null')).toBeNull()
  })
})

describe('shouldApplyCampaign', () => {
  const campaign = { id: 'c1', minVersion: '0.3.9', maxVersion: '0.3.9', mode: 'notify' as const }

  it('범위 안이고 아직 닫지 않았으면 적용', () => {
    expect(shouldApplyCampaign({ campaign, appVersion: '0.3.9', dismissedId: null })).toBe(true)
  })

  it('사용자가 닫은 캠페인은 다시 적용하지 않는다', () => {
    expect(shouldApplyCampaign({ campaign, appVersion: '0.3.9', dismissedId: 'c1' })).toBe(false)
  })

  it('다른 캠페인을 닫았던 것은 영향이 없다 — 새 캠페인은 다시 뜬다', () => {
    expect(shouldApplyCampaign({ campaign, appVersion: '0.3.9', dismissedId: 'c0' })).toBe(true)
  })

  it('범위 밖이면 적용하지 않는다', () => {
    expect(shouldApplyCampaign({ campaign, appVersion: '0.3.10', dismissedId: null })).toBe(false)
  })

  it('캠페인이 없으면 적용하지 않는다', () => {
    expect(shouldApplyCampaign({ campaign: null, appVersion: '0.3.9', dismissedId: null })).toBe(false)
  })
})

describe('nextCheckDelayMs — 24시간 주기 + 지수 백오프', () => {
  it('성공 직후(실패 0회)는 24시간', () => {
    expect(nextCheckDelayMs(0)).toBe(CHECK_INTERVAL_MS)
    expect(CHECK_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)
  })

  it('실패가 쌓이면 1h → 2h → 4h로 두 배씩', () => {
    expect(nextCheckDelayMs(1)).toBe(RETRY_BASE_MS)
    expect(nextCheckDelayMs(2)).toBe(2 * RETRY_BASE_MS)
    expect(nextCheckDelayMs(3)).toBe(4 * RETRY_BASE_MS)
  })

  it('6시간에서 멈춘다 — 계속 실패하는 피드가 1시간마다 두드리지 않게', () => {
    expect(nextCheckDelayMs(4)).toBe(RETRY_MAX_MS)
    expect(nextCheckDelayMs(10)).toBe(RETRY_MAX_MS)
    expect(RETRY_MAX_MS).toBe(6 * 60 * 60 * 1000)
  })
})

describe('loadPolicy — 실패는 전부 캠페인 없음', () => {
  const url = 'https://github.com/parsingk/Astera/releases/latest/download/policy.json'

  it('200이면 본문을 캠페인으로 파싱한다', async () => {
    const fetchFn = vi.fn(
      async () => new Response('{"id":"c1","maxVersion":"0.3.9"}', { status: 200 })
    ) as unknown as typeof fetch
    expect(await loadPolicy(url, fetchFn)).toEqual({
      id: 'c1',
      maxVersion: '0.3.9',
      mode: 'notify'
    })
    // 공개 릴리스라 자격증명을 싣지 않는다 — 주소만으로 요청한다.
    expect(fetchFn).toHaveBeenCalledWith(url)
  })

  it('404는 캠페인 없음 — 정책 파일이 없는 상태의 자연스러운 표현', async () => {
    const fetchFn = (async () =>
      new Response('Not Found', { status: 404 })) as unknown as typeof fetch
    expect(await loadPolicy(url, fetchFn)).toBeNull()
  })

  it('네트워크 실패(오프라인)는 캠페인 없음', async () => {
    const fetchFn = (async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch
    expect(await loadPolicy(url, fetchFn)).toBeNull()
  })

  it('본문이 깨져도 캠페인 없음', async () => {
    const fetchFn = (async () =>
      new Response('<html>proxy error</html>', { status: 200 })) as unknown as typeof fetch
    expect(await loadPolicy(url, fetchFn)).toBeNull()
  })
})
