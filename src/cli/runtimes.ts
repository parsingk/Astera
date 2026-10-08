// `astera runtimes add | list | remove` (remote runtime design §4.4, §4.5, N8): this machine's list of paired Runtimes,
// the controller side of pairing. Answered in the CLI process: the profiles and their tokens live in
// `<profile>/runtimes/` through the secret store, and a token is never printed, never read from an argument and never
// put in the environment. `remove` forgets a Runtime here; it does not revoke the pairing there (§4.5).
import path from 'node:path'
import { openSecretStore } from '../core/secrets/secretStore'
import { openRuntimeRegistry, type RuntimeProfile, type RuntimeRegistry } from '../core/runtimes/registry'
import { parsePairing } from '../core/remote/pairing'
import { GATEWAY_PROTOCOL } from '../core/remote/frames'
import { RemoteError, type RuntimeLink } from '../core/remote/client'
import { remoteCodeOf, type CliError } from '../core/orchestration/cliOutput'
import { REMOTE_DEFAULTS } from '../core/remote/settings'

export interface RuntimesDeps {
  registry(): Promise<RuntimeRegistry>
  /** A pinned TLS connection (core/remote/client.ts `connectRuntime`). */
  connect(o: { host: string; port: number; pin: string }): Promise<RuntimeLink>
  hostname(): string
  now(): string
  version: string
  /** How long one step of a pairing (connect and redeem, then connect and sign in) may take; PAIR_STEP_MS when left out. */
  timeoutMs?: number
}

/** Second pass RR-5: a mistyped or firewalled address held a pairing for the OS's connect wait (two minutes on Linux), and
 *  a Runtime that never answered held it for good. */
export const PAIR_STEP_MS = 30_000

/** Connects, runs `f` on the link and closes it, all within `ms`; past it the link is closed and the step is
 *  RUNTIME_OFFLINE. */
function boundedStep<T>(d: RuntimesDeps, to: { host: string; port: number; pin: string }, f: (link: RuntimeLink) => Promise<T>): Promise<T> {
  const ms = d.timeoutMs ?? PAIR_STEP_MS
  let link: RuntimeLink | null = null
  let late = false
  const work = (async () => {
    const l = await d.connect(to)
    if (late) {
      l.close()
      throw new Error('late')
    }
    link = l
    try {
      return await f(l)
    } finally {
      l.close()
    }
  })()
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      late = true
      ;(link as RuntimeLink | null)?.close()
      reject(Object.assign(new Error(`the Runtime did not answer within ${Math.round(ms / 1000)} s`), { code: 'RUNTIME_OFFLINE' }))
    }, ms)
    work.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e))
    )
  })
}

type Result = { ok: true; body: unknown } | { ok: false; error: CliError }

const failure = (code: CliError['code'], message: string, details?: Record<string, unknown>): Result => ({
  ok: false,
  error: { code, message, ...(details ? { details } : {}) }
})

/** The controller's registry in this profile. */
export const controllerRegistry = (profileDir: string): Promise<RuntimeRegistry> =>
  openRuntimeRegistry(openSecretStore({ dir: path.join(profileDir, 'runtimes'), profileDir }))

/** The profile `key` names: a runtime id exactly, else one name equal to it ignoring case. A name two Runtimes share
 *  is refused with both ids rather than answered with the first (Review Focus 3). */
export function resolveRuntime(list: RuntimeProfile[], key: string): RuntimeProfile | { code: 'RUNTIME_NOT_FOUND'; message: string } {
  const byId = list.find((r) => r.runtimeId === key)
  const byName = list.filter((r) => r.name.toLowerCase() === key.toLowerCase())
  // One Runtime's id and another's name (review M7): neither is the obvious one, so neither is taken.
  const other = byName.filter((r) => r !== byId)
  if (byId && other.length > 0)
    return { code: 'RUNTIME_NOT_FOUND', message: `${key} is the id of ${byId.runtimeId} and the name of ${other.map((r) => r.runtimeId).join(', ')}; use the other runtime's id, or rename it` }
  if (byId) return byId
  if (byName.length === 1) return byName[0]
  if (byName.length > 1)
    return { code: 'RUNTIME_NOT_FOUND', message: `the name ${key} matches ${byName.map((r) => r.runtimeId).join(', ')}; use the runtime id` }
  return { code: 'RUNTIME_NOT_FOUND', message: `no paired Runtime is called ${key}; \`astera runtimes list\` names them` }
}

/** The code a connection or handshake failure carries, or RUNTIME_OFFLINE for one that never reached the Runtime. */
const codeOfError = (e: unknown): CliError['code'] => {
  const code = e instanceof RemoteError ? e.code : (e as { code?: unknown } | null)?.code
  return remoteCodeOf({ code }) ?? 'RUNTIME_OFFLINE'
}
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A profile as printed: everything but the token, which the registry never hands back with it anyway. */
const shown = (p: RuntimeProfile): Record<string, unknown> => ({
  runtimeId: p.runtimeId,
  name: p.name,
  address: p.address,
  port: p.port,
  fingerprint: p.fingerprint,
  permission: p.permission,
  createdAt: p.createdAt,
  lastSeenAt: p.lastSeenAt
})

/** What a pairing that was redeemed but not kept leaves on the Runtime, and how to clear it. */
const LEFT_BEHIND = 'The Runtime still lists this pairing: run `astera runtime clients` and `astera runtime revoke --id <clientId>` there'

async function add(args: Record<string, unknown>, d: RuntimesDeps): Promise<Result> {
  let address: string
  let port: number
  let code: string
  let fingerprint: string
  if (typeof args.pair === 'string') {
    const parts = parsePairing(args.pair)
    if ('error' in parts) return failure('INVALID_ARGUMENTS', parts.error)
    ;({ address, port, code, fingerprint } = parts)
  } else {
    if (typeof args.address !== 'string' || typeof args.code !== 'string')
      return failure('INVALID_ARGUMENTS', 'runtimes add needs --pair <string>, or --address, --code and --fingerprint')
    // §4.4: the CLI has no prompt to show a key and ask, so the fingerprint is required.
    if (typeof args.fingerprint !== 'string') return failure('INVALID_ARGUMENTS', 'pairing needs the fingerprint the Runtime printed')
    address = args.address
    code = args.code
    fingerprint = args.fingerprint
    port = REMOTE_DEFAULTS.port
  }
  if (args.port !== undefined) {
    const p = Number(args.port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) return failure('INVALID_ARGUMENTS', '--port needs a whole number from 1 to 65535')
    port = p
  }
  // --address wins over the hint the string carries (Tailscale names, NAT).
  if (typeof args.address === 'string' && args.address !== '') address = args.address
  const name = typeof args.name === 'string' && args.name !== '' ? args.name : d.hostname()
  const client = { name: 'astera cli', version: d.version, surface: 'cli' as const }

  // The pin is checked on the TLS handshake, before any frame (§3.2): a different key never sees the code.
  let paired: { clientId: string; token: string }
  try {
    paired = await boundedStep(d, { host: address, port, pin: fingerprint }, (link) => link.redeem(code, name, client))
  } catch (e) {
    return failure(codeOfError(e), `pairing with ${address}:${port} failed: ${messageOf(e)}`)
  }
  // A new connection with the new token reads who the Runtime is and what this pairing may do.
  let hello: Awaited<ReturnType<RuntimeLink['auth']>>
  try {
    hello = await boundedStep(d, { host: address, port, pin: fingerprint }, (link) => link.auth(paired.token, client))
  } catch (e) {
    // The code is spent and the Runtime keeps a pairing whose token is now lost (review M5): say how to clear it.
    return failure(codeOfError(e), `paired with ${address}:${port}, but the first sign-in failed: ${messageOf(e)}. ${LEFT_BEHIND}`)
  }
  if (hello.gatewayProtocol !== GATEWAY_PROTOCOL)
    return failure(
      'RUNTIME_PROTOCOL_MISMATCH',
      `the Runtime speaks remote protocol ${hello.gatewayProtocol} and this build speaks ${GATEWAY_PROTOCOL}; update the older side and pair again. ${LEFT_BEHIND}`
    )
  const profile: RuntimeProfile = {
    runtimeId: hello.runtimeId,
    name: typeof args.name === 'string' && args.name !== '' ? args.name : hello.displayName,
    address,
    port,
    fingerprint,
    permission: hello.permission,
    createdAt: d.now(),
    lastSeenAt: d.now()
  }
  try {
    await (await d.registry()).add(profile, paired.token)
  } catch (e) {
    return failure('FAILED', `paired, but this machine could not keep the pairing: ${messageOf(e)}`)
  }
  return { ok: true, body: shown(profile) }
}

export async function runRuntimesCommand(cmd: string, args: Record<string, unknown>, d: RuntimesDeps): Promise<Result> {
  switch (cmd) {
    case 'runtimes-add':
      return add(args, d)
    case 'runtimes-list':
      return { ok: true, body: (await (await d.registry()).list()).map(shown) }
    case 'runtimes-remove': {
      if (typeof args.id !== 'string' || args.id === '') return failure('INVALID_ARGUMENTS', 'runtimes remove needs --id <runtimeId|name>')
      const reg = await d.registry()
      const found = resolveRuntime(await reg.list(), args.id)
      if ('code' in found) return failure(found.code, found.message)
      await reg.remove(found.runtimeId)
      return {
        ok: true,
        body: {
          removed: found.runtimeId,
          // §4.5: forgetting here leaves the pairing standing there until it is revoked on the Runtime.
          revoked: false,
          note: `${found.name} still lists this machine until \`astera runtime revoke\` runs there`
        }
      }
    }
    default:
      return failure('INVALID_ARGUMENTS', `unknown runtimes command ${cmd}`)
  }
}
