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
