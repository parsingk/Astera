// The Host's `lsp-*` commands (Phase 3 Part 3), for this machine's app and CLI: the servers' states and what is
// installed, an install or a removal the person approved in Settings, and a server's log. No gate lists them, so a remote
// controller, an MCP client and a plugin are refused by default; an agent's shell may read but not change.
import { promises as fs } from 'node:fs'
import type { LspInstalled, LspServerId, LspServerStatus } from '../../core/lsp/model'

export const LSP_COMMANDS: ReadonlySet<string> = new Set(['lsp-status', 'lsp-install', 'lsp-remove', 'lsp-log'])

/** The ones that change what is installed. */
export const LSP_CHANGES: ReadonlySet<string> = new Set(['lsp-install', 'lsp-remove'])

/** How many of a log's last lines `lsp-log` answers. */
export const LSP_LOG_LINES = 200

const SERVERS: ReadonlySet<string> = new Set(['typescript', 'typescript5', 'python'])

/** An install's failure as an answer: its code (LSP_UNAVAILABLE, LSP_INTEGRITY, PLUGIN_NPM_*) decides the status. */
function failure(e: unknown): { status: number; body: unknown } {
  const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : 'LSP_INSTALL_FAILED'
  const error = e instanceof Error ? e.message : String(e)
  const status = code === 'LSP_UNAVAILABLE' ? 409 : code === 'LSP_INTEGRITY' ? 422 : code.startsWith('PLUGIN_NPM_') ? 502 : 500
  return { status, body: { code, error } }
}

export async function lspCommand(a: {
  cmd: string
  args: Record<string, unknown>
  installer: { list(): Promise<LspInstalled[]>; install(id: LspServerId): Promise<void>; remove(id: LspServerId): Promise<void> }
  manager: { status(): LspServerStatus[]; stopServer(id: LspServerId): Promise<void>; logFile(server: LspServerId, root: string): string }
  agentRefusal?: string
  /** For tests: how a log is read. */
  readLog?: (file: string) => Promise<string>
}): Promise<{ status: number; body: unknown }> {
  if (LSP_CHANGES.has(a.cmd) && a.agentRefusal !== undefined) return { status: 403, body: { error: a.agentRefusal } }
  if (a.cmd === 'lsp-status') return { status: 200, body: { servers: a.manager.status(), installed: await a.installer.list() } }
  const server = a.args.server
  if (typeof server !== 'string' || !SERVERS.has(server)) return { status: 400, body: { error: `${a.cmd} needs a server: typescript, typescript5 or python` } }
  const id = server as LspServerId
  switch (a.cmd) {
    case 'lsp-install':
      try {
        await a.installer.install(id)
      } catch (e) {
        return failure(e)
      }
      return { status: 200, body: { server: id, installed: true } }
    case 'lsp-remove':
      await a.manager.stopServer(id)
      await a.installer.remove(id)
      return { status: 200, body: { server: id, installed: false } }
    case 'lsp-log': {
      if (typeof a.args.root !== 'string' || a.args.root === '') return { status: 400, body: { error: 'lsp-log needs the root the server runs for' } }
      const read = a.readLog ?? ((f: string) => fs.readFile(f, 'utf8'))
      let text = ''
      try {
        text = await read(a.manager.logFile(id, a.args.root))
      } catch {
        // no log yet
      }
      const lines = text.split('\n').filter((l) => l !== '')
      return { status: 200, body: { lines: lines.slice(-LSP_LOG_LINES) } }
    }
    default:
      return { status: 400, body: { error: `not an lsp command: ${a.cmd}` } }
  }
}
