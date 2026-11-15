// Claude Code's shell on Windows, in Codex's sandbox (claude shell sandbox design D1 to D3, D7): Claude Code has no
// sandbox of its own on native Windows, so a sandboxed session names a bash wrapper in CLAUDE_CODE_SHELL_PREFIX, and the
// wrapper runs each shell command as `codex sandbox <the Codex session's profile> -- <git bash> <boot script>`. Measured
// with the kit in F:\astera-work\scratch\winsbx\pfx (spec M1 to M5), Claude Code 2.1.325 and codex-cli 0.160.0.

/** The wrapper and the boot script, written beside the scope's settings twin (the profile folder, read-only inside). */
export const SHELL_WRAP_FILE = 'shell-wrap.sh'
export const SHELL_BOOT_FILE = 'shell-boot.sh'

/** What only a Bash tool command carries (spec M2): Claude Code's snapshot `source` before the command and its cwd capture
 *  after it. The model's text sits inside the `eval`, so it can add a mark but never remove one. Not `eval '`: a command
 *  that needs no quoting arrives as `eval whoami` (measured 2026-11-16; the prototype matched on it and ran that outside). */
export const TOOL_MARKS: readonly string[] = ['shell-snapshots/snapshot-', 'pwd -P >|']

/** What the wrapper is built from. `codex`: an absolute path bash can run (bashRunnable); `bash`: Git Bash; `root`: the
 *  session's folder, which becomes the sandbox's work folder (spec M5); `args`: what follows `codex sandbox` before `--`,
 *  the profile's `-c` values; `bootFile`: where SHELL_BOOT_SCRIPT is written; `codexHome`: the borrowed Codex account's
 *  home, null to start codex with CODEX_HOME unset. */
export interface ClaudeShellPlan {
  codex: string
  codexHome: string | null
  bash: string
  root: string
  args: readonly string[]
  bootFile: string
}

const slashed = (p: string): string => p.replace(/\\/g, '/')

// One single-quoted bash word: nothing inside is read by bash, and a single quote is closed, escaped and reopened
const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The wrapper (D2, D3). It passes its argument straight on only when CLAUDE_PROJECT_DIR is set and not empty (Claude Code
 * sets it for hooks, the status line and MCP startup, not for tool commands) AND the argument holds no TOOL_MARKS AND it
 * got exactly one argument (Claude Code passes one, spec M1). Everything else runs inside the sandbox: a future Claude
 * Code that changes either half of the tool shape still lands inside, which is the fail-closed rule.
 *
 * Inside, the command and its folder travel to the boot script in environment variables, not arguments: MSYS rewrites
 * arguments to a native program (`/c/x` to `C:\x`) and the variable carried 100 000 characters whole (spec M4). The MSYS
 * switches are set for the codex launch only, so the `-c` values and paths reach codex as written; the boot script takes
 * them off again. Paths bash runs or enters are forward-slashed; the `-c` values and the codex home are left as given,
 * since only codex reads them. Not `exec` for codex: the measured prototype waited and exited with its code (spec M6).
 */
export function shellWrapScript(plan: ClaudeShellPlan): string {
  const marks = TOOL_MARKS.map((m) => `*${sq(m)}*`).join('|')
  const home = plan.codexHome === null ? 'unset CODEX_HOME' : `export CODEX_HOME=${sq(plan.codexHome)}`
  const root = sq(slashed(plan.root))
  const codex = [sq(slashed(plan.codex)), 'sandbox', ...plan.args.map(sq), '--', sq(slashed(plan.bash)), sq(slashed(plan.bootFile))].join(' ')
  return [
    '#!/bin/bash',
    "# Astera: Claude Code's shell prefix for a sandboxed session on Windows. Written by Astera at each start; do not edit.",
    'if [ "$#" -eq 1 ] && [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then',
    '  case "$1" in',
    `    ${marks}) ;;`,
    '    *) exec bash -c "$1" ;;',
    '  esac',
    'fi',
    'export ASTERA_SBX_SCRIPT="${1-}"',
    'export ASTERA_SBX_CWD="$PWD"',
    'export ASTERA_SBX_CODEX_HOME="${CODEX_HOME-}"',
    home,
    `cd ${root} || { echo "astera sandbox: cannot enter "${root} >&2; exit 125; }`,
    `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' ${codex}`,
    'exit $?',
    ''
  ].join('\n')
}

/** The boot script `codex sandbox` runs under Git Bash (D3): it takes the wrapper's variables back out, puts the
 *  session's own CODEX_HOME back (unset when it was empty), enters the command's folder (126 and a line when the
 *  sandbox's account cannot) and evaluates the command as `bash -c` would have. */
export const SHELL_BOOT_SCRIPT = [
  '#!/bin/bash',
  "# Astera: runs inside Codex's sandbox, the command Claude Code built in the folder it was started in.",
  'unset MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL',
  '__astera_s="${ASTERA_SBX_SCRIPT-}"',
  '__astera_d="${ASTERA_SBX_CWD-}"',
  '__astera_h="${ASTERA_SBX_CODEX_HOME-}"',
  'unset ASTERA_SBX_SCRIPT ASTERA_SBX_CWD ASTERA_SBX_CODEX_HOME',
  'if [ -n "$__astera_h" ]; then export CODEX_HOME="$__astera_h"; else unset CODEX_HOME; fi',
  'cd "$__astera_d" || { echo "astera sandbox: cannot enter $__astera_d" >&2; exit 126; }',
  'unset __astera_d __astera_h',
  'eval "$__astera_s"',
  ''
].join('\n')

/** The two switches a session with the route starts with (D7), in its settings twin's `env` and its environment: the
 *  wrapper, forward-slashed for the bash that runs it, and the PowerShell tool off, since the prefix does not cover it
 *  (spec M7). */
export function claudeShellEnv(wrapFile: string): Record<string, string> {
  return { CLAUDE_CODE_SHELL_PREFIX: slashed(wrapFile), CLAUDE_CODE_USE_POWERSHELL_TOOL: '0' }
}

/** The codex bash can run by its absolute path (D4.3): an `.exe` as it is; for an npm `.cmd` or `.bat` shim the sh shim
 *  npm writes beside it without an extension, when it is there; anything else null. */
export function bashRunnable(resolved: string, exists: (p: string) => boolean): string | null {
  if (/\.exe$/i.test(resolved)) return resolved
  if (!/\.(cmd|bat)$/i.test(resolved)) return null
  const sibling = resolved.replace(/\.(cmd|bat)$/i, '')
  return exists(sibling) ? sibling : null
}
