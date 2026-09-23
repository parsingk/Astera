/** The text of app-settings.json as its readers take it: a JSON object, or a throw. Same guard as the
 *  sibling stores (ProjectSettings, RunConfigStore) — typeof [] === 'object', so an array would
 *  otherwise pass straight through. In core so the Host's read (agentPermissionMode.ts) and the app's
 *  store (main/appSettingsStore.ts) parse the file the same way. */
export function settingsObjectOf(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid schema')
  return parsed as Record<string, unknown>
}
