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
   *  window — a socket created and then chmoded has one.
   *
   *  **null on win32, and that is not the same as "the pipe is private".** An earlier note here said
   *  the default security descriptor admits only this user and administrators. Measured 2026-09-21,
   *  it does not: `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;;FR;;;WD)(A;;FR;;;AN)` — Everyone and
   *  ANONYMOUS LOGON both get FILE_GENERIC_READ. Node's `net` has no way to set a pipe's ACL, so
   *  there is nothing to return here. What keeps another local user from hearing anything is that
   *  read access alone cannot complete the handshake, and the Host broadcasts only to peers that
   *  have (`greetedSockets` in server.ts). */
  dirToPrepare: string | null
}

/** Where every named pipe lives on win32. Listing it lists the pipes that exist right now. */
const PIPE_DIR = '\\\\.\\pipe\\'

/** The protocol is part of the address, not something to discover after connecting. From slice 2 a
 *  Host holds live terminals, so an app that cannot speak its protocol must not reach it at all —
 *  and an address that already says which protocol lives there makes that impossible rather than
 *  merely handled.
 *
 *  Protocol 1 gets no suffix: that is the name version 1 already called itself, before this existed,
 *  and giving it a `-v1` it never bound would make `retireOlderHosts` probe an address no v1 Host has
 *  ever listened on. The suffix marks protocols after the first; the original's name is its own. */
export function hostAddress(a: {
  profileDir: string
  platform: NodeJS.Platform
  tmpDir: string
  protocol: number
}): HostAddress {
  const key = createHash('sha256').update(a.profileDir).digest('hex').slice(0, KEY_LENGTH)
  const name = a.protocol === 1 ? `astera-host-${key}` : `astera-host-${key}-v${a.protocol}`
  if (a.platform === 'win32') return { address: PIPE_DIR + name, dirToPrepare: null }
  const dir = `${a.tmpDir.replace(/\/+$/, '')}/${name}`
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

/**
 * The addresses of this profile's Hosts at **other** protocol versions that exist right now, with
 * the protocol each one names. `list` reads a directory's entry names.
 *
 * **Why a CLI needs this** (conformance audit #12). The protocol is part of the address (above), so
 * a CLI of another build asks its own address, finds nobody, and would read the state file a live
 * Host is writing. Before it trusts "nobody is there" it asks whether a sibling is.
 *
 * **Listed rather than enumerated**, so a newer protocol than this build knows is found too. On
 * win32 the pipe namespace is listable and a pipe is there only while a server holds it. On posix
 * the entries are the per-address directories under the temp folder, and a directory can outlive
 * its Host, so an entry found here is a candidate: the caller still has to connect to it. A listing
 * that cannot be read finds nothing, which is the answer this path gave before the check existed.
 */
export function siblingHostAddresses(a: {
  profileDir: string
  platform: NodeJS.Platform
  tmpDir: string
  protocol: number
  list(dir: string): readonly string[]
}): { protocol: number; address: string }[] {
  const base = hostAddress({ ...a, protocol: 1 }).address
  const stem = a.platform === 'win32' ? base.slice(PIPE_DIR.length) : base.split('/').slice(-2)[0]
  const dir = a.platform === 'win32' ? PIPE_DIR : a.tmpDir.replace(/\/+$/, '')
  let names: readonly string[]
  try {
    names = a.list(dir)
  } catch {
    return []
  }
  const found: { protocol: number; address: string }[] = []
  for (const name of names) {
    const m = name === stem ? ['', '1'] : new RegExp(`^${stem}-v(\\d+)$`).exec(name)
    if (m === null) continue
    const protocol = Number(m[1])
    if (protocol === a.protocol) continue
    found.push({ protocol, address: hostAddress({ ...a, protocol }).address })
  }
  return found.sort((x, y) => x.protocol - y.protocol)
}
