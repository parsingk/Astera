// The MCP Gateway as the Host runs it (Agent Control Plane release 2, Gateway design §4.1): the token table watching the
// Host's two registries, the upstream pool and the HTTP listener, opened only while the registry shares an enabled
// stdio server and closed when it shares none, so a profile that shares nothing opens no port (anti-goal 1).
import { readExtensionRegistry } from '../../core/extensions/registry'
import { hideExtensionSecrets } from '../../core/extensions/secrets'
import type { PtyRegistry } from '../registry'
import type { ProcRegistry } from '../procRegistry'
import { createTokenTable, watchGatewayTokens } from './tokens'
import { createUpstreamPool, type UpstreamState } from './upstream'
import { createGateway } from './server'

export interface GatewayHub {
  /** Opens or closes the listener for what the registry shares now; answers the port, or null when closed. */
  sync(): Promise<number | null>
  port(): number | null
  states(): UpstreamState[]
  stopServer(serverId: string): Promise<void>
  close(): Promise<void>
}

export function createGatewayHub(d: {
  profileDir: string
  ptys: Pick<PtyRegistry, 'open' | 'onExit'>
  procs: Pick<ProcRegistry, 'open' | 'onExit'>
  log: (line: string) => void
  baseEnv?: NodeJS.ProcessEnv
}): GatewayHub {
  const tokens = createTokenTable()
  const pool = createUpstreamPool({ profileDir: d.profileDir, baseEnv: d.baseEnv ?? process.env, log: d.log })
  const readRegistry = () => readExtensionRegistry(d.profileDir)
  const gateway = createGateway({ tokens, pool, readRegistry, log: d.log, hide: (s) => hideExtensionSecrets(d.profileDir, s).catch(() => s) })
  watchGatewayTokens({ ptys: d.ptys, procs: d.procs, table: tokens, onForget: (t) => gateway.forgetTokens(t) })

  // One sync at a time: a registry change and a spawn's prepare may both ask
  let chain: Promise<number | null> = Promise.resolve(null)
  const syncNow = async (): Promise<number | null> => {
    let wanted: boolean
    try {
      wanted = (await readRegistry()).entries.some((e) => e.kind === 'mcp' && e.enabled && e.transport === 'stdio')
    } catch (err) {
      // A damaged registry changes nothing about a listener already open; the person repairs it in the app
      d.log(`gateway: the registry could not be read (${err instanceof Error ? err.message : String(err)})`)
      return gateway.port()
    }
    if (wanted && gateway.port() === null) {
      const port = await gateway.listen()
      d.log(`gateway: listening on 127.0.0.1:${port}`)
    } else if (!wanted && gateway.port() !== null) {
      await gateway.close()
      await pool.close()
      d.log('gateway: closed, no stdio server is shared')
    }
    return gateway.port()
  }

  return {
    sync: () => {
      chain = chain.then(syncNow, syncNow)
      return chain
    },
    port: () => gateway.port(),
    states: () => pool.states(),
    stopServer: (serverId) => pool.stopServer(serverId),
    close: async () => {
      await gateway.close()
      await pool.close()
    }
  }
}
