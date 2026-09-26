import { describe, it, expect } from 'vitest'
import { slackApiUrlFrom } from './apiUrl'

describe('slackApiUrlFrom (P15)', () => {
  it('honours a loopback URL only, with a trailing slash', () => {
    expect(slackApiUrlFrom({ ASTERA_SLACK_API_URL: 'http://127.0.0.1:4567/api' })).toBe('http://127.0.0.1:4567/api/')
    expect(slackApiUrlFrom({ ASTERA_SLACK_API_URL: 'http://localhost:1/api/' })).toBe('http://localhost:1/api/')
    expect(slackApiUrlFrom({ ASTERA_SLACK_API_URL: 'http://[::1]:1/' })).toBe('http://[::1]:1/')
    for (const v of [undefined, '', 'https://slack.example.com/api/', 'file:///etc/passwd', 'not a url', 'http://127.0.0.2/'])
      expect(slackApiUrlFrom({ ASTERA_SLACK_API_URL: v }), String(v)).toBeUndefined()
  })
})
