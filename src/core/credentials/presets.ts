// CLI login presets for hide-only entries (credentials design §5, C8): what each removes from an agent session and which
// configuration location it points at an empty folder or file. Only presets measured to hide their login are here
// (inventory §21: Windows 2026-10-26, macOS and Linux by the measure-sandbox workflow 2026-10-27), each with the
// platforms it was measured on. A convenience, not every way a tool signs in.
export interface Preset {
  id: string
  label: string
  remove: string[]
  redirect: Record<string, 'empty-dir' | 'empty-file'>
  measuredOn: NodeJS.Platform[]
}

export const PRESETS: Preset[] = [
  { id: 'gh', label: 'GitHub CLI (gh)', remove: ['GH_TOKEN', 'GITHUB_TOKEN'], redirect: { GH_CONFIG_DIR: 'empty-dir' }, measuredOn: ['win32', 'darwin', 'linux'] },
  {
    id: 'aws',
    label: 'AWS CLI',
    remove: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE'],
    redirect: { AWS_CONFIG_FILE: 'empty-file', AWS_SHARED_CREDENTIALS_FILE: 'empty-file' },
    measuredOn: ['win32', 'darwin', 'linux']
  },
  { id: 'gcloud', label: 'Google Cloud CLI', remove: ['GOOGLE_APPLICATION_CREDENTIALS'], redirect: { CLOUDSDK_CONFIG: 'empty-dir' }, measuredOn: ['win32', 'linux'] },
  { id: 'npm', label: 'npm', remove: ['NPM_TOKEN'], redirect: { NPM_CONFIG_USERCONFIG: 'empty-file' }, measuredOn: ['win32', 'darwin', 'linux'] },
  // The docker CLI stops presenting stored logins; its credential helper still answers any program that asks (inventory §21)
  { id: 'docker', label: 'Docker', remove: [], redirect: { DOCKER_CONFIG: 'empty-dir' }, measuredOn: ['win32', 'linux'] },
  { id: 'kubectl', label: 'kubectl', remove: [], redirect: { KUBECONFIG: 'empty-file' }, measuredOn: ['win32', 'linux'] }
]

export const PRESET_IDS: string[] = PRESETS.map((p) => p.id)
