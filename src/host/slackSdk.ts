// The Slack SDK for the Host (plan ruling P1). Loaded with import(), never imported statically: a static
// import is a top-level require in host.js, and MODULE_NOT_FOUND there is no Host at all on a runtime an
// older build installed. The literal names keep scripts/host-runtime-scan.mjs able to see both packages.
import { WEB_CLIENT_OPTIONS, type SlackPoster } from '../core/slack/transport'
import { SOCKET_WEB_CLIENT_OPTIONS, type SocketClient } from '../core/slack/inbox'
import { slackApiUrlFrom } from '../core/slack/apiUrl'

/** The two constructors the Host's Slack needs, built from the SDK it loaded: the notifier's poster and
 *  the inbox's socket client, the same shapes the app's main/slackSdk.ts gives. */
export interface HostSlackSdk {
  createPoster(token: string): SlackPoster
  createClient(appToken: string): SocketClient
}

/** Loads the SDK once, at start. Null when it cannot, which the Host logs and then runs without Slack
 *  and without `slack-owner`, so the app keeps Slack. Never rejects. `imports` is the test seam. */
export async function loadSlackSdk(a: {
  env: Record<string, string | undefined>
  log(m: string): void
  imports?: { webApi(): Promise<unknown>; socketMode(): Promise<unknown> }
}): Promise<HostSlackSdk | null> {
  const imports = a.imports ?? { webApi: () => import('@slack/web-api'), socketMode: () => import('@slack/socket-mode') }
  try {
    const web = (await imports.webApi()) as { WebClient?: unknown; default?: { WebClient?: unknown } }
    const sock = (await imports.socketMode()) as { SocketModeClient?: unknown; default?: { SocketModeClient?: unknown } }
    const WebClient = (web.WebClient ?? web.default?.WebClient) as (new (t: string, o: object) => SlackPoster) | undefined
    const SocketModeClient = (sock.SocketModeClient ?? sock.default?.SocketModeClient) as (new (o: object) => SocketClient) | undefined
    if (typeof WebClient !== 'function' || typeof SocketModeClient !== 'function') {
      a.log('slack: the SDK loaded without WebClient or SocketModeClient — this Host does not own Slack')
      return null
    }
    const url = slackApiUrlFrom(a.env)
    return {
      createPoster: (token) => new WebClient(token, { ...WEB_CLIENT_OPTIONS, ...(url ? { slackApiUrl: url } : {}) }),
      // The SDK's own reconnect is off (final review C1): it dropped its promise, and on node.exe a
      // reconnect that failed for good was an unhandled rejection that ended the Host. SlackInbox reconnects,
      // and its WebClient retries nothing itself (SOCKET_WEB_CLIENT_OPTIONS).
      createClient: (appToken) =>
        new SocketModeClient({
          appToken,
          autoReconnectEnabled: false,
          clientOptions: { ...SOCKET_WEB_CLIENT_OPTIONS, ...(url ? { slackApiUrl: url } : {}) }
        })
    }
  } catch (err) {
    // The name only: an SDK error message can carry a path or a token.
    a.log(`slack: the SDK could not be loaded (${err instanceof Error ? err.name : 'unknown'}) — this Host does not own Slack`)
    return null
  }
}
