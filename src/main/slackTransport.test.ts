import { describe, it, expect } from 'vitest'
import {
  WebhookTransport,
  SlackPostError,
  BotTransport,
  createWebClient,
  type SlackPoster
} from './slackTransport'

describe('WebhookTransport', () => {
  it('텍스트를 webhook URL로 POST한다', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return { ok: true, status: 200 } as Response
    }) as unknown as typeof fetch
    const t = new WebhookTransport('https://hooks.slack.com/services/T/B/x', fetchFn)

    const ts = await t.post('안녕')

    expect(calls).toEqual([
      { url: 'https://hooks.slack.com/services/T/B/x', body: { text: '안녕' } }
    ])
    expect(ts).toBeNull() // webhook은 메시지 ts를 돌려주지 않는다
    expect(t.supportsThreads).toBe(false)
  })

  it('threadTs를 받아도 무시한다 — webhook은 스레드를 지원하지 않는다', async () => {
    const bodies: unknown[] = []
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return { ok: true, status: 200 } as Response
    }) as unknown as typeof fetch
    const t = new WebhookTransport('https://hooks.slack.com/x', fetchFn)

    await t.post('본문', '1700000000.000100')

    expect(bodies).toEqual([{ text: '본문' }])
  })

  it('non-ok 응답은 SlackPostError로 던진다', async () => {
    const fetchFn = (async () => ({ ok: false, status: 429 }) as Response) as unknown as typeof fetch
    const t = new WebhookTransport('https://hooks.slack.com/x', fetchFn)

    await expect(t.post('x')).rejects.toBeInstanceOf(SlackPostError)
    await expect(t.post('x')).rejects.toMatchObject({ reason: 'status=429' })
  })

  it('fetch 예외는 URL이 새지 않는 reason으로 감싼다', async () => {
    const fetchFn = (async () => {
      throw new TypeError('Failed to parse URL from https://hooks.slack.com/secret')
    }) as unknown as typeof fetch
    const t = new WebhookTransport('https://hooks.slack.com/secret', fetchFn)

    await expect(t.post('x')).rejects.toMatchObject({ reason: 'TypeError' })
  })
})

describe('BotTransport', () => {
  const poster = (
    impl: (a: { channel: string; text: string; thread_ts?: string }) => Promise<{ ok?: boolean; ts?: string }>
  ): { client: SlackPoster; calls: { channel: string; text: string; thread_ts?: string }[] } => {
    const calls: { channel: string; text: string; thread_ts?: string }[] = []
    return {
      calls,
      client: {
        chat: {
          postMessage: async (a) => {
            calls.push(a)
            return impl(a)
          }
        }
      }
    }
  }

  it('채널로 보내고 메시지 ts를 돌려준다', async () => {
    const p = poster(async () => ({ ok: true, ts: '1700000000.000100' }))
    const t = new BotTransport(p.client, 'C123')

    const ts = await t.post('안녕')

    expect(p.calls).toEqual([{ channel: 'C123', text: '안녕' }])
    expect(ts).toBe('1700000000.000100')
    expect(t.supportsThreads).toBe(true)
  })

  it('threadTs를 주면 thread_ts로 실어 보낸다', async () => {
    const p = poster(async () => ({ ok: true, ts: '2' }))
    const t = new BotTransport(p.client, 'C123')

    await t.post('답글', '1700000000.000100')

    expect(p.calls[0]).toEqual({ channel: 'C123', text: '답글', thread_ts: '1700000000.000100' })
  })

  it('ok가 아니면 SlackPostError', async () => {
    const p = poster(async () => ({ ok: false }))
    const t = new BotTransport(p.client, 'C123')

    await expect(t.post('x')).rejects.toBeInstanceOf(SlackPostError)
  })

  it('SDK 예외는 토큰이 새지 않는 reason으로 감싼다', async () => {
    const p = poster(async () => {
      throw new Error('invalid_auth xoxb-secret-token')
    })
    const t = new BotTransport(p.client, 'C123')

    await expect(t.post('x')).rejects.toMatchObject({ reason: 'Error' })
  })

  // WebAPIPlatformError 모양의 가짜 — err.name·err.code·err.data.error를 실제 SDK와 같게 만든다
  // (errors.ts: name = constructor.name, code = ErrorCode.PlatformError, data = { ok, error }).
  class FakePlatformError extends Error {
    code = 'slack_webapi_platform_error'
    constructor(
      public data: { ok: false; error: string },
      message: string
    ) {
      super(message)
      this.name = 'WebAPIPlatformError'
    }
  }

  // t.post()는 항상 거부되어야 하는 시나리오에서만 쓴다 — 성공해버리면 테스트 의도와 다르므로 던진다.
  async function captureRejection(p: Promise<unknown>): Promise<SlackPostError> {
    try {
      await p
    } catch (e) {
      return e as SlackPostError
    }
    throw new Error('expected post() to reject, but it resolved')
  }

  it('플랫폼 오류는 err.code·data.error를 reason에 담아 invalid_auth와 channel_not_found를 구별한다', async () => {
    const authErr = new FakePlatformError({ ok: false, error: 'invalid_auth' }, 'An API error occurred: invalid_auth')
    const channelErr = new FakePlatformError(
      { ok: false, error: 'channel_not_found' },
      'An API error occurred: channel_not_found'
    )

    const t1 = new BotTransport(poster(async () => { throw authErr }).client, 'C123')
    const t2 = new BotTransport(poster(async () => { throw channelErr }).client, 'C123')

    const [e1, e2] = await Promise.all([captureRejection(t1.post('x')), captureRejection(t2.post('x'))])

    expect(e1.reason).toContain('invalid_auth')
    expect(e2.reason).toContain('channel_not_found')
    expect(e1.reason).not.toBe(e2.reason) // 구별 가능해야 진단에 쓸 수 있다
  })

  it('플랫폼 오류의 reason에 err.message(토큰이 섞일 수 있는 자유형식 필드)는 절대 담기지 않는다', async () => {
    const secretToken = 'xoxb-should-not-leak-1234'
    const err = new FakePlatformError(
      { ok: false, error: 'invalid_auth' },
      `An API error occurred while using token ${secretToken}`
    )
    const t = new BotTransport(poster(async () => { throw err }).client, 'C123')

    const caught = await captureRejection(t.post('x'))

    expect(caught.reason).not.toContain(secretToken)
    expect(caught.reason).not.toContain('An API error occurred')
    expect(caught.reason).toContain('invalid_auth') // err.data.error는 비밀이 아니므로 여전히 남는다
  })
})

describe('createWebClient', () => {
  it('SDK 기본값(무제한 타임아웃 + 약 30분간 10회 재시도) 대신 유한한 타임아웃·적은 재시도를 쓴다', () => {
    // WebClient는 생성자에서 받은 timeout·retryConfig를 그대로 인스턴스 필드에 저장한다
    // (compiled WebClient.js: this.timeout = timeout; this.retryConfig = retryConfig). private는
    // TS 컴파일 타임에만 존재하므로 런타임에서 그대로 읽을 수 있다 — 실제 네트워크 호출 없이
    // 구성값만 검증한다.
    const client = createWebClient('xoxb-test') as unknown as {
      timeout: number
      retryConfig: { retries?: number }
    }

    expect(client.timeout).toBeGreaterThan(0) // 0 = 무제한(SDK 기본값) — 루트 게시가 영원히 안 끝날 수 있다
    expect(client.timeout).toBeLessThanOrEqual(10_000)
    expect(client.retryConfig.retries).toBeDefined()
    expect(client.retryConfig.retries as number).toBeLessThanOrEqual(2) // 기본값(10회)보다 확실히 적어야 한다
  })
})
