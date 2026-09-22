// The local orchestration server — the HTTP shell, and nothing else.
//
// The logic it shells is `handleCommand` in core/orchestration/command.ts: routing, authorization and
// argument validation are what is worth testing, and this file is the thin layer that puts them on a
// loopback port. **The command layer moved to core so the Host can run it too** (host control plane
// design §5); this file stayed here because `node:http` and the loopback token belong to the app's
// own process, and the Host answers `orch-call` over its socket instead.
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { handleCommand, type OrchServerDeps } from '../../core/orchestration/command'

export interface OrchServer {
  port: number
  token: string
  close(): Promise<void>
}

export async function startOrchServer(deps: OrchServerDeps): Promise<OrchServer> {
  const token = randomBytes(32).toString('hex')
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      const buf = Buffer.from(JSON.stringify(body), 'utf8')
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length })
      res.end(buf)
    }
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' })
    const sessionId = String(req.headers['x-astera-session'] ?? '')
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let payload: { cmd?: string; args?: Record<string, unknown> } = {}
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        return send(400, { error: 'invalid json' })
      }
      if (!payload.cmd) return send(400, { error: 'cmd is required' })
      handleCommand(deps, { sessionId }, payload.cmd, payload.args ?? {})
        .then((r) => send(r.status, r.body))
        .catch((e: unknown) => send(500, { error: String(e) }))
    })
  })
  // Turns a listen failure into a reject. Without an error listener, the 'error' that net.Server
  // emits (EACCES, EADDRNOTAVAIL — genuinely possible with security products that block loopback) is
  // raised as a throw and becomes an uncaught exception in the Electron main process — the caller's
  // .catch() does not catch it (it is not a rejection), and at the same time this Promise stays
  // pending forever so the boot latch never releases.
  // After listen succeeds the reject is removed and replaced with a logging listener: rejecting an
  // already-settled Promise just disappears quietly, and removing the listener entirely would turn
  // a runtime error back into a throw.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      server.on('error', (e) => deps.log?.(`orch server error: ${String(e)}`))
      resolve()
    })
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  return {
    port,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
