// What the sandbox blocks per CLI and OS (sandbox design §6, "Coverage with the sandbox"), the second table beside
// Enforce's: `policies show` answers it and Settings › Security & Access shows it. Only what was measured is claimed:
// Windows on this PC (inventory §23.3), macOS and Linux on GitHub's runners (§22, §23.4). Types only, so the renderer
// reads it too.
import type { CoverageCell, SandboxCoverageRow } from '../audit/types'
import type { MessageKey } from '../i18n'
import type { SandboxKind } from '../types'

const ENFORCED: CoverageCell = { level: 'enforced' }
const NONE: CoverageCell = { level: 'none' }
/** E3: the network is allowed inside the sandbox, on every OS for both CLIs. */
const ALLOWED: CoverageCell = { level: 'seen' }

/** Codex's sandbox on every OS: writes stay in the session's folder, its repository's git directories and TEMP; E6's
 *  locations cannot be read; the OS credential store is kept out (Windows' elevated sandbox keeps Credential Manager out,
 *  measured; macOS and Linux with the denies Astera adds, `~/Library/Keychains` and the session bus, measured). */
const CODEX = { write: ENFORCED, sensitive: ENFORCED, stores: ENFORCED, network: ALLOWED }
/** On Linux the deny names the session bus by its file path (locations.ts busSocketOf): a bus on an abstract socket is
 *  not a path, and is not denied. */
const CODEX_LINUX = { ...CODEX, stores: { level: 'enforced', note: 'bus-path-only' } } as const

/** Claude Code's sandbox on macOS and Linux. Writes and E6 were measured on the runtime it runs (srt 0.0.79, §23.4), as
 *  were the stores; every one of them carries the note, since Claude Code's own use of the keys was not exercised (spec
 *  goal 4: never claim more than was measured; final fix pass, minor 5). */
const RUNTIME_MEASURED: CoverageCell = { level: 'enforced', note: 'runtime-measured' }
const CLAUDE_POSIX = { write: RUNTIME_MEASURED, sensitive: RUNTIME_MEASURED, stores: RUNTIME_MEASURED, network: ALLOWED } as const

/** Claude Code on Windows has no sandbox: deny rules keep its file tools out of E6's locations, its shell is not
 *  restricted ("Windows: 셸은 제한 없음"). */
const CLAUDE_WIN32 = { write: NONE, sensitive: { level: 'partial', note: 'file-tools-only' }, stores: NONE, network: ALLOWED } as const

export const SANDBOX_COVERAGE: readonly SandboxCoverageRow[] = [
  { provider: 'claude', os: 'win32', classes: CLAUDE_WIN32 },
  { provider: 'claude', os: 'darwin', classes: CLAUDE_POSIX },
  { provider: 'claude', os: 'linux', classes: CLAUDE_POSIX },
  { provider: 'codex', os: 'win32', classes: CODEX },
  { provider: 'codex', os: 'darwin', classes: CODEX },
  { provider: 'codex', os: 'linux', classes: CODEX_LINUX }
]

/** Said under the table: E6 is the list, so the rest of the home stays readable inside the sandbox (spec §6). */
export const SANDBOX_TABLE_CAPTION: MessageKey = 'settings.security.sandboxCoverage.homeReadable'

/** Said beside a row the cells cannot say it for: Claude Code's shell on Windows is not restricted; on Linux, from
 *  Ubuntu 25.04 its shell commands fail under AppArmor's profile for bubblewrap (bwrap-userns-restrict), which takes
 *  capabilities away from the programs inside bubblewrap (Task E fix rounds 2 and 3). Null for the others. */
export const sandboxRowCaption = (r: Pick<SandboxCoverageRow, 'provider' | 'os'>): MessageKey | null =>
  r.provider !== 'claude' ? null : r.os === 'win32' ? 'settings.security.sandboxCoverage.windowsClaude' : r.os === 'linux' ? 'settings.security.sandboxCoverage.linuxClaudeUbuntu' : null

/** The protection a sandboxed session of `provider` gets on `platform` (SessionInfo.sandboxKind), decided by the session
 *  managers, which know both: Claude Code on Windows has no sandbox, only deny rules for its file tools; everything else
 *  runs in its CLI's own sandbox. `platform` is a string: the renderer, which has no NodeJS types, reads this file. */
export const sandboxKindOf = (provider: 'claude' | 'codex', platform: string): SandboxKind =>
  provider === 'claude' && platform === 'win32' ? 'deny-only' : 'sandbox'
