// 2026-10-26: the browser pane's send pasted into the agent's terminal and pressed Enter 50 ms later, and Codex swallows
// an Enter that comes right after a paste (openai/codex#56982). It goes through sessionBus.pasteAndSubmit now, whose
// Enter waits for the session to draw the paste and go quiet. Read from the source as agentTabs.wiring.test reads the
// App's other wiring.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8')

describe('the browser pane’s send to a session', () => {
  it('pastes and submits through pasteAndSubmit, with no Enter on a timer of its own', () => {
    const start = app.indexOf('onSendToSession={(sessionId, text) => {')
    expect(start).toBeGreaterThan(-1)
    const send = app.slice(start, app.indexOf('\n        }}\n', start))
    expect(send).toContain("if (!sessionBus.pasteAndSubmit(sessionId, text)) return 'no-terminal'")
    expect(send).not.toContain('submitInto')
    expect(send).not.toContain('setTimeout')
  })
})
