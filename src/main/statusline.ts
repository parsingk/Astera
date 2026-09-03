import { promises as fs } from 'node:fs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Account } from '../core/types'

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

// Hook capture script (node): Claude runs it as the Stop and Notification hooks → it appends the stdin payload (JSON)
// as one line to ASTERA_HOOK_OUT (a per-session jsonl). With that env unset it does nothing.
const HOOK_CAPTURE_SCRIPT = `const fs = require('fs')
const out = process.env.ASTERA_HOOK_OUT
const chunks = []
function finish() {
  if (out) {
    try { fs.appendFileSync(out, Buffer.concat(chunks).toString('utf8').replace(/\\r?\\n/g, ' ') + '\\n') } catch {}
  }
  process.exit(0)
}
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', finish)
process.stdin.on('error', finish)
`

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

/** The tools whose calls the Pre/PostToolUse hooks watch. Both events share it so the capture and the
 *  invalidation cannot cover different sets — see the PostToolUse comment in init(). */
const TOOL_MATCHER = 'AskUserQuestion|Bash|PowerShell|Write|Edit|NotebookEdit'

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
    this.hookEventsDir = path.join(userDataDir, 'hook-events')
  }

  /** Writes the capture script and settings files, and resets the per-session output folder (removing leftovers from the previous run). */
  async init(): Promise<void> {
    await fs.mkdir(this.userDataDir, { recursive: true })
    await fs.writeFile(this.capturePath, CAPTURE_SCRIPT, 'utf8')
    await fs.writeFile(this.hookCapturePath, HOOK_CAPTURE_SCRIPT, 'utf8')
    const hookCmd = `"${this.nodePath.replace(/\\/g, '/')}" "${this.hookCapturePath.replace(/\\/g, '/')}"`
    // Hooks from --settings merge with the account's global settings.json hooks and both run
    // (measured). The global settings stay untouched.
    //
    // Stop and Notification go into EVERY session, not just Slack-notifying or rolling ones. They are
    // how the app learns that a session finished a turn or stopped for input, and desktop
    // notifications are offered for any session — two of the four events ship on. Gating them the way
    // the tool hooks are gated is what made the notification feature inert for an ordinary session:
    // the flag was on, the sink had no per-session gate, and the event simply never arrived.
    //
    // The cost is one node process when a turn ends and one when a prompt appears. That is not the
    // cost the tool hooks below were carefully limited for — those fire per tool call.
    const sessionHooks = {
      Stop: [{ hooks: [{ type: 'command', command: hookCmd }] }],
      Notification: [{ hooks: [{ type: 'command', command: hookCmd }] }]
    }
    const settings = {
      // It is a JSON string, so no shell escaping. Paths are normalised to forward slashes (fine on Windows too).
      statusLine: {
        type: 'command',
        command: `"${this.nodePath.replace(/\\/g, '/')}" "${this.capturePath.replace(/\\/g, '/')}"`,
        padding: 0
      },
      hooks: sessionHooks
    }
    await fs.writeFile(this.settingsFile, JSON.stringify(settings, null, 2), 'utf8')
    // Slack's pending-question bookkeeping on top: the tool-call pair, which fires per tool call and
    // is therefore matcher-limited. Only a Slack-notifying or rolling session pays for it.
    const hooksSettings = {
      ...settings,
      hooks: {
        ...sessionHooks,
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
    await fs.writeFile(this.hooksSettingsFile, JSON.stringify(hooksSettings, null, 2), 'utf8')
    await fs.rm(this.hookEventsDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(this.hookEventsDir, { recursive: true })
    // Clear the previous run's session files, then recreate the folder (safe because PTYs die when the app restarts)
    await fs.rm(this.outDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(this.outDir, { recursive: true })
  }

  /** Injection info for a session spawn. originalCommand is the existing statusLine from the account's
   *  settings.json (the chain target).
   *
   *  Every session gets the Stop and Notification hooks and its own hookOutPath — that is what desktop
   *  notifications are built on, and they are offered for any session. `opts.toolHooks` adds the
   *  per-tool-call capture pair on top, which only Slack's pending-question reporting needs. */
  spawnConfig(sessionId: string, account: Account, opts?: { toolHooks?: boolean }): StatusLineSpawn {
    const toolHooks = opts?.toolHooks === true
    return {
      // Normalised to forward slashes — this is the --settings argument path passed to the shell/cmd (a verified format). node fs handles it as-is too.
      settingsFile: (toolHooks ? this.hooksSettingsFile : this.settingsFile).replace(/\\/g, '/'),
      outPath: path.join(this.outDir, `${sessionId}.json`),
      originalCommand: this.readOriginalStatusLine(account.configDir),
      // Always set: with ASTERA_HOOK_OUT unset the capture script does nothing, so a hook that is
      // installed but has nowhere to write is the same as no hook at all.
      hookOutPath: path.join(this.hookEventsDir, `${sessionId}.jsonl`)
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
