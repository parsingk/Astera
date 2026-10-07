// `astera --runtime <id|name> ...` (remote runtime design §2.8, §3.4, §3.9, X1-14): a command sent to a paired Runtime
// through the controller link instead of this machine's Host. Three refusals come before anything else, in this
// order, and none of them reads a file of this profile:
//
// 1. a command the Runtime does not offer at all (its target is not "yes"): RUNTIME_CAPABILITY_MISSING. This is what
//    keeps every local fallback away from a remote target: the state file, the pending-report queue, `host`,
//    `skills`, `higgsfield`, `mcp`, `projects add` and the rest are local only;
// 2. a `jobs create` with no `--cwd`: the folder is the Runtime's, so this machine's working directory is never
//    filled in for it (D8.3);
// 3. a Runtime nobody paired: RUNTIME_NOT_FOUND.
//
// Arguments go as typed: a path names a folder on the Runtime, so nothing here resolves it against this machine.
import { remoteMutation, remoteTarget } from '../core/remote/targets'
import { openRemoteLink, type RemoteLink, type RemoteTarget } from '../core/remote/link'
import { RemoteError } from '../core/remote/client'
import { codeForStatus, messageFrom, refusalDetailsOf, remoteCodeOf, type CliError } from '../core/orchestration/cliOutput'
import type { RuntimeRegistry } from '../core/runtimes/registry'
import { spelledCommand } from '../core/orchestration/cliUsage'
import { DEFAULT_WAIT_TIMEOUT_MS } from '../core/orchestration/types'
import { controllerRegistry, resolveRuntime } from './runtimes'
import { clientTimeoutMs, followRun, type HostAnswer, type OutputMode } from './follow'

export interface RemoteDeps {
  registry(): Promise<RuntimeRegistry>
  link(t: RemoteTarget): RemoteLink
}

type Refused = { error: CliError }

/** A link failure as the CLI says it: its §3.10 code, the Runtime it was, and for a change whose answer was lost the
 *  request id, so `requests show` on that Runtime can be asked once it answers again. */
const refusalOf = (e: RemoteError, runtimeId: string, request: string | undefined): Refused => {
  const code = remoteCodeOf({ code: e.code }) ?? 'FAILED'
  const lost = code === 'RUNTIME_OUTCOME_UNKNOWN' || code === 'REMOTE_TIMEOUT'
  return {
    error: {
      code,
      message:
        code === 'RUNTIME_OUTCOME_UNKNOWN'
          ? `${e.message}. List the newest Jobs on this runtime before trying again.`
          : e.message,
      details: { runtime: runtimeId, ...(lost && request !== undefined ? { requestId: request } : {}) }
    }
  }
}

/** `--runtime` after the command (review I4). A public command refuses it as a flag it does not take; a session command
 *  takes any flag, so it would land in the arguments and the command would run on this machine. */
export function trailingRuntimeError(args: Record<string, unknown>): string | null {
  return args.runtime === undefined ? null : '--runtime goes before the command: astera --runtime <id|name> <command> ...'
}

/** The commands that make a Job and fill a missing folder with the Runtime Host's own working directory (command.ts):
 *  `jobs create`, and `run-create`, its older name (review I5). */
const MAKES_A_JOB: ReadonlySet<string> = new Set(['jobs-create', 'run-create'])

export async function answerRemote(a: {
  cmd: string
  args: Record<string, unknown>
  runtime: string
  request: string
  profileDir: string
  mode: OutputMode
  write(text: string): void
  version: string
  deps?: Partial<RemoteDeps>
}): Promise<HostAnswer | Refused> {
  if (remoteTarget(a.cmd) === 'no')
    return {
      error: {
        code: 'RUNTIME_CAPABILITY_MISSING',
        message: `${spelledCommand(a.cmd)} works on this machine only; it has no --runtime form`
      }
    }
  if (MAKES_A_JOB.has(a.cmd) && (typeof a.args.cwd !== 'string' || a.args.cwd === ''))
    return {
      error: {
        code: 'INVALID_ARGUMENTS',
        message: `a remote ${spelledCommand(a.cmd)} needs --cwd: the folder on the Runtime, which this machine's folder is not`
      }
    }
  const registry = await (a.deps?.registry ?? (() => controllerRegistry(a.profileDir)))()
  const found = resolveRuntime(await registry.list(), a.runtime)
  if ('code' in found) return { error: { code: found.code, message: found.message } }
  const token = await registry.token(found.runtimeId)
  if (token === null)
    return { error: { code: 'RUNTIME_NOT_FOUND', message: `${found.name} has no token on this machine; pair it again with \`astera runtimes add\`` } }
  const target: RemoteTarget = { runtimeId: found.runtimeId, address: found.address, port: found.port, fingerprint: found.fingerprint, token }
  const link = (a.deps?.link ?? ((t: RemoteTarget) => openRemoteLink({ target: t, client: { name: 'astera cli', version: a.version, surface: 'cli' } })))(target)
  try {
    if (a.cmd === 'runs-follow') {
      let lost: RemoteError | null = null
      const followed = await followRun({
        id: a.args.id,
        mode: a.mode,
        timeoutMs: typeof a.args.timeoutMs === 'number' ? a.args.timeoutMs : DEFAULT_WAIT_TIMEOUT_MS,
        write: a.write,
        call: async (callArgs, timeoutMs) => {
          const r = await link.call(a.cmd, callArgs, { timeoutMs })
          if (r instanceof RemoteError) {
            lost = r
            return { unreachable: r.message }
          }
          return r
        }
      })
      if ('ended' in followed) return { status: 200, body: followed.ended }
      if ('refused' in followed) return followed.refused
      return refusalOf(lost ?? new RemoteError('RUNTIME_OFFLINE', 'stuck' in followed ? followed.stuck : followed.unreachable), found.runtimeId, undefined)
    }
    // §3.9: only a change carries the request id, so a resend of it is a retry the Runtime can answer from its receipt.
    const request = remoteMutation(a.cmd) ? a.request : undefined
    const r = await link.call(a.cmd, a.args, { ...(request !== undefined ? { request } : {}), timeoutMs: clientTimeoutMs({ cmd: a.cmd, args: a.args }) })
    if (r instanceof RemoteError) return refusalOf(r, found.runtimeId, request)
    if (r.status >= 200 && r.status < 300) return r
    // A refusal from the Runtime names that Runtime (review I2), so its next steps point there and not here.
    const code = remoteCodeOf(r.body) ?? codeForStatus(r.status)
    const message = messageFrom(r.body, `the Runtime answered ${r.status}`)
    if (code === 'RUNTIME_OUTCOME_UNKNOWN') return refusalOf(new RemoteError(code, message), found.runtimeId, request)
    return { error: { code, message, details: { ...refusalDetailsOf(r.body), runtime: found.runtimeId } } }
  } finally {
    link.close()
  }
}
