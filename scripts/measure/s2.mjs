// The S2 measurement's plan (the sandbox plan's Task 2; enforce and sandbox design §10 items 1-4): which sets run on
// which system, and what each hands its sandbox. Every argument, environment variable and settings file comes from the
// builders the sessions will call (src/core/sandbox), so what is measured is what ships. s2.measure.test.mjs runs the
// plan with the S4 workspaces, fixtures and probes (measure-sandbox.mjs, probes.mjs). This module imports the app's
// TypeScript, so it loads under vitest only.
import path from 'node:path'
import { codexSandboxArgs } from '../../src/core/sandbox/codexProfile'
import { claudeSessionDenied } from '../../src/core/sandbox/claudeSettings'
import { codexSessionDenied } from '../../src/core/sandbox/prepared'
import { profileReadOnly } from '../../src/core/sandbox/locations'
import { PROBES, verdict } from './probes.mjs'
import { probeEnv } from './measure-sandbox.mjs'

/** On a GitHub-hosted runner with its variable, or on this Windows PC with the local one. Anywhere else the file runs
 *  as part of the suite and skips: the run writes fake credentials into the home folder. The runner test is
 *  measure-sandbox.mjs's own (both variables), so a machine that copied one of them is not taken for a runner. */
export function s2Enabled(env, platform) {
  if (env.ASTERA_MEASURE_S2 === '1' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted') return true
  return platform === 'win32' && env.ASTERA_MEASURE_S2_LOCAL === '1'
}

/** The readiness probe with a scratch CODEX_HOME has its own variable: a Codex home without the sandbox set up may
 *  bring up Windows' administrator prompt, so it runs only after the person has been asked. */
export const scratchReadinessEnabled = (env, platform) => platform === 'win32' && env.ASTERA_MEASURE_S2_SCRATCH_READINESS === '1'

/** The sets, in the order they run. `layout` is where the session folder is: a repository's root, a subfolder of it, or
 *  a linked worktree whose common directory is in another repository (as an Astera worker's is). */
export const S2_SETS = [
  { name: 'codex-repo', kind: 'codex', layout: 'repo' },
  { name: 'codex-subfolder', kind: 'codex', layout: 'subfolder' },
  { name: 'codex-worktree', kind: 'codex', layout: 'worktree' },
  // The fallback candidate: the common directory's `worktrees` folder in place of the worktree's own git directory
  { name: 'codex-worktree-alt', kind: 'codex', layout: 'worktree', variant: 'alt' },
  // The common case: a repository that never turned extensions.worktreeConfig on, and no config.worktree made first,
  // so the run shows what each sandbox does with the missing files (bubblewrap may leave a mount-point file)
  { name: 'codex-worktree-common', kind: 'codex', layout: 'worktree', common: true },
  // `command/exec` with no sandbox parameter, which "defaults to the user's configured policy"
  { name: 'app-server', kind: 'app-server', layout: 'worktree' },
  // `command/exec` naming the profile, as `thread/start`'s `permissions` does for a thread's commands
  { name: 'app-server-profile', kind: 'app-server', layout: 'worktree', profileParam: true },
  // srt on Linux puts /dev/null over the names it protects that are missing in the folder, and `git add -A` refuses a
  // device (inventory §22.5): an exclude file with srt's file names (the plan's candidate), then with its directories too
  { name: 'srt-linux-exclude', kind: 'srt', layout: 'worktree', platforms: ['linux'], exclude: 'files' },
  { name: 'srt-linux-exclude-dirs', kind: 'srt', layout: 'worktree', platforms: ['linux'], exclude: 'directories' },
  // srt on macOS with a socket where the Host listens, granted and not: the shipped settings grant none (final fix pass,
  // C2), so the ungranted control (socketWithoutGrant) is what a sandboxed Claude session gets
  { name: 'srt-mac-socket', kind: 'srt', layout: 'worktree', platforms: ['darwin'], socket: true },
  // Task E (2026-10-28): Astera's profile folder inside the session's folder (no repository), as a session started in
  // the home folder holds it: its sandbox keeps it read-only and the Host key in it readable. Sets of their own, so a
  // profile folder never sits in another set's repository, where git would see it
  { name: 'codex-profile', kind: 'codex', layout: 'folder', profileInside: true },
  { name: 'srt-profile', kind: 'srt', layout: 'folder', platforms: ['linux', 'darwin'], profileInside: true }
]

export const s2SetNames = (platform) => S2_SETS.filter((s) => s.platforms === undefined || s.platforms.includes(platform)).map((s) => s.name)

/** What a sandboxed Codex session may not read: E6, the OS credential store its sandbox leaves open (the macOS
 *  keychains, the Linux session bus), on macOS and Linux the folder a Host's socket is in (`hostDir`), and on every OS
 *  the profile's app key (`appKeyFile`). The list a session's start builds (prepared.ts codexSessionDenied, which
 *  sessionSandboxArgs denies), so what is measured is what a start hands Codex. */
export const codexDenied = (platform, env, home, hostDir = null, appKeyFile = null) =>
  codexSessionDenied({ platform, env, homeDir: home, hostSocketDir: hostDir, appKeyFile })

/** What a sandboxed Claude session may not read: E6, the OS credential store (the macOS keychains; the Linux session
 *  bus, which srt blocks with every Unix socket anyway, inventory §22.3) and the profile's app key (`appKeyFile`). The
 *  list a Claude start builds (claudeSettings.ts claudeSessionDenied, which StatusLineManager's twins deny), so what is
 *  measured is what a start hands Claude. */
export const claudeDenied = (platform, env, home, appKeyFile = null) => claudeSessionDenied({ platform, env, homeDir: home, appKeyFile })

/** What a sandboxed session of either CLI may not write: Astera's profile folder (`profileDir`, Task E). The list every
 *  start builds (locations.ts profileReadOnly, which sessionSandboxArgs keeps read and StatusLineManager's twins keep
 *  from being written), so what is measured is what a start hands either sandbox. */
export const sessionReadOnly = (profileDir = null) => profileReadOnly(profileDir)

/** `codex sandbox` and `codex app-server` take the profile's `-c` values; `-a never` is an option of the session command,
 *  which the builder puts first. */
export function codexSandboxCommandArgs(args) {
  if (args[0] !== '-a' || args[1] !== 'never') throw new Error(`the builder's arguments no longer start with -a never: ${args.slice(0, 2).join(' ')}`)
  return args.slice(2)
}

/** The permission profile's name, read off the builder's `default_permissions`, so thread/start names the same one. */
export function profileNameOf(args) {
  const m = args.map((a) => /^default_permissions="([^"]+)"$/.exec(a)).find((x) => x !== null)
  if (!m) throw new Error('the builder names no default_permissions')
  return m[1]
}

const tomlEntry = (p, access) => `${JSON.stringify(p)}=${JSON.stringify(access)}`

/** A set's Codex arguments: the builder's, with `-a never` dropped. The fallback (`variant: 'alt'`) names the common
 *  directory's `worktrees` folder where the builder names the worktree's own git directory, and nothing else changes. */
export function codexSetArgs({ platform, layout, denied, readOnly, variant = 'shipped' }) {
  const args = codexSandboxCommandArgs(codexSandboxArgs({ platform, layout, denied, readOnly }))
  if (variant !== 'alt') return args
  if (!layout?.worktree || layout.gitDir === layout.commonDir) throw new Error('the fallback grant is for a session in a linked worktree')
  const from = tomlEntry(layout.gitDir, 'write')
  const to = tomlEntry(`${layout.commonDir}/worktrees`, 'write')
  const i = args.findIndex((a) => a.startsWith('permissions=') && a.includes(from))
  if (i < 0) throw new Error(`the builder's profile does not name the worktree's git directory: ${from}`)
  return args.map((a, j) => (j === i ? a.replace(from, to) : a))
}

/**
 * Claude's sandbox settings (the builder's `sandbox` part) as srt's own settings file, the way Claude Code hands them to
 * the runtime: the session folder writable, Claude's temp folder too (srt's default `/tmp/claude`), the builder's
 * paths, and for a worktree its common directory with the hooks and config kept read-only, which Claude does itself
 * ("Filesystem isolation", code.claude.com/docs/en/sandboxing), after the builder's own denyWrite (the git files that
 * decide what git runs, final fix pass C1). srt on its own takes only a list of hosts, so the list names the ones the
 * probes reach; how Claude Code opens the network cannot be measured without a login.
 */
export function srtSettingsOf(claude, { commonDir = null, allowUnixSockets } = {}) {
  const s = claude.sandbox
  if (!s) throw new Error('these Claude settings have no sandbox part (win32 gets the deny rules only)')
  const network = { allowedDomains: ['example.com', 'registry.npmjs.org'], deniedDomains: [] }
  if (allowUnixSockets !== undefined) network.allowUnixSockets = allowUnixSockets
  return {
    network,
    filesystem: {
      denyRead: s.filesystem.denyRead,
      allowRead: [],
      allowWrite: ['.', ...s.filesystem.allowWrite, ...(commonDir ? [commonDir] : [])],
      denyWrite: [...new Set([...s.filesystem.denyWrite, ...(commonDir ? [`${commonDir}/hooks`, `${commonDir}/config`] : [])])]
    }
  }
}

/** srt 0.0.79's own lists (`DANGEROUS_FILES` and `getDangerousDirectories()` in dist/sandbox/sandbox-utils.js). The run
 *  reads them off the installed package too, so a drift shows in the results. */
export const SRT_DANGEROUS_FILES = ['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json']
export const SRT_DANGEROUS_DIRECTORIES = ['.vscode', '.idea', '.claude/commands', '.claude/agents']

/** The exclude file's patterns. A name without a slash matches at any depth; a path is relative to the repository's top,
 *  so the `.claude` ones are spelled for any depth, since srt puts them in the session folder, which may be a subfolder. */
export function excludePatterns({ directories }) {
  if (!directories) return [...SRT_DANGEROUS_FILES]
  return [...SRT_DANGEROUS_FILES, ...SRT_DANGEROUS_DIRECTORIES.map((d) => (d.includes('/') ? `**/${d}` : d))]
}

/** The person's global excludes first, since `core.excludesFile` passed this way replaces theirs, then the patterns. */
export function excludesText(globalText, patterns) {
  const own = globalText.replace(/\s+$/, '')
  return `${own ? `${own}\n` : ''}${patterns.join('\n')}\n`
}

export const excludesEnv = (file) => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: file })

/** Where git reads the global excludes from: `core.excludesFile` when it is set, else `$XDG_CONFIG_HOME/git/ignore`, else
 *  `~/.config/git/ignore` (git-config(1)). */
export function globalExcludesPath(configured, env, home) {
  const h = home.replace(/\\/g, '/')
  if (configured) return configured.startsWith('~/') ? `${h}/${configured.slice(2)}` : configured
  return env.XDG_CONFIG_HOME ? `${env.XDG_CONFIG_HOME.replace(/\\/g, '/')}/git/ignore` : `${h}/.config/git/ignore`
}

/** A file name the fixture's global excludes list, and the probe that says whether git still ignores it. */
export const GLOBAL_IGNORED = 'astera-probe-ignored.txt'
export const GLOBAL_EXCLUDE_PROBE = { id: 'git-global-exclude', line: `git check-ignore -q ${GLOBAL_IGNORED}` }

/** Connects to the socket a child node process listens on (srt-mac-socket) and prints what it answers. */
export const SOCKET_PROBE = {
  id: 'unix-socket',
  line: `node -e 'const s = require("net").connect(process.env.ASTERA_PROBE_SOCKET); s.on("data", (d) => { process.stdout.write(d); process.exit(0) }); s.on("error", (e) => { console.error(e.message); process.exit(1) })'`
}

const WIN32_COMMIT = 'git -c user.name=p -c user.email=p@p commit -qm probe'

/**
 * The Windows probes (plan Task 2, the local variable), as cmd.exe lines. None holds a double quote: node and codex
 * pass the line to cmd.exe as one argument, quoting it with backslash escapes that cmd.exe does not read. So the
 * helpers live in ASTERA_PROBE_DIR (fetch.cjs, the credential request) and the paths come from variables:
 * - `write-home`: the fake home is in TEMP, which the sandbox may write, so the line writes ASTERA_PROBE_OUTSIDE, a
 *   folder outside TEMP and the workspace, as the person's home is;
 * - `git-hooks-write`: ASTERA_PROBE_HOOKS is the hooks folder of the common directory `gitLayoutOf` found;
 * - `git-credential`: git's store helper and the fake home's `.git-credentials` (an E6 entry), with the system config,
 *   and so Git Credential Manager and its window, left out.
 */
export const WIN32_PROBES = [
  { id: 'write-workspace', line: 'echo x> probe-write.txt' },
  { id: 'write-tmp', line: 'echo x> %TEMP%\\astera-probe.txt' },
  { id: 'write-home', line: 'echo x> %ASTERA_PROBE_OUTSIDE%\\astera-probe-write.txt' },
  { id: 'git-credential', line: 'git credential fill < %ASTERA_PROBE_DIR%\\credential-request.txt' },
  { id: 'network', line: 'node %ASTERA_PROBE_DIR%\\fetch.cjs https://example.com' },
  { id: 'loopback', line: 'node %ASTERA_PROBE_DIR%\\fetch.cjs http://127.0.0.1:%ASTERA_PROBE_PORT%/' },
  { id: 'git-commit', line: `echo c>> commit.txt && git add -A && ${WIN32_COMMIT}` },
  { id: 'git-commit-named', line: `echo n>> named.txt && git add named.txt && ${WIN32_COMMIT}` },
  { id: 'git-hooks-write', line: 'echo x> %ASTERA_PROBE_HOOKS%\\pre-commit' },
  { id: 'git-config-write', line: 'git config core.hooksPath C:/astera-probe-hooks' },
  { id: 'npm-install', line: 'npm install --prefix . --no-audit --no-fund --loglevel=error is-number@7.0.0' }
]

/** The helpers the Windows probes run from ASTERA_PROBE_DIR. fetch.cjs sets the exit code and lets node end by itself:
 *  found by the first local run, `process.exit()` while the TLS socket closes crashes node 24 on Windows ("Assertion
 *  failed: !(handle->flags & UV_HANDLE_CLOSING)") after the answer has come. It tries twice, since a smoke run read a
 *  one-off "read ECONNRESET" from example.com as denied; a sandbox that refuses the network refuses both. */
export const WIN32_PROBE_FILES = {
  'fetch.cjs':
    "// Exit code 0 on any HTTP answer below 500, 1 on none in two tries\nconst get = () => fetch(process.argv[2], { signal: AbortSignal.timeout(15000) }).then(async (r) => { await r.arrayBuffer(); return r.status })\nget().catch(() => get()).then((status) => { console.log(status); process.exitCode = status < 500 ? 0 : 1 }, (e) => { console.error(String(e?.cause?.message ?? e?.message ?? e)); process.exitCode = 1 })\n",
  'credential-request.txt': 'protocol=https\nhost=astera-probe.example\n\n'
}

/** Write the `config.worktree` files git may read for the session's repository (git reads them under
 *  `extensions.worktreeConfig`, and one can set `core.hooksPath`): the one in the git directory git names for the
 *  session (a worktree's own, or a repository's `.git`), the main checkout's in the common directory, and another
 *  worktree's (ASTERA_PROBE_SIBLING, a second worktree the run adds). On Windows the directories come from variables the
 *  run sets from `gitLayoutOf`. */
export const CONFIG_WORKTREE_PROBES = [
  { id: 'git-worktree-config-write', line: `echo '[core]' >> "$(git rev-parse --path-format=absolute --git-dir)/config.worktree"` },
  { id: 'git-common-config-worktree-write', line: `echo '[core]' >> "$(git rev-parse --path-format=absolute --git-common-dir)/config.worktree"` },
  { id: 'git-sibling-config-worktree-write', line: `echo '[core]' >> "$ASTERA_PROBE_SIBLING"` }
]
export const WIN32_CONFIG_WORKTREE_PROBES = [
  { id: 'git-worktree-config-write', line: 'echo [core]>> %ASTERA_PROBE_GITDIR%\\config.worktree' },
  { id: 'git-common-config-worktree-write', line: 'echo [core]>> %ASTERA_PROBE_COMMON%\\config.worktree' },
  { id: 'git-sibling-config-worktree-write', line: 'echo [core]>> %ASTERA_PROBE_SIBLING%' }
]

/** Everyday git in the session's checkout (final fix pass, C1): with every commondir, modules and a worktree's `.git`
 *  pointer read-only, and the missing ones made first, these must still run. Normal work only. */
export const NORMAL_WORK_PROBES = [
  { id: 'git-status', line: 'git status --porcelain' },
  { id: 'git-log', line: 'git log -1 --format=%s' },
  { id: 'git-worktree-list', line: 'git worktree list' }
]
/** The same for cmd.exe, which reads `%` as the start of a variable, so the log line names no format; none of them holds
 *  a double quote (WIN32_PROBES). And the global ignore entry the fixture adds: the elevated sandbox's own account cannot
 *  read the person's home, so the session's git reads the copy the start writes in TEMP (gitExcludes.ts), and `-v` says
 *  which file the entry came from. The run's fake home is in TEMP itself, so this says the copy is read and applied, not
 *  that the home could not be. */
export const WIN32_NORMAL_WORK_PROBES = [
  { id: 'git-status', line: 'git status --porcelain' },
  { id: 'git-log', line: 'git log -1 --oneline' },
  { id: 'git-worktree-list', line: 'git worktree list' },
  { id: GLOBAL_EXCLUDE_PROBE.id, line: `git check-ignore -v ${GLOBAL_IGNORED}` }
]

/** Where a profile set keeps its profile folder, inside the session's folder. */
export const PROFILE_FOLDER = 'astera-profile'

/** The two checks of a profile folder inside the session's folder (ASTERA_PROBE_PROFILE), and nothing else (Task E): a
 *  single file written into it, which the sandbox must refuse, and the Host key read, which it must allow, since the
 *  `astera` inside a session checks the loopback's proof with it. Plain normal use only. */
export const PROFILE_PROBES = [
  { id: 'profile-write', line: 'echo x > "$ASTERA_PROBE_PROFILE/astera-probe-write.txt"' },
  { id: 'profile-host-key-read', line: 'cat "$ASTERA_PROBE_PROFILE/host/host.key" > /dev/null' }
]
/** The same for cmd.exe, with no double quote (WIN32_PROBES). */
export const WIN32_PROFILE_PROBES = [
  { id: 'profile-write', line: 'echo x> %ASTERA_PROBE_PROFILE%\\astera-probe-write.txt' },
  { id: 'profile-host-key-read', line: 'type %ASTERA_PROBE_PROFILE%\\host\\host.key > nul' }
]
export const profileProbesFor = (platform) => (platform === 'win32' ? WIN32_PROFILE_PROBES : PROFILE_PROBES)

/** What the common-case set runs (and its sanity line first): a commit, the config.worktree writes and normal work. */
export const COMMON_CASE_PROBES = ['git-commit', ...CONFIG_WORKTREE_PROBES.map((p) => p.id), ...NORMAL_WORK_PROBES.map((p) => p.id)]

/** The probes for a set's layout: the S4 ones on macOS and Linux, without those that `cd wt` (a worktree below the
 *  session's repository) where the session is not that repository's root; the cmd.exe ones on Windows. Both end with
 *  the config.worktree probes, which S4 did not have, and the normal-work ones. */
export function probesFor(platform, layout) {
  if (platform === 'win32') return [...WIN32_PROBES, ...WIN32_CONFIG_WORKTREE_PROBES, ...WIN32_NORMAL_WORK_PROBES]
  return [...(layout === 'repo' ? PROBES : PROBES.filter((p) => !p.line.startsWith('cd wt '))), ...CONFIG_WORKTREE_PROBES, ...NORMAL_WORK_PROBES]
}

export const shellArgv = (platform, line) => (platform === 'win32' ? ['cmd.exe', '/d', '/c', line] : ['sh', '-c', line])
export const sanityLine = (platform) => (platform === 'win32' ? 'echo ok' : 'true')

/** The Windows readiness probe (design §10 item 1), as the plan gives it. */
export const READY_MARKER = 'ASTERA_SANDBOX_OK'
const modeArgv = (mode, command) => ['sandbox', '-c', `windows.sandbox="${mode}"`, '--', 'cmd.exe', '/d', '/c', ...command]
export const readinessArgv = (mode) => modeArgv(mode, ['echo', READY_MARKER])
/** The same command running programs rather than cmd.exe's own `echo`: who runs it, which tells the implementations
 *  apart, and whether a program starts at all (found by the first local run: under mxc `echo` answered and `whoami`
 *  did not start). */
export const whoamiArgv = (mode) => modeArgv(mode, ['whoami'])
export const nodeVersionArgv = (mode) => modeArgv(mode, ['node', '--version'])
/** Codex's own report, which reads the sandbox setup without running it ("sandbox provisioning" under sandbox.helpers). */
export const DOCTOR_ARGV = ['-c', 'windows.sandbox="elevated"', 'doctor', '--json']

/** The run's own environment without what `npx` hands its children (the workflow and the local run start vitest with
 *  it): npm's whole config as `npm_config_*`, the person's real `~/.npmrc` among it. A session Astera starts has none of
 *  them. Found by the first local run. */
export function withoutNpmRunEnv(env) {
  const e = { ...env }
  for (const k of Object.keys(e))
    if (/^npm_(config|package|lifecycle)_/i.test(k) || ['npm_command', 'npm_execpath', 'npm_node_execpath', 'INIT_CWD'].includes(k)) delete e[k]
  return e
}

/**
 * The local Windows run's environment: the probes' (measure-sandbox.mjs) in a fake home, with the person's own
 * CODEX_HOME. Codex looks for its sandbox setup there, or in the home folder without it, and a home without the setup
 * brings up Windows' administrator prompt. A registered core makes a set-up home read as not set up, so it is left out.
 * Git's system config is left out too: it names Git Credential Manager, which could open a window for the fake host.
 * So are the variables that point git's global or system config elsewhere (XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL,
 * GIT_CONFIG_SYSTEM): with them the fixtures' `git config --global` and the global excludes could reach the person's own.
 */
export function localWin32Env({ env, home, codexHome, probeDir, outside, port }) {
  const e = {
    ...probeEnv(env, home, port),
    USERPROFILE: home,
    APPDATA: path.win32.join(home, 'AppData', 'Roaming'),
    CODEX_HOME: codexHome,
    ASTERA_PROBE_DIR: probeDir,
    ASTERA_PROBE_OUTSIDE: outside,
    GIT_CONFIG_NOSYSTEM: '1',
    GCM_INTERACTIVE: 'never',
    GIT_TERMINAL_PROMPT: '0'
  }
  for (const k of ['CODEX_WINDOWS_REGISTERED_CORE', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) delete e[k]
  return e
}

/** `thread/start` for a sandboxed chat (plan Task 6): the named profile, which "cannot be combined with `sandbox`". */
export const s2ThreadStart = (cwd, profile) => ({ cwd, approvalPolicy: 'never', permissions: profile })

/** `command/exec` for one probe. No sandbox parameter; `permissionProfile` only in the set that names the profile. */
export const execParams = ({ platform, line, cwd, profile, timeoutMs }) => ({
  command: shellArgv(platform, line),
  cwd,
  timeoutMs,
  ...(profile ? { permissionProfile: profile } : {})
})

const OUT_MAX = 400
const ANSWER_MAX = 8000

/** An answer kept whole when it is short, as text cut at ANSWER_MAX when it is not. */
export function clip(answer) {
  const s = JSON.stringify(answer) ?? 'null'
  return s.length <= ANSWER_MAX ? answer : { truncated: s.slice(0, ANSWER_MAX) }
}

/** `thread/start`'s answer for the results: what it says about the sandbox, the profile and the approval policy copied
 *  out first, so they stay whole however long the rest of the answer is. */
export function threadStartRecord(answer) {
  const r = answer.result
  const own = r ? { sandbox: r.sandbox, activePermissionProfile: r.activePermissionProfile, approvalPolicy: r.approvalPolicy } : {}
  return { ok: Boolean(r), ...own, ...(answer.error ? { error: answer.error } : {}), answer: clip(answer) }
}

/** codex's words for a command that ran past its timeout: `SandboxErr::Timeout` ("command timed out") behind
 *  command_exec.rs's "exec failed: " (rust-v0.160.0). A denied command's own output only ever follows "sandbox denied
 *  exec error", so a probe's "timed out" on stderr cannot read as this. */
const EXEC_TIMEOUT = /^exec failed: sandbox error: command timed out\b/

/** A `command/exec` answer read as a probe's result (probes.mjs runProbes' shape). A command the sandbox stopped comes
 *  back as an error rather than an exit code, so the error's text is the output. */
export function execResult(id, answer) {
  const r = answer.result
  const code = typeof r?.exitCode === 'number' ? r.exitCode : null
  const message = answer.error?.message ?? ''
  return {
    id,
    code,
    ok: code === 0,
    timedOut: Boolean(answer.timedOut) || EXEC_TIMEOUT.test(message),
    missing: false,
    out: (r ? `${r.stdout ?? ''}${r.stderr ?? ''}` : message).slice(0, OUT_MAX),
    ...(answer.error ? { error: answer.error } : {})
  }
}

/** The probes that failed with no sandbox: an instrument fault, never a finding. */
export const brokenPlain = (plain) => plain.filter((p) => !p.ok).map((p) => p.id)

export const verdicts = (plain, sandboxed) => Object.fromEntries(plain.map((p) => [p.id, verdict(p, sandboxed.find((s) => s.id === p.id) ?? { refused: true })]))

/** The sets as Markdown: one row per probe, one column per set, each read against the set's own run with no sandbox. */
export function s2Table(title, sets) {
  const names = Object.keys(sets)
  const ids = []
  for (const n of names) for (const p of sets[n].plain) if (!ids.includes(p.id)) ids.push(p.id)
  const rows = ids.map((id) => {
    const cells = names.map((n) => {
      const plain = sets[n].plain.find((p) => p.id === id)
      const sandboxed = sets[n].sandboxed.find((p) => p.id === id)
      return plain === undefined || sandboxed === undefined ? 'not run' : verdict(plain, sandboxed)
    })
    return `| ${id} | ${cells.join(' | ')} |`
  })
  return [`### ${title}`, '', `| probe | ${names.join(' | ')} |`, `| --- | ${names.map(() => '---').join(' | ')} |`, ...rows, ''].join('\n')
}
