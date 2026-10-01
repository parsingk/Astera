// The line that registers `astera mcp serve` with each MCP client, for this platform (Settings, CLI
// tab, under MCP access). docs/mcp.md's "Connect a client" gives the short forms beside these.
//
// **Each line names the installed command by its full path**, so the client's PATH does not matter:
// on Windows a folder just put on the user Path reaches only shells started after it, so a client
// already running cannot find `astera`; on macOS and Linux `~/.local/bin` is often not on the PATH a
// GUI app starts with.
//
// **On Windows each launches through `cmd /c`, with the path as its own argument.** There the command
// is astera.cmd, and a client that starts its server without a shell cannot run a .cmd (docs/mcp.md:
// EINVAL by full path from Node). Measured 2026-10-01 on Windows 11, spawning from Node 24 and from
// Rust's std::process::Command (Codex is Rust) with a shim in a folder named with a space and with
// Hangul: `cmd /c <path> mcp serve` listed all 16 tools from both. `cmd /s /c "\"<path>\" mcp serve"`
// failed from both (each spawner escapes the inner quotes as \", which cmd does not read). The quoted
// `claude`/`codex` lines below gave the client exactly that argv when typed into cmd, PowerShell 7 and
// Windows PowerShell 5.1. What it does not cover: a user folder with `&`, `(` or `)` in its name,
// where cmd strips the quotes (docs/mcp.md says what to use there).

export interface McpRegistrationLine {
  client: 'Claude Code' | 'Codex' | 'Cursor'
  line: string
}

/** A string as one single-quoted POSIX shell word. */
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The installed command in the CLI's install folder (CliInstallStatus.dir): the file shuttle.ts
 * writes first on this platform, `astera.cmd` on win32 and `astera` elsewhere. Written here rather
 * than taken from shuttle.ts, which reads the disk and so cannot reach the renderer; the test ties
 * the two.
 */
export function shimPathFor(a: { platform: string; dir: string }): string {
  return a.platform === 'win32' ? `${a.dir.replace(/[\\/]+$/, '')}\\astera.cmd` : `${a.dir.replace(/\/+$/, '')}/astera`
}

export function mcpRegistrationLines(a: { platform: string; shimPath: string }): McpRegistrationLine[] {
  const win = a.platform === 'win32'
  // Double quotes on Windows read the same in cmd and in PowerShell for a path with spaces or Hangul.
  const launch = win ? `cmd /c "${a.shimPath}" mcp serve` : `${shQuote(a.shimPath)} mcp serve`
  const server = win
    ? { command: 'cmd', args: ['/c', a.shimPath, 'mcp', 'serve'] }
    : { command: a.shimPath, args: ['mcp', 'serve'] }
  return [
    { client: 'Claude Code', line: `claude mcp add astera -- ${launch}` },
    { client: 'Codex', line: `codex mcp add astera -- ${launch}` },
    { client: 'Cursor', line: JSON.stringify({ mcpServers: { astera: server } }) }
  ]
}
