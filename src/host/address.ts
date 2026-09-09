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

/** The protocol is part of the address, not something to discover after connecting. From slice 2 a
 *  Host holds live terminals, so an app that cannot speak its protocol must not reach it at all —
 *  and an address that already says which protocol lives there makes that impossible rather than
 *  merely handled. */
export function hostAddress(a: {
  profileDir: string
  platform: NodeJS.Platform
  tmpDir: string
  protocol: number
}): HostAddress {
  const key = createHash('sha256').update(a.profileDir).digest('hex').slice(0, KEY_LENGTH)
  if (a.platform === 'win32')
    return { address: String.raw`\\.\pipe\astera-host-${key}-v${a.protocol}`, dirToPrepare: null }
  const dir = `${a.tmpDir.replace(/\/+$/, '')}/astera-host-${key}-v${a.protocol}`
  return { address: `${dir}/sock`, dirToPrepare: dir }
}

/**
 * Tells a Host at any older protocol's address to leave. Its terminals end with it — surviving an
 * update is not a promise this app makes, and the alternative is a Host the new app can neither show
 * nor stop (design §9).
 *
 * `connect` is injected: it writes one line to an address and reports whether anything was there.
 */
export async function retireOlderHosts(a: {
  profileDir: string
  platform: NodeJS.Platform
  tmpDir: string
  protocol: number
  connect(address: string, line: string): Promise<boolean>
  log(m: string): void
}): Promise<number> {
  let retired = 0
  for (let v = 1; v < a.protocol; v++) {
    const { address } = hostAddress({ profileDir: a.profileDir, platform: a.platform, tmpDir: a.tmpDir, protocol: v })
    const answered = await a.connect(address, `${JSON.stringify({ t: 'retire' })}\n`)
    if (!answered) continue
    a.log(`a Host speaking protocol ${v} was asked to leave; its terminals end with it`)
    retired += 1
  }
  return retired
}
