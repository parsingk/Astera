// The GitHub lifecycle's policy defaults as the Host reads them from app-settings.json (GitHub lifecycle G7a): the
// narrowing is lifecycleDefaults.ts's, shared with the app's store and the Settings pane.
import { githubLifecycleDefaultsOf, type GitHubLifecycleDefaults } from '../github/lifecycleDefaults'
import { readAppSettingsObject } from './settingsObject'

/** Missing file: the defaults. Unreadable file: throws, because it may have said "do not rerun" (the readMcpAccess
 *  rule), and a Job made with the defaults instead would rerun what the person turned off. */
export async function readGitHubLifecycleDefaults(filePath: string): Promise<GitHubLifecycleDefaults> {
  const parsed = await readAppSettingsObject(filePath)
  return githubLifecycleDefaultsOf(parsed?.githubLifecycle)
}
