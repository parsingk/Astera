import { promises as fs } from 'node:fs'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Account } from '../types'
import { AUDIT_HOOK_EVENTS, hookEventsDirIn, hookEventsFileIn } from '../hooks/sessionState'
import { dirIdentity } from '../files/watchedDir'
import { HOOK_EVENT_AT } from '../hooks/eventTime'
import { renameRetrying } from '../renameRetry'
import { SESSION_CONTEXT_SCRIPT } from './sessionContext'
import { CLAUDE_INPUT_FIELDS } from '../audit/resolve'
import ENFORCE_HOOK_SOURCE from 'virtual:astera-enforce-hook'
import { codexEnforceArgs } from './codexEnforce'
import { claudeSandboxSettings, claudeSessionDenied, type ClaudeSandboxSettings } from '../sandbox/claudeSettings'
import { appKeyPath } from '../host/hostKey'
import { npmCacheOf } from '../sandbox/codexProfile'
import type { GitLayout } from '../sandbox/gitLayout'
import { profileReadOnly } from '../sandbox/locations'

/** The statusLine injection info handed to SessionManager when a session is spawned. */
export interface StatusLineSpawn {
  settingsFile: string // --settings <file> (session-scoped statusLine; the global settings.json is not modified)
  outPath: string // The file the capture script writes the payload to (one per session)
  originalCommand: string | null // That account's pre-existing global statusLine command — when present it is chained so the HUD stays
  hookOutPath?: string // the file the hook capture appends events to (one per session) — always set
  observed?: true // the settings file is an observe variant (ensureObserveFiles): the session sends its tool calls to its audit file
  enforced?: true // the settings file is an enforce variant (ensureEnforceFiles): every tool call waits on the blocking hook first
  sandboxed?: true // the settings file is a sandbox twin (ensureSandboxFiles): Claude's sandbox and the deny rules are in it
}

/** Whether every sandbox twin is in place (ensureSandboxFiles). */
export type SandboxFilesResult = 'ok' | 'write-failed'

/** What a sandboxed Claude session's twins are built for (ensureSandboxFiles, spawnConfig, sandboxChatArgs): its folder's
 *  git layout, whose git files the sandbox keeps from being written, and the environment the session is built from (its
 *  account's, before the Credentials list's hiding), which the places it may not read are read from: its APPDATA, its
 *  session bus (final fix pass, C1 and minor 2). Null layout: outside a repository. */
export interface SandboxScope {
  layout: GitLayout | null
  env: Record<string, string | undefined>
}

/** How many scopes a StatusLineManager keeps the twins of up to date: every settings rewrite rewrites them all. A scope
 *  prepared before the last this many is written again by its next sandboxed start's prepare. */
export const SANDBOX_SCOPES_KEPT = 32

/** The folder the twins go in, one folder per scope under it, named by a hash of what the scope's sandbox holds. */
export const SANDBOX_TWINS_DIR = 'sandbox-settings'

/** How long a scope's twins folder may go unwritten before a Host's start removes it (pruneSandboxTwins). */
export const SANDBOX_TWINS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** A scope's twins folder's name: sandboxKeyOf's 16 hex. */
const TWINS_FOLDER = /^[0-9a-f]{16}$/

/**
 * Removes the scopes' twins folders (`<profile>/sandbox-settings/<hash>/`) not written for `maxAgeMs` that no live
 * session uses (`inUse`, by folder name), and returns the names removed (sandbox follow-ups, item 3). Written means the
 * newest of the folder's own time, which every sandboxed start stamps (writeTwinsOf), and its twins'. **Nothing else is
 * touched**: only a real folder (not a link) whose name is a scope's hash, holding nothing but twins (`.json` files),
 * each removed by name and then the empty folder; any other entry keeps the whole folder. Never throws.
 */
export async function pruneSandboxTwins(o: {
  profileDir: string
  now: number
  inUse: ReadonlySet<string>
  maxAgeMs?: number
  log?: (m: string) => void
}): Promise<string[]> {
  const root = path.join(o.profileDir, SANDBOX_TWINS_DIR)
  const maxAge = o.maxAgeMs ?? SANDBOX_TWINS_MAX_AGE_MS
  let names: string[]
  try {
    names = await fs.readdir(root)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names.sort()) {
    if (!TWINS_FOLDER.test(name) || o.inUse.has(name)) continue
    const dir = path.join(root, name)
    try {
      const st = await fs.lstat(dir)
      if (!st.isDirectory() || st.isSymbolicLink()) continue
      const entries = await fs.readdir(dir, { withFileTypes: true })
      if (entries.some((e) => !e.isFile() || !e.name.endsWith('.json'))) {
        o.log?.(`sandbox twins: ${name} holds more than twins — left as it is`)
        continue
      }
      const files = entries.map((e) => path.join(dir, e.name))
      const written = Math.max(st.mtimeMs, ...(await Promise.all(files.map(async (f) => (await fs.lstat(f)).mtimeMs))))
      if (o.now - written < maxAge) continue
      for (const f of files) await fs.unlink(f)
      await fs.rmdir(dir)
      removed.push(name)
    } catch (err) {
      o.log?.(`sandbox twins: ${name} could not be removed: ${String(err)}`)
    }
  }
  return removed
}

/** Enforce's hook (enforce design §5), written beside the Rules it reads: the bundle of core/audit/hook/enforceMain.ts. */
export const ENFORCE_HOOK_FILE = 'astera-enforce-hook.cjs'

/** Whether the hook and its settings are in place, and when not, why (the code a refused start carries, E5). */
export type EnforceFilesResult = 'ok' | 'no-interpreter' | 'hook-write-failed'

/** Astera's own node, which runs the Enforce hook: `env`, when set, is a `NAME=value` the command starts with; `tail`
 *  is an argument it ends with. */
export interface EnforceInterpreter {
  file: string
  env?: string
  tail?: string
}

/**
 * What runs the Enforce hook (enforce design §5). A blocking hook must not depend on a node the person may not have, so
 * it is Astera's own: on Windows the Host runtime (astera-host.exe, the node the capture scripts already run under, when
 * it is a path); elsewhere the app's executable run as node (`ELECTRON_RUN_AS_NODE=1`), which is what the Host itself
 * runs as there. Windows without the runtime has none: a bare `node` is not Astera's, and a session started in Enforce
 * there is refused (E5, `ENFORCE_UNAVAILABLE: no-interpreter`).
 *
 * A Linux AppImage's executable is its temporary mount, gone once the app quits while its sessions run on in the Host,
 * so the hook calls the AppImage file (`APPIMAGE`) the way the public shuttle does, `--no-sandbox` last for the same
 * reason (core/orchestration/exec/shuttle.ts, appImageShuttle): AppRun adds none in front of node's arguments then.
 */
export function enforceInterpreter(o: {
  platform: NodeJS.Platform
  captureNode: string
  execPath: string
  appImage?: string
}): EnforceInterpreter | null {
  if (o.platform === 'linux' && o.appImage) return { file: o.appImage, env: 'ELECTRON_RUN_AS_NODE=1', tail: '--no-sandbox' }
  // A macOS app opened where it was downloaded runs from a translocated copy that goes when it quits (final review M9)
  if (o.platform === 'darwin' && o.execPath.includes('/AppTranslocation/')) return null
  if (o.platform !== 'win32') return { file: o.execPath, env: 'ELECTRON_RUN_AS_NODE=1' }
  return /^[A-Za-z]:[\\/]/.test(o.captureNode) ? { file: o.captureNode } : null
}

/**
 * The command line that runs the Enforce hook for `provider`, quoted as captureCommand quotes a capture script. Both
 * CLIs run it in a shell that reads that form: Claude Code in Git Bash or PowerShell on Windows, Codex in its own
 * session shell, which is PowerShell on Windows and the user's sh, bash or zsh elsewhere (codex-rs core/src/session/mod.rs
 * build_hooks_config, shell-command/src/shell_detect.rs, rust-v0.160.0). Measured 2026-10-27: the double-quoted form
 * fails in Codex's PowerShell. A Windows without PowerShell sends Codex to cmd.exe, where it fails too; the Host's
 * proof then stops the session.
 */
export function enforceCommand(i: EnforceInterpreter, script: string, provider: 'claude' | 'codex'): string {
  return `${i.env ? `${i.env} ` : ''}${captureCommand(i.file, script)} ${provider}${i.tail ? ` ${i.tail}` : ''}`
}

// Capture script (node): Claude runs it as the statusLine → it writes the stdin payload to ASTERA_STATUSLINE_OUT, and
// when ASTERA_STATUSLINE_ORIGINAL (the pre-existing statusLine) is set it runs that as-is so the original HUD survives (stdout passes through).
const CAPTURE_SCRIPT = `const fs = require('fs')
const cp = require('child_process')
const out = process.env.ASTERA_STATUSLINE_OUT
const orig = process.env.ASTERA_STATUSLINE_ORIGINAL
const chunks = []
let done = false
function finish() {
  if (done) return
  done = true
  const data = Buffer.concat(chunks)
  if (out) { try { fs.writeFileSync(out, data) } catch {} }
  if (orig && orig.trim()) {
    try {
      const child = cp.spawn(orig, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] })
      child.on('error', () => process.exit(0))
      child.on('close', (code) => process.exit(typeof code === 'number' ? code : 0))
      child.stdin.on('error', () => {})
      child.stdin.write(data)
      child.stdin.end()
    } catch { process.exit(0) }
  } else {
    process.exit(0)
  }
}
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', finish)
process.stdin.on('error', finish)
`

// Hook capture script (node): Claude runs it for every hook the settings files below install
// (Notification, Stop, StopFailure, UserPromptSubmit and the tool pair; for a Slack-notifying or
// rolling session the tool pair matches more tools), and it appends the stdin payload (JSON) as one
// line to ASTERA_HOOK_OUT (a per-session jsonl). With that env unset it does nothing.
//
// **It stamps when its process started, as `astera_at` (HOOK_EVENT_AT), first in the object.** Two
// async hooks can land out of order, and Claude Code spawns hooks in event order, so the start time
// is what orders them (core/hooks/eventTime.ts). The time is `performance.timeOrigin`: when this node
// process began, as epoch milliseconds with a fraction, so node's own startup (tens of ms, and the
// part that varies) is not in it. It is closer to Claude's spawn than the script's first statement,
// and in the same measurement it inverted 2 of 40 pairs spawned at once against 7 for `Date.now()`.
// The capture runs under whatever `node` the settings command names (Astera's own Host runtime on
// Windows, else bare `node` on PATH; the resolved one on macOS); a node older than 16 has no global
// `performance`, and falls back to `Date.now()` taken first, before stdin is read. Spliced in
// as text rather than parsed and re-serialised, so the payload is written exactly as Claude sent it
// (a number past 2^53 would not survive a round trip). A payload that is not an object is written as
// before, with no stamp.
const HOOK_CAPTURE_SCRIPT = `const at = typeof performance === 'object' && Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : Date.now()
const fs = require('fs')
const out = process.env.ASTERA_HOOK_OUT
const chunks = []
function finish() {
  if (out) {
    let line = Buffer.concat(chunks).toString('utf8').replace(/\\r?\\n/g, ' ').trim()
    if (line.startsWith('{')) {
      const rest = line.slice(1).trimStart()
      line = '{"${HOOK_EVENT_AT}":' + at + (rest.startsWith('}') ? '' : ',') + rest
    }
    try { fs.appendFileSync(out, line + '\\n') } catch {}
  }
  process.exit(0)
}
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', finish)
process.stdin.on('error', finish)
`

// Observe mode's capture (node): run by the observe-only hooks (PostToolUse and PostToolUseFailure for every tool,
// ensureObserveFiles). It writes not to the session's own hook file, which attention, `sessions list`, pendingPrompt and
// Slack read, but beside it, to <session>.audit.jsonl (AUDIT_HOOK_EVENTS), which only the Host's recorder reads; so an
// observed session's own file holds exactly what a plain session's does. Of the payload it keeps what names the call
// (the event, the tool, its id, whether it was interrupted, where it ran, and of its input only the fields the resolver
// reads, CLAUDE_INPUT_FIELDS) with the stamp the other capture takes; the tool's output (`tool_response`, a failure's
// `error`) and the rest of its input (a Write's contents, an Edit's strings) are never written. Parsed and written
// again, unlike the other capture: nothing here needs a number past 2^53 kept as it was sent.
const HOOK_AUDIT_CAPTURE_SCRIPT = `const at = typeof performance === 'object' && Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : Date.now()
const fs = require('fs')
const out = process.env.ASTERA_HOOK_OUT
const FIELDS = ${JSON.stringify(CLAUDE_INPUT_FIELDS)}
const chunks = []
function finish() {
  if (out && out.endsWith('.jsonl')) {
    try {
      const p = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        const input = {}
        const given = p.tool_input
        if (given && typeof given === 'object' && !Array.isArray(given)) for (const k of FIELDS) if (given[k] !== undefined) input[k] = given[k]
        const kept = { ${HOOK_EVENT_AT}: at, hook_event_name: p.hook_event_name, tool_name: p.tool_name, tool_input: input, tool_use_id: p.tool_use_id }
        if (p.is_interrupt === true) kept.is_interrupt = true
        if (typeof p.cwd === 'string') kept.cwd = p.cwd
        fs.appendFileSync(out.slice(0, -'.jsonl'.length) + '${AUDIT_HOOK_EVENTS}', JSON.stringify(kept) + '\\n')
      }
    } catch {}
  }
  process.exit(0)
}
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', finish)
process.stdin.on('error', finish)
`

/**
 * A script a running session may execute at any moment, or a settings file a starting session may
 * read, put in place for this launch.
 *
 * - **Unchanged content is not written at all.** Most launches write the same bytes, so a hook
 *   loading the file is never raced in the common case.
 * - **Otherwise it is written to a temp file beside it and renamed over it**, the way the repo's
 *   stores write (core/scheduler/config.ts), so a reader sees the old file or the new one and never
 *   half of one. Written in place, a hook that fired mid-write loaded a torn script (measured in the
 *   task F review: 251 torn reads in 1653 runs).
 * - **A busy rename is retried** (renameRetrying: RENAME_BUSY, RENAME_TRIES, 20 to 50 ms apart). Measured on Windows,
 *   5 to 8% of renames over a script being loaded fail with EPERM.
 * - **If it still fails, the script is written in place**, the old behaviour: a torn read is possible
 *   but rare.
 *
 * **Never throws.** `init` runs inside createCore, and a rejection there leaves the app with no window
 * (the same path core/scheduler/config.ts's load() documents for a rename EPERM). createCore has no
 * logger, so a failure goes to the console. The temp file is removed on every path. Resolves to
 * whether the file holds `content` now, for a caller that must not point a session at a file that is
 * not there (the observe files). The sandbox's git excludes go through it too (core/sandbox/claudeStart.ts).
 */
export async function writeScript(file: string, content: string): Promise<boolean> {
  try {
    if ((await fs.readFile(file, 'utf8')) === content) return true
  } catch {
    /* no file yet, or unreadable: write it */
  }
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, content, 'utf8')
    await renameRetrying(tmp, file)
    return true
  } catch (err) {
    console.warn(`astera: could not swap in ${path.basename(file)} (${(err as Error).message}); writing it in place`)
    try {
      await fs.writeFile(file, content, 'utf8')
      return true
    } catch (again) {
      console.warn(`astera: could not write ${path.basename(file)} (${(again as Error).message})`)
      return false
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}

/**
 * The absolute path to the node that will run the capture script.
 *
 * Why an absolute path is needed: the statusLine/hook config's command is executed by claude in its
 * own shell. On macOS, if node lives under nvm/mise, that shell won't read the rc file and won't find
 * `node`, and the failure is silent (the capture script only talks over stdout). Resolving this once
 * at startup and baking it in makes this whole failure mode disappear. This resolution is for macOS.
 *
 * The win32 branch below exists, but neither caller (core.ts, host/spawner.ts) uses it: a PATH walk
 * with existsSync can freeze the thread for as long as SMB takes on an offline drive (pathProbe.ts),
 * and on win32 the capture scripts run under Astera's own Host runtime instead, or a bare `node`
 * where there is none.
 *
 * If it can't be found, this just returns 'node' — the prior behavior, and still correct as long as
 * it's on PATH.
 */
export function resolveNodePath(
  env: { PATH?: string },
  exists: (p: string) => boolean,
  platform: NodeJS.Platform
): string {
  const bin = platform === 'win32' ? 'node.exe' : 'node'
  const delimiter = platform === 'win32' ? ';' : ':'
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = platform === 'win32' ? `${dir}\\${bin}` : `${dir}/${bin}`
    if (exists(candidate)) return candidate
  }
  return 'node'
}

/** A drive or UNC path, after the backslashes have been turned into slashes. */
const WINDOWS_PATH = /^(?:[A-Za-z]:\/|\/\/)/

/** `p` as one word that Git Bash and PowerShell both read literally, or null when no quoting does:
 *  single quotes, else double quotes for a path with a `'` in it (`O'Brien`), unless it also holds
 *  `$` or a backtick, which both shells expand inside double quotes. */
function quotedForBothShells(p: string): string | null {
  if (!p.includes("'")) return `'${p}'`
  if (!/[$`"]/.test(p)) return `"${p}"`
  return null
}

/**
 * The command line that runs one capture script, `<node> <script>`, as the settings file hands it to
 * Claude Code.
 *
 * **On Windows it has to read the same in two shells.** Claude Code runs a hook's command through Git
 * Bash when it finds one and through PowerShell when it does not (its own hook schema says so, as of
 * 2.1.296). The quoted form, `"<node>" "<script>"`, is a parse error in PowerShell: a line that starts
 * with a string is an expression there, and the second string is an unexpected token. Measured on a
 * PC without Git: every hook of every session failed with ParserError UnexpectedToken, Node installed
 * or not. So for a Windows path:
 *
 * - the script is one quoted word, which both shells take as an argument;
 * - node, when it is a path, keeps its drive letter outside the quotes: `C:'/…/astera-host.exe'`. A
 *   line that starts with a bare word is a command in PowerShell, which joins the quoted rest onto it,
 *   and bash joins the two halves the same way. Measured through both, with a space and Hangul in
 *   both paths, the payload piped through to the capture. A bare `node` stays bare.
 *
 * A path neither quoting can hold falls back to the quoted form, which still works through Git Bash.
 * Anything that is not a Windows path (macOS, Linux) gets that form too, byte for byte as before.
 */
export function captureCommand(node: string, script: string): string {
  const n = node.replace(/\\/g, '/')
  const s = script.replace(/\\/g, '/')
  const quoted = `"${n}" "${s}"`
  const arg = WINDOWS_PATH.test(s) ? quotedForBothShells(s) : null
  if (arg === null) return quoted
  if (!n.includes('/')) return `${n} ${arg}`
  const rest = /^[A-Za-z]:\//.test(n) ? quotedForBothShells(n.slice(2)) : null
  return rest === null ? quoted : `${n.slice(0, 2)}${rest} ${arg}`
}

/** The one tool whose PreToolUse/PostToolUse pair **every** session gets. Its `tool_input` is the question
 *  the conversation view draws as a card (core/sessions/pendingPrompt.ts → core/prompts/askUserQuestion.ts), and
 *  a question is minutes apart, so the cost is one node process per question — the same order as Stop. */
const ASK_MATCHER = 'AskUserQuestion'

/** The tools whose calls the Pre/PostToolUse hooks watch in a Slack-notifying or rolling session. A
 *  superset of ASK_MATCHER on purpose: that file replaces the every-session file rather than layering on
 *  it, so the question capture must be in here too or those sessions would lose it. Both events share it
 *  so the capture and the invalidation cannot cover different sets — see the PostToolUse comment in ensureFiles(). */
const TOOL_MATCHER = `${ASK_MATCHER}|Bash|PowerShell|Write|Edit|NotebookEdit`

/** Settings file contents as ensureFiles last built them, for the observe variants. */
interface BuiltSettings {
  settings: { hooks: { PostToolUse: unknown[] } }
  hooksSettings: { hooks: { PostToolUse: unknown[] } }
}

/** A settings file's observe variant (ensureObserveFiles): the audit capture `command` after every tool call. */
function withObserveHooks(s: BuiltSettings['settings'], command: string): string {
  const audit = { matcher: '*', hooks: [{ type: 'command', command, async: true }] }
  return JSON.stringify({ ...s, hooks: { ...s.hooks, PostToolUse: [...s.hooks.PostToolUse, audit], PostToolUseFailure: [audit] } }, null, 2)
}

/** What a sandbox twin adds (ensureSandboxFiles): the builder's settings. */
type SandboxPart = ClaudeSandboxSettings

/** The name of a scope's twins folder: a hash of what its sandbox holds. */
const sandboxKeyOf = (part: SandboxPart): string => createHash('sha256').update(JSON.stringify(part)).digest('hex').slice(0, 16)

/** A settings file's sandbox twin: the same JSON with Claude's sandbox added and the deny rules after any it already has. */
function withSandbox(content: string, part: SandboxPart): string {
  const s = JSON.parse(content) as Record<string, unknown> & { permissions?: Record<string, unknown> & { deny?: string[] } }
  const permissions = { ...(s.permissions ?? {}), deny: [...(s.permissions?.deny ?? []), ...part.permissions.deny] }
  return JSON.stringify({ ...s, ...(part.sandbox ? { sandbox: part.sandbox } : {}), permissions }, null, 2)
}

export class StatusLineManager {
  private readonly capturePath: string
  private readonly settingsFile: string
  private readonly outDir: string
  private readonly hookCapturePath: string
  private readonly hooksSettingsFile: string
  private readonly observeSettingsFile: string
  private readonly observeHooksSettingsFile: string
  private readonly hookAuditCapturePath: string
  private readonly sessionContextPath: string
  private readonly enforceHookPath: string
  private readonly enforceSettingsFile: string
  private readonly enforceHooksSettingsFile: string
  private readonly enforceChatSettingsFile: string
  private readonly sandboxChatSettingsFile: string
  private readonly enforceSandboxChatSettingsFile: string
  readonly hookEventsDir: string // Watched by index.ts's HookEventWatcher
  private built: BuiltSettings | null = null
  /** Both observe files hold what the last ensureObserveFiles built; until then an observed session gets the plain file. */
  private observeReady = false
  /** The hook and the three enforce files hold what the last ensureEnforceFiles built; until then a session is not
   *  marked enforced. */
  private enforceReady = false
  /** Every settings file a session can be pointed at, with what it was last built to hold: a sandbox twin is built from it. */
  private variants = new Map<string, string>()
  /** The twins in place, by scope key and the file each is a twin of, with what that file held when the twin was written:
   *  a twin of a file that has changed since is not handed out (spawnConfig). */
  private twins = new Map<string, string>()
  /** The scopes whose sandboxed chat file (no hooks) holds what their last write built. */
  private sandboxChatReady = new Set<string>()
  /** The sandbox each prepared scope's twins hold, by key, the latest prepared last (SANDBOX_SCOPES_KEPT of them). From
   *  a scope's first ensureSandboxFiles on, each file rewritten gets its twins rewritten with it, so the order in which a
   *  start's preparations run does not matter (a Host chat prepares its sandbox before the capability refresh writes
   *  Enforce's files). */
  private scopes = new Map<string, SandboxPart>()
  private readonly platform: NodeJS.Platform
  private readonly execPath: string
  private readonly appImage: string | undefined
  private readonly findRuntime: (() => Promise<string | null>) | undefined
  /** A Host runtime found installed, for the Enforce hook only, when the capture scripts have no node of Astera's. */
  private runtimeExe: string | null = null
  /** The person's home, which the sandbox's denied places are read under (the environment is the session's, its
   *  SandboxScope), and the temp folder npm's cache is in. */
  private readonly homeDir: string
  private readonly tmpDir: string

  constructor(
    private userDataDir: string,
    /** The node that will run the capture script. The default matches prior behavior (a PATH lookup).
     *  `useNode` changes it once the app knows better. */
    private nodePath: string = 'node',
    /** Where a folder it cannot use is told. */
    private log: (m: string) => void = (m) => console.warn(m),
    /** Where the Enforce hook's interpreter comes from (enforceInterpreter): the process's own, unless a test says. */
    host: {
      platform?: NodeJS.Platform
      execPath?: string
      appImage?: string
      /** Windows: a Host runtime an Astera installed (core/host/installedRuntime.ts), asked when the capture node is a
       *  bare `node`, so the hook still runs with Astera's own node there. */
      findRuntime?: () => Promise<string | null>
      /** The sandbox's (ensureSandboxFiles): the process's own home and temp folder, unless a test says. */
      homeDir?: string
      tmpDir?: string
    } = {}
  ) {
    this.findRuntime = host.findRuntime
    this.platform = host.platform ?? process.platform
    this.execPath = host.execPath ?? process.execPath
    this.homeDir = host.homeDir ?? os.homedir()
    this.tmpDir = host.tmpDir ?? os.tmpdir()
    // A test that names the executable names the AppImage too, or there is none
    this.appImage = host.execPath === undefined ? process.env.APPIMAGE : host.appImage
    this.capturePath = path.join(userDataDir, 'astera-statusline-capture.cjs')
    this.settingsFile = path.join(userDataDir, 'astera-statusline-settings.json')
    this.outDir = path.join(userDataDir, 'statusline')
    this.hookCapturePath = path.join(userDataDir, 'astera-hook-capture.cjs')
    this.hooksSettingsFile = path.join(userDataDir, 'astera-hooks-settings.json')
    this.observeSettingsFile = path.join(userDataDir, 'astera-observe-settings.json')
    this.observeHooksSettingsFile = path.join(userDataDir, 'astera-observe-hooks-settings.json')
    this.hookAuditCapturePath = path.join(userDataDir, 'astera-hook-audit-capture.cjs')
    this.sessionContextPath = path.join(userDataDir, 'astera-session-context.cjs')
    this.enforceHookPath = path.join(userDataDir, ENFORCE_HOOK_FILE)
    this.enforceSettingsFile = path.join(userDataDir, 'astera-enforce-settings.json')
    this.enforceHooksSettingsFile = path.join(userDataDir, 'astera-enforce-hooks-settings.json')
    this.enforceChatSettingsFile = path.join(userDataDir, 'astera-enforce-chat-settings.json')
    this.sandboxChatSettingsFile = path.join(userDataDir, 'astera-sandbox-chat-settings.json')
    this.enforceSandboxChatSettingsFile = path.join(userDataDir, 'astera-enforce-sandbox-chat-settings.json')
    // The Host reads these files back for `sessions list` (host/sessions.ts), so where they are is one
    // rule in core rather than a path spelled out twice.
    this.hookEventsDir = hookEventsDirIn(userDataDir)
  }

  /** The app's start: ensureFiles() then startupCleanup(). */
  async init(): Promise<void> {
    await this.ensureFiles()
    await this.startupCleanup()
  }

  /** Runs the capture scripts under `node` from now on, rewriting the settings files when that is a
   *  change. Only sessions that start after it get the new command: a session reads its settings file
   *  once, at startup (see UserPromptSubmit in ensureFiles). */
  async useNode(node: string): Promise<void> {
    if (node === this.nodePath) return
    this.nodePath = node
    await this.ensureFiles()
  }

  /** Writes the capture scripts and both settings files, skipping identical content, and creates the
   *  folders the scripts write into. Never deletes anything. The Host calls this and only this: the
   *  hook events are its running sessions'. */
  async ensureFiles(): Promise<void> {
    await fs.mkdir(this.userDataDir, { recursive: true })
    // Written whole and then swapped in: sessions still running from before this launch run these
    // scripts by path, and a hook that fires during an in-place write would load half a script.
    await writeScript(this.capturePath, CAPTURE_SCRIPT)
    await writeScript(this.hookCapturePath, HOOK_CAPTURE_SCRIPT)
    await writeScript(this.sessionContextPath, SESSION_CONTEXT_SCRIPT)
    const hookCmd = captureCommand(this.nodePath, this.hookCapturePath)
    const contextCmd = captureCommand(this.nodePath, this.sessionContextPath)
    // Hooks from --settings merge with the account's global settings.json hooks and both run
    // (measured). The global settings stay untouched.
    //
    // Notification goes into EVERY session, not just Slack-notifying or rolling ones. It is how the
    // app learns a session has stopped for a choice or an approval, and the desktop notification for
    // that is offered for any session and ships on. Gating it the way the hooks below are gated is
    // what made the notification feature inert for an ordinary session: the flag was on, the sink had
    // no per-session gate, and the event simply never arrived.
    //
    // The cost is one node process when a prompt appears.
    //
    // Stop goes into every session for the same reason, and it is what lets a session stop waiting.
    // core/sessions/attention.ts reads Notification to learn a session is waiting on a person, and Stop or
    // PostToolUse to learn it no longer is. PostToolUse only ever fires when a call actually runs, so
    // a person who answers "no" produces neither — and without Stop here an ordinary session would
    // stay `waiting` for the rest of its life, with the conversation view's banner up and its
    // composer locked the whole time (measured in the dev app, not reasoned about). It used to be
    // kept out of here on the grounds that nothing but slack.ts read it; attention.ts reads it now.
    // The cost is one node process at the end of a turn, which is minutes apart, not per keystroke.
    const everySessionHooks = {
      // What Astera offers, told to the agent as it starts (sessionContext.ts). Synchronous on purpose:
      // the text has to be in the conversation before the first turn, so unlike the capture hooks it
      // is not `async`. It is not the capture script — it prints the hook JSON on stdout — and it runs
      // once per session start.
      SessionStart: [{ hooks: [{ type: 'command', command: contextCmd }] }],
      Notification: [{ hooks: [{ type: 'command', command: hookCmd }] }],
      Stop: [{ hooks: [{ type: 'command', command: hookCmd }] }],
      // The question capture. Every session: the conversation view draws AskUserQuestion as a form from
      // this hook's tool_input, and nothing else carries it (the transcript is silent while the CLI
      // waits). Matcher-limited to the one tool so ordinary tool calls pay nothing; the write/execute
      // family stays in the gated file below for the reasons given there.
      PreToolUse: [{ matcher: ASK_MATCHER, hooks: [{ type: 'command', command: hookCmd }] }],
      PostToolUse: [{ matcher: ASK_MATCHER, hooks: [{ type: 'command', command: hookCmd }] }],
      // A turn starting and a turn ended by an API error (a limit, an auth failure) — StopFailure fires
      // *instead of* Stop then. The Host reads both for `astera sessions list`: it tells working from
      // waiting off the event that happened last (core/hooks/sessionState.ts). In the app, attention,
      // pendingPrompt and Slack read StopFailure as a turn end, the same as Stop, and read
      // UserPromptSubmit only for when it happened, to pass by a turn end that is older than it;
      // rolling reads neither. `async`, so Claude Code does not
      // wait on the capture's node process (about 0.1 s through Git Bash) before every prompt; it
      // honours that for both events (2.1.280 forces a hook synchronous only on its SessionStart,
      // Setup and MessageDisplay passes and on calls from a cloud session). Being async, the two can
      // land out of order, which is what the capture's stamp is for (core/hooks/eventTime.ts).
      //
      // **A session keeps the hooks it started with.** Claude Code 2.1.280 reads a `--settings`
      // file once, at startup: `Wyo` reads it and pins its content
      // (`replaceFlagSettingsFilePinnedContent`), and every later settings load parses that pinned
      // content, not the file (`flagExpectedContent: nA() ?? Ase()`, which `tve` uses in place of a
      // read). Its settings watcher skips the source outright (`xD`:
      // `if(Y==="flagSettings")continue`). So rewriting this file at app start never reaches a
      // running session, not even when another settings change refreshes that session's hooks
      // snapshot (`jlt` → `updateHooksConfigSnapshot`). A session opened before a hook was added here
      // has to be reopened to get it. The capture script is different: it is run by path, so a
      // running session's existing hooks run the rewritten script, stamp included.
      //
      // Nothing marks such a session today. A mark would need a hook-set version in the pty note at
      // spawn, and every session spawned before the mark existed would carry none, whether or not
      // it has these hooks, so it could not tell the two apart. docs/cli.md says it instead.
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd, async: true }] }],
      StopFailure: [{ hooks: [{ type: 'command', command: hookCmd, async: true }] }]
    }
    const settings = {
      // It is a JSON string, so no JSON escaping on top; the shell quoting is captureCommand's. Paths
      // are normalised to forward slashes (fine on Windows too).
      statusLine: {
        type: 'command',
        command: captureCommand(this.nodePath, this.capturePath),
        padding: 0
      },
      hooks: everySessionHooks
    }
    // Through writeScript like the scripts: the app and the Host both write these files, and a
    // session starting mid-write would read half a settings file.
    const settingsJson = JSON.stringify(settings, null, 2)
    this.variants.set(this.settingsFile, settingsJson)
    await writeScript(this.settingsFile, settingsJson)
    // What only a Slack-notifying or rolling session pays for, on top: the write/execute family in the
    // tool pair, which fires per tool call and is therefore matcher-limited. The pair itself is already
    // in everySessionHooks for AskUserQuestion; this widens its matcher.
    const hooksSettings = {
      ...settings,
      hooks: {
        ...everySessionHooks,
        // Captures what the waiting screen shows (the question and its options, the tool awaiting approval and its
        // arguments) **before** the tool runs. The transcript cannot supply it — Claude Code does not flush assistant
        // messages while it waits for user interaction, so while a question or approval prompt is on screen that
        // tool_use is not present in the file (two measured findings in the countToolUses comment in core/slack/transcript.ts).
        //
        // The matcher catches only the write/execute family plus AskUserQuestion. HOOK_CAPTURE_SCRIPT starts a fresh
        // node process for every hooked tool call and Claude Code waits for it to finish, so matching all tools would
        // add that latency to every call — most noticeably on the read tools (Read, Grep, Glob), which are called by
        // far the most often. Those tools also rarely require approval, so the trade is not worth it.
        //
        // The cost: a user who configured the read tools to require approval gets only the text in that notification.
        // Hardcoding tool names here is a limitation too — a new tool will be missing from this list. Either way the
        // notification only falls back to the previous behaviour (a one-line message), so it is not a silent failure.
        PreToolUse: [{ matcher: TOOL_MATCHER, hooks: [{ type: 'command', command: hookCmd }] }],
        // The pair that ends the capture: PostToolUse fires once the tool has actually run, and its
        // tool_use_id lets SlackNotifier drop the capture for certain. Without it a subagent's tool call
        // stays "waiting" until Stop — its tool_use is written only to the subagent's own transcript, so the
        // "has the id shown up in the transcript tail" fallback never sees it (measured; the full account is
        // in the clearPendingTool comment in slack.ts). The same matcher on purpose: what has to be ended is
        // exactly what PreToolUse captured, and a narrower list here would silently leave some captures
        // uncleared.
        //
        // The cost is one more node process per write/execute call — the hook count for those tools doubles.
        // What it buys is removing a false "input needed" that fired repeatedly, and the read tools (called
        // far more often) stay outside the matcher, so the latency reasoning above is unchanged.
        PostToolUse: [{ matcher: TOOL_MATCHER, hooks: [{ type: 'command', command: hookCmd }] }]
      }
    }
    const hooksJson = JSON.stringify(hooksSettings, null, 2)
    this.variants.set(this.hooksSettingsFile, hooksJson)
    await writeScript(this.hooksSettingsFile, hooksJson)
    this.built = { settings, hooksSettings }
    // The folders the capture scripts write into. Both scripts swallow a write error, so a session
    // spawned before these exist (the Host's first spawn on a fresh profile, where the app's
    // startupCleanup never ran) would lose its statusline and hook output silently. Creating a folder
    // that is already there touches nothing in it.
    await fs.mkdir(this.hookEventsDir, { recursive: true })
    await fs.mkdir(this.outDir, { recursive: true })
    if (this.scopes.size > 0) await this.writeSandboxTwins()
  }

  /**
   * Observe mode (observe mode design §4, §5): writes the audit capture and the two settings files a session started
   * while the mode is observe reads instead of the ones above. Each is its plain file with two more entries, for every
   * tool (`*`): PostToolUse (a call that ran) and PostToolUseFailure (one that failed or was interrupted), both through
   * the audit capture into the session's audit file, where the Host's recorder reads them (host/audit/sources.ts).
   * `async`, so no tool call waits on the capture's node process. The entries already there stay as they are and still
   * write the session's own file, so attention, `sessions list`, pendingPrompt and Slack read an observed session
   * exactly as a plain one (the review's I2).
   *
   * Separate files, written only when a session is about to start observed (`SessionManager.prepare`), so a
   * compatibility session reads exactly the bytes it always did, and nothing is written for observe until it is on. A
   * session reads its file once at start (see UserPromptSubmit above), so rewriting these later reaches only new
   * sessions. Until all three are written, an observed session gets the plain file and is not marked observed
   * (`spawnConfig`). Never throws.
   */
  async ensureObserveFiles(): Promise<void> {
    if (!this.built) await this.ensureFiles()
    const b = this.built
    if (!b) return
    const script = await writeScript(this.hookAuditCapturePath, HOOK_AUDIT_CAPTURE_SCRIPT)
    const command = captureCommand(this.nodePath, this.hookAuditCapturePath)
    const plainJson = withObserveHooks(b.settings, command)
    const widerJson = withObserveHooks(b.hooksSettings, command)
    this.variants.set(this.observeSettingsFile, plainJson)
    this.variants.set(this.observeHooksSettingsFile, widerJson)
    const plain = await writeScript(this.observeSettingsFile, plainJson)
    const wider = await writeScript(this.observeHooksSettingsFile, widerJson)
    this.observeReady = script && plain && wider
    if (this.scopes.size > 0) await this.writeSandboxTwins()
  }

  /** The Enforce hook's command line for `provider`, or null where there is no Astera node to run it (enforceInterpreter). */
  enforceHookCommand(provider: 'claude' | 'codex'): string | null {
    const i =
      enforceInterpreter({ platform: this.platform, captureNode: this.nodePath, execPath: this.execPath, appImage: this.appImage }) ??
      (this.runtimeExe !== null ? { file: this.runtimeExe } : null)
    return i === null ? null : enforceCommand(i, this.enforceHookPath, provider)
  }

  /**
   * Enforce mode (enforce design §5, E1): writes the blocking hook and the settings a session started in Enforce reads.
   * Each terminal file is its observe variant (which it writes first) with one more PreToolUse entry for every tool
   * (`*`), not `async`: Claude Code waits on it, and the hook prints the deny itself. Every file also says
   * `"disableAllHooks": false`: it is passed as --settings, above user, project and local settings, so a project's
   * `.claude/settings.local.json` that turns hooks off cannot turn this one off (final review C2, measured 2026-10-27). A chat session (`--settings` on top
   * of its own arguments) gets a file with only that entry. Written only when a session is about to start in Enforce, so
   * an Off or Observe session reads exactly the bytes it did. Resolves to 'ok' once all of it is written, else why not: no
   * Astera node to run the hook (Windows without the Host runtime), or a file it could not write; the session is then
   * refused (E5). Never
   * throws.
   */
  async ensureEnforceFiles(): Promise<EnforceFilesResult> {
    await this.ensureObserveFiles()
    if (this.platform === 'win32' && this.findRuntime && enforceInterpreter({ platform: 'win32', captureNode: this.nodePath, execPath: this.execPath }) === null)
      this.runtimeExe = await this.findRuntime().catch(() => null)
    const b = this.built
    const command = this.enforceHookCommand('claude')
    if (command === null) {
      this.enforceReady = false
      return 'no-interpreter'
    }
    if (!b || !this.observeReady) {
      this.enforceReady = false
      return 'hook-write-failed'
    }
    const script = await writeScript(this.enforceHookPath, ENFORCE_HOOK_SOURCE)
    const pre = { matcher: '*', hooks: [{ type: 'command', command, timeout: 10 }] }
    const withEnforce = (s: BuiltSettings['settings']): string => {
      const observed = JSON.parse(withObserveHooks(s, captureCommand(this.nodePath, this.hookAuditCapturePath))) as {
        hooks: { PreToolUse?: unknown[] }
      }
      return JSON.stringify(
        { ...observed, disableAllHooks: false, hooks: { ...observed.hooks, PreToolUse: [...(observed.hooks.PreToolUse ?? []), pre] } },
        null,
        2
      )
    }
    const plainJson = withEnforce(b.settings)
    const widerJson = withEnforce(b.hooksSettings)
    const chatJson = JSON.stringify({ disableAllHooks: false, hooks: { PreToolUse: [pre] } }, null, 2)
    this.variants.set(this.enforceSettingsFile, plainJson)
    this.variants.set(this.enforceHooksSettingsFile, widerJson)
    this.variants.set(this.enforceChatSettingsFile, chatJson)
    const plain = await writeScript(this.enforceSettingsFile, plainJson)
    const wider = await writeScript(this.enforceHooksSettingsFile, widerJson)
    const chat = await writeScript(this.enforceChatSettingsFile, chatJson)
    this.enforceReady = script && plain && wider && chat
    if (this.scopes.size > 0) await this.writeSandboxTwins()
    return this.enforceReady ? 'ok' : 'hook-write-failed'
  }

  /** A Claude chat session's arguments for Enforce, once ensureEnforceFiles has written them, else null. */
  enforceChatArgs(): string[] | null {
    return this.enforceReady ? ['--settings', this.enforceChatSettingsFile.replace(/\\/g, '/')] : null
  }

  /**
   * The sandbox (sandbox design §6): writes, for the scope of a sandboxed Claude start (SandboxScope: its folder's git
   * layout and the environment its session is built from), a twin of each settings file a session can be pointed at
   * (plain, hooks, observe, observe hooks, enforce, enforce hooks, as far as each has been built), the same JSON with
   * Claude's sandbox added and the deny rules for the E6 list and the OS credential store, with this profile folder kept
   * from being written (claudeSandboxSettings), and the files a sandboxed chat takes as its one `--settings`: the sandbox alone, and with Enforce's hook. The twins of one
   * scope are in a folder of their own, `sandbox-settings/<hash>`, named by what its sandbox holds, so sessions in
   * different repositories, or of accounts whose environment names another bus, never read each other's, and two starts
   * in the same folder share them. No Unix socket is granted, the Host's included: a sandboxed session reaches the Host
   * through `astera` in `excludedCommands` or the loopback with its workload token, so a line `excludedCommands` does not
   * take out (`cd x && astera …`) cannot reach it, on macOS as on Linux. Windows gets the deny rules only (Claude has no
   * sandbox there). Written only once a sandboxed Claude is about to start (core/sandbox/claudeStart.ts), so a session
   * without it reads exactly the bytes it always did, at the same path. From then on every file rewritten gets the twins
   * of the last SANDBOX_SCOPES_KEPT scopes rewritten too. Resolves to 'write-failed' when one of this scope's twins is not
   * in place: a session asked to be sandboxed is then not marked so (spawnConfig), and its manager refuses it (E5).
   * Never throws.
   *
   * The app and the Host each write these paths in the profile folder, each from its own home and temp folder, as they
   * already do the files the twins are made from; a scope names the same folder in both only when what its sandbox holds
   * is the same.
   */
  async ensureSandboxFiles(scope: SandboxScope): Promise<SandboxFilesResult> {
    if (!this.built) await this.ensureFiles()
    const part = this.sandboxPart(scope)
    const key = sandboxKeyOf(part)
    this.scopes.delete(key)
    this.scopes.set(key, part)
    for (const old of [...this.scopes.keys()].slice(0, Math.max(0, this.scopes.size - SANDBOX_SCOPES_KEPT))) this.forgetScope(old)
    return this.writeTwinsOf(key, part)
  }

  /** What a sandbox twin adds: the builder's settings, for the scope's layout and from the scope's environment, under the
   *  person's home. */
  private sandboxPart(scope: SandboxScope): SandboxPart {
    // With the app key of this profile (sandbox follow-ups, item 1), as a Codex session's profile denies it, and the profile
    // folder itself kept from being written (Task E), as a Codex session's profile keeps it read
    const denied = claudeSessionDenied({ platform: this.platform, env: scope.env, homeDir: this.homeDir, appKeyFile: appKeyPath(this.userDataDir) })
    const readOnly = profileReadOnly(this.userDataDir)
    return claudeSandboxSettings({ platform: this.platform, denied, readOnly, npmCache: npmCacheOf(this.tmpDir), layout: scope.layout })
  }

  private twinsDirOf(key: string): string {
    return path.join(this.userDataDir, SANDBOX_TWINS_DIR, key)
  }

  private twinOf(file: string, key: string): string {
    const name = file === this.enforceChatSettingsFile ? path.basename(this.enforceSandboxChatSettingsFile) : path.basename(file).replace(/\.json$/, '-sandbox.json')
    return path.join(this.twinsDirOf(key), name)
  }

  private chatTwinOf(key: string): string {
    return path.join(this.twinsDirOf(key), path.basename(this.sandboxChatSettingsFile))
  }

  /** Whether `file`'s twin for the scope `key` holds the sandbox over what `file` holds now. */
  private twinReady(file: string, key: string): boolean {
    const from = this.twins.get(`${key}\u0000${file}`)
    return from !== undefined && from === this.variants.get(file)
  }

  /** Stops keeping a scope's twins up to date; its files stay on disk, and none is handed out again until a prepare writes
   *  them anew. */
  private forgetScope(key: string): void {
    this.scopes.delete(key)
    this.sandboxChatReady.delete(key)
    for (const k of [...this.twins.keys()]) if (k.startsWith(`${key}\u0000`)) this.twins.delete(k)
  }

  private async writeSandboxTwins(): Promise<void> {
    for (const [key, part] of [...this.scopes]) await this.writeTwinsOf(key, part)
  }

  private async writeTwinsOf(key: string, part: SandboxPart): Promise<SandboxFilesResult> {
    // A folder that cannot be made fails each write below, which says so
    await fs.mkdir(this.twinsDirOf(key), { recursive: true }).catch(() => {})
    // Stamped at every prepare, which writes nothing when every twin already holds what it would: a Host's start removes
    // a folder not written for 30 days (pruneSandboxTwins), and a folder still started from must never read as old
    const now = new Date()
    await fs.utimes(this.twinsDirOf(key), now, now).catch(() => {})
    let ok = true
    for (const [file, content] of [...this.variants]) {
      const k = `${key}\u0000${file}`
      if (await writeScript(this.twinOf(file, key), withSandbox(content, part))) this.twins.set(k, content)
      else {
        this.twins.delete(k)
        ok = false
      }
    }
    const chat = await writeScript(this.chatTwinOf(key), withSandbox('{}', part))
    if (chat) this.sandboxChatReady.add(key)
    else this.sandboxChatReady.delete(key)
    return ok && chat ? 'ok' : 'write-failed'
  }

  /** A sandboxed Claude chat's one `--settings` (sandbox design §6): the sandbox of its scope, and in Enforce the blocking
   *  hook with it, once ensureSandboxFiles for that scope (and for Enforce ensureEnforceFiles) has written it, else null. */
  sandboxChatArgs(enforce: boolean, scope: SandboxScope): string[] | null {
    const key = sandboxKeyOf(this.sandboxPart(scope))
    if (enforce)
      return this.enforceReady && this.twinReady(this.enforceChatSettingsFile, key) ? ['--settings', this.twinOf(this.enforceChatSettingsFile, key).replace(/\\/g, '/')] : null
    return this.sandboxChatReady.has(key) ? ['--settings', this.chatTwinOf(key).replace(/\\/g, '/')] : null
  }

  /** A Codex session's arguments for Enforce (terminal and app-server), once ensureEnforceFiles has written the hook,
   *  else null. */
  enforceCodexArgs(): string[] | null {
    const command = this.enforceReady ? this.enforceHookCommand('codex') : null
    return command === null ? null : codexEnforceArgs({ command, platform: this.platform })
  }

  /** The app-start half: empties the hook events folder (a queue the app drains) and makes the
   *  per-session output folder. The app alone calls it. */
  async startupCleanup(): Promise<void> {
    // Hook events are a queue the app drains while it runs, so anything still sitting here was
    // written while it was away and is stale on arrival — a Notification from hours ago would push a
    // session into `waiting` over whatever is true now. Dropped, not replayed.
    //
    // **Emptied in place, never removed.** A Host that outlives the app holds a watch on this folder,
    // and on win32 removing a watched folder leaves it pending delete: the mkdir after it reported
    // success without making anything, and once the Host let go the folder was gone for the whole app
    // session, every hook event of it dropped by the capture script's swallowed write error
    // (watchedDir.ts has the measurement). One file that will not delete costs only itself.
    await fs.mkdir(this.hookEventsDir, { recursive: true })
    let names: string[] = []
    try {
      names = await fs.readdir(this.hookEventsDir)
    } catch {
      /* checked below */
    }
    for (const name of names) {
      if (name.endsWith('.jsonl')) await fs.rm(path.join(this.hookEventsDir, name), { force: true }).catch(() => {})
    }
    // A folder that cannot be read now (pending delete under an older Host's watch) loses every hook
    // event the sessions write: said, and not fatal to the app's start.
    if (dirIdentity(this.hookEventsDir) === null)
      this.log(`statusline: the hook events folder ${this.hookEventsDir} cannot be used; hook events are lost until it can`)
    // The session payloads are NOT cleared here, and used to be. They are the latest snapshot rather
    // than a queue, and the Host means a session outlives the app that started it: wiping the folder
    // took the transcript path away from every session that survived a restart, so the conversation
    // view read "no transcript yet" for a session with a full one and rolling could not find the file
    // to resume from, until that session happened to write a statusline again. Collected by
    // `pruneExcept` instead, once the app knows which sessions it actually has.
    await fs.mkdir(this.outDir, { recursive: true })
  }

  /** Deletes the stored payload of every session not in `keep`.
   *
   *  The collector for this folder. Called once the app has taken its sessions back from the Host
   *  (main/ipc.ts), which is the first moment the full set is known — at `init` it is not, and
   *  guessing there is what the old unconditional wipe amounted to. A payload for a session the app
   *  has no record of can never be read by anything, so it is exactly the garbage that wipe was
   *  after; a payload for a session that is merely exited stays, because its record is still around
   *  and a resume may still ask for its transcript path.
   *
   *  Never throws: a folder that is not there yet, or one file that will not delete, leaves the rest
   *  of the sweep alone. */
  async pruneExcept(keep: ReadonlySet<string>): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(this.outDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      if (keep.has(name.slice(0, -'.json'.length))) continue
      await fs.rm(path.join(this.outDir, name), { force: true }).catch(() => {})
    }
  }

  /** Injection info for a session spawn. originalCommand is the existing statusLine from the account's
   *  settings.json (the chain target).
   *
   *  Every session gets the Notification hook and its own hookOutPath — that is what the desktop
   *  notification for a choice or an approval is built on, and it is offered for any session.
   *  `opts.toolHooks` adds what only slack.ts reads: the turn summary's Stop and the per-tool-call
   *  capture pair. `opts.observe` (a session started while the mode is observe) points it at the
   *  observe variant of that file, once ensureObserveFiles has written them, and says so (`observed`).
   *  `opts.enforce` (with observe, a session started in Enforce) points it at the enforce variant, once
   *  ensureEnforceFiles has written them, and says so (`enforced`). `opts.sandbox` (a sandboxed Claude session's scope)
   *  points it at that scope's sandbox twin of whichever of these it would read, once ensureSandboxFiles has written that
   *  twin over what the file holds now, and says so (`sandboxed`); without that mark its manager refuses the start. */
  spawnConfig(sessionId: string, account: Account, opts?: { toolHooks?: boolean; observe?: boolean; enforce?: boolean; sandbox?: SandboxScope }): StatusLineSpawn {
    const toolHooks = opts?.toolHooks === true
    const observe = opts?.observe === true && this.observeReady
    const enforce = observe && opts?.enforce === true && this.enforceReady
    const variant = enforce
      ? toolHooks
        ? this.enforceHooksSettingsFile
        : this.enforceSettingsFile
      : observe
      ? toolHooks
        ? this.observeHooksSettingsFile
        : this.observeSettingsFile
      : toolHooks
        ? this.hooksSettingsFile
        : this.settingsFile
    const key = opts?.sandbox ? sandboxKeyOf(this.sandboxPart(opts.sandbox)) : null
    const sandboxed = key !== null && this.twinReady(variant, key)
    const file = sandboxed && key !== null ? this.twinOf(variant, key) : variant
    return {
      // Normalised to forward slashes — this is the --settings argument path passed to the shell/cmd (a verified format). node fs handles it as-is too.
      settingsFile: file.replace(/\\/g, '/'),
      outPath: path.join(this.outDir, `${sessionId}.json`),
      originalCommand: this.readOriginalStatusLine(account.configDir),
      // Always set: with ASTERA_HOOK_OUT unset the capture script does nothing, so a hook that is
      // installed but has nowhere to write is the same as no hook at all.
      hookOutPath: hookEventsFileIn(this.hookEventsDir, sessionId),
      ...(observe ? { observed: true as const } : {}),
      ...(enforce ? { enforced: true as const } : {}),
      ...(sandboxed ? { sandboxed: true as const } : {})
    }
  }

  /** Reads the session's statusLine payload (JSON). null when it does not exist yet or is corrupt. */
  async read(sessionId: string): Promise<unknown | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.outDir, `${sessionId}.json`), 'utf8'))
    } catch {
      return null
    }
  }

  private readOriginalStatusLine(configDir: string): string | null {
    try {
      const raw = readFileSync(path.join(configDir, 'settings.json'), 'utf8')
      const cmd = (JSON.parse(raw) as { statusLine?: { command?: unknown } })?.statusLine?.command
      return typeof cmd === 'string' && cmd.trim() !== '' ? cmd : null
    } catch {
      return null // No settings.json, or a parse failure → nothing to chain
    }
  }
}
