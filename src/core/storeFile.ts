// Reading a JSON store's file so that "could not read it" is never taken for "it is damaged" (audit U-1). A store that
// took any read error but ENOENT for damage started empty, and its next write erased the file it never saw: on win32
// a file another process is renaming at that instant answers EPERM. The rule, as worktrees/registry.ts has it:
// nothing read, nothing healed.
import { promises as fs } from 'node:fs'
import { readFileRetrying } from './renameRetry'

export type StoreRead = { kind: 'missing' } | { kind: 'unreadable'; error: unknown } | { kind: 'text'; text: string }

/** The file's text, read with the rename retries; `missing` for ENOENT and ENOTDIR (a path under a file, which POSIX
 *  answers where win32 says ENOENT: no file can be there), `unreadable` for any other error. */
export async function readStoreFile(file: string): Promise<StoreRead> {
  try {
    return { kind: 'text', text: await readFileRetrying(file) }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
    return { kind: 'unreadable', error: e }
  }
}

/** Keeps the bytes of a damaged file beside it: `<file>.bak`, or a stamped name when one is already there, so a
 *  second damage never writes over the copy of the first. Never throws. */
export async function keepDamaged(file: string, text: string): Promise<void> {
  const plain = `${file}.bak`
  const taken = await fs.stat(plain).then(
    () => true,
    () => false
  )
  const target = taken ? `${file}.${Date.now()}-${process.pid}.bak` : plain
  await fs.writeFile(target, text, { encoding: 'utf8', flag: 'wx' }).catch(() => {})
}

/** A store whose file could not be read refuses to write over it (audit U-1). */
export class StoreUnread extends Error {
  constructor(file: string, cause: unknown) {
    super(`${file} could not be read (${cause instanceof Error ? cause.message : String(cause)}); it is not written over`)
    this.name = 'StoreUnread'
  }
}
