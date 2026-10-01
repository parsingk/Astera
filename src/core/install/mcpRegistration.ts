// The line that registers `astera mcp serve` with each MCP client, for this platform (Settings, CLI
// tab, under MCP access). The same forms docs/mcp.md's "Connect a client" gives.
//
// **On Windows each launches through `cmd /c`.** There `astera` is astera.cmd, and a client that
// starts its server without a shell can neither find nor run a .cmd (docs/mcp.md: ENOENT by name,
// EINVAL by full path). Codex included: docs/mcp.md documents `cmd /c` for it too.

export interface McpRegistrationLine {
  client: 'Claude Code' | 'Codex' | 'Cursor'
  line: string
}

export function mcpRegistrationLines(platform: string): McpRegistrationLine[] {
  const win = platform === 'win32'
  const launch = win ? 'cmd /c astera mcp serve' : 'astera mcp serve'
  const server = win ? { command: 'cmd', args: ['/c', 'astera', 'mcp', 'serve'] } : { command: 'astera', args: ['mcp', 'serve'] }
  return [
    { client: 'Claude Code', line: `claude mcp add astera -- ${launch}` },
    { client: 'Codex', line: `codex mcp add astera -- ${launch}` },
    { client: 'Cursor', line: JSON.stringify({ mcpServers: { astera: server } }) }
  ]
}
