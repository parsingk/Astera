// The MCP Gateway as the Host runs it (Agent Control Plane release 2, Gateway design §4.1): the token table watching the
// Host's two registries, the upstream pool and the HTTP listener. The listener is open for the Host's whole life: it
// serves the shared stdio servers and the loopback route a sandboxed session reaches the Host by (sandbox design §6).
import { readExtensionRegistry } from '../../core/extensions/registry'
import { hideExtensionSecrets } from '../../core/extensions/secrets'
import type { PtyRegistry } from '../registry'
import type { ProcRegistry } from '../procRegistry'
import { createTokenTable, watchGatewayTokens } from './tokens'
import { createUpstreamPool, type UpstreamState } from './upstream'
import { createGateway } from './server'

export interface GatewayHub {
  /** Opens the listener if it is not open (it stays open for the Host's life: sandboxed sessions reach the Host through
   *  it) and stops the upstream servers when the registry shares none; answers the port, or null before it has opened. */
  sync(): Promise<number | null>
  port(): number | null
  /** The app session id of a live workload token, or null. */
  sessionOfToken(token: string): string | null
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
  /** The app session a pty or proc id belongs to, for `sessionOfToken` (the workload token). */
  sessionOfOwner: (ownerId: string) => string | undefined
  /** Each session's tool call through the Gateway, for its credential-use record (credentials design §6). */
  onToolCall?: Parameters<typeof createGateway>[0]['onToolCall']
  /** The Host's commands, for `POST /astera/call`. Absent, that route answers 501. */
  call?: Parameters<typeof createGateway>[0]['call']
  /** Sends a message to every socket the Host holds, for a command's state change. */
  broadcast?: Parameters<typeof createGateway>[0]['broadcast']
}): GatewayHub {
  const tokens = createTokenTable(d.sessionOfOwner, d.log)
  const pool = createUpstreamPool({ profileDir: d.profileDir, baseEnv: d.baseEnv ?? process.env, log: d.log })
  const readRegistry = () => readExtensionRegistry(d.profileDir)
  const gateway = createGateway({
    tokens,
    pool,
    readRegistry,
    log: d.log,
    hide: (s) => hideExtensionSecrets(d.profileDir, s).catch(() => s),
    ...(d.onToolCall ? { onToolCall: d.onToolCall } : {}),
    ...(d.call ? { call: d.call } : {}),
    ...(d.broadcast ? { broadcast: d.broadcast } : {})
  })
  watchGatewayTokens({ ptys: d.ptys, procs: d.procs, table: tokens, onForget: (t) => gateway.forgetTokens(t) })

  // One sync at a time: a registry change and a spawn's prepare may both ask
  let chain: Promise<number | null> = Promise.resolve(null)
  const syncNow = async (): Promise<number | null> => {
    // Listening comes first and does not depend on the registry: the loopback route is the way in for a session that
    // cannot open the Host's pipe, whether or not anything is shared
    if (gateway.port() === null) {
      const port = await gateway.listen()
      d.log(`gateway: listening on 127.0.0.1:${port}`)
    }
    let wanted: boolean
    try {
      wanted = (await readRegistry()).entries.some((e) => e.kind === 'mcp' && e.enabled && e.transport === 'stdio')
    } catch (err) {
      // A damaged registry changes nothing about the servers running; the person repairs it in the app
      d.log(`gateway: the registry could not be read (${err instanceof Error ? err.message : String(err)})`)
      return gateway.port()
    }
    if (!wanted && pool.states().length > 0) {
      await pool.close()
      d.log('gateway: no stdio server is shared, the servers that ran were stopped')
    }
    return gateway.port()
  }

  return {
    sync: () => {
      chain = chain.then(syncNow, syncNow)
      return chain
    },
    port: () => gateway.port(),
    sessionOfToken: (token) => tokens.sessionOf(token),
    states: () => pool.states(),
    stopServer: (serverId) => pool.stopServer(serverId),
    close: async () => {
      await gateway.close()
      await pool.close()
    }
  }
}
