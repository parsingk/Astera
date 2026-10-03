// The line that registers `astera mcp serve` with each MCP client, for this platform (Settings, CLI
// tab, under MCP access). docs/mcp.md's "Connect a client" gives the short forms beside these.
//
// **Each line names the installed command by its full path**, so the client's PATH does not matter:
// on Windows a folder just put on the user Path reaches only shells started after it, so a client
// already running cannot find `astera`; on macOS and Linux `~/.local/bin` is often not on the PATH a
// GUI app starts with.
//
// **On Windows each launches through `cmd /c call`, with the path as its own argument.** There the
// command is astera.cmd, and a client that starts its server without a shell cannot run a .cmd
// (docs/mcp.md: EINVAL by full path from Node). Measured 2026-10-01 on Windows 11, spawning from
// Node 24 and from Rust's std::process::Command (Codex is Rust) with a shim in folders named with a
// space, with Hangul, and `a&b (c)`: `cmd /c call <path> mcp serve` listed all 16 tools from both in
// all three, with the exit code and stdio passed through. Without `call`, `cmd /c <path> mcp serve`
// worked for the first two but not for `a&b (c)`: with `&` or parentheses between the quotes cmd
// strips them. `call` puts a word before the quote, so cmd keeps them. `cmd /s /c "\"<path>\" mcp
// serve"` failed everywhere (each spawner escapes the inner quotes as \", which cmd does not read).
// The quoted `claude`/`codex` lines below gave the client exactly that argv when typed into cmd,
// PowerShell 7 and Windows PowerShell 5.1.
//
// **The Claude Code line registers at user scope (`-s user`).** Without a scope `claude mcp add`
// writes the server under the folder it is typed in only, so it would be missing from every other
// project. Measured 2026-10-02 on claude 2.1.287: `-s user` writes the top-level `mcpServers` of
// `~/.claude.json` (of `$CLAUDE_CONFIG_DIR/.claude.json` when that is set), the argv after `--`
// unchanged. The Register buttons beside these lines run the same argv (mcpServerFor, mcpClients.ts).
//
// **Not handled: a folder name with `$`, a backtick, `^` or `%`.** PowerShell expands `$` and the
// backtick inside double quotes, and cmd (and `call`) reads `^` and `%` in the path. A person whose
// install folder has one of these registers the server by hand (`$`, backtick: a JSON or TOML entry
// no shell reads) or moves the CLI folder (`^`, `%`: any form through cmd), as docs/mcp.md says.

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

/** The command and args a client starts the server with: the Cursor entry, and the argv the Register
 *  buttons hand `claude mcp add` and `codex mcp add` (mcpClients.ts), so no one re-splits a line. */
export function mcpServerFor(a: { platform: string; shimPath: string }): { command: string; args: string[] } {
  return a.platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'call', a.shimPath, 'mcp', 'serve'] }
    : { command: a.shimPath, args: ['mcp', 'serve'] }
}

export function mcpRegistrationLines(a: { platform: string; shimPath: string }): McpRegistrationLine[] {
  const win = a.platform === 'win32'
  // Double quotes on Windows read the same in cmd and in PowerShell for a path with spaces, Hangul,
  // `&` or parentheses.
  const launch = win ? `cmd /c call "${a.shimPath}" mcp serve` : `${shQuote(a.shimPath)} mcp serve`
  const server = mcpServerFor(a)
  return [
    // `-s user` (see the top of this file); Codex has one global list and no scope.
    { client: 'Claude Code', line: `claude mcp add -s user astera -- ${launch}` },
    { client: 'Codex', line: `codex mcp add astera -- ${launch}` },
    { client: 'Cursor', line: JSON.stringify({ mcpServers: { astera: server } }) }
  ]
}

/**
 * The lines that register the MCP HTTP entrance (MCP HTTP design §4), copy only. Checked against the
 * installed CLIs' help on 2026-10-03: `claude mcp add --help` (2.1.288) gives `[options] <name> <url>` with
 * `-s user` and `--transport http` as options and `--header "..."` (variadic, so it goes last); `-s user` for the
 * reason at the top of this file; `codex mcp add --help` (0.160.0) gives `--url` and `--bearer-token-env-var`
 * (no header flag), so its line names a variable the person sets to the token. Cursor has no CLI here;
 * its line is the mcp.json entry with `url` and `headers`. The token is base64url, so it needs no quoting.
 */
export function mcpHttpRegistrationLines(a: { url: string; token: string }): McpRegistrationLine[] {
  return [
    { client: 'Claude Code', line: `claude mcp add -s user --transport http astera ${a.url} --header "Authorization: Bearer ${a.token}"` },
    { client: 'Codex', line: `codex mcp add astera --url ${a.url} --bearer-token-env-var ASTERA_MCP_TOKEN` },
    { client: 'Cursor', line: JSON.stringify({ mcpServers: { astera: { url: a.url, headers: { Authorization: `Bearer ${a.token}` } } } }) }
  ]
}

/** The URLs the running entrance answers at: the local one, and, while other devices are allowed, one per
 *  typed host name (its own port kept) and per address of this machine. The Host gives only the local
 *  form (`McpHttpState.url`); these are the names it also allows (cli/mcp/http.ts allowedHosts). */
export function mcpHttpUrls(a: {
  state: { state: string; url?: string; lan: boolean; port: number } | null
  hosts: string[]
  addresses: string[]
}): string[] {
  const s = a.state
  if (s?.state !== 'running' || !s.url) return []
  const out = [s.url]
  if (!s.lan) return out
  const at = (h: string): string =>
    /^\[.*\]:\d+$/.test(h) || /^[^:]+:\d+$/.test(h) ? h : h.includes(':') && !h.startsWith('[') ? `[${h}]:${s.port}` : `${h}:${s.port}`
  for (const h of [...a.hosts, ...a.addresses]) {
    const url = `http://${at(h.trim())}/mcp`
    if (h.trim() && !out.includes(url)) out.push(url)
  }
  return out
}
