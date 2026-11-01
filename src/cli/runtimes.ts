// `astera runtimes add | list | remove` (remote runtime design §4.4, §4.5, N8): this machine's list of paired Runtimes,
// the controller side of pairing. Answered in the CLI process: the profiles and their tokens live in
// `<profile>/runtimes/` through the secret store, and a token is never printed, never read from an argument and never
// put in the environment. `remove` forgets a Runtime here; it does not revoke the pairing there (§4.5).
//
// `get`, `ping` and `expect` (remote governance design §10.2): `get` reads a Runtime's report, keeps it as the last
// snapshot (§5.4) and compares it with this computer's extensions; `ping` asks whether it answers; `expect` edits which of
// this computer's extensions the person expects there (§6.1). `expect` changes only this computer's registry, so the
// sandboxed-session gate on `--runtime` changes (§7.4) does not apply to it (ruling R14-1). Nothing installs there.
import path from 'node:path'
import { openSecretStore } from '../core/secrets/secretStore'
import { factsNoter, openRuntimeRegistry, seenRecorder, SNAPSHOT_TOO_LARGE, type RuntimeProfile, type RuntimeRegistry } from '../core/runtimes/registry'
import { parsePairing } from '../core/remote/pairing'
import { GATEWAY_PROTOCOL, type ClientInfo, type HelloFrame } from '../core/remote/frames'
import { RemoteError, type RuntimeLink } from '../core/remote/client'
import { openRemoteLink, type RemoteLink, type RemoteTarget } from '../core/remote/link'
import { readRuntimeReport } from '../core/controlPlane/read'
import { runtimeDetail } from '../core/controlPlane/detail'
import { liveExpected } from '../core/controlPlane/compare'
import type { ReportExtension } from '../core/controlPlane/report'
import { CLI_ERROR_CODES, remoteCodeOf, type CliError } from '../core/orchestration/cliOutput'
import { REMOTE_DEFAULTS } from '../core/remote/settings'
import { t } from '../core/i18n'
import { LINK_FAILURE_KEYS } from '../core/remote/linkFailures'

export interface RuntimesDeps {
  registry(): Promise<RuntimeRegistry>
  /** A pinned TLS connection (core/remote/client.ts `connectRuntime`). */
  connect(o: { host: string; port: number; pin: string }): Promise<RuntimeLink>
  hostname(): string
  now(): string
  version: string
  /** How long one step of a pairing (connect and redeem, then connect and sign in) may take; PAIR_STEP_MS when left out. */
  timeoutMs?: number
  /** Who asks: the app has no --replace to point at (final review M-4). */
  surface?: 'app' | 'cli'
  /** Whether a person or an agent session asks (remote governance design §7.1), said at the first sign-in. Absent means
   *  an agent. */
  agent?: boolean
  /** The controller link `get` and `ping` open (core/remote/link.ts `openRemoteLink` when left out). */
  link?(t: RemoteTarget, o: { onHello(h: HelloFrame): void; client: ClientInfo; reconnectForMs?: number }): RemoteLink
  /** This computer's extensions as a report gives them (core/controlPlane/local.ts), for `get` and `expect`. */
  localExtensions?(): Promise<ReportExtension[]>
}

/** Second pass RR-5: a mistyped or firewalled address held a pairing for the OS's connect wait (two minutes on Linux), and
 *  a Runtime that never answered held it for good. */
export const PAIR_STEP_MS = 30_000

/** How long `ping` keeps trying after a connection drops mid-call: the app's APP_RECONNECT_FOR_MS (main/remote/runtimes.ts,
 *  which imports this file, so it is not imported back). A link that never connected answers at once either way. */
export const PING_RECONNECT_FOR_MS = 10_000

/** The refusals `get` answers with the last snapshot and exit 0 (rulings R14-2, R14-3): the Runtime did not answer, or
 *  not in time, or it is too old to report. Any other refusal is the command's error. */
const SNAPSHOT_REFUSALS: ReadonlySet<string> = new Set(['RUNTIME_OFFLINE', 'REMOTE_TIMEOUT', 'RUNTIME_CAPABILITY_MISSING'])

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
    // Trimmed: a value read from stdin (`--code -`, security audit SEC-6) ends in a newline.
    address = args.address.trim()
    code = args.code.trim()
    fingerprint = args.fingerprint.trim()
    port = REMOTE_DEFAULTS.port
  }
  if (args.port !== undefined) {
    const p = Number(args.port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) return failure('INVALID_ARGUMENTS', '--port needs a whole number from 1 to 65535')
    port = p
  }
  // --address wins over the hint the string carries (Tailscale names, NAT).
  if (typeof args.address === 'string' && args.address.trim() !== '') address = args.address.trim()
  const name = typeof args.name === 'string' && args.name !== '' ? args.name : d.hostname()
  const client = { name: 'astera cli', version: d.version, surface: 'cli' as const, agent: d.agent !== false }

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
  let reg: RuntimeRegistry
  try {
    reg = await d.registry()
    await reg.add(profile, paired.token, { replace: args.replace === true })
  } catch (e) {
    // A Runtime makes a new id with every new key (identity.ts), so the same id under another key is another machine
    // claiming to be the paired one (final review M-4).
    if ((e as { code?: unknown }).code === 'RUNTIME_ALREADY_PAIRED')
      return failure(
        'CONFLICT',
        `${messageOf(e)}. A Runtime makes a new id with every new key, so another machine is claiming to be it, and this pairing was not kept.${
          d.surface === 'app' ? '' : ' If you know why and want it to take that place, run astera runtimes add again with --replace.'
        } ${LEFT_BEHIND}`
      )
    return failure('FAILED', `paired, but this machine could not keep the pairing: ${messageOf(e)}`)
  }
  // The pairing keeps no facts (registry.ts `add`): the sign-in hello's are noted as every later hello's are (§4.1)
  await factsNoter(reg, profile.runtimeId, undefined)(hello)
  return { ok: true, body: shown(profile) }
}

/** The paired Runtime `--id` names, or the refusal. */
async function named(verb: string, args: Record<string, unknown>, reg: RuntimeRegistry): Promise<RuntimeProfile | Result> {
  if (typeof args.id !== 'string' || args.id === '') return failure('INVALID_ARGUMENTS', `runtimes ${verb} needs --id <runtimeId|name>`)
  const r = resolveRuntime(await reg.list(), args.id)
  return 'code' in r ? failure(r.code, r.message) : r
}
const isResult = (v: object): v is Result => 'ok' in v

/** This computer's extensions, or why they cannot be compared: an empty list would call every entry there "only there". */
async function localOf(d: RuntimesDeps): Promise<ReportExtension[] | Result> {
  if (!d.localExtensions) return failure('FAILED', "this caller cannot read this computer's extensions")
  try {
    return await d.localExtensions()
  } catch (e) {
    return failure('FAILED', `this computer's extensions could not be read: ${messageOf(e)}`)
  }
}

/**
 * Opens a link to `p`, runs `f` on it and closes it, as answerRemote does (cli/remote.ts): each hello's facts are noted
 * and waited for before this returns, since the CLI exits right after (§4.1), and `reached` keeps the time it answered,
 * at most once a minute (§4.2).
 */
async function withLink<T extends object>(
  d: RuntimesDeps,
  reg: RuntimeRegistry,
  p: RuntimeProfile,
  f: (link: RemoteLink, reached: () => Promise<void>) => Promise<T>,
  o: { reconnectForMs?: number } = {}
): Promise<T | Result> {
  const token = await reg.token(p.runtimeId)
  if (token === null) return failure('RUNTIME_NOT_FOUND', `${p.name} has no token on this machine; pair it again with \`astera runtimes add\``)
  const target: RemoteTarget = { runtimeId: p.runtimeId, address: p.address, port: p.port, fingerprint: p.fingerprint, token }
  const note = factsNoter(reg, p.runtimeId, p.facts)
  let noted: Promise<void> = Promise.resolve()
  const onHello = (h: HelloFrame): void => {
    noted = noted.then(() => note(h))
  }
  const client: ClientInfo = { name: 'astera cli', version: d.version, surface: 'cli', agent: d.agent !== false }
  const link = (d.link ?? ((t, lo) => openRemoteLink({ ...lo, target: t })))(target, { onHello, client, ...o })
  try {
    return await f(link, seenRecorder(reg, p.runtimeId, p.lastSeenAt))
  } finally {
    link.close()
    await noted
  }
}

async function get(args: Record<string, unknown>, d: RuntimesDeps): Promise<Result> {
  const reg = await d.registry()
  const p = await named('get', args, reg)
  if (isResult(p)) return p
  const local = await localOf(d)
  if (isResult(local)) return local
  const read = await withLink(d, reg, p, async (link, reached) => {
    // Any reply counts as an answer, a refusal too: only a link failure means the Runtime did not answer
    let answered = false
    let r = await readRuntimeReport({
      hello: () => link.hello(),
      call: async (cmd, a, o) => {
        const reply = await link.call(cmd, a, o)
        if (!(reply instanceof RemoteError)) answered = true
        return reply
      },
      subscribe: (pty, h) => link.subscribe(pty, h),
      close: () => link.close()
    })
    if (answered) await reached()
    // Too large to keep is a report this computer does not take (final review F12): FAILED, the old snapshot kept
    if (r.ok && !(await reg.keepSnapshot(p.runtimeId, { readAt: d.now(), report: r.report }))) r = { ok: false, code: 'FAILED', message: SNAPSHOT_TOO_LARGE }
    return { r, answered }
  })
  if (isResult(read)) return read
  if (!read.r.ok && !SNAPSHOT_REFUSALS.has(read.r.code)) {
    const code = (CLI_ERROR_CODES as readonly string[]).includes(read.r.code) ? (read.r.code as CliError['code']) : 'FAILED'
    return failure(code, read.r.message, { runtime: p.runtimeId, ...(read.r.reason !== undefined && { reason: read.r.reason }) })
  }
  // Read again for what this ask changed: the facts, the snapshot, the time it answered
  const now = (await reg.list()).find((x) => x.runtimeId === p.runtimeId) ?? p
  return {
    ok: true,
    body: runtimeDetail({
      profile: now,
      local,
      here: d.version,
      answering: read.answered,
      ...(read.r.ok ? {} : { refusal: { code: read.r.code, message: read.r.message, ...(read.r.reason !== undefined && { reason: read.r.reason }) } })
    })
  }
}

async function ping(args: Record<string, unknown>, d: RuntimesDeps): Promise<Result> {
  const reg = await d.registry()
  const p = await named('ping', args, reg)
  if (isResult(p)) return p
  const body = await withLink(d, reg, p, async (link, reached) => {
    const r = await link.call('projects-list', {})
    const h = link.hello()
    if (r instanceof RemoteError && Object.hasOwn(LINK_FAILURE_KEYS, r.code))
      // An error and a non-zero exit, as `get` ends with any refusal it does not answer from the snapshot (final review F9)
      return failure(r.code as CliError['code'], t('en', LINK_FAILURE_KEYS[r.code]))
    if (!(r instanceof RemoteError)) await reached()
    return {
      runtimeId: p.runtimeId,
      answers: !(r instanceof RemoteError),
      ...(h && { asteraVersion: h.asteraVersion, platform: h.platform }),
      ...(r instanceof RemoteError && { code: r.code })
    }
  }, { reconnectForMs: PING_RECONNECT_FOR_MS })
  return isResult(body) ? body : { ok: true, body }
}

/** `--add a,b`: the ids, trimmed, empty ones left out; null for a flag given with no value. */
const idsOf = (v: unknown): string[] | null =>
  v === undefined ? [] : typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter((s) => s !== '') : null

async function expectIds(args: Record<string, unknown>, d: RuntimesDeps): Promise<Result> {
  const add = idsOf(args.add)
  const remove = idsOf(args.remove)
  if (add === null || remove === null) return failure('INVALID_ARGUMENTS', '--add and --remove take extension ids, comma separated (from `astera ext list`)')
  // Ruling RF-1: an id taken off the list takes its finding with it, an ignore by another name, so an agent is refused
  // the edit as it is refused an ignore (host/orch.ts AGENT_REFUSAL). Absent means an agent, as at sign-in
  if ((add.length > 0 || remove.length > 0) && d.agent !== false)
    return failure('PERMISSION_DENIED', 'runtimes expect --add/--remove is for a person at their own shell or in the Astera app, not an agent session (ASTERA_SESSION is set)')
  const reg = await d.registry()
  const p = await named('expect', args, reg)
  if (isResult(p)) return p
  const local = await localOf(d)
  if (isResult(local)) return local
  const e = editExpected(p.expected, local, add, remove)
  if (!e.ok) return failure('INVALID_ARGUMENTS', e.message)
  if (e.store) await reg.setExpected(p.runtimeId, e.store)
  return { ok: true, body: { runtimeId: p.runtimeId, expected: e.expected } }
}

/**
 * `expect`'s edit of the kept list, shared with the app's (main/remote/runtimes.ts): `store` is the list to write, null
 * when nothing was asked, and `expected` the ids as read back. §6.1: the list names this computer's entries. An id to
 * remove may instead be one still kept in the list after it was removed here (ruling R14-2), so it can be cleared; any
 * other is refused whole, and nothing is written.
 */
export function editExpected(
  kept: readonly string[] | undefined,
  local: readonly ReportExtension[],
  add: readonly string[],
  remove: readonly string[]
): { ok: true; store: string[] | null; expected: string[] } | { ok: false; message: string } {
  const here = new Set(local.map((e) => e.id))
  const held = kept ?? []
  const unknown = [...add.filter((id) => !here.has(id)), ...remove.filter((id) => !here.has(id) && !held.includes(id))]
  if (unknown.length > 0)
    return { ok: false, message: `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not an extension on this computer; \`astera ext list\` names them` }
  const store = add.length > 0 || remove.length > 0 ? [...held.filter((id) => !remove.includes(id)), ...add] : null
  return { ok: true, store, expected: liveExpected([...new Set(store ?? held)], local) }
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
    case 'runtimes-get':
      return get(args, d)
    case 'runtimes-ping':
      return ping(args, d)
    case 'runtimes-expect':
      return expectIds(args, d)
    default:
      return failure('INVALID_ARGUMENTS', `unknown runtimes command ${cmd}`)
  }
}
