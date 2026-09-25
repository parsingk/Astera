// The slack.json writer. Stays in the app: the Host never writes this file (plan ruling P2) — it only
// reads it through SlackConfigReader (core/slack/config.ts), which this class extends.
import { promises as fs } from 'node:fs'
import { SlackConfigReader, norm, type SlackConfig } from '../core/slack/config'

export class SlackConfigStore extends SlackConfigReader {
  /** Returns the normalised value — so the caller does not have to write and then read it back. */
  async save(cfg: SlackConfig): Promise<SlackConfig> {
    const normalized: SlackConfig = {
      webhookUrl: norm(cfg.webhookUrl),
      botToken: norm(cfg.botToken),
      channelId: norm(cfg.channelId),
      appToken: norm(cfg.appToken),
      memberId: norm(cfg.memberId)
    }
    await fs.writeFile(this.filePath, JSON.stringify(normalized, null, 2), 'utf8')
    return normalized
  }

  /** A partial update. Passing an object holding only some fields straight to save() has save() normalise
   *  each missing field to norm(undefined)=null, silently erasing values that were already in slack.json in
   *  one save. patch() reads the existing values first, preserves the fields that were not sent
   *  (undefined), and overwrites only those that were. One load() plus one save() is the whole thing, so
   *  the caller needs no separate "re-read after saving".
   *
   *  The settings modal now sends all five fields, but patch is kept — partial updates have to work so that
   *  a future caller touching a single field leaves the rest alive.
   *
   *  Merging is only safe when the current values are actually known. load()'s all-null fallback would turn
   *  a failed read into "nothing was stored", and one save later the tokens on disk are gone — so a read
   *  failure throws here instead, leaving the file untouched. The save fails visibly and the values survive
   *  to be read on the next attempt. */
  async patch(partial: Partial<SlackConfig>): Promise<SlackConfig> {
    const current = await this.read()
    if (!current)
      throw new Error(
        `slack.json could not be read; refusing to save over values that may still be there: ${this.filePath}`
      )
    return this.save({
      webhookUrl: partial.webhookUrl !== undefined ? partial.webhookUrl : current.webhookUrl,
      botToken: partial.botToken !== undefined ? partial.botToken : current.botToken,
      channelId: partial.channelId !== undefined ? partial.channelId : current.channelId,
      appToken: partial.appToken !== undefined ? partial.appToken : current.appToken,
      memberId: partial.memberId !== undefined ? partial.memberId : current.memberId
    })
  }
}
