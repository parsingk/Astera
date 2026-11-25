// A plugin folder's package.json as JSON, or the sentence saying why it holds none: what the plugin manager's manifest
// reader and the folder check (folderCheck.ts) both start from.
import { promises as fs } from 'node:fs'
import path from 'node:path'

export async function readPackage(folder: string): Promise<{ ok: true; pkg: unknown } | { ok: false; error: string }> {
  const file = path.join(folder, 'package.json')
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, error: `no package.json in ${folder}` }
    return { ok: false, error: `${file} cannot be read: ${(e as Error).message}` }
  }
  try {
    // A byte order mark first, as Windows PowerShell 5.1 and older Notepad write one, is skipped as npm skips it
    return { ok: true, pkg: JSON.parse(text.replace(/^\uFEFF/, '')) }
  } catch {
    return { ok: false, error: `${file} is not JSON` }
  }
}
