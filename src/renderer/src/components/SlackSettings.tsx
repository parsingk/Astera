// Settings › Slack, on its own (audit UI-1): its five fields were App's state, so every keystroke in a token drew the
// whole app and every pane under it again. The fields live here; App draws this and nothing changes there as one types.
import { useEffect, useRef, useState } from 'react'
import { slackMode } from '../../../core/slack/ready'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'

export function SlackSettings(): React.JSX.Element {
  const { t } = useI18n()
  const [slackUrl, setSlackUrl] = useState('') // the Slack Webhook URL in the settings modal
  const [slackSaved, setSlackSaved] = useState(false)
  // Bot configuration. appToken is for Socket Mode receiving only, so for now it is merely stored
  const [slackBotToken, setSlackBotToken] = useState('')
  const [slackChannelId, setSlackChannelId] = useState('')
  const [slackAppToken, setSlackAppToken] = useState('')
  // The one Slack Member ID allowed to reply into sessions. Left empty, every reply is blocked
  const [slackMemberId, setSlackMemberId] = useState('')
  // Saving is blocked until getConfig has returned — the save button sends all five fields
  // explicitly, so pressing it while they are still empty strings would overwrite an already-stored
  // token, channel, and webhook with null in one go. (When there was a single field, patch()
  // preserving undefined protected the rest; that is no longer the case.)
  const [slackLoaded, setSlackLoaded] = useState(false)
  /** Whether a field was changed before the configuration was read (audit UI-7): the read then does not overwrite it. */
  const touched = useRef(false)

  useEffect(() => {
    let cancelled = false
    void window.api.slack.getConfig().then(
      (c) => {
        if (cancelled) return
        if (!touched.current) {
          setSlackUrl(c.webhookUrl ?? '')
          setSlackBotToken(c.botToken ?? '')
          setSlackChannelId(c.channelId ?? '')
          setSlackAppToken(c.appToken ?? '')
          setSlackMemberId(c.memberId ?? '')
        }
        setSlackLoaded(true)
      },
      // Said, and Save stays off (audit UI-7): saving the empty fields would erase the configuration it could not read.
      (err) => toast.error(err instanceof Error ? err.message : String(err))
    )
    return () => {
      cancelled = true
    }
  }, [])

  return (
      <div className="settings-slack">
        <label className="settings-field-label">Slack Webhook URL</label>
        <input
          type="text"
          className="slack-url-input"
          value={slackUrl}
          placeholder="https://hooks.slack.com/services/…"
          onChange={(e) => {
            touched.current = true
            setSlackUrl(e.target.value)
            setSlackSaved(false)
          }}
        />
        {/* Bot configuration. Tokens are password inputs — it reduces exposure over a shared
            screen or a shoulder. Once filled, a password shows only ●●●, so every field needs
            a label to say what it is */}
        <label className="settings-field-label">{t('settings.slack.botSection')}</label>
        <label className="settings-field-label">Bot Token</label>
        <input
          type="password"
          className="slack-url-input"
          value={slackBotToken}
          placeholder="xoxb-…"
          onChange={(e) => {
            touched.current = true
            setSlackBotToken(e.target.value)
            setSlackSaved(false)
          }}
        />
        <label className="settings-field-label">Channel ID</label>
        <input
          type="text"
          className="slack-url-input"
          value={slackChannelId}
          placeholder="C0123456789"
          onChange={(e) => {
            touched.current = true
            setSlackChannelId(e.target.value)
            setSlackSaved(false)
          }}
        />
        <span className="settings-hint">{t('settings.slack.channelIdHint')}</span>
        <label className="settings-field-label">App Token</label>
        <input
          type="password"
          className="slack-url-input"
          value={slackAppToken}
          placeholder="xapp-…"
          onChange={(e) => {
            touched.current = true
            setSlackAppToken(e.target.value)
            setSlackSaved(false)
          }}
        />
        <span className="settings-hint">{t('settings.slack.appTokenHint')}</span>
        {/* The one member allowed to reply into sessions. The channel alone is not a
            permission boundary — anyone invited there could push input into a session — so
            replies are matched against this ID. Left empty, every reply is blocked rather
            than allowed (core/slack/inbound.ts), which is why the warning below is loud. */}
        <label className="settings-field-label">Member ID</label>
        <input
          type="text"
          className="slack-url-input"
          value={slackMemberId}
          placeholder="U0123456789"
          onChange={(e) => {
            touched.current = true
            setSlackMemberId(e.target.value)
            setSlackSaved(false)
          }}
        />
        <span className="settings-hint">{t('settings.slack.memberIdHint')}</span>
        {/* Gated on bot mode, not on the full intake condition (which also needs the app
            token): slackMode() is the verdict core already owns, so no third place gets to
            judge "is the bot on" and drift from it. In bot mode without an app token there
            is no intake at all, and the warning still reads true there. */}
        {slackMode({
          webhookUrl: slackUrl.trim() || null,
          botToken: slackBotToken.trim() || null,
          channelId: slackChannelId.trim() || null
        }) === 'bot' &&
          slackMemberId.trim() === '' && (
            <span className="update-note update-err">
              {t('settings.slack.memberIdRequired')}
            </span>
          )}
        <div className="slack-cell">
          <button
            disabled={!slackLoaded}
            onClick={() =>
              void window.api.slack
                .setConfig({
                  webhookUrl: slackUrl.trim() || null,
                  botToken: slackBotToken.trim() || null,
                  channelId: slackChannelId.trim() || null,
                  appToken: slackAppToken.trim() || null,
                  memberId: slackMemberId.trim() || null
                })
                .then(() => setSlackSaved(true))
                // A rejection means the store refused to overwrite values it could not read —
                // the settings on disk survived. Saying so beats a silently dead button, since
                // "Saved" never appears either way.
                .catch((err) =>
                  toast.error(
                    t('settings.slack.saveFailed', {
                      detail: err instanceof Error ? err.message : String(err)
                    })
                  )
                )
            }
          >
            {t('settings.slack.save')}
          </button>
          {slackSaved && <span className="update-note">{t('settings.slack.saved')}</span>}
        </div>
        {/* Shows immediately which transport the current input adds up to — filling in a bot
            token but leaving out the channel ID falls back to the Webhook silently, so that
            has to be visible. The verdict uses slackMode() from core: it has to be the same
            function that applyConfig (in main) and the notification checkbox gating use, so
            one side cannot drift from the other */}
        <span className="settings-hint">
          {t(
            (
              {
                bot: 'settings.slack.modeBot',
                webhook: 'settings.slack.modeWebhook',
                off: 'settings.slack.modeOff'
              } as const
            )[
              slackMode({
                webhookUrl: slackUrl.trim() || null,
                botToken: slackBotToken.trim() || null,
                channelId: slackChannelId.trim() || null
              })
            ]
          )}
        </span>
        <span className="settings-hint">{t('settings.slack.hint')}</span>
        <span className="settings-hint">{t('settings.slack.setupGuide')}</span>
      </div>
  )
}
