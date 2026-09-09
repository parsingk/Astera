// Where the Host listens. Derived from the profile directory, so the dev app, the installed app and
// a throwaway verification profile each get their own Host and never meet (design §5).
//
// Pure, and the platform arrives as an argument rather than being read from `process`: this module's
// tests run on windows, macos and ubuntu, and a module that asks the host which platform it is on
// can only be tested on one of them.
import { createHash } from 'node:crypto'

/** Long enough that two profiles on one machine will not collide, short enough to keep the posix
 *  socket path far inside its ~104 byte limit. */
const KEY_LENGTH = 12

export interface HostAddress {
  /** What `net.createServer().listen()` and `net.connect()` take. */
  address: string
  /** posix only: the directory to create with mode 0700 *before* binding, so the socket is never
   *  briefly world-reachable. Locking the directory rather than the socket file is what removes that
   *  window — a socket created and then chmoded has one. null on win32, where the pipe's own default
   *  security descriptor already admits only this user and administrators. */
  dirToPrepare: string | null
}

export function hostAddress(a: {
  profileDir: string
  platform: NodeJS.Platform
  tmpDir: string
}): HostAddress {
  const key = createHash('sha256').update(a.profileDir).digest('hex').slice(0, KEY_LENGTH)
  if (a.platform === 'win32')
    return { address: String.raw`\\.\pipe\astera-host-${key}`, dirToPrepare: null }
  const dir = `${a.tmpDir.replace(/\/+$/, '')}/astera-host-${key}`
  return { address: `${dir}/sock`, dirToPrepare: dir }
}
