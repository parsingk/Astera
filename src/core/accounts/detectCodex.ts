import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DetectCandidate } from './detect'
import { DEFAULT_ACCOUNT_PLACEHOLDER_LABEL } from './detect'

// win32 first: ignores path case (the same rule as detect.ts)
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

/** Whether it is ~/.codex (the default CODEX_HOME) — shared by SessionManager's ambient verdict and the detect label */
export function isAmbientCodexDir(homeDir: string, configDir: string): boolean {
  return normalize(configDir) === normalize(path.join(homeDir, '.codex'))
}

// The markers that identify a codex config dir: auth.json, config.toml or a sessions directory
// (sessions counts only as a "directory" — this keeps a file of the same name from being misread, the same
// rule as projects in detect.ts)
async function hasCodexMarker(dir: string): Promise<boolean> {
  return (
    (await exists(path.join(dir, 'auth.json'))) ||
    (await exists(path.join(dir, 'config.toml'))) ||
    (await isDirectory(path.join(dir, 'sessions')))
  )
}

// Decodes only the JWT payload segment to pull the email out. The signature is not verified (this is for
// identification). The token string never leaves this function — it must not be stored, transmitted or logged.
function decodeJwtEmail(idToken: string): string | null {
  const parts = idToken.split('.')
  if (parts.length < 2) return null
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
    const email = (payload as Record<string, unknown>).email
    return typeof email === 'string' && email !== '' ? email : null
  } catch {
    return null
  }
}

/** Extracts the logged-in email from the tokens.id_token JWT in auth.json. Every failure gives null.
 *  Unlike readAccountEmail on the claude side, this does read the credential file — that is the only place
 *  the email exists — and email is the only field extracted (approved by the user). */
export async function readCodexEmail(configDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(configDir, 'auth.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const tokens = (parsed as Record<string, unknown>).tokens
    if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) return null
    const idToken = (tokens as Record<string, unknown>).id_token
    return typeof idToken === 'string' ? decodeJwtEmail(idToken) : null
  } catch {
    return null // both absent and corrupt fall back — it must never crash
  }
}

async function suggestLabel(configDir: string, homeDir: string): Promise<string> {
  const email = await readCodexEmail(configDir)
  if (email) return email
  if (isAmbientCodexDir(homeDir, configDir)) return DEFAULT_ACCOUNT_PLACEHOLDER_LABEL
  return path.basename(configDir)
}

async function collectCandidateDirs(homeDir: string): Promise<string[]> {
  // Mirrors collectCandidateDirs in detect.ts — '.claude' → '.codex'
  const dirs = [path.join(homeDir, '.codex')]

  let topEntries: import('node:fs').Dirent[] = []
  try {
    topEntries = await fs.readdir(homeDir, { withFileTypes: true })
  } catch {
    topEntries = [] // does not crash even when homeDir itself is missing
  }

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue
    if (entry.name === '.codex-accounts') {
      // .codex-accounts is itself the root, so it is excluded from the candidates — only its subdirectories are scanned
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
    } else if (entry.name.startsWith('.codex-')) {
      dirs.push(path.join(homeDir, entry.name))
    }
  }

  return dirs
}

export async function detectCodexConfigDirs(opts: {
  homeDir: string // os.homedir() injected (easier to test)
  excludeDirs: string[] // the configDirs already registered
}): Promise<DetectCandidate[]> {
  const { homeDir, excludeDirs } = opts
  const excludeSet = new Set(excludeDirs.map(normalize))

  const candidateDirs = await collectCandidateDirs(homeDir)
  const seen = new Set<string>()
  const results: DetectCandidate[] = []

  for (const dir of candidateDirs) {
    const norm = normalize(dir)
    if (seen.has(norm) || excludeSet.has(norm)) continue
    seen.add(norm)

    if (!(await hasCodexMarker(dir))) continue

    results.push({
      configDir: dir,
      loggedIn: await exists(path.join(dir, 'auth.json')),
      suggestedLabel: await suggestLabel(dir, homeDir),
      provider: 'codex'
    })
  }

  results.sort((a, b) => {
    const aIsHome = isAmbientCodexDir(homeDir, a.configDir)
    const bIsHome = isAmbientCodexDir(homeDir, b.configDir)
    if (aIsHome !== bIsHome) return aIsHome ? -1 : 1
    return a.configDir.localeCompare(b.configDir)
  })

  return results
}
