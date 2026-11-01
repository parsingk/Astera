// Whether the agent session this CLI or stdio MCP server runs in is sandboxed (remote governance design §7.4, the
// person's decision P3): a sandboxed session may read a paired Runtime but never start or change work there, so both ask
// this machine's Host before they send a change over the controller link.
//
// Its own minimal `orch-call`, the shape of run.ts's `callHost`: the MCP server must not load the CLI's main module, so
// this cannot import run.ts. No loopback fallback either: inside a sandbox the pipe cannot be opened, and a Host that
// cannot be reached already answers "sandboxed", which is the right answer there.
import { connectHost } from '../core/host/connect'
import { spelledCommand } from '../core/orchestration/cliUsage'
import { cliHostTarget, workloadTokenFor } from './host'

/** Why a change to a Runtime is not sent from a sandboxed session (§7.4, the person's decision P3). Here and not beside
 *  `remoteMutation` in core/remote/targets.ts: that module is in the renderer's build, and the CLI's spelling of a
 *  command (cliUsage.ts) brings node-only modules with it. The closing clause is for a person's shell that kept a stale
 *  `ASTERA_SESSION`, which the Host cannot vouch for and so counts as sandboxed (ruling R13-1). */
export const sandboxedRemoteRefusal = (cmd: string): string =>
  `a sandboxed session can only read another computer: ${spelledCommand(cmd)} changes work there, so it was not sent (if this shell is not an agent session, unset ASTERA_SESSION)`

/** Why an MCP server with no Astera session in its env does not send a change to a Runtime (ruling R13-4): an MCP client
 *  that does not pass the session's `ASTERA_SESSION` or `ASTERA_GATEWAY_TOKEN` to the server leaves it no session to ask
 *  about. An MCP server is always an agent's, so a missing session there is an unknown sandbox, which counts as
 *  sandboxed (§7.4). */
export const mcpNoSessionRefusal = (cmd: string): string =>
  `this MCP client did not pass its Astera session, so Astera treats it as sandboxed and did not send ${spelledCommand(cmd)}; use \`astera --runtime <id|name> ${spelledCommand(cmd)}\` from the session's shell`

/** Whether the env names an Astera agent session: a session id or a session's workload token (§7.1). */
export const inAgentSession = (env: NodeJS.ProcessEnv): boolean => (env.ASTERA_SESSION ?? '') !== '' || !!env.ASTERA_GATEWAY_TOKEN

/** The whole question, connection included: a Host that says nothing in this long counts as no answer. */
const DEADLINE_MS = 10_000

type AskArgs = {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  version: string
  connect?: typeof connectHost
}

/** False for a process in no agent session (no `ASTERA_SESSION`, no `ASTERA_GATEWAY_TOKEN`): the person's own shell, the
 *  same trust the local classification gives it (§7.2). That holds for the CLI only: the MCP server refuses before asking
 *  when its env has no session (remoteLink.ts `noSession`, ruling R13-4). Otherwise the Host's answer, and true for anything that is not
 *  a 200 with a boolean in it: an answer that cannot be had counts as sandboxed (§7.4). */
export async function askCallerSandboxed(a: AskArgs): Promise<boolean> {
  return (await hostSaysSandboxed(a)) ?? true
}

/** `askCallerSandboxed` with the failure kept apart: null when no definite answer was had (no Host, no reply in time, a
 *  refusal, an older Host), so a caller that remembers the answer can leave that one out (ruling R13-2). */
export async function hostSaysSandboxed(a: AskArgs): Promise<boolean | null> {
  const sessionId = a.env.ASTERA_SESSION ?? ''
  if (!inAgentSession(a.env)) return false
  const started = Date.now()
  const { address, profileDir } = cliHostTarget({ env: a.env, platform: a.platform, home: a.home })
  let conn: Awaited<ReturnType<typeof connectHost>>
  try {
    conn = await (a.connect ?? connectHost)({ address, profileDir, app: a.version, log: () => {}, timeoutMs: DEADLINE_MS })
  } catch {
    return null
  }
  if ('error' in conn) return null
  const c = conn
  try {
    const token = workloadTokenFor({ env: a.env, platform: a.platform, home: a.home, profileDir, address })
    const body = await new Promise<unknown>((resolve) => {
      const call = 'sandboxed_1'
      let offMessage: () => void = () => {}
      let offClose: () => void = () => {}
      const done = (v: unknown): void => {
        clearTimeout(timer)
        offMessage()
        offClose()
        resolve(v)
      }
      const timer = setTimeout(() => done(null), Math.max(0, DEADLINE_MS - (Date.now() - started)))
      timer.unref?.()
      offMessage = c.onMessage((m) => {
        if (m.t === 'orch-result' && m.call === call) done(m.status === 200 ? m.body : null)
      })
      offClose = c.onClose(() => done(null))
      c.call({ t: 'orch-call', call, cmd: 'caller-sandboxed', args: {}, session: sessionId, ...(token === undefined ? {} : { token }) })
    })
    const sandboxed = (body as { sandboxed?: unknown } | null)?.sandboxed
    return typeof sandboxed === 'boolean' ? sandboxed : null
  } finally {
    c.close()
  }
}

/** The MCP server's question, asked until the Host gives a definite answer and then kept for the server's life: a
 *  session's sandbox does not change while it runs (§7.4). An ask with no answer counts as sandboxed for that call only,
 *  so a Host that was restarting does not refuse the session's changes for good (ruling R13-2). */
export function rememberedSandboxed(ask: () => Promise<boolean | null>): () => Promise<boolean> {
  let kept: boolean | null = null
  return async () => {
    if (kept !== null) return kept
    const said = await ask()
    if (said !== null) kept = said
    return said ?? true
  }
}
