import { describe, it, expect } from 'vitest'
import { createWebClient, createSocketClient } from './slackSdk'

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

  it('points both clients at a loopback API URL when the seam says so (P15)', () => {
    const c = createWebClient('xoxb-test', { ASTERA_SLACK_API_URL: 'http://127.0.0.1:9/api/' }) as unknown as { slackApiUrl: string }
    expect(c.slackApiUrl).toBe('http://127.0.0.1:9/api/')
    expect((createWebClient('xoxb-test', {}) as unknown as { slackApiUrl: string }).slackApiUrl).toBe('https://slack.com/api/')
  })
})

describe('createSocketClient', () => {
  // Final review C1: the SDK's own reconnect drops its promise, so a failed one is an unhandled rejection.
  it('turns the SDK reconnect off: SlackInbox reconnects with its own backoff', () => {
    const c = createSocketClient('xapp-test', {}) as unknown as { autoReconnectEnabled: boolean }
    expect(c.autoReconnectEnabled).toBe(false)
  })

  // Reconnect e2e: the SDK's own WebClient retried apps.connections.open 100 times with no ceiling, inside
  // start(), so SlackInbox's capped backoff never ran during an outage.
  it('gives its WebClient no retries of its own and a finite timeout: SlackInbox owns every retry', () => {
    const c = createSocketClient('xapp-test', {}) as unknown as { webClient: { timeout: number; retryConfig: { retries?: number } } }
    expect(c.webClient.retryConfig.retries).toBe(0)
    expect(c.webClient.timeout).toBeGreaterThan(0)
    expect(c.webClient.timeout).toBeLessThanOrEqual(10_000)
  })
})
