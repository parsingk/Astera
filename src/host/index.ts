// The Astera Host (design §4). Not an Electron app: it is this repository's third main-process
// bundle, run as plain Node through the app's own binary with ELECTRON_RUN_AS_NODE=1, the way the
// `astera` CLI shuttle already avoids shipping a Node binary.
//
// Everything it needs arrives in the environment, because it has no `app.getPath('userData')` to ask.
import os from 'node:os'
import path from 'node:path'
import * as pty from 'node-pty'
import { hostAddress } from './address'
import { openHostLog } from './log'
import { startHostServer, ADDRESS_TAKEN } from './server'
import { PtyRegistry } from './registry'
import { attachPtyHost } from './ptyHost'
import { HOST_PROTOCOL } from '../core/host/protocol'

/** With no client for this long, there is nothing for the Host to be. Slice 2 adds "and no session is
 *  alive" to this, and slice 3 adds "and no Run is in progress" (design §8). */
const IDLE_MS = 60_000

/** How long the Host lets its own event loop turn after ending its sessions, before calling exit.
 *  Measured on win32: exit() called in the same turn as the kill never returns and never exits — it
 *  blocks inside node-pty's ConPTY teardown, and the pty exit callbacks never even run. One turn is
 *  enough for that teardown to finish, and exit() then works. */
const EXIT_SETTLE_MS = 300
/** The net under that, for a teardown that does not finish. A Host that has closed its address and
 *  ended its sessions has nothing left to do gracefully, and one that will not leave is worse than
 *  one that leaves hard: it holds the address's twin, and it is invisible outside Task Manager. */
const EXIT_HAMMER_MS = 1_500

async function main(): Promise<void> {
  const profileDir = process.env.ASTERA_HOST_PROFILE_DIR
  if (!profileDir) {
    process.stderr.write('astera-host: ASTERA_HOST_PROFILE_DIR is required\n')
    process.exit(2)
  }
  const log = openHostLog({ path: process.env.ASTERA_HOST_LOG ?? path.join(profileDir, 'host', 'host.log') })
  const addr = hostAddress({ profileDir, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })

  // The Host is where node-pty lives now. `withExitedPtyGuard`'s job — swallowing a write or resize
  // to a pty that has already gone — is the registry's `live` check here instead: it knows which
  // sessions have exited, and the app across the socket does not.
  const registry = new PtyRegistry({
    spawn: (file, args, opts) => pty.spawn(file, args, { name: 'xterm-256color', ...opts }),
    log: (m) => log.write(m)
  })
  let handlePty: ReturnType<typeof attachPtyHost> | null = null

  let server: Awaited<ReturnType<typeof startHostServer>>
  /** Every way out goes through here, and it ends the process whatever happened on the way. An earlier
   *  version put `process.exit(0)` after `killAll()` inside a `.then()` that nothing caught, and on
   *  win32 that was not theoretical: node-pty's ConPTY kill runs a helper process to enumerate the
   *  console, the helper fails under ELECTRON_RUN_AS_NODE ("AttachConsole failed"), and the throw
   *  reached the promise. The Host then sat there with its pipe closed and its sessions still running,
   *  and the rejection went nowhere because the promise was only `void`ed. The registry guards each
   *  kill now, and this guards the rest of the path. */
  const leave = (why?: string): void => {
    // The idle and retire paths have already said why in the server's own log line; a signal has not.
    if (why) log.write(`${why} — leaving`)
    void server
      .close()
      .catch((err) => log.write(`the server did not close cleanly: ${String(err)}`))
      .finally(() => {
        registry.killAll()
        // Both deferred, and both unref'd: see EXIT_SETTLE_MS. Unref'd so that a Host whose loop
        // empties on its own is not held open by its own way out.
        setTimeout(() => process.exit(0), EXIT_SETTLE_MS).unref()
        setTimeout(() => process.kill(process.pid, 'SIGKILL'), EXIT_HAMMER_MS).unref()
      })
  }

  try {
    server = await startHostServer({
      address: addr.address,
      dirToPrepare: addr.dirToPrepare,
      version: process.env.ASTERA_HOST_VERSION ?? '0.0.0',
      idleMs: IDLE_MS,
      onIdle: () => leave(),
      onMessage: (m, send) => handlePty?.(m, send) ?? false,
      holdsWork: () => registry.liveCount() > 0,
      log
    })
  } catch (err) {
    // Losing the bind race is the normal outcome of two apps starting at once, and it is not a
    // failure: the other Host serves them both.
    const taken = err instanceof Error && err.message === ADDRESS_TAKEN
    log.write(taken ? 'another Host already serves this profile — leaving' : `could not listen: ${String(err)}`)
    process.exit(0)
  }

  handlePty = attachPtyHost({ registry, broadcast: (m) => server.broadcast(m) })

  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => leave(signal))
}

void main()
