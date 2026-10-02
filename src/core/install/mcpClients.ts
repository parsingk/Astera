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
import { findOnWindowsPath } from '../sessions/windowsExecutable'
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
  } catch {
    // A fixed reason, never the parser's message: it quotes the text around the error, and this file
    // holds tokens. detail reaches the renderer.
    return { state: 'absent', detail: '~/.claude.json is not valid JSON' }
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
  } catch {
    // Fixed, as for ~/.claude.json: the parser's message would quote the output.
    return { state: 'absent', detail: 'codex mcp get returned output that is not JSON' }
  }
  const transport = isObject(entry) ? entry.transport : undefined
  if (!isObject(transport)) return { state: 'different' }
  // A disabled entry does not run, so it is not "registered"; Register again removes and adds it, and
  // a fresh add is enabled.
  if (isObject(entry) && entry.enabled === false) return { state: 'different' }
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

const RUNNABLE = ['.exe', '.com', '.bat', '.cmd']

/** The file to run for `cli` where locateCli found it. On win32 `Get-Command` can answer with the
 *  `.ps1` of npm's three-file shim set (`codex`, `codex.cmd`, `codex.ps1`), and `cmd /c call` on
 *  a .ps1 hands it to its file association: the CLI never runs. So anything but .exe/.com/.bat/.cmd
 *  is swapped for the runnable sibling in the same folder, by PATHEXT order; null when there is none
 *  (read as not installed). */
export function executableFor(
  cli: McpClient,
  found: string,
  platform: string,
  env: NodeJS.ProcessEnv,
  exists?: (p: string) => boolean
): string | null {
  if (platform !== 'win32') return found
  if (RUNNABLE.includes(path.win32.extname(found).toLowerCase())) return found
  return findOnWindowsPath(cli, { PATH: path.win32.dirname(found), PATHEXT: env.PATHEXT ?? env.Pathext }, exists)
}

/** Characters cmd.exe reads as syntax or expands, even inside quotes for `%` and `!`. */
const CMD_SYNTAX = /[&|<>^%()"!]/

/** Why a run is refused, or null. A .cmd or .bat CLI on win32 runs through `cmd.exe /d /c call`
 *  (windowsSpawn), and execFile quotes a word only when it has a space, so a word with `&` and no
 *  space reaches cmd bare; the CLI's own `%*` then reads every word again. Rather than a quoting rule
 *  for two layers of cmd, such a run is refused and the person registers by hand. An .exe is started
 *  directly and no cmd reads its words. */
export function cmdRefusal(file: string, args: string[], platform: string): string | null {
  if (platform !== 'win32') return null
  if (!['.bat', '.cmd'].includes(path.win32.extname(file).toLowerCase())) return null
  const bad = [file, ...args].find((w) => CMD_SYNTAX.test(w))
  if (bad === undefined) return null
  return `${path.win32.basename(file)} runs through cmd, which reads & | < > ^ % ( ) ! or a quote in "${bad}" as syntax; register Astera by hand with the copied line or the JSON entry (docs/mcp.md, Connect a client)`
}
