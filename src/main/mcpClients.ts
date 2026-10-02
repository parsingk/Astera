// Runs Claude Code's and Codex's CLIs for the Register buttons in Settings (core/install/mcpClients.ts
// holds what is decided from their output, and why status never starts the server).
//
// Each CLI is found where the machine says it is now (locateCli), not on this process's PATH, which
// was copied when the app started and misses a CLI installed since. It is then spawned by that
// absolute path with no shell: directly for an .exe, through `cmd.exe /d /c call` for a .cmd shim on
// win32 (windowsSpawn; an npm install of either CLI is a .cmd, which execFile cannot start).
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { locateCli } from './cliLocate'
import { windowsSpawn } from '../core/sessions/windowsExecutable'
import {
  claudeStatusFrom,
  codexStatusFrom,
  registerMcpClient,
  type CliRun,
  type McpClient,
  type McpClientStatus,
  type McpRegisterResult,
  type McpServerCommand
} from '../core/install/mcpClients'

const TIMEOUT_MS = 30_000

function runAt(found: string, args: string[]): Promise<CliRun> {
  const spawn = process.platform === 'win32' ? windowsSpawn(path.win32.basename(found), args, () => found) : { file: found, args }
  return new Promise((resolve) => {
    execFile(spawn.file, spawn.args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      const code: unknown = err ? (err as { code?: unknown }).code : 0
      resolve({
        ok: !err,
        stdout: String(stdout ?? ''),
        // A timeout or a spawn failure (no exit code) leaves stderr empty; its message then says what
        // happened. A CLI that exited says it itself, on stderr or stdout.
        stderr: String(stderr ?? '') || (err && typeof code !== 'number' ? err.message : ''),
        ...(code === 'ENOENT' ? { notFound: true } : {})
      })
    })
  })
}

/** Where `claude mcp add -s user` writes (measured, core/install/mcpClients.ts). */
function claudeConfigFile(home: string): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || home, '.claude.json')
}

async function readClaudeConfig(home: string): Promise<string | null | Error> {
  try {
    return await readFile(claudeConfigFile(home), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return err instanceof Error ? err : new Error(String(err))
  }
}

async function statusOf(client: McpClient, want: McpServerCommand, home: string, found: string | null): Promise<McpClientStatus> {
  if (found === null) return { state: 'not-installed' }
  if (client === 'claude') {
    const text = await readClaudeConfig(home)
    if (text instanceof Error) return { state: 'absent', detail: text.message }
    return claudeStatusFrom(text, want, process.platform)
  }
  return codexStatusFrom(await runAt(found, ['mcp', 'get', 'astera', '--json']), want, process.platform)
}

export async function mcpClientsStatus(want: McpServerCommand, home: string): Promise<Record<McpClient, McpClientStatus>> {
  const [claude, codex] = await Promise.all(
    (['claude', 'codex'] as const).map(async (c) => statusOf(c, want, home, await locateCli(c)))
  )
  return { claude, codex }
}

/** Looks again before it runs anything: what the screen showed may be stale. */
export async function registerMcpClientNow(client: McpClient, want: McpServerCommand, home: string): Promise<McpRegisterResult> {
  const found = await locateCli(client)
  const { state } = await statusOf(client, want, home, found)
  // state is 'not-installed' when found is null, and registerMcpClient then runs nothing.
  return registerMcpClient(client, state, want, (args) => runAt(found ?? client, args))
}
