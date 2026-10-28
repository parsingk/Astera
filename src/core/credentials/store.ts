// Reading and writing the Credentials list (credentials design §4). The Host writes it; the app's and the Host's session
// managers read it when they build a session's environment. A damaged file is kept beside itself and refused, never
// overwritten, the way the observe rules are (audit/policy.ts).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { profilePaths } from '../profile/paths'
import { keepDamaged, readStoreFile } from '../storeFile'
import { writeThroughTmp } from '../accounts/fileQueue'
import { RepairNeeded } from '../settings/repairNeeded'
import type { CredentialsFile, HideOnlyEntry, Hiding } from './types'

const FILE = 'credentials.json'

export class CredentialsDamaged extends RepairNeeded {
  constructor(file: string) {
    super(`${file} is damaged; a copy was kept beside it`, file)
  }
}

/** Names the provider CLIs and Astera need to run (credentials design §4, my call 1): never hidden, whatever their case. */
const PROTECTED = /^(?:ASTERA_|CLAUDE_|CODEX_|ANTHROPIC_|OPENAI_)/i
export const isProtectedName = (name: string): boolean => PROTECTED.test(name)
/** What the OS gives every program, which a session cannot run without (final review M3): the command path, the system
 *  and temp folders, home and the user. Never hidden either, whatever their case. */
const SYSTEM: ReadonlySet<string> = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'USERNAME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM'
])
export const isSystemName = (name: string): boolean => SYSTEM.has(name.toUpperCase())
/** Names no entry ever takes from a session: the protected ones and the OS's. */
export const isNeverHidden = (name: string): boolean => isProtectedName(name) || isSystemName(name)
export const isEnvName = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)

export const newHideOnlyId = (): string => `hc_${randomBytes(6).toString('hex')}`

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')

function hidingOf(v: unknown): Hiding | null {
  if (!isRecord(v) || typeof v.on !== 'boolean') return null
  if (v.projects === undefined) return { on: v.on }
  return isStrings(v.projects) ? { on: v.on, projects: v.projects } : null
}

function entryOf(v: unknown): HideOnlyEntry | null {
  if (!isRecord(v) || v.kind !== 'hide-only') return null
  const hide = hidingOf(v.hide)
  if (typeof v.id !== 'string' || typeof v.alias !== 'string' || typeof v.createdAt !== 'string') return null
  if (!isStrings(v.envNames) || !isStrings(v.presets) || hide === null) return null
  return { kind: 'hide-only', id: v.id, alias: v.alias, envNames: v.envNames, presets: v.presets, hide, createdAt: v.createdAt }
}

function fileOf(v: unknown): CredentialsFile | null {
  if (!isRecord(v) || v.version !== 1 || !Array.isArray(v.entries) || !isRecord(v.mcpHide)) return null
  const entries = v.entries.map(entryOf)
  if (entries.some((e) => e === null)) return null
  const mcpHide: Record<string, Hiding> = {}
  for (const [id, h] of Object.entries(v.mcpHide)) {
    const hide = hidingOf(h)
    if (hide === null) return null
    mcpHide[id] = hide
  }
  return { version: 1, entries: entries as HideOnlyEntry[], mcpHide }
}

/** The list in `text`, or null when it is not one (damaged). Shared with the session managers' synchronous read
 *  (hiding.ts). */
export function parseCredentials(text: string): CredentialsFile | null {
  try {
    return fileOf(JSON.parse(text))
  } catch {
    return null
  }
}

/** The damaged bytes are copied aside once per distinct text, so a file read at every spawn is not copied every time. */
const keptDamage = new Map<string, string>()

/** The list; empty when there is no file. Rejects with CredentialsDamaged after keeping the damaged bytes beside it. */
export async function readCredentials(profileDir: string): Promise<CredentialsFile> {
  const file = profilePaths(profileDir).credentials
  const read = await readStoreFile(file)
  if (read.kind === 'missing') return { version: 1, entries: [], mcpHide: {} }
  if (read.kind === 'unreadable') throw new RepairNeeded(`${FILE} could not be read (${String(read.error)})`, FILE)
  const f = parseCredentials(read.text)
  if (f === null) {
    const hash = createHash('sha256').update(read.text).digest('hex')
    if (keptDamage.get(file) !== hash) {
      keptDamage.set(file, hash)
      await keepDamaged(file, read.text)
    }
    throw new CredentialsDamaged(FILE)
  }
  return f
}

export async function writeCredentials(profileDir: string, f: CredentialsFile): Promise<void> {
  const file = profilePaths(profileDir).credentials
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeThroughTmp(file, JSON.stringify(f, null, 2) + '\n')
}

export type HideOnlyRefusal = 'protected-name' | 'system-name' | 'bad-name' | 'empty' | 'unknown-preset' | 'alias-empty'

/** Whether a hide-only entry may be kept: a name, a preset Astera knows, nothing protected. */
export function validateHideOnly(
  e: { alias: string; envNames: string[]; presets: string[] },
  knownPresets: readonly string[]
): { ok: true } | { ok: false; reason: HideOnlyRefusal } {
  if (e.alias.trim() === '') return { ok: false, reason: 'alias-empty' }
  if (e.envNames.length === 0 && e.presets.length === 0) return { ok: false, reason: 'empty' }
  if (e.envNames.some((n) => !isEnvName(n))) return { ok: false, reason: 'bad-name' }
  if (e.envNames.some(isProtectedName)) return { ok: false, reason: 'protected-name' }
  if (e.envNames.some(isSystemName)) return { ok: false, reason: 'system-name' }
  if (e.presets.some((p) => !knownPresets.includes(p))) return { ok: false, reason: 'unknown-preset' }
  return { ok: true }
}
