// What a session is told about Astera when it starts. Claude Code runs this as a SessionStart hook
// (installed by statusline.ts) and takes the `additionalContext` of its stdout JSON into the
// conversation, so an agent knows what Astera offers before it decides how to do a job — a skill's
// description alone did not stop an agent launching the project's app on the person's screen.
//
// Which lines appear is decided **when the session starts**, from the profile's app-settings.json, by
// the same gates `skillStubs` (main/orchestration/stub.ts) installs the skills by. The hooks settings
// file is written once per launch and a toggle can change after, so the decision cannot be baked in
// there. A file that is missing or unreadable reads as every gated feature off: this hook must never
// print a failure into a conversation. Outside a session Astera started (no ASTERA_CLI) it prints
// nothing.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { LAUNCH_FORBIDDEN } from './commands'

const HEADER = 'This session runs inside Astera. Use Astera\'s tools before building your own:'
const LINES = {
  app:
    '- To run, click through or screenshot THIS project\'s app — including your own checks nobody asked for — use the agent app workspace: `astera app help`, then `astera app js`. Never launch the app on the person\'s screen (no `npx electron-vite dev`/`npm run dev` with a debugging port, no window tools).',
  browser: '- To open this project\'s web pages: `astera browser help`.',
  task: '- Record a task in How It Works: /astera-task.',
  handoff: '- Leave a handoff memo: `astera handoff`.',
  orchestration: '- Read or message other sessions, plan Jobs, dispatch work: `astera help`.',
  higgsfield: '- Higgsfield accounts: `astera higgsfield list` / `use --account <account>` (ask the user first).'
}
const FOOTER = 'Full list: `astera help`.'

export const SESSION_CONTEXT_SCRIPT = `const fs = require('fs')
const path = require('path')
const dir = process.env.ASTERA_PROFILE_DIR
const H = ${JSON.stringify({ HEADER, LINES, FOOTER })}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) } catch { return null }
}
try {
  if (process.env.ASTERA_CLI && dir) {
    const s = readJson('app-settings.json') || {}
    const hf = readJson(path.join('higgsfield', 'accounts.json'))
    const lines = [H.HEADER]
    if (s.agentAppEnabled === true) lines.push(H.LINES.app)
    if (s.agentBrowserEnabled === true) lines.push(H.LINES.browser)
    if (s.workUnitTrackingEnabled === true) lines.push(H.LINES.task)
    if (s.resumeStrategy === 'smart') lines.push(H.LINES.handoff)
    lines.push(H.LINES.orchestration)
    if (hf && Array.isArray(hf.accounts) && hf.accounts.length > 0) lines.push(H.LINES.higgsfield)
    lines.push(H.FOOTER)
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\\n') } }))
  }
} catch {}
process.exit(0)
`

/** The lines the script above prints, decided by the same rules, for a session that cannot run it: a
 *  codex TUI (codexDeveloperInstructions). The script keeps its own copy because it runs as a separate
 *  file; a test runs both over the same settings (sessionContext.test.ts) so the two cannot drift. */
export function sessionContextLines(settings: unknown, higgsfield: unknown): string[] {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {}
  const hf = higgsfield && typeof higgsfield === 'object' ? (higgsfield as { accounts?: unknown }) : null
  const lines = [HEADER]
  if (s.agentAppEnabled === true) lines.push(LINES.app)
  if (s.agentBrowserEnabled === true) lines.push(LINES.browser)
  if (s.workUnitTrackingEnabled === true) lines.push(LINES.task)
  if (s.resumeStrategy === 'smart') lines.push(LINES.handoff)
  lines.push(LINES.orchestration)
  if (hf && Array.isArray(hf.accounts) && hf.accounts.length > 0) lines.push(LINES.higgsfield)
  lines.push(FOOTER)
  return lines
}

/** True when this config.toml sets `developer_instructions` itself, at the top level: a key under a
 *  table (`[profiles.x]`) belongs to that table, not to every session. */
function setsDeveloperInstructions(toml: string): boolean {
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return false
    if (/^\s*developer_instructions\s*=/.test(line)) return true
  }
  return false
}

function readJson(read: (p: string) => string | null, file: string): unknown {
  try {
    const text = read(file)
    return text === null ? null : JSON.parse(text)
  } catch {
    return null
  }
}

function readFileOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * What a codex session is told about Astera at start, as one `developer_instructions` value, or null.
 *
 * **Not a hook, though codex 0.160 has SessionStart hooks** (measured 2026-10-07). It runs no hook it
 * has not been told to trust: a "Hooks need review" menu stops the session first, a hook given with
 * `-c` included, and nobody is in front of a worker to answer it. The one switch past that,
 * `--dangerously-bypass-hook-trust`, would also run whatever hooks a cloned repository ships. A
 * `developer_instructions` override reaches the model as a developer message with no menu at all. It is
 * decided when the session is spawned rather than when it starts, which for a session is one moment.
 *
 * **One line, with nothing cmd.exe reads as syntax** (LAUNCH_FORBIDDEN): an npm-installed codex starts
 * through `cmd.exe /c call`, where a line break or a `<` would break the launch. The higgsfield line's
 * `<account>` becomes `(account)` for that reason.
 *
 * **Null when the account's own config.toml sets developer_instructions**: `-c` would replace it, and the
 * person's own instructions matter more than this list.
 */
export function codexDeveloperInstructions(a: {
  profileDir: string
  codexHome: string
  read?: (file: string) => string | null
}): string | null {
  const read = a.read ?? readFileOrNull
  const own = read(path.join(a.codexHome, 'config.toml'))
  if (own !== null && setsDeveloperInstructions(own)) return null
  const lines = sessionContextLines(
    readJson(read, path.join(a.profileDir, 'app-settings.json')),
    readJson(read, path.join(a.profileDir, 'higgsfield', 'accounts.json'))
  )
  const text = lines.join(' ').replace(/</g, '(').replace(/>/g, ')')
  return LAUNCH_FORBIDDEN.test(text) ? null : text
}
