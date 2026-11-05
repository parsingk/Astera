// What Astera remembers about each Codex account's plugins (Codex plugin sharing design §5): per account, the shared
// plugins it installed and their versions, whether it is waiting for its sessions to end, the last failure, and which of
// the account's own plugins Astera turned off. The installed versions are read from Codex again at every pass, but
// `turnedOff` is not: it is Astera's own memory of which plugins it switched off and Codex cannot give it back, and the
// rows also say which Codex copies an account still runs from. So a file that is there and could not be read is a
// failure, never no rows (audit U-1, as storeFile.ts has it), and the sync tells a damaged file from a missing one and
// keeps the damaged text beside it before it writes anything. The screen and the CLI read a damaged file as no rows.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeThroughTmp } from '../../accounts/fileQueue'
import { extensionPaths } from '../../profile/paths'
import { keepDamaged, readStoreFile } from '../../storeFile'
import type { CodexPluginAccountState } from './types'

export type { CodexPluginAccountState, CodexPluginFailureCode } from './types'

/** The file as rows, with its text when it is damaged (not `{ version: 1, accounts: [...] }`). Rejects with the read error
 *  when the file is there but could not be read. */
async function readRows(file: string): Promise<{ kind: 'missing' } | { kind: 'rows'; rows: CodexPluginAccountState[] } | { kind: 'damaged'; text: string }> {
  const read = await readStoreFile(file)
  if (read.kind === 'unreadable') throw read.error
  if (read.kind === 'missing') return read
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    return { kind: 'damaged', text: read.text }
  }
  const s = parsed as { version?: unknown; accounts?: unknown } | null
  return s?.version === 1 && Array.isArray(s.accounts) ? { kind: 'rows', rows: s.accounts as CodexPluginAccountState[] } : { kind: 'damaged', text: read.text }
}

/** The outcome rows; empty when the file is missing or damaged. Rejects with the read error when the file is there but
 *  could not be read. Writes nothing. */
export async function readCodexPluginAccounts(profileDir: string): Promise<CodexPluginAccountState[]> {
  const read = await readRows(extensionPaths(profileDir).codexPluginAccounts)
  return read.kind === 'rows' ? read.rows : []
}

/** The outcome rows as the sync reads them: a damaged file is no rows and `damaged`, and its text is kept beside it
 *  first (`keepDamaged`), since the sync then writes over it. Rejects with the read error when the file is there but
 *  could not be read. */
export async function readCodexPluginAccountsForSync(profileDir: string): Promise<{ rows: CodexPluginAccountState[]; damaged: boolean }> {
  const file = extensionPaths(profileDir).codexPluginAccounts
  const read = await readRows(file)
  if (read.kind !== 'damaged') return { rows: read.kind === 'rows' ? read.rows : [], damaged: false }
  await keepDamaged(file, read.text)
  return { rows: [], damaged: true }
}

/** Writes the rows atomically, replacing the earlier ones. */
export async function writeCodexPluginAccounts(profileDir: string, accounts: CodexPluginAccountState[]): Promise<void> {
  const file = extensionPaths(profileDir).codexPluginAccounts
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeThroughTmp(file, JSON.stringify({ version: 1, accounts }, null, 2) + '\n')
}
