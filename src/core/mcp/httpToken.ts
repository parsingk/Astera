// The token file of the MCP HTTP entrance: <profileDir>/mcp-http-token, one line, 32 random bytes in
// base64url (MCP HTTP F1 design §2). Written by the app, re-read by the HTTP process on change.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs, type Stats } from 'node:fs'
import path from 'node:path'
import { readFileRetrying, renameRetrying } from '../renameRetry'

export function tokenPath(profileDir: string): string {
  return path.join(profileDir, 'mcp-http-token')
}

async function writeToken(profileDir: string, token: string): Promise<void> {
  const file = tokenPath(profileDir)
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await fs.mkdir(profileDir, { recursive: true })
  try {
    await fs.writeFile(tmp, `${token}\n`, { mode: 0o600 })
    await renameRetrying(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

const STAT_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
const STAT_TRIES = 5

const freshToken = (): string => randomBytes(32).toString('base64url')

/** The token on disk, created (atomically) when the file is missing or empty. Only the Host calls it, before
 *  it starts the entrance (host/mcpHttp.ts), one start at a time; the app only reads the file or calls
 *  `newToken`. Two concurrent calls on a missing file would both write and the later one would win. */
export async function ensureToken(profileDir: string): Promise<string> {
  const existing = await readTokenFile(tokenPath(profileDir))
  if (existing) return existing
  const token = freshToken()
  await writeToken(profileDir, token)
  return token
}

/** Replaces the token; the old one stops matching at the next request of the HTTP process. */
export async function newToken(profileDir: string): Promise<string> {
  const token = freshToken()
  await writeToken(profileDir, token)
  return token
}

async function readTokenFile(file: string): Promise<string | null> {
  try {
    return (await readFileRetrying(file)).trim() || null
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** `fs.stat`, retried on the busy errors Windows gives for a moment while another process holds the
 *  file, the way readFileRetrying retries a read. The last error is thrown. */
async function statRetrying(file: string): Promise<Stats> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fs.stat(file)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (attempt >= STAT_TRIES || !STAT_BUSY.has(code)) throw err
      await new Promise((r) => setTimeout(r, 10 + attempt * 10))
    }
  }
}

/** Reads the file again only when its inode, ctime, mtime or size changed since the last read. A missing or empty
 *  file is null. */
export function createTokenReader(file: string): { current(): Promise<string | null> } {
  let stamp = ''
  let cached: string | null = null
  return {
    async current() {
      let next: string
      try {
        const st = await statRetrying(file)
        // Every token file has the same size and a POSIX mtime is coarse, so the inode (a rename lands a
        // new one) and the ctime are part of the stamp: two quick rotations must not look alike.
        next = `${st.ino}:${st.ctimeMs}:${st.mtimeMs}:${st.size}`
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        stamp = ''
        cached = null
        return null
      }
      if (next !== stamp) {
        cached = await readTokenFile(file)
        stamp = next
      }
      return cached
    }
  }
}

/** Constant-time compare; false when the lengths differ or the expected token is empty. */
export function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}
