// Owns the Slack transport protocol only. slack.ts holds the notification content and the session concepts;
// this file knows only "where the text goes and how". Tokens and URLs never make it into a log or an error.

import { WebClient } from '@slack/web-api'

/** A post failure. reason goes into the log verbatim, so it may only carry values that cannot contain a URL or token. */
export class SlackPostError extends Error {
  constructor(readonly reason: string) {
    super(`slack post failed ${reason}`)
    this.name = 'SlackPostError'
  }
}

export interface SlackTransport {
  /** On success the message ts (usable as a thread root), or null when unsupported. Failure throws SlackPostError. */
  post(text: string, threadTs?: string): Promise<string | null>
  readonly supportsThreads: boolean
}

/** The legacy Incoming Webhook transport. No thread support — there is no thread_ts field at all. */
export class WebhookTransport implements SlackTransport {
  readonly supportsThreads = false

  constructor(
    private url: string,
    private fetchFn: typeof fetch
  ) {}

  // threadTs is accepted to match the interface signature, but a webhook has no threads, so it is simply ignored.
  async post(text: string, _threadTs?: string): Promise<string | null> {
    let res: Response
    try {
      res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      })
    } catch (err) {
      // err.message can contain the user-supplied URL — keep only the name
      throw new SlackPostError(err instanceof Error ? err.name : 'unknown')
    }
    if (!res.ok) throw new SlackPostError(`status=${res.status}`)
    return null
  }
}

/** The minimal shape WebClient satisfies. Kept narrow so tests can supply a fake without the SDK. */
export interface SlackPoster {
  chat: {
    postMessage(args: {
      channel: string
      text: string
      thread_ts?: string
    }): Promise<{ ok?: boolean; ts?: string }>
  }
}

/** Confines SDK construction to one place — so no other file imports @slack/web-api.
 *
 *  Why timeout and retryConfig are specified explicitly: the SDK defaults are no request timeout (timeout: 0) plus
 *  tenRetriesInAboutThirtyMinutes (10 attempts, roughly 30 minutes in total). The root message register() in slack.ts
 *  posts is queued behind `await record.thread` in send(), so if a session starts while offline or rate-limited, that
 *  root chat.postMessage stays pending for up to 30 minutes on the defaults and every notification for that session
 *  (turn complete, limit, rolling, exit) piles up behind it. The design promises an immediate fallback — "root post
 *  fails → threadTs null → notifications go to channel level" — so a finite timeout and few retries are what make
 *  that fallback actually happen within seconds. */
export function createWebClient(token: string): SlackPoster {
  return new WebClient(token, { timeout: 10_000, retryConfig: { retries: 2 } })
}

/** Extracts an identifier that is safe to log from an SDK exception such as WebAPIPlatformError.
 *  err.message is never used — it is the one free-form field that can contain a token or URL. Instead it carries only
 *  err.name (the exception class name), err.code (the SDK ErrorCode, e.g. slack_webapi_platform_error) and
 *  err.data?.error (the platform error code Slack returns, e.g. invalid_auth, channel_not_found, not_in_channel) —
 *  all three are fixed, non-secret identifiers, which is what makes invalid_auth distinguishable from
 *  channel_not_found/not_in_channel in the log (the log is the only diagnostic channel; showing the state in the UI was rejected).
 *
 *  Why it is exported: Socket Mode connection failures in slackInbox.ts throw the same SDK exception shapes
 *  (WebAPIPlatformError and friends). Keeping only err.name there would log a mistyped token (invalid_auth) as nothing
 *  but "WebAPIPlatformError", making the diagnosis the docs describe impossible. */
export function botErrorReason(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown'
  const code = (err as { code?: unknown }).code
  const platform = (err as { data?: { error?: unknown } }).data?.error
  const parts = [err.name]
  if (typeof code === 'string') parts.push(code)
  if (typeof platform === 'string') parts.push(platform)
  return parts.join(':')
}

/** The Slack App (bot) transport. chat.postMessage supports thread_ts, so it creates a session thread. */
export class BotTransport implements SlackTransport {
  readonly supportsThreads = true

  constructor(
    private client: SlackPoster,
    private channel: string
  ) {}

  async post(text: string, threadTs?: string): Promise<string | null> {
    let res: { ok?: boolean; ts?: string }
    try {
      res = await this.client.chat.postMessage({
        channel: this.channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {})
      })
    } catch (err) {
      throw new SlackPostError(botErrorReason(err))
    }
    if (res.ok === false) throw new SlackPostError('ok=false')
    return res.ts ?? null
  }
}
