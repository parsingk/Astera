// Lives in core since Slack in the Host (Task 1), so the Host runs the same notifier the app does.
// Carved out of notifier.ts (formerly main/slack.ts): the read-only half of slack.json settings storage.
// The Host uses SlackConfigReader directly (it never writes the file); the app's writer,
// SlackConfigStore, extends it in main/slackConfigStore.ts (plan ruling P2).
import { promises as fs } from 'node:fs'

export interface SlackConfig {
  webhookUrl: string | null
  botToken: string | null // xoxb-
  channelId: string | null // the channel the session thread is posted in
  // xapp-. It is for Socket Mode receiving only and plays no part in choosing the transport (applyConfig) —
  // the actual consumer is the inbox. It is stored ahead of time so the settings screen is only touched once.
  appToken: string | null
  // The one Slack Member ID (U…) whose thread replies are injected into sessions. Receiving-side
  // permission only — it plays no part in choosing the transport either, so sending keeps working
  // without it while every reply is blocked (see classifyInbound in core/slack/inbound.ts). A missing
  // value blocks everyone rather than allowing everyone, so an old slack.json with no such field
  // converges on the safe side with no migration.
  memberId: string | null
}

export const EMPTY_SLACK_CONFIG: SlackConfig = {
  webhookUrl: null,
  botToken: null,
  channelId: null,
  appToken: null,
  memberId: null
}

export const norm = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null

/** Settings storage (userData/slack.json). A missing or corrupt file falls back to defaults — it does not
 *  block the app. Tokens never leave this file: they are not put in logs or error messages. */
// The file is the only copy of the credentials, so the read paths distinguish "nothing stored" from
// "could not be read" — see read() for why, and patch() (in SlackConfigStore) for what depends on it.
export class SlackConfigReader {
  constructor(protected readonly filePath: string) {}

  /** The stored values, or null when the file is there but could not be read — a state that is not the same
   *  as "nothing is stored" and must not be collapsed into one. A missing file (ENOENT) is a fresh install
   *  and gives defaults; an unparseable file gives defaults too, because that damage does not heal on a
   *  retry and the settings screen has to stay able to overwrite it. Anything else — EPERM or EBUSY while
   *  another process holds the file on Windows, EMFILE under fd pressure — is transient, and the values it
   *  hides are still on disk. */
  protected async read(): Promise<SlackConfig | null> {
    let text: string
    try {
      text = await fs.readFile(this.filePath, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_SLACK_CONFIG }
      return null
    }
    try {
      const raw = JSON.parse(text) as Record<string, unknown>
      return {
        webhookUrl: norm(raw.webhookUrl),
        botToken: norm(raw.botToken),
        channelId: norm(raw.channelId),
        appToken: norm(raw.appToken),
        memberId: norm(raw.memberId)
      }
    } catch {
      return { ...EMPTY_SLACK_CONFIG }
    }
  }

  /** Reading is deliberately forgiving: an unreadable file leaves Slack looking unconfigured rather than
   *  keeping the app from starting. Writers must not inherit that forgiveness — see SlackConfigStore.patch(). */
  async load(): Promise<SlackConfig> {
    return (await this.read()) ?? { ...EMPTY_SLACK_CONFIG }
  }
}
