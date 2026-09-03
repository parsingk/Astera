// The desktop-notification switches (design doc §6/§8).
//
// The first two mean *the work has stopped* and default on. accountSwitched means it is proceeding,
// and with several sessions running that is noise — a reason to ship it off, not to omit it.
//
// A fourth switch, turnDone, was dropped: it fired on every Stop hook, so it announced the end of
// each individual response rather than the end of anything, and the sentence it produced ("the work
// has finished") said something that was not true. Slack still posts its own turn notice; that is a
// thread you are reading, not a toast interrupting you.
//
// They move together as one stored object, so there is one place that knows what a missing file
// means and they cannot drift apart on disk.
//
// node: no imports — the settings screen (renderer) and the notifier (main) both read this.

export interface DesktopNotifySettings {
  inputNeeded: boolean
  limitWaiting: boolean
  accountSwitched: boolean
}

export const DESKTOP_NOTIFY_DEFAULTS: DesktopNotifySettings = {
  inputNeeded: true,
  limitWaiting: true,
  accountSwitched: false
}

/** Read from a file a user can edit by hand, so the narrowing is per default — the convention
 *  appSettingsStore already applies flag by flag. A default-on flag reads as off only on an explicit
 *  `false` (absent or corrupt must read as on, as `githubPolling` does); a default-off flag reads as
 *  on only on an explicit `true`, so 'yes' or 1 cannot switch an event on. */
export function readDesktopNotify(v: unknown): DesktopNotifySettings {
  const o: Record<string, unknown> =
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  return {
    inputNeeded: o.inputNeeded !== false,
    limitWaiting: o.limitWaiting !== false,
    accountSwitched: o.accountSwitched === true
  }
}

/** What to store. Every flag at its default returns `undefined`, so the key itself is left out of the
 *  file — the same "falsy values are omitted" rule appSettingsStore's persist follows, and nothing is
 *  lost because `readDesktopNotify(undefined)` reconstructs exactly these defaults. */
export function writableDesktopNotify(
  s: DesktopNotifySettings
): DesktopNotifySettings | undefined {
  const out = readDesktopNotify(s)
  const keys = Object.keys(DESKTOP_NOTIFY_DEFAULTS) as (keyof DesktopNotifySettings)[]
  return keys.some((k) => out[k] !== DESKTOP_NOTIFY_DEFAULTS[k]) ? out : undefined
}
