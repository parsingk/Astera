// What Enforce blocks per provider and kind of session (enforce design §5), apart from policy.ts, which reads the
// profile's files: the renderer reads this table too (Policies' Enforce preview, securityText.ts).
import type { CoverageCell, CoverageRow } from './types'

const SHELL_TEXT_ONLY: CoverageCell = { level: 'partial', note: 'shell-text-only' }
/** Claude's network calls are hooked when WebFetch or WebSearch make them; a `curl` in the shell is shell text. */
const WEB_TOOLS_ONLY: CoverageCell = { level: 'partial', note: 'web-tools-only' }
const ENFORCED: CoverageCell = { level: 'enforced' }

/** What Enforce's hook decides before a call runs (enforce design §5, inventory §19), per provider and kind of session.
 *  Enforced only where the hook sees every call of the class: Codex reads files through its shell, which the hook reads
 *  as text, and network is partial everywhere (Claude's web tools are hooked, a `curl` is shell text; Codex's hosted
 *  web search is not hooked at all). */
export const COVERAGE_ENFORCE: readonly CoverageRow[] = [
  { provider: 'claude', kind: 'terminal', classes: { shell: ENFORCED, 'file-read': ENFORCED, 'file-write': ENFORCED, mcp: ENFORCED, network: WEB_TOOLS_ONLY } },
  { provider: 'claude', kind: 'chat', classes: { shell: ENFORCED, 'file-read': ENFORCED, 'file-write': ENFORCED, mcp: ENFORCED, network: WEB_TOOLS_ONLY } },
  {
    provider: 'codex',
    kind: 'terminal',
    classes: { shell: ENFORCED, 'file-read': SHELL_TEXT_ONLY, 'file-write': ENFORCED, mcp: ENFORCED, network: { level: 'partial', note: 'web-search-and-shell-text' } }
  },
  { provider: 'codex', kind: 'chat', classes: { shell: ENFORCED, 'file-read': SHELL_TEXT_ONLY, 'file-write': ENFORCED, mcp: ENFORCED, network: { level: 'partial' } } }
]
