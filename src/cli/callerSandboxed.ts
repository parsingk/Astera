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
 *  command (cliUsage.ts) brings node-only modules with it. */
export const sandboxedRemoteRefusal = (cmd: string): string =>
  `a sandboxed session can only read another computer: ${spelledCommand(cmd)} changes work there, so it was not sent`

/** The whole question, connection included: a Host that says nothing in this long counts as no answer. */
const DEADLINE_MS = 10_000

/** False for a process in no agent session (no `ASTERA_SESSION`, no `ASTERA_GATEWAY_TOKEN`): the person's own shell, the
 *  same trust the local classification gives it (§7.2). Otherwise the Host's answer, and true for anything that is not
 *  a 200 with a boolean in it: an answer that cannot be had counts as sandboxed (§7.4). */
export async function askCallerSandboxed(a: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  version: string
  connect?: typeof connectHost
}): Promise<boolean> {
  const sessionId = a.env.ASTERA_SESSION ?? ''
  if (sessionId === '' && !a.env.ASTERA_GATEWAY_TOKEN) return false
  const started = Date.now()
  const { address, profileDir } = cliHostTarget({ env: a.env, platform: a.platform, home: a.home })
  let conn: Awaited<ReturnType<typeof connectHost>>
  try {
    conn = await (a.connect ?? connectHost)({ address, profileDir, app: a.version, log: () => {}, timeoutMs: DEADLINE_MS })
  } catch {
    return true
  }
  if ('error' in conn) return true
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
    return typeof sandboxed === 'boolean' ? sandboxed : true
  } finally {
    c.close()
  }
}
