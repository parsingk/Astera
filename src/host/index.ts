// The Astera Host (design §4). Not an Electron app: it is this repository's third main-process
// bundle, run as plain Node through the app's own binary with ELECTRON_RUN_AS_NODE=1, the way the
// `astera` CLI shuttle already avoids shipping a Node binary.
//
// Everything it needs arrives in the environment, because it has no `app.getPath('userData')` to ask.
import os from 'node:os'
import path from 'node:path'
import { hostAddress } from './address'
import { openHostLog } from './log'
import { startHostServer, ADDRESS_TAKEN } from './server'

/** With no client for this long, there is nothing for the Host to be. Slice 2 adds "and no session is
 *  alive" to this, and slice 3 adds "and no Run is in progress" (design §8). */
const IDLE_MS = 60_000

async function main(): Promise<void> {
  const profileDir = process.env.ASTERA_HOST_PROFILE_DIR
  if (!profileDir) {
    process.stderr.write('astera-host: ASTERA_HOST_PROFILE_DIR is required\n')
    process.exit(2)
  }
  const log = openHostLog({ path: process.env.ASTERA_HOST_LOG ?? path.join(profileDir, 'host', 'host.log') })
  const addr = hostAddress({ profileDir, platform: process.platform, tmpDir: os.tmpdir() })

  let server: Awaited<ReturnType<typeof startHostServer>>
  try {
    server = await startHostServer({
      address: addr.address,
      dirToPrepare: addr.dirToPrepare,
      version: process.env.ASTERA_HOST_VERSION ?? '0.0.0',
      idleMs: IDLE_MS,
      onIdle: () => {
        void server.close().then(() => process.exit(0))
      },
      log
    })
  } catch (err) {
    // Losing the bind race is the normal outcome of two apps starting at once, and it is not a
    // failure: the other Host serves them both.
    const taken = err instanceof Error && err.message === ADDRESS_TAKEN
    log.write(taken ? 'another Host already serves this profile — leaving' : `could not listen: ${String(err)}`)
    process.exit(0)
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      log.write(`${signal} — leaving`)
      void server.close().then(() => process.exit(0))
    })
}

void main()
