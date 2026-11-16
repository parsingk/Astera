// What a sandboxed Claude start does before its spawn (sandbox design §6), for both session managers: the terminal one
// (core/sessions/manager.ts) and the chat one (core/chat/manager.ts). Claude's sandbox is its settings file, written by
// StatusLineManager.ensureSandboxFiles for the start's scope: the folder's git layout, whose git files it keeps from being
// written (final fix pass, C1), and the environment the session is built from. What else is done: the version floor,
// npm's cache folder (macOS and Linux) and, on Linux, the git excludes Task 2 measured (inventory §23.4). On Windows,
// whether the session's shell can run in a Codex account's sandbox (claude shell sandbox design D4 to D6).
// Both spawns are synchronous, so everything here that touches the disk or runs a process is done in `prepare`, which
// every caller awaits first (a roll before its kill).
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { ENFORCE_MIN, atLeast, type CliVersionProbe } from '../sessions/cliVersion'
import { writeScript, type SandboxFilesResult, type SandboxScope } from '../sessions/statusline'
import { appServerSandboxArgs, appendGitConfig, codexSandboxEnv, npmCacheOf } from './codexProfile'
import { globalExcludesText, runGitFile, type CodexExcludes, type RunGit } from './gitExcludes'
import { ensureGitFiles, ensureWorktreeConfigFiles, gitLayoutOf, type GitLayout } from './gitLayout'
import { PREPARED_MS, PreparedLayouts, codexVersionBlocker, prepareCodexSandbox, type CodexVersionProbe, type CodexWindowsReady } from './prepared'
import type { DenyEntry, LinkLook } from './locations'
import type { ClaudeSandboxSettings } from './claudeSettings'
import { bashRunnable, type ClaudeShellPlan } from './claudeShell'
import { SANDBOX_UNAVAILABLE, sandboxUnavailable } from './unavailable'

const slashed = (p: string): string => p.replace(/\\/g, '/')

/** Why a sandboxed Claude start on Windows has no route for its shell into Codex's sandbox (claude shell sandbox design
 *  D4), in D4's order: no Git Bash (Claude Code then has no Bash tool to wrap), no Codex account registered, no codex
 *  bash can run (or one whose version is not there), a codex older than ENFORCE_MIN.codex or of a version not known,
 *  the account's Windows sandbox not set up, Codex could not be asked about it, anything else (the log names it). */
export type ClaudeShellOff = 'no-git-bash' | 'no-codex-account' | 'no-codex' | 'codex-too-old' | 'not-set-up' | 'check-failed' | 'other'

/** What a prepare decided for the shell (ClaudeSandboxStart.shellOf): on, or off with the reason and the refusal a start
 *  that must be sandboxed gets for it (D5). */
export type ClaudeShellState = { on: true } | { on: false; why: ClaudeShellOff; refusal: string }

/** D5's refusal for the reasons whose own code says nothing the person could act on. */
const NO_SANDBOX_CLAUDE = `${SANDBOX_UNAVAILABLE}: no-sandbox claude`

/** The reason a Codex prepare's refusal is for Claude's shell (prepareCodexSandbox, codexSandboxBlocker): its codes for
 *  codex itself and for the account's Windows sandbox keep their own words as the refusal, which name the account to set
 *  up; every other refusal or failure is `other`, refused as `no-sandbox claude` (D5), the log naming the cause. */
const SHELL_OFF_BY_CODE = new Map<string, ClaudeShellOff>([
  ['cli-missing', 'no-codex'],
  ['cli-too-old', 'codex-too-old'],
  ['cli-version-unknown', 'codex-too-old'],
  ['windows-setup', 'not-set-up'],
  ['windows-check-failed', 'check-failed']
])

function shellOffOf(err: unknown): { why: ClaudeShellOff; refusal: string } {
  const message = err instanceof Error ? err.message : String(err)
  const code = new RegExp(`^${SANDBOX_UNAVAILABLE}: (\\S+)`).exec(message)?.[1]
  const why = code === undefined ? undefined : SHELL_OFF_BY_CODE.get(code)
  return why === undefined ? { why: 'other', refusal: NO_SANDBOX_CLAUDE } : { why, refusal: message }
}

/** The route a prepare found, kept for the spawn: the wrapper's plan, the Codex account it borrows, and what that
 *  account's Codex prepare read for the session's environment (codexSandboxEnv: the layout, the excludes copy). */
interface ShellRoute {
  plan: Omit<ClaudeShellPlan, 'bootFile'>
  accountId: string
  layout: GitLayout | null
  excludesFile: string | null
}

type ShellDecision = { on: true; route: ShellRoute } | { on: false; why: ClaudeShellOff; refusal: string }

/** srt 0.0.79's own lists (`DANGEROUS_FILES` and `getDangerousDirectories()` in dist/sandbox/sandbox-utils.js), the runtime
 *  Claude Code's sandbox uses. On Linux srt mounts `/dev/null` over each of them that is missing in the session folder, and
 *  `git add -A` then fails on the placeholder ("can only add regular files"). */
export const SRT_DANGEROUS_FILES = ['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json']
export const SRT_DANGEROUS_DIRECTORIES = ['.vscode', '.idea', '.claude/commands', '.claude/agents']

/** The exclude file's text: the person's own excludes first, since `core.excludesFile` passed through GIT_CONFIG takes the
 *  place of theirs, then srt's names. A name without a slash matches at any depth; the `.claude` folders are spelled for any
 *  depth too, since srt puts them in the session folder, which may be a subfolder of the repository (measured with exactly
 *  these lines, inventory §23.4). */
export function gitExcludesText(globalText: string): string {
  const own = globalText.replace(/\s+$/, '')
  const lines = [...SRT_DANGEROUS_FILES, ...SRT_DANGEROUS_DIRECTORIES.map((d) => (d.includes('/') ? `**/${d}` : d))]
  return `${own ? `${own}\n` : ''}${lines.join('\n')}\n`
}

/** The exclude file, in the profile folder, which the sandbox lets a session read (it denies only the E6 list), named for
 *  the user whose sessions read it. */
export const gitExcludesFileOf = (profileDir: string, uid: number): string => `${slashed(profileDir).replace(/\/+$/, '')}/sandbox/excludes-${uid}`

/** A sandboxed Claude session's environment, on macOS and Linux (on Windows nothing here: a session whose shell runs in
 *  Codex's sandbox gets that sandbox's environment from its scope, `SandboxScope.shell.env`, and one without keeps npm's
 *  own cache):
 *  - npm's cache in TEMP, since srt leaves out a write path that does not exist and the default cache is under the home
 *    folder;
 *  - on Linux the exclude file, numbered after the GIT_CONFIG_* entries the session inherits (`env`), as codexSandboxEnv
 *    numbers its own; `excludesFile` null: it could not be written, and git keeps the person's own excludes.
 *  No Host address is planted: the sandbox grants no socket, so `astera` reaches the Host through `excludedCommands`,
 *  outside the sandbox, where it derives the address as any session does. */
export function claudeSandboxEnv(o: {
  platform: NodeJS.Platform
  tmpDir: string
  excludesFile: string | null
  env?: Record<string, string | undefined>
}): Record<string, string> {
  if (o.platform === 'win32') return {}
  const env: Record<string, string> = { npm_config_cache: npmCacheOf(o.tmpDir) }
  if (o.platform !== 'linux' || o.excludesFile === null) return env
  return { ...env, ...appendGitConfig(o.env, [['core.excludesFile', o.excludesFile]]) }
}

/** Why a sandboxed Claude cannot start, or null: older than the floor Enforce measured (cliVersion.ts ENFORCE_MIN), whose
 *  sandbox keys were measured with it, or a Claude whose version is not known, which could be one that ignores them and
 *  runs its shell unsandboxed (E5). The CLI's own words for each are the version check's codes. */
export function claudeSandboxBlocker(version: string | null | undefined): string | null {
  if (version === undefined) return `${SANDBOX_UNAVAILABLE}: cli-missing claude`
  if (version === null) return `${SANDBOX_UNAVAILABLE}: cli-version-unknown claude`
  return atLeast(version, ENFORCE_MIN.claude) ? null : `${SANDBOX_UNAVAILABLE}: cli-too-old claude ${version} ${ENFORCE_MIN.claude}`
}

/** What both session managers ask of a sandboxed Claude start. */
export interface ClaudeSandboxStart {
  /** The version floor; on macOS and Linux the folder's git layout read and its missing git files made (`git-layout` when
   *  either fails); on Windows the route for the shell (claude shell sandbox design D4: `gitBash` is the Git Bash the
   *  manager's prepare found, null for none), which with `required` (a start that must be sandboxed) refuses with the
   *  reason's refusal (D5) when there is none, and without it goes on with the deny rules; the settings twins for the
   *  scope (`settings-write-failed` when they cannot be written); npm's cache folder on macOS and Linux, and on Linux the
   *  exclude file, in that order: an old Claude is refused before anything is written. `env` is the environment the
   *  session is built from (its account's, before the hiding), the one the spawn hands scopeOf. Rejects with
   *  `SANDBOX_UNAVAILABLE: …`. Off Windows `gitBash` and `required` change nothing. */
  prepare(o: { accountId: string; cwd: string; env: Record<string, string | undefined>; gitBash?: string | null; required?: boolean }): Promise<void>
  /** The version floor again, read synchronously at the spawn (the CLI may have changed since the prepare). */
  blocker(): string | null
  /** The scope a prepare wrote twins for, for this account and folder within PREPARED_MS, with `env`, the environment the
   *  session is built from, and on Windows the route for the shell (`shell`) when that prepare found one; undefined when
   *  no prepare kept one, and the spawn then refuses with `not-prepared`. */
  scopeOf(accountId: string, cwd: string, env: Record<string, string | undefined>): SandboxScope | undefined
  /** Windows: what the prepare kept for this account and folder within PREPARED_MS decided for the shell (D4, D5), never a
   *  new look. A folder with no prepare kept, and every folder off Windows, where nothing is decided, answers off with
   *  `other` and `not-prepared`; a spawn that asks off Windows is asking the wrong question. */
  shellOf(accountId: string, cwd: string): ClaudeShellState
  /** A chat's one `--settings`: the sandbox of its scope, with the Enforce hook when `enforce`; null when it was not
   *  written. */
  chatArgs(enforce: boolean, scope: SandboxScope): string[] | null
  /** The settings the scope's twin holds, and the links its named paths go through (Task K: a Task's check runs under
   *  them, srtCheck.ts). */
  settingsOf(scope: SandboxScope): { part: ClaudeSandboxSettings; links: string[] }
  /** What the session's environment gets, after everything else Astera adds: `inherited` is that environment. */
  env(inherited: Record<string, string | undefined>): Record<string, string>
}

export function claudeSandboxStart(o: {
  platform: NodeJS.Platform
  /** Astera's profile folder, where the exclude file goes. */
  profileDir: string
  /** The person's home and environment, for where git keeps their global excludes. */
  homeDir: string
  env: Record<string, string | undefined>
  /** os.tmpdir(), where npm's cache goes. */
  tmpDir: string
  files: {
    ensureSandboxFiles(scope: SandboxScope): Promise<SandboxFilesResult>
    sandboxChatArgs(enforce: boolean, scope: SandboxScope): string[] | null
    sandboxPartOf(scope: SandboxScope): { part: ClaudeSandboxSettings; links: string[] }
    /** The agents' login files a scope's twin denies, chosen once here at the prepare (sandbox design §6): kept with the
     *  prepared layout and carried by the scope the spawn gets. Absent, the twin chooses them itself each time. */
    chooseAgentLogins?(scope: Pick<SandboxScope, 'look'>): string[]
  }
  /** The version check Enforce asks (cliVersion.ts), shared with it. */
  version: Pick<CliVersionProbe, 'warm'> & ((cli: 'claude') => string | null | undefined)
  /** Linux: the user the exclude file is named for. Default: this process's. */
  uid?: number
  /** Test injection; default runs git. */
  runGit?: RunGit
  /** Test injection; default Date.now. */
  now?: () => number
  /** How the disk is read for links on the paths the twins name (Task E fix round 5, core/sandbox/locations.ts
   *  namedPathFor), carried on each scope: the app's and the Host's wiring give nodeLinkLook; null names every path as
   *  given. Required (fix round 6), so a wiring that forgets it does not compile. */
  linkLook: LinkLook | null
  log: (m: string) => void
  // Windows only, for the route of the shell into Codex's sandbox (claude shell sandbox design D4, D6); each absent
  // reads as that step failing, so a wiring without them starts as before the route existed
  /** The default Codex account and the environment its sessions start with (its CODEX_HOME is the home the sandbox runs
   *  under); null when no Codex account is registered. */
  shellCodex?: () => { account: { id: string }; env: Record<string, string | undefined> } | null
  /** Whether that account's Windows sandbox is set up (prepareCodexSandbox `ready`). */
  codexReady?: CodexWindowsReady
  /** The codex version question (prepareCodexSandbox `version`). */
  codexVersion?: CodexVersionProbe
  /** The codex the account's sessions would start, resolved to an absolute path; null when none is found. */
  codexExe?: () => string | null
  /** Writes the copy of the person's git excludes the sandbox's own account reads (prepareCodexSandbox `excludes`). */
  codexExcludes?: CodexExcludes
  /** The profile's app key, the read-only folders and the agents' login files, as a sandboxed Codex start of this process
   *  gets them (prepareCodexSandbox). */
  appKeyFile?: string | null
  readOnly?: readonly string[]
  agentLogins?: () => readonly DenyEntry[]
  /** Test injection; default existsSync. */
  exists?: (p: string) => boolean
}): ClaudeSandboxStart {
  const excludesFile = gitExcludesFileOf(o.profileDir, o.uid ?? process.getuid?.() ?? 0)
  const runGit = o.runGit ?? runGitFile
  const now = o.now ?? Date.now
  const exists = o.exists ?? existsSync
  /** The layouts the prepares read, by account and folder, for the spawn's scope, as a Codex start keeps its own. */
  const layouts = new PreparedLayouts()
  /** What the Windows prepares decided for the shell, by account and folder, kept and trusted as long as their layouts. */
  const shells = new Map<string, { decided: ShellDecision; at: number }>()
  const shellKeyOf = (accountId: string, cwd: string): string => `${accountId}\u0000${cwd}`
  const shellDecidedOf = (accountId: string, cwd: string, t: number): ShellDecision | undefined => {
    const e = shells.get(shellKeyOf(accountId, cwd))
    return e && t - e.at < PREPARED_MS ? e.decided : undefined
  }
  /** The scope's `shell` for a route, with the environment a sandboxed Codex session gets on Windows (D8), numbered after
   *  the GIT_CONFIG entries of `env`, the environment the session is built from. */
  const shellScopeOf = (route: ShellRoute, env: Record<string, string | undefined>): NonNullable<SandboxScope['shell']> => ({
    plan: route.plan,
    env: codexSandboxEnv({ platform: 'win32', layout: route.layout, tmpDir: o.tmpDir, env, excludesFile: route.excludesFile }),
    accountId: route.accountId
  })

  /** The work folder's guards (D6), read-only inside the sandbox so the shell cannot plant what Claude Code runs outside
   *  it: `.claude`, made empty first when missing, since a read entry holds only for a path that is there (spec M8), and
   *  each of srt's dangerous names that is there (the `.claude` ones are inside the first). Forward slashes. */
  const guardsOf = async (cwd: string): Promise<string[]> => {
    const claude = path.join(cwd, '.claude')
    if (!exists(claude)) await fs.mkdir(claude, { recursive: true })
    const names = [...SRT_DANGEROUS_FILES, ...SRT_DANGEROUS_DIRECTORIES.filter((d) => !d.startsWith('.claude/'))].filter((n) => exists(path.join(cwd, n)))
    const root = slashed(cwd).replace(/\/+$/, '')
    return ['.claude', ...names].map((n) => `${root}/${n}`)
  }

  /** Whether the shell can run in a Codex account's sandbox (D4), asked in D4's order, the first that fails the reason:
   *  Git Bash, the default Codex account, a codex bash can run (bashRunnable), its version, then, after the guards are in
   *  place, everything a sandboxed Codex start on Windows checks, by its own code with that account's environment and
   *  this folder (prepareCodexSandbox), whose profile, with the guards as more read-only paths, is the wrapper's (D6).
   *  Each reason is logged with what caused it. Never throws. */
  const decideShell = async (cwd: string, gitBash: string | null): Promise<ShellDecision> => {
    const off = (why: ClaudeShellOff, refusal: string, cause: string): ShellDecision => {
      o.log(`sandbox: Claude's shell in ${cwd} cannot run in Codex's sandbox (${why}): ${cause}; the session holds its file tools only`)
      return { on: false, why, refusal }
    }
    if (!gitBash) return off('no-git-bash', NO_SANDBOX_CLAUDE, 'no Git Bash was found, so Claude Code has no Bash tool to wrap')
    const codex = o.shellCodex?.() ?? null
    if (codex === null) return off('no-codex-account', NO_SANDBOX_CLAUDE, 'no Codex account is registered whose sandbox it could borrow')
    const resolved = o.codexExe?.() ?? null
    const runnable = resolved === null ? null : bashRunnable(resolved, exists)
    if (runnable === null) return off('no-codex', `${SANDBOX_UNAVAILABLE}: cli-missing codex`, resolved === null ? 'codex was not found' : `${resolved} is not a program bash can run`)
    // Asked before anything is made in the folder; prepareCodexSandbox asks again, from the same probe
    await o.codexVersion?.warm('codex')
    const tooOld = codexVersionBlocker(o.codexVersion)
    if (tooOld !== null) return off(shellOffOf(new Error(tooOld)).why, tooOld, tooOld)
    try {
      const guards = await guardsOf(cwd)
      // The session's `-c` values, as prepareCodexSandbox built them for its readiness check, are handed to `check`
      const built: { args?: string[] } = {}
      const prepared = await prepareCodexSandbox({
        accountId: codex.account.id,
        cwd,
        platform: 'win32',
        homeDir: o.homeDir,
        env: codex.env,
        ready: o.codexReady,
        appKeyFile: o.appKeyFile ?? null,
        agentLogins: o.agentLogins?.() ?? [],
        readOnly: [...(o.readOnly ?? []), ...guards],
        version: o.codexVersion,
        check: (args) => {
          built.args = args
        },
        ...(o.codexExcludes ? { excludes: o.codexExcludes } : {}),
        look: o.linkLook,
        log: o.log
      })
      if (!built.args) throw new Error('the Codex prepare built no profile')
      return {
        on: true,
        route: {
          plan: { codex: runnable, codexHome: codex.env.CODEX_HOME ?? null, bash: gitBash, root: cwd, args: appServerSandboxArgs(built.args) },
          accountId: codex.account.id,
          layout: prepared.layout,
          excludesFile: prepared.excludesFile
        }
      }
    } catch (err) {
      const { why, refusal } = shellOffOf(err)
      return off(why, refusal, String(err))
    }
  }
  /** Whether the last prepare wrote the exclude file: a spawn after one that could not points git at nothing new. */
  let excludesWritten = false
  const blocker = (): string | null => claudeSandboxBlocker(o.version('claude'))

  const writeExcludes = async (): Promise<boolean> => {
    const text = gitExcludesText(await globalExcludesText({ env: o.env, homeDir: o.homeDir, tmpDir: o.tmpDir, runGit }))
    try {
      await fs.mkdir(path.dirname(excludesFile), { recursive: true })
    } catch (err) {
      o.log(`sandbox: the folder for ${excludesFile} could not be made: ${String(err)}`)
      return false
    }
    // Swapped in whole, as the settings are: a session already running may be reading it
    return writeScript(excludesFile, text)
  }

  /** The folder's git layout, with its missing git files made, on macOS and Linux; null on Windows, where Claude has no
   *  sandbox and its twin holds the deny rules only, whatever the folder (the shell's route reads its own, decideShell). The git files a sandbox keeps from being written
   *  are made first, as a Codex start makes them (gitLayout.ts): srt then denies writing a file that is there rather than
   *  a path that is not. A layout that cannot be read or prepared refuses the start (`git-layout`). */
  const layoutFor = async (cwd: string): Promise<GitLayout | null> => {
    if (o.platform === 'win32') return null
    try {
      const layout = await gitLayoutOf(cwd)
      if (layout) {
        await ensureGitFiles(layout)
        await ensureWorktreeConfigFiles(layout)
      }
      return layout
    } catch (err) {
      o.log(`sandbox: the git layout of ${cwd} could not be read or prepared: ${String(err)}`)
      throw sandboxUnavailable('git-layout')
    }
  }

  return {
    prepare: async (p) => {
      await o.version.warm('claude')
      const blocked = blocker()
      if (blocked !== null) throw new Error(blocked)
      const layout = await layoutFor(p.cwd)
      // Windows: the route for the shell, before the twins, which carry it (D4); a start that must be sandboxed is refused
      // without one (D5), anything else goes on with the deny rules
      const decided = o.platform === 'win32' ? await decideShell(p.cwd, p.gitBash ?? null) : null
      if (decided !== null && !decided.on && p.required === true) throw new Error(decided.refusal)
      const shell = decided?.on ? shellScopeOf(decided.route, p.env) : undefined
      const chosen = o.files.chooseAgentLogins?.({ look: o.linkLook })
      const written = await o.files.ensureSandboxFiles({ layout, env: p.env, cwd: p.cwd, look: o.linkLook, ...(chosen ? { agentLogins: chosen } : {}), ...(shell ? { shell } : {}) })
      // Task E fix rounds 5 and 6 (rule E5): a named path through a link the session could change, through which srt
      // cannot keep the deny in force (StatusLineManager.refusesLinks says how, per OS; ensureSandboxFiles writes no twin)
      if (typeof written === 'object') {
        o.log(`sandbox: ${written.linked.join(', ')} is a link inside the session's writable folders, which it could repoint, and Claude's sandbox cannot keep the path closed through it, so the sandboxed start is refused`)
        throw sandboxUnavailable('linked-path')
      }
      if (written !== 'ok') {
        o.log("sandbox: Claude's sandbox settings could not be written, so the sandboxed start is refused")
        throw sandboxUnavailable('settings-write-failed')
      }
      // A sandboxed npm cannot install until its cache folder exists (inventory §23.4); a folder that cannot be made costs
      // only the installs, so it is said and not refused. Windows has no shell sandbox for Claude, and npm keeps its own
      if (o.platform !== 'win32')
        await fs.mkdir(npmCacheOf(o.tmpDir), { recursive: true }).catch((err: unknown) => o.log(`sandbox: npm's cache folder could not be made: ${String(err)}`))
      if (o.platform === 'linux') {
        excludesWritten = await writeExcludes()
        if (!excludesWritten) o.log(`sandbox: the git excludes ${excludesFile} could not be written; git add -A may fail in the session`)
      }
      const at = now()
      layouts.keep(p.accountId, p.cwd, layout, at, [], null, false, (chosen ?? []).map((path) => ({ path, kind: 'file' as const })))
      if (decided !== null) {
        for (const [k, v] of shells) if (at - v.at >= PREPARED_MS) shells.delete(k)
        shells.set(shellKeyOf(p.accountId, p.cwd), { decided, at })
      }
    },
    blocker,
    scopeOf: (accountId, cwd, env) => {
      // One clock reading, so the layout and the route are of the same prepare
      const t = now()
      const layout = layouts.layoutOf(accountId, cwd, t)
      if (layout === undefined) return undefined
      // The login files the prepare chose, so the spawn's twin is the one the prepare wrote
      const chosen = o.files.chooseAgentLogins ? layouts.agentLoginsOf(accountId, cwd, t).map((e) => e.path) : null
      // And the route it found, never a new look
      const decided = shellDecidedOf(accountId, cwd, t)
      const shell = decided?.on ? shellScopeOf(decided.route, env) : undefined
      return { layout, env, cwd, look: o.linkLook, ...(chosen ? { agentLogins: chosen } : {}), ...(shell ? { shell } : {}) }
    },
    shellOf: (accountId, cwd) => {
      const decided = shellDecidedOf(accountId, cwd, now())
      if (decided === undefined) return { on: false, why: 'other', refusal: sandboxUnavailable('not-prepared').message }
      return decided.on ? { on: true } : { on: false, why: decided.why, refusal: decided.refusal }
    },
    chatArgs: (enforce, scope) => o.files.sandboxChatArgs(enforce, scope),
    settingsOf: (scope) => o.files.sandboxPartOf(scope),
    env: (inherited) =>
      claudeSandboxEnv({
        platform: o.platform,
        tmpDir: o.tmpDir,
        excludesFile: excludesWritten ? excludesFile : null,
        env: inherited
      })
  }
}
