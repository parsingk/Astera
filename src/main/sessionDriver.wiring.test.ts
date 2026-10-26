// The app's scheduler, rolling and Slack deliver through one ptyDriver (index.ts). Its Enter waits for the session to
// have drawn the text and gone quiet (core/sessions/sessionDriver.ts), which it can only do when it is given the
// session's last output: Codex swallowed an Enter 150 ms after a long text and left the message unsent (found on the
// dev app, 2026-10-26; openai/codex#56982). index.ts cannot run without Electron, so the wiring is guarded by its text.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')

describe('index.ts gives the app’s pty driver the session’s last output', () => {
  it('passes lastOutputAt from the session manager to ptyDriver', () => {
    const start = src.indexOf('ptyDriver({')
    expect(start).toBeGreaterThan(-1)
    const call = src.slice(start, src.indexOf('}),', start))
    expect(call).toContain('lastOutputAt: (id) => core!.sessions.lastOutput(id)')
  })
})
