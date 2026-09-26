import { describe, it, expect } from 'vitest'
import { loadSlackSdk } from './slackSdk'
import { hostFeatures } from './features'
import { HOST_FEATURE_SLACK_OWNER } from '../core/host/protocol'

describe('loadSlackSdk (Slack in the Host Task 3, P1)', () => {
  it('builds both constructors from what the imports give, with the API URL seam', async () => {
    const made: unknown[] = []
    class WebClient { constructor(t: string, o: unknown) { made.push(['web', t, o]) } }
    class SocketModeClient { constructor(o: unknown) { made.push(['socket', o]) } }
    const sdk = await loadSlackSdk({
      env: { ASTERA_SLACK_API_URL: 'http://127.0.0.1:9/api/' },
      log: () => {},
      imports: { webApi: async () => ({ WebClient }), socketMode: async () => ({ default: { SocketModeClient } }) }
    })
    sdk!.createPoster('xoxb-t')
    sdk!.createClient('xapp-t')
    expect(made).toEqual([
      ['web', 'xoxb-t', { timeout: 10_000, retryConfig: { retries: 2 }, slackApiUrl: 'http://127.0.0.1:9/api/' }],
      ['socket', { appToken: 'xapp-t', autoReconnectEnabled: false, clientOptions: { slackApiUrl: 'http://127.0.0.1:9/api/' } }]
    ])
  })

  // Review Focus 5.
  it('answers null when an import fails, and the Host then announces no slack-owner', async () => {
    const logs: string[] = []
    const failing = async (): Promise<unknown> => { throw Object.assign(new Error('Cannot find package xoxb-secret'), { name: 'Error', code: 'ERR_MODULE_NOT_FOUND' }) }
    const sdk = await loadSlackSdk({ env: {}, log: (m) => logs.push(m), imports: { webApi: failing, socketMode: failing } })
    expect(sdk).toBeNull()
    expect(logs.join('\n')).toMatch(/does not own Slack/)
    expect(logs.join('\n')).not.toMatch(/xoxb-secret/) // the name only, never the message
    expect(hostFeatures({ spawns: true, slack: sdk !== null })).not.toContain(HOST_FEATURE_SLACK_OWNER)
  })

  it('loads the installed SDK for real, and constructing a client sends nothing', async () => {
    const sdk = await loadSlackSdk({ env: {}, log: () => {} })
    expect(typeof sdk?.createPoster('xoxb-test').chat.postMessage).toBe('function')
  })

  // Final review C1: the SDK's own reconnect drops its promise, so a failed one ended the Host.
  it('builds the real socket-mode client with its own reconnect off: SlackInbox reconnects instead', async () => {
    const sdk = await loadSlackSdk({ env: {}, log: () => {} })
    expect((sdk!.createClient('xapp-test') as unknown as { autoReconnectEnabled: boolean }).autoReconnectEnabled).toBe(false)
  })
})
