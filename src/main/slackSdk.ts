// Confines Slack SDK construction to the app (plan ruling P1: the SDK never enters core). The Host loads
// the same SDK with a literal import() at start instead (src/host/slackSdk.ts, Task 3) — a static import
// here would put a top-level require('@slack/…') in the Host bundle, and an older runtime with no @slack
// installed would fail to start the Host at all.
import { WebClient } from '@slack/web-api'
import { SocketModeClient } from '@slack/socket-mode'
import { WEB_CLIENT_OPTIONS, type SlackPoster } from '../core/slack/transport'
import type { SocketClient } from '../core/slack/inbox'
import { slackApiUrlFrom } from '../core/slack/apiUrl'

/** Confines SDK construction to one place — so no other file imports @slack/web-api. The options and why
 *  they are finite: WEB_CLIENT_OPTIONS in core/slack/transport.ts. A loopback `ASTERA_SLACK_API_URL`
 *  points the client at a fake Slack (P15). */
export function createWebClient(token: string, env: Record<string, string | undefined> = process.env): SlackPoster {
  const url = slackApiUrlFrom(env)
  return new WebClient(token, { ...WEB_CLIENT_OPTIONS, ...(url ? { slackApiUrl: url } : {}) })
}

/** Confines SDK construction to one place — so no other file imports @slack/socket-mode. The API URL seam
 *  goes through `clientOptions`, so `apps.connections.open` and the WebSocket URL both come from it (P15). */
export function createSocketClient(appToken: string, env: Record<string, string | undefined> = process.env): SocketClient {
  const url = slackApiUrlFrom(env)
  return new SocketModeClient({ appToken, ...(url ? { clientOptions: { slackApiUrl: url } } : {}) }) as unknown as SocketClient
}
