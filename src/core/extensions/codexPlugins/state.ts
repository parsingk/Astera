// What Astera remembers about each Codex account's plugins (Codex plugin sharing design §5): per account, the shared
// plugins it installed and their versions, whether it is waiting for its sessions to end, the last failure, and which of
// the account's own plugins Astera turned off. A missing or damaged file reads as no rows, nothing is kept aside: the
// next sync works every account out again from Codex itself and writes the file anew, so there is nothing here to lose.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeThroughTmp } from '../../accounts/fileQueue'
import { extensionPaths } from '../../profile/paths'
import { readStoreFile } from '../../storeFile'

export type CodexPluginFailureCode =
  | 'marketplace-taken'
  | 'codex-unsupported'
  | 'config-unreadable'
  | 'hooks-unreadable'
  | 'refused'
  | 'timed-out'

export interface CodexPluginAccountState {
  accountId: string
  /** Plugin name to the version Codex reports installed from this profile's marketplace. */
  installed: Record<string, string>
  waiting: boolean
  failure?: { message: string; code?: CodexPluginFailureCode }
  /** Own plugin ids (`name@marketplace`) Astera set to enabled = false (C1). */
  turnedOff: string[]
  at: string
}

/** The outcome rows; empty when the file is missing or cannot be read as `{ version: 1, accounts: [...] }`. */
export async function readCodexPluginAccounts(profileDir: string): Promise<CodexPluginAccountState[]> {
  const read = await readStoreFile(extensionPaths(profileDir).codexPluginAccounts)
  if (read.kind !== 'text') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    return []
  }
  const s = parsed as { version?: unknown; accounts?: unknown } | null
  return s?.version === 1 && Array.isArray(s.accounts) ? (s.accounts as CodexPluginAccountState[]) : []
}

/** Writes the rows atomically, replacing the earlier ones. */
export async function writeCodexPluginAccounts(profileDir: string, accounts: CodexPluginAccountState[]): Promise<void> {
  const file = extensionPaths(profileDir).codexPluginAccounts
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeThroughTmp(file, JSON.stringify({ version: 1, accounts }, null, 2) + '\n')
}
