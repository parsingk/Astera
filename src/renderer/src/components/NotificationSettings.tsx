import { useEffect, useState } from 'react'
import type { DesktopNotifySettings } from '../../../core/notify/settings'
import type { MessageKey } from '../../../core/i18n'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'

/** The three events, in the order §6's table lists them: the two that mean *the work has stopped*
 *  first, then the one that means *it is proceeding*. That order is the explanation — a person
 *  scanning the list should meet the two they almost certainly want before the one they may not. */
const EVENTS = [
  {
    key: 'inputNeeded',
    label: 'settings.notifications.inputNeeded',
    hint: 'settings.notifications.inputNeededHint'
  },
  {
    key: 'limitWaiting',
    label: 'settings.notifications.limitWaiting',
    hint: 'settings.notifications.limitWaitingHint'
  },
  {
    key: 'accountSwitched',
    label: 'settings.notifications.accountSwitched',
    hint: 'settings.notifications.accountSwitchedHint'
  }
] as const satisfies readonly { key: keyof DesktopNotifySettings; label: MessageKey; hint: MessageKey }[]

/** The Notifications pane of the settings modal (design doc §8). Its own tab rather than a corner of
 *  General: General already carries the resume strategy and two experimental toggles, and Slack,
 *  GitHub and Worktree each earned a tab at less weight than these checkboxes and an explanation of
 *  what each event means. */
export function NotificationSettings(): React.JSX.Element {
  const { t } = useI18n()
  const [flags, setFlags] = useState<DesktopNotifySettings | null>(null) // null = first read in flight

  useEffect(() => {
    void window.api.settings.getDesktopNotify().then(setFlags)
  }, [])

  const toggle = (key: keyof DesktopNotifySettings, next: boolean): void => {
    if (!flags) return
    const was = flags[key]
    const updated = { ...flags, [key]: next }
    setFlags(updated) // optimistic — reverted below on failure
    void window.api.settings.setDesktopNotify(updated).catch((err) => {
      // Revert this key alone, through a functional updater: a second checkbox toggled while
      // this save was in flight has already applied, and reverting the whole record would
      // discard it.
      setFlags((f) => (f ? { ...f, [key]: was } : f))
      toast.error(
        t('settings.notifications.saveFailed', {
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    })
  }

  return (
    <>
      <span className="settings-hint">{t('settings.notifications.hint')}</span>
      {EVENTS.map(({ key, label, hint }) => (
        <div key={key}>
          {/* A label so pressing the text toggles too — the same wrapping the GitHub polling row uses */}
          <label className="settings-row">
            <span>{t(label)}</span>
            <input
              type="checkbox"
              // Unchecked until the first read answers, rather than defaulting to the on state:
              // a checkbox that flips itself a moment after the tab opens reads as a setting that
              // changed, and this one did not.
              checked={flags?.[key] ?? false}
              disabled={flags === null}
              onChange={(e) => toggle(key, e.target.checked)}
            />
          </label>
          <span className="settings-hint">{t(hint)}</span>
        </div>
      ))}
    </>
  )
}
