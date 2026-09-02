// The four desktop-notification switches (design doc §6/§8).
//
// The first two mean *the work has stopped* and default on. The last two mean *the work is
// proceeding*, and with four sessions running they are noise — which is a reason to ship them off,
// not a reason to omit them: the person running eight worktrees may well want the turn-finished
// signal, and enabling it is one click.
//
// They move together as one stored object, so there is one place that knows what a missing file
// means and the four cannot drift apart on disk.
//
// node: no imports — the settings screen (renderer) and the notifier (main) both read this.

export interface DesktopNotifySettings {
  inputNeeded: boolean
  limitWaiting: boolean
  accountSwitched: boolean
  turnDone: boolean
}

export const DESKTOP_NOTIFY_DEFAULTS: DesktopNotifySettings = {
  inputNeeded: true,
  limitWaiting: true,
  accountSwitched: false,
  turnDone: false
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
    accountSwitched: o.accountSwitched === true,
    turnDone: o.turnDone === true
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
