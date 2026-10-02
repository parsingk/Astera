// Whether `astera mcp serve` is registered with Claude Code and Codex, and registering it, for the
// Register buttons in Settings (CLI tab, beside the copy lines; mcpRegistration.ts gives the argv).
// main/mcpClients.ts runs the CLIs; this file holds what is decided from their output.
//
// **Status never runs the server.** Measured 2026-10-02 with a throwaway server that wrote a file
// when started: `claude mcp get <name>` and `claude mcp list` (claude 2.1.287) each started it twice
// to health-check it, and starting `astera mcp serve` may start a Host. So Claude Code's status is
// read from the file `claude mcp add -s user` writes, `~/.claude.json` (or
// `$CLAUDE_CONFIG_DIR/.claude.json`), top-level `mcpServers.astera`. `codex mcp get <name> --json`
// (codex-cli 0.160.0) did not start it and did not touch `~/.codex/config.toml`, so Codex is asked.
// Neither file is ever written here: registering goes through each client's own CLI. (Measured: an
// add or remove by `codex mcp` rewrites the other `[mcp_servers.*]` tables in its own format, the
// same values; typing the copied line does the same.)

import path from 'node:path'
import { isSamePath } from '../files/tree'
import type { McpClient, McpClientStatus, McpRegisterResult } from '../types'

export type { McpClient, McpClientStatus, McpRegisterResult }
export type McpClientState = McpClientStatus['state']

export interface McpServerCommand {
  command: string
  args: string[]
}
/** One CLI run. `notFound`: the CLI could not be started (not installed). */
export interface CliRun {
  ok: boolean
  stdout: string
  stderr: string
  notFound?: boolean
}

const NAME = 'astera'

export function addArgs(client: McpClient, server: McpServerCommand): string[] {
  const scope = client === 'claude' ? ['-s', 'user'] : []
  return ['mcp', 'add', ...scope, NAME, '--', server.command, ...server.args]
}

export function removeArgs(client: McpClient): string[] {
  return client === 'claude' ? ['mcp', 'remove', '-s', 'user', NAME] : ['mcp', 'remove', NAME]
}

/** Each word equal, or on win32 two absolute paths naming the same file (an install path written
 *  with other case or separators is the same install). */
function sameServer(command: unknown, args: unknown, want: McpServerCommand, platform: string): boolean {
  if (typeof command !== 'string' || !Array.isArray(args)) return false
  const have = [command, ...args]
  const need = [want.command, ...want.args]
  return (
    have.length === need.length &&
    have.every(
      (w, i) =>
        w === need[i] ||
        (platform === 'win32' &&
          typeof w === 'string' &&
          path.win32.isAbsolute(w) &&
          path.win32.isAbsolute(need[i]) &&
          isSamePath(w, need[i], 'win32'))
    )
  )
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Claude Code's user-scope entry from the text of `~/.claude.json`; null when there is no file. */
export function claudeStatusFrom(configText: string | null, want: McpServerCommand, platform: string): McpClientStatus {
  if (configText === null) return { state: 'absent' }
  let config: unknown
  try {
    config = JSON.parse(configText)
  } catch (err) {
    return { state: 'absent', detail: err instanceof Error ? err.message : String(err) }
  }
  if (!isObject(config)) return { state: 'absent', detail: 'not a JSON object' }
  const servers = config.mcpServers
  const entry = isObject(servers) ? servers[NAME] : undefined
  if (entry === undefined) return { state: 'absent' }
  if (!isObject(entry)) return { state: 'different' }
  return { state: sameServer(entry.command, entry.args, want, platform) ? 'registered' : 'different' }
}

/** Codex's entry from `codex mcp get astera --json`. */
export function codexStatusFrom(run: CliRun, want: McpServerCommand, platform: string): McpClientStatus {
  if (run.notFound) return { state: 'not-installed' }
  if (!run.ok) {
    // Measured: exit 1 and `Error: No MCP server named 'astera' found.` on stderr.
    if (/No MCP server named/i.test(run.stderr)) return { state: 'absent' }
    return { state: 'absent', detail: firstLine(run.stderr) || firstLine(run.stdout) }
  }
  let entry: unknown
  try {
    entry = JSON.parse(run.stdout)
  } catch (err) {
    return { state: 'absent', detail: err instanceof Error ? err.message : String(err) }
  }
  const transport = isObject(entry) ? entry.transport : undefined
  if (!isObject(transport)) return { state: 'different' }
  return { state: sameServer(transport.command, transport.args, want, platform) ? 'registered' : 'different' }
}

export function firstLine(s: string): string {
  return (
    s
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  )
}

/** Registers by the client's CLI: add when absent, remove then add when another command is
 *  registered under the name. Measured: `claude mcp add` over an existing name exits 1 with
 *  "MCP server <name> already exists in user config"; `codex mcp add` replaces it, and goes the same
 *  way here so both clients take one path. */
export async function registerMcpClient(
  client: McpClient,
  state: McpClientState,
  server: McpServerCommand,
  run: (args: string[]) => Promise<CliRun>
): Promise<McpRegisterResult> {
  if (state === 'registered') return { ok: true }
  if (state === 'not-installed') return { ok: false, message: `${client} is not installed` }
  const steps = state === 'different' ? [removeArgs(client), addArgs(client, server)] : [addArgs(client, server)]
  for (const args of steps) {
    const r = await run(args)
    if (!r.ok) return { ok: false, message: firstLine(r.stderr) || firstLine(r.stdout) || `${client} ${args.slice(0, 2).join(' ')} failed` }
  }
  return { ok: true }
}
