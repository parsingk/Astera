import { describe, it, expect } from 'vitest'
import { isSlackReady, slackMode } from './ready'

describe('slackMode', () => {
  it('botToken+channelId면 봇 경로 — webhookUrl이 함께 있어도 봇이 우선이다', () => {
    expect(slackMode({ webhookUrl: 'https://hooks/x', botToken: 'xoxb-1', channelId: 'C1' })).toBe('bot')
  })

  it('봇 조건이 채널 미기재로 걸리면 webhook으로 떨어진다 (applyConfig의 폴백과 동일)', () => {
    expect(slackMode({ webhookUrl: 'https://hooks/x', botToken: 'xoxb-1', channelId: null })).toBe(
      'webhook'
    )
  })

  it('webhookUrl만 있으면 webhook', () => {
    expect(slackMode({ webhookUrl: 'https://hooks/x', botToken: null, channelId: null })).toBe('webhook')
  })

  it('전송 경로가 하나도 없으면 off', () => {
    expect(slackMode({ webhookUrl: null, botToken: 'xoxb-1', channelId: null })).toBe('off')
    expect(slackMode({ webhookUrl: null, botToken: null, channelId: 'C1' })).toBe('off')
    expect(slackMode({ webhookUrl: null, botToken: null, channelId: null })).toBe('off')
  })
})

describe('isSlackReady', () => {
  it('botToken+channelId만 있어도 준비된 것으로 본다 (봇 전용 설정)', () => {
    expect(isSlackReady({ webhookUrl: null, botToken: 'xoxb-1', channelId: 'C1' })).toBe(true)
  })

  it('webhookUrl만 있어도 준비된 것으로 본다 (기존 동작 유지)', () => {
    expect(isSlackReady({ webhookUrl: 'https://hooks.slack.com/x', botToken: null, channelId: null })).toBe(
      true
    )
  })

  it('botToken만 있고 channelId가 없으면 준비되지 않은 것으로 본다 (applyConfig의 webhook 폴백과 동일)', () => {
    expect(isSlackReady({ webhookUrl: null, botToken: 'xoxb-1', channelId: null })).toBe(false)
  })

  it('channelId만 있고 botToken이 없으면 준비되지 않은 것으로 본다', () => {
    expect(isSlackReady({ webhookUrl: null, botToken: null, channelId: 'C1' })).toBe(false)
  })

  it('셋 다 없으면 준비되지 않은 것으로 본다', () => {
    expect(isSlackReady({ webhookUrl: null, botToken: null, channelId: null })).toBe(false)
  })
})
