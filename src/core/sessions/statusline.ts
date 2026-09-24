import { promises as fs } from 'node:fs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Account } from '../types'
import { hookEventsDirIn, hookEventsFileIn } from '../hooks/sessionState'
import { HOOK_EVENT_AT } from '../hooks/eventTime'
import { renameRetrying } from '../renameRetry'

/** The statusLine injection info handed to SessionManager when a session is spawned. */
export interface StatusLineSpawn {
  settingsFile: string // --settings <file> (session-scoped statusLine; the global settings.json is not modified)
  outPath: string // The file the capture script writes the payload to (one per session)
  originalCommand: string | null // That account's pre-existing global statusLine command — when present it is chained so the HUD stays
  hookOutPath?: string // the file the hook capture appends events to (one per session) — always set
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
// The capture runs under whatever `node` the settings command names (bare `node` on PATH on Windows,
// the resolved one on macOS); a node older than 16 has no global `performance`, and falls back to
// `Date.now()` taken first, before stdin is read. Spliced in
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
 * logger, so a failure goes to the console. The temp file is removed on every path.
 */
async function writeScript(file: string, content: string): Promise<void> {
  try {
    if ((await fs.readFile(file, 'utf8')) === content) return
  } catch {
    /* no file yet, or unreadable: write it */
  }
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, content, 'utf8')
    await renameRetrying(tmp, file)
  } catch (err) {
    console.warn(`astera: could not swap in ${path.basename(file)} (${(err as Error).message}); writing it in place`)
    try {
      await fs.writeFile(file, content, 'utf8')
    } catch (again) {
      console.warn(`astera: could not write ${path.basename(file)} (${(again as Error).message})`)
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
 * The win32 branch below exists and is covered by its own test, but the caller (core.ts) does not use
 * it — it passes the literal 'node' on win32 instead, to keep the emitted statusLine command
 * byte-identical to what shipped before this function existed.
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

/** The one tool whose PreToolUse/PostToolUse pair **every** session gets. Its `tool_input` is the question
 *  the conversation view draws as a card (main/pendingPrompt.ts → core/prompts/askUserQuestion.ts), and
 *  a question is minutes apart, so the cost is one node process per question — the same order as Stop. */
const ASK_MATCHER = 'AskUserQuestion'

/** The tools whose calls the Pre/PostToolUse hooks watch in a Slack-notifying or rolling session. A
 *  superset of ASK_MATCHER on purpose: that file replaces the every-session file rather than layering on
 *  it, so the question capture must be in here too or those sessions would lose it. Both events share it
 *  so the capture and the invalidation cannot cover different sets — see the PostToolUse comment in ensureFiles(). */
const TOOL_MATCHER = `${ASK_MATCHER}|Bash|PowerShell|Write|Edit|NotebookEdit`

export class StatusLineManager {
  private readonly capturePath: string
  private readonly settingsFile: string
  private readonly outDir: string
  private readonly hookCapturePath: string
  private readonly hooksSettingsFile: string
  readonly hookEventsDir: string // Watched by index.ts's HookEventWatcher

  constructor(
    private userDataDir: string,
    /** The node that will run the capture script. The default matches prior behavior (a PATH lookup). */
    private nodePath: string = 'node'
  ) {
    this.capturePath = path.join(userDataDir, 'astera-statusline-capture.cjs')
    this.settingsFile = path.join(userDataDir, 'astera-statusline-settings.json')
    this.outDir = path.join(userDataDir, 'statusline')
    this.hookCapturePath = path.join(userDataDir, 'astera-hook-capture.cjs')
    this.hooksSettingsFile = path.join(userDataDir, 'astera-hooks-settings.json')
    // The Host reads these files back for `sessions list` (host/sessions.ts), so where they are is one
    // rule in core rather than a path spelled out twice.
    this.hookEventsDir = hookEventsDirIn(userDataDir)
  }

  /** The app's start: ensureFiles() then startupCleanup(). */
  async init(): Promise<void> {
    await this.ensureFiles()
    await this.startupCleanup()
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
    const hookCmd = `"${this.nodePath.replace(/\\/g, '/')}" "${this.hookCapturePath.replace(/\\/g, '/')}"`
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
    // main/attention.ts reads Notification to learn a session is waiting on a person, and Stop or
    // PostToolUse to learn it no longer is. PostToolUse only ever fires when a call actually runs, so
    // a person who answers "no" produces neither — and without Stop here an ordinary session would
    // stay `waiting` for the rest of its life, with the conversation view's banner up and its
    // composer locked the whole time (measured in the dev app, not reasoned about). It used to be
    // kept out of here on the grounds that nothing but slack.ts read it; attention.ts reads it now.
    // The cost is one node process at the end of a turn, which is minutes apart, not per keystroke.
    const everySessionHooks = {
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
      // It is a JSON string, so no shell escaping. Paths are normalised to forward slashes (fine on Windows too).
      statusLine: {
        type: 'command',
        command: `"${this.nodePath.replace(/\\/g, '/')}" "${this.capturePath.replace(/\\/g, '/')}"`,
        padding: 0
      },
      hooks: everySessionHooks
    }
    // Through writeScript like the scripts: the app and the Host both write these files, and a
    // session starting mid-write would read half a settings file.
    await writeScript(this.settingsFile, JSON.stringify(settings, null, 2))
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
    await writeScript(this.hooksSettingsFile, JSON.stringify(hooksSettings, null, 2))
    // The folders the capture scripts write into. Both scripts swallow a write error, so a session
    // spawned before these exist (the Host's first spawn on a fresh profile, where the app's
    // startupCleanup never ran) would lose its statusline and hook output silently. Creating a folder
    // that is already there touches nothing in it.
    await fs.mkdir(this.hookEventsDir, { recursive: true })
    await fs.mkdir(this.outDir, { recursive: true })
  }

  /** The app-start half: empties the hook events folder (a queue the app drains) and makes the
   *  per-session output folder. The app alone calls it. */
  async startupCleanup(): Promise<void> {
    // Hook events are a queue the app drains while it runs, so anything still sitting here was
    // written while it was away and is stale on arrival — a Notification from hours ago would push a
    // session into `waiting` over whatever is true now. Dropped, not replayed.
    await fs.rm(this.hookEventsDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(this.hookEventsDir, { recursive: true })
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
   *  capture pair. */
  spawnConfig(sessionId: string, account: Account, opts?: { toolHooks?: boolean }): StatusLineSpawn {
    const toolHooks = opts?.toolHooks === true
    return {
      // Normalised to forward slashes — this is the --settings argument path passed to the shell/cmd (a verified format). node fs handles it as-is too.
      settingsFile: (toolHooks ? this.hooksSettingsFile : this.settingsFile).replace(/\\/g, '/'),
      outPath: path.join(this.outDir, `${sessionId}.json`),
      originalCommand: this.readOriginalStatusLine(account.configDir),
      // Always set: with ASTERA_HOOK_OUT unset the capture script does nothing, so a hook that is
      // installed but has nowhere to write is the same as no hook at all.
      hookOutPath: hookEventsFileIn(this.hookEventsDir, sessionId)
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
