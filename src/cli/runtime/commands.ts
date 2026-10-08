// `astera runtime start | stop | status | pair | clients | revoke` (and `serve`, in serve.ts, which run.ts dispatches;
// named here as 'runtime-serve' only so the agent-context witness finds every runtime command in one file) (remote runtime design §2.9, plan ruling P1): the
// person's switches for Remote Runtime on this machine. They answer in the CLI process, reading and writing
// remote-runtime.json and the identity, and ask the Host only what only it knows. Everything a command needs from the
// machine comes through `RuntimeCommandDeps`, so each one is tested without a Host or a network.
import type { HostCommandResult } from '../host'
import { codeForStatus, type CliError } from '../../core/orchestration/cliOutput'
import type { RemoteSettings } from '../../core/remote/settings'
import { formatPairing } from '../../core/remote/pairing'

export interface RuntimeCommandDeps {
  readSettings(): Promise<RemoteSettings>
  writeSettings(patch: Partial<RemoteSettings>): Promise<RemoteSettings>
  /** Makes the identity on the first start (its certificate names `san`), or answers the one there. */
  ensureIdentity(san: string): Promise<{ runtimeId: string; spkiSha256: string; displayName: string }>
  loadIdentity(): Promise<{ runtimeId: string; spkiSha256: string; displayName: string } | null>
  /** One Host command for this profile. `start`: start a Host first when none answers. `down` when none answers. */
  hostCall(
    cmd: string,
    args: Record<string, unknown>,
    o: { start: boolean }
  ): Promise<{ status: number; body: unknown } | { down: true } | { error: CliError }>
  sleep(ms: number): Promise<void>
  /** A private address of this machine, for a pairing string while listening on every interface. */
  privateAddress(): string | null
  /** This machine's name: the pairing string's hint when it listens everywhere and has no private address. */
  hostname(): string
  /** Run inside an agent session Astera started (`ASTERA_SESSION` is set; security audit SEC-10). */
  agentSession?: boolean
}

/** `runtime start` and `runtime pair` from an agent session (security audit SEC-10). A speed bump, as every role check
 *  in this CLI: an agent that clears ASTERA_SESSION reads as a shell. */
const agentRefusal = (cmd: string): HostCommandResult => ({
  ok: false,
  error: {
    code: 'PERMISSION_DENIED',
    message: `astera ${cmd.replace('-', ' ')} is for a person at their own shell or in the Astera app, not an agent session (ASTERA_SESSION is set)`
  }
})

const START_WAIT_MS = 10_000
const POLL_MS = 250

const failure = (code: CliError['code'], message: string, details?: Record<string, unknown>): HostCommandResult => ({
  ok: false,
  error: { code, message, ...(details ? { details } : {}) }
})

const hostDown = (): HostCommandResult =>
  failure('HOST_NOT_RUNNING', 'no Host is running for this profile; run `astera runtime start` first')

/** The Host's answer as a result: 2xx is the body, anything else its error with the exit code its status means. */
const answered = (r: { status: number; body: unknown }): HostCommandResult => {
  if (r.status >= 200 && r.status < 300) return { ok: true, body: (r.body ?? {}) as Record<string, unknown> }
  const b = (r.body ?? {}) as { error?: string }
  return failure(codeForStatus(r.status), b.error ?? `the Host answered ${r.status}`)
}

export async function runRuntimeCommand(cmd: string, args: Record<string, unknown>, d: RuntimeCommandDeps): Promise<HostCommandResult> {
  switch (cmd) {
    case 'runtime-start': {
      // Before anything is written (security audit SEC-10): opening this machine to the network is a person's call.
      if (d.agentSession) return agentRefusal(cmd)
      const patch: Partial<RemoteSettings> = { enabled: true }
      if (args.listen !== undefined) {
        if (typeof args.listen !== 'string' || args.listen === '') return failure('INVALID_ARGUMENTS', '--listen needs an address')
        patch.listen = args.listen
      }
      if (args.port !== undefined) {
        const port = Number(args.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) return failure('INVALID_ARGUMENTS', '--port needs a whole number from 1 to 65535')
        patch.port = port
      }
      // The identity first (Phase 3 minor): a start that cannot make one must not leave Remote on with no key to serve.
      const id = await d.ensureIdentity(patch.listen ?? (await d.readSettings()).listen)
      const s = await d.writeSettings(patch)
      const reload = await d.hostCall('runtime-reload', {}, { start: true })
      if ('error' in reload) return { ok: false, error: reload.error }
      if ('down' in reload) return failure('HOST_NOT_RUNNING', 'a Host could not be started for this profile')
      let r: { status: number; body: unknown } = reload
      for (let waited = 0; ; waited += POLL_MS) {
        if (r.status !== 200) return answered(r)
        const g = (r.body as { gateway?: { state?: string; code?: string; message?: string } }).gateway
        if (g?.state === 'ready') return { ok: true, body: { enabled: true, listen: s.listen, port: s.port, fingerprint: id.spkiSha256, ...(r.body as object) } }
        if (g?.state === 'failed')
          return failure('FAILED', `the Gateway failed: ${g.code ?? '?'}: ${g.message ?? ''}`, { gateway: g.code ?? 'FAILED' })
        if (waited >= START_WAIT_MS) return failure('TIMEOUT', `the Gateway was not ready after ${START_WAIT_MS / 1000} s`)
        await d.sleep(POLL_MS)
        const next = await d.hostCall('runtime-status', {}, { start: false })
        if ('error' in next) return { ok: false, error: next.error }
        if ('down' in next) return failure('HOST_NOT_RUNNING', 'the Host went away while the Gateway was starting')
        r = next
      }
    }
    case 'runtime-stop': {
      const s = await d.writeSettings({ enabled: false })
      const r = await d.hostCall('runtime-reload', {}, { start: false })
      if ('error' in r) return { ok: false, error: r.error }
      if ('down' in r) return { ok: true, body: { enabled: s.enabled, host: 'not running' } }
      const done = answered(r)
      return done.ok ? { ok: true, body: { enabled: s.enabled, host: 'running', ...done.body } } : done
    }
    case 'runtime-status': {
      const s = await d.readSettings()
      const id = await d.loadIdentity().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
      const identity = id === null ? {} : 'error' in id ? { identityError: id.error } : { runtimeId: id.runtimeId, displayName: id.displayName, fingerprint: id.spkiSha256 }
      const r = await d.hostCall('runtime-status', {}, { start: false })
      if ('error' in r) return { ok: false, error: r.error }
      const base = { enabled: s.enabled, listen: s.listen, port: s.port, ...identity }
      if ('down' in r) return { ok: true, body: { ...base, host: 'not running' } }
      const done = answered(r)
      return done.ok ? { ok: true, body: { ...base, host: 'running', ...done.body } } : done
    }
    case 'runtime-pair': {
      if (d.agentSession) return agentRefusal(cmd)
      const permission = args.readOnly === true ? 'read-only' : 'full-control'
      // Everything a pairing string needs is checked before a code is made (Phase 3 minor): a code nobody can redeem,
      // while Remote is off, is not handed out.
      const s = await d.readSettings()
      if (!s.enabled) return failure('CONFLICT', 'Remote Runtime is off, so nothing could redeem a code; run `astera runtime start` first')
      const id = await d.loadIdentity()
      if (!id) return failure('FAILED', 'this machine has no Runtime identity yet; run `astera runtime start` first')
      const r = await d.hostCall('pair-create', { permission, ...(typeof args.name === 'string' ? { name: args.name } : {}) }, { start: false })
      if ('error' in r) return { ok: false, error: r.error }
      if ('down' in r) return hostDown()
      const done = answered(r)
      if (!done.ok) return done
      const everywhere = s.listen === '0.0.0.0' || s.listen === '::'
      // Never 0.0.0.0 in the string: with no private address found, this machine's name is the hint (`runtimes add
      // --address` overrides it on the other side).
      const address = everywhere ? (d.privateAddress() ?? d.hostname()) : s.listen
      const code = String(done.body.code)
      return {
        ok: true,
        body: {
          pairing: formatPairing({ address, port: s.port, code, fingerprint: id.spkiSha256 }),
          address,
          port: s.port,
          code,
          fingerprint: id.spkiSha256,
          expiresAt: done.body.expiresAt,
          permission
        }
      }
    }
    case 'runtime-clients':
    case 'runtime-revoke': {
      if (cmd === 'runtime-revoke' && (typeof args.id !== 'string' || args.id === '')) return failure('INVALID_ARGUMENTS', 'revoke needs --id <clientId> (from `astera runtime clients`)')
      const r = await d.hostCall(cmd === 'runtime-clients' ? 'clients-list' : 'clients-revoke', cmd === 'runtime-revoke' ? { id: args.id } : {}, { start: false })
      if ('error' in r) return { ok: false, error: r.error }
      if ('down' in r) return hostDown()
      return answered(r)
    }
    case 'runtime-serve':
      return failure('FAILED', 'runtime serve runs in the foreground from run.ts, not here')
    default:
      return failure('FAILED', `${cmd} is not a runtime command`)
  }
}
