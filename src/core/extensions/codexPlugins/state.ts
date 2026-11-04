// What Astera remembers about each Codex account's plugins (Codex plugin sharing design §5): per account, the shared
// plugins it installed and their versions, whether it is waiting for its sessions to end, the last failure, and which of
// the account's own plugins Astera turned off. A missing or damaged file reads as no rows and nothing is kept aside: the
// installed versions are read from Codex again at the next sync, so those rows are rebuilt. `turnedOff` is not: it is
// Astera's own memory of which plugins it switched off and Codex cannot give it back. A file with no text to read it from
// (missing, or damaged) has lost it already, but a file that is there and could not be read has not, and a write made
// after taking it for no rows would leave the person's own plugin disabled for good. So that case is a failure, never
// no rows (audit U-1, as storeFile.ts has it).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeThroughTmp } from '../../accounts/fileQueue'
import { extensionPaths } from '../../profile/paths'
import { readStoreFile } from '../../storeFile'
import type { CodexPluginAccountState } from './types'

export type { CodexPluginAccountState, CodexPluginFailureCode } from './types'

/** The outcome rows; empty when the file is missing or its text is not `{ version: 1, accounts: [...] }`. Rejects with the
 *  read error when the file is there but could not be read. */
export async function readCodexPluginAccounts(profileDir: string): Promise<CodexPluginAccountState[]> {
  const read = await readStoreFile(extensionPaths(profileDir).codexPluginAccounts)
  if (read.kind === 'unreadable') throw read.error
  if (read.kind === 'missing') return []
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
