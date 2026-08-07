// Decides whether Slack notifications are "ready".
//
// The condition NewSessionDialog.tsx (renderer) uses to gate the Slack notification checkbox and the
// condition SlackNotifier.applyConfig() (src/main/slack.ts) uses to pick a transport were judged
// separately in different files and drifted apart — the checkbox only looked at webhookUrl, so a user
// who had configured only botToken+channelId could not tick it even though the bot transport really
// was on. Having both renderer and main look at this single function in core keeps them from drifting
// again. core does not depend on electron or the SDK, so it can be used as-is from both layers.
export interface SlackTransportConfig {
  webhookUrl: string | null
  botToken: string | null
  channelId: string | null
}

/** The transport the configuration selects. Same priority as the branching in applyConfig() — if the
 *  bot condition fails because no channel is set it falls through to webhook, and with neither one
 *  nothing is sent.
 *
 *  Why the decision is collected into this one function: the same priority is needed independently in
 *  three places — applyConfig (the transport), gating the notification checkbox in the new-session
 *  modal, and showing the current mode in settings. Kept separately, changing only one of them makes
 *  them silently drift apart (which is exactly the bug that produced this function). */
export function slackMode(cfg: SlackTransportConfig): 'bot' | 'webhook' | 'off' {
  if (cfg.botToken && cfg.channelId) return 'bot'
  if (cfg.webhookUrl) return 'webhook'
  return 'off'
}

/** Whether the configuration can send notifications — true when any transport at all resolves */
export function isSlackReady(cfg: SlackTransportConfig): boolean {
  return slackMode(cfg) !== 'off'
}
