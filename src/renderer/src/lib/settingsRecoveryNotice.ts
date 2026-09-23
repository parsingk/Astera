// The one notice for a damaged app-settings.json. App.tsx is where it runs, but that file is out of
// the tests' reach, so the decision lives here (the same reason spawnNotice.ts exists).

/** The i18n key of the notice: the settings were reset and permission prompts are on. */
export const SETTINGS_RECOVERED_KEY = 'settings.recovered.toast'

/** Asks main whether its load recovered from a damaged file (it answers true once), and shows the
 *  notice when it did. A failed ask shows nothing: the notice is information, not a gate. */
export async function announceSettingsRecovery(
  take: () => Promise<boolean>,
  show: (key: typeof SETTINGS_RECOVERED_KEY) => void
): Promise<void> {
  let recovered: boolean
  try {
    recovered = await take()
  } catch {
    return
  }
  if (recovered) show(SETTINGS_RECOVERED_KEY)
}
