// What the sandbox blocks per CLI and OS (sandbox design §6, "Coverage with the sandbox"), the second table beside
// Enforce's: `policies show` answers it and Settings › Security & Access shows it. Only what was measured is claimed:
// Windows on this PC (inventory §23.3), macOS and Linux on GitHub's runners (§22, §23.4). Types only, so the renderer
// reads it too.
import type { CoverageCell, SandboxCoverageRow } from '../audit/types'

const ENFORCED: CoverageCell = { level: 'enforced' }
const NONE: CoverageCell = { level: 'none' }
/** E3: the network is allowed inside the sandbox, on every OS for both CLIs. */
const ALLOWED: CoverageCell = { level: 'seen' }

/** Codex's sandbox on every OS: writes stay in the session's folder, its repository's git directories and TEMP; E6's
 *  locations cannot be read; the OS credential store is kept out (Windows' elevated sandbox keeps Credential Manager out,
 *  measured; macOS and Linux with the denies Astera adds, `~/Library/Keychains` and the session bus, measured). */
const CODEX = { write: ENFORCED, sensitive: ENFORCED, stores: ENFORCED, network: ALLOWED }

/** Claude Code's sandbox on macOS and Linux. Writes and E6 were measured on the runtime it runs (srt 0.0.79, §23.4), as
 *  were the stores; the stores carry the note, since Claude Code's own use of the keys was not exercised. */
const CLAUDE_POSIX = { write: ENFORCED, sensitive: ENFORCED, stores: { level: 'enforced', note: 'runtime-measured' }, network: ALLOWED } as const

/** Claude Code on Windows has no sandbox: deny rules keep its file tools out of E6's locations, its shell is not
 *  restricted ("Windows: 셸은 제한 없음"). */
const CLAUDE_WIN32 = { write: NONE, sensitive: { level: 'partial', note: 'file-tools-only' }, stores: NONE, network: ALLOWED } as const

export const SANDBOX_COVERAGE: readonly SandboxCoverageRow[] = [
  { provider: 'claude', os: 'win32', classes: CLAUDE_WIN32 },
  { provider: 'claude', os: 'darwin', classes: CLAUDE_POSIX },
  { provider: 'claude', os: 'linux', classes: CLAUDE_POSIX },
  { provider: 'codex', os: 'win32', classes: CODEX },
  { provider: 'codex', os: 'darwin', classes: CODEX },
  { provider: 'codex', os: 'linux', classes: CODEX }
]
