// Confines Slack SDK construction to the app (plan ruling P1: the SDK never enters core). The Host loads
// the same SDK with a literal import() at start instead (src/host/slackSdk.ts, Task 3) — a static import
// here would put a top-level require('@slack/…') in the Host bundle, and an older runtime with no @slack
// installed would fail to start the Host at all.
import { WebClient } from '@slack/web-api'
import { SocketModeClient } from '@slack/socket-mode'
import type { SlackPoster } from '../core/slack/transport'
import type { SocketClient } from '../core/slack/inbox'

/** Confines SDK construction to one place — so no other file imports @slack/web-api.
 *
 *  Why timeout and retryConfig are specified explicitly: the SDK defaults are no request timeout (timeout: 0) plus
 *  tenRetriesInAboutThirtyMinutes (10 attempts, roughly 30 minutes in total). The root message register() in
 *  core/slack/notifier.ts posts is queued behind `await record.thread` in send(), so if a session starts while
 *  offline or rate-limited, that root chat.postMessage stays pending for up to 30 minutes on the defaults and
 *  every notification for that session (turn complete, limit, rolling, exit) piles up behind it. The design
 *  promises an immediate fallback — "root post fails → threadTs null → notifications go to channel level" —
 *  so a finite timeout and few retries are what make that fallback actually happen within seconds. */
export function createWebClient(token: string): SlackPoster {
  return new WebClient(token, { timeout: 10_000, retryConfig: { retries: 2 } })
}

/** Confines SDK construction to one place — so no other file imports @slack/socket-mode. */
export function createSocketClient(appToken: string): SocketClient {
  return new SocketModeClient({ appToken }) as unknown as SocketClient
}
