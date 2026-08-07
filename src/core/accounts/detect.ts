import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface DetectCandidate {
  configDir: string
  loggedIn: boolean // the verdict from accounts/loginStatus.ts (claude also checks Keychain on macOS)
  suggestedLabel: string // the email, falling back to the folder name; ~/.claude gets 'Default account'
  provider: 'claude' | 'codex' // tells the two apart when detection results are merged
}

/** Placeholder label for the default account when its email could not be read. It is replaced by the
 *  email as soon as that becomes readable.
 *
 *  **Deliberately not an i18n string.** The value is persisted as the account's label in accounts.json
 *  and `AccountRegistry.syncPlaceholderLabels` compares against it by identity to decide whether a
 *  label is still a placeholder. Making it language-dependent would break that comparison the moment
 *  the app language changed, and the email would then never fill in. Rendering it translated would
 *  mean keeping a stable sentinel here and localising at display time — a separate change. */
export const DEFAULT_ACCOUNT_PLACEHOLDER_LABEL = 'Default account'

// win32 first: ignores path case (the same rule as normalize in ProjectSettings)
const normalize = (p: string): string => path.resolve(p).toLowerCase()

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

// The markers that identify a config dir: any one of .credentials.json, settings.json or projects/ exists
// (projects counts only as a "directory" — this keeps a file of the same name from being misread)
async function hasConfigMarker(dir: string): Promise<boolean> {
  return (
    (await exists(path.join(dir, '.credentials.json'))) ||
    (await exists(path.join(dir, 'settings.json'))) ||
    (await isDirectory(path.join(dir, 'projects')))
  )
}

// Parses <dir>/.claude.json defensively and reads only oauthAccount.emailAddress (credentials untouched, the parser.ts pattern)
async function readEmailAddress(dir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(dir, '.claude.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const oauthAccount = (parsed as Record<string, unknown>).oauthAccount
    if (oauthAccount === null || typeof oauthAccount !== 'object' || Array.isArray(oauthAccount)) {
      return null
    }
    const email = (oauthAccount as Record<string, unknown>).emailAddress
    return typeof email === 'string' && email !== '' ? email : null
  } catch {
    return null // both absent and corrupt fall back — it must never crash
  }
}

/** Reads the logged-in email out of configDir's .claude.json.
 *  For the default config dir (<homeDir>/.claude) it also falls back to the sidecar <homeDir>/.claude.json.
 *  The credentials (.credentials.json) are never read. Every failure gives null. */
export async function readAccountEmail(configDir: string, homeDir: string): Promise<string | null> {
  const direct = await readEmailAddress(configDir)
  if (direct) return direct
  if (normalize(configDir) === normalize(path.join(homeDir, '.claude'))) {
    return readEmailAddress(homeDir) // the sidecar: <homeDir>/.claude.json
  }
  return null
}

async function suggestLabel(configDir: string, homeDir: string): Promise<string> {
  const email = await readAccountEmail(configDir, homeDir)
  if (email) return email
  if (normalize(configDir) === normalize(path.join(homeDir, '.claude'))) {
    return DEFAULT_ACCOUNT_PLACEHOLDER_LABEL
  }
  return path.basename(configDir)
}

async function collectCandidateDirs(homeDir: string): Promise<string[]> {
  const dirs = [path.join(homeDir, '.claude')]

  let topEntries: import('node:fs').Dirent[] = []
  try {
    topEntries = await fs.readdir(homeDir, { withFileTypes: true })
  } catch {
    topEntries = [] // does not crash even when homeDir itself is missing
  }

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue
    if (entry.name === '.claude-accounts') {
      // .claude-accounts is itself the root, so it is excluded from the candidates — only its subdirectories are scanned
      const accountsRoot = path.join(homeDir, entry.name)
      let subEntries: import('node:fs').Dirent[] = []
      try {
        subEntries = await fs.readdir(accountsRoot, { withFileTypes: true })
      } catch {
        subEntries = []
      }
      for (const sub of subEntries) {
        if (sub.isDirectory()) dirs.push(path.join(accountsRoot, sub.name))
      }
    } else if (entry.name.startsWith('.claude-')) {
      dirs.push(path.join(homeDir, entry.name))
    }
  }

  return dirs
}

export async function detectConfigDirs(opts: {
  homeDir: string // os.homedir() injected (easier to test)
  excludeDirs: string[] // the configDirs already registered
  /** The login probe. If not passed, falls back to the existing file-marker rule — a default for
   *  tests only; the real wiring (providers/descriptor.ts) always passes it explicitly. */
  isLoggedIn?: (configDir: string) => Promise<boolean>
}): Promise<DetectCandidate[]> {
  const { homeDir, excludeDirs } = opts
  const isLoggedIn =
    opts.isLoggedIn ?? ((dir: string) => exists(path.join(dir, '.credentials.json')))
  const excludeSet = new Set(excludeDirs.map(normalize))
  const homeClaudeNorm = normalize(path.join(homeDir, '.claude'))

  const candidateDirs = await collectCandidateDirs(homeDir)
  const seen = new Set<string>()
  const results: DetectCandidate[] = []

  for (const dir of candidateDirs) {
    const norm = normalize(dir)
    if (seen.has(norm) || excludeSet.has(norm)) continue
    seen.add(norm)

    if (!(await hasConfigMarker(dir))) continue

    results.push({
      configDir: dir,
      loggedIn: await isLoggedIn(dir),
      suggestedLabel: await suggestLabel(dir, homeDir),
      provider: 'claude'
    })
  }

  results.sort((a, b) => {
    const aIsHome = normalize(a.configDir) === homeClaudeNorm
    const bIsHome = normalize(b.configDir) === homeClaudeNorm
    if (aIsHome !== bIsHome) return aIsHome ? -1 : 1
    return a.configDir.localeCompare(b.configDir)
  })

  return results
}
