// `<profile>/remote-runtime.json` (remote runtime design §2.9, §4.6): whether this machine accepts remote controllers,
// and where it listens. Not a secret, so it sits in the profile root beside the other settings. `astera runtime
// start` and `stop` write it; every Host start reads it (N4); `serve` only ever reads it (X1-13).
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

export interface RemoteSettings {
  enabled: boolean
  listen: string
  port: number
}

/** Off by default, and loopback when on until a private address is chosen (§4.3); the port is DC-10's. */
export const REMOTE_DEFAULTS: RemoteSettings = { enabled: false, listen: '127.0.0.1', port: 47831 }

const FILE = 'remote-runtime.json'

/** A settings file that is there and cannot be read: refused, never read as "off". */
export class RemoteSettingsUnreadable extends Error {
  readonly code = 'REMOTE_SETTINGS_UNREADABLE'
  readonly file = FILE
}

const problem = (s: RemoteSettings): string | null => {
  if (typeof s.enabled !== 'boolean') return 'enabled must be true or false'
  if (typeof s.listen !== 'string' || s.listen.trim() === '') return 'listen must be an address'
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return 'port must be a whole number from 1 to 65535'
  return null
}

export async function readRemoteSettings(profileDir: string): Promise<RemoteSettings> {
  let text: string
  try {
    text = await fs.readFile(path.join(profileDir, FILE), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...REMOTE_DEFAULTS }
    throw e
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new RemoteSettingsUnreadable(`${FILE} is not JSON; fix it or run \`astera runtime stop\` to rewrite it`)
  }
  const s = { ...REMOTE_DEFAULTS, ...(parsed as Partial<RemoteSettings>) }
  const why = problem(s)
  if (why) throw new RemoteSettingsUnreadable(`${FILE}: ${why}`)
  return s
}

/** Merges `patch` over what is there and writes the result whole, through a temp file and a rename. */
export async function writeRemoteSettings(profileDir: string, patch: Partial<RemoteSettings>): Promise<RemoteSettings> {
  const current = await readRemoteSettings(profileDir).catch((e: unknown) => {
    // A broken file is replaced by a write: writing is how a person repairs it.
    if (e instanceof RemoteSettingsUnreadable) return { ...REMOTE_DEFAULTS }
    throw e
  })
  const next = { ...current, ...patch }
  const why = problem(next)
  if (why) throw new Error(why)
  const file = path.join(profileDir, FILE)
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, file)
  return next
}
