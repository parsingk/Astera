// The app's scheduler, rolling and Slack deliver through one ptyDriver (index.ts). Its Enter waits for the session to
// have drawn the text and gone quiet (core/sessions/sessionDriver.ts), which it can only do when it is given the
// session's last output: Codex swallowed an Enter 150 ms after a long text and left the message unsent (found on the
// dev app, 2026-10-26; openai/codex#56982). index.ts cannot run without Electron, so the wiring is guarded by its text.
// ipc.ts's orchestration coordinator (a worker's prompt typed into a --terminal reuse) and dispatch loop (a sleeping
// coordinator's nudge) type through ptyDriver too, and are guarded the same way.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, 'index.ts'), 'utf8')
const ipc = readFileSync(path.join(here, 'ipc.ts'), 'utf8')

describe('index.ts gives the app’s pty driver the session’s last output', () => {
  it('passes lastOutputAt from the session manager to ptyDriver', () => {
    const start = src.indexOf('ptyDriver({')
    expect(start).toBeGreaterThan(-1)
    const call = src.slice(start, src.indexOf('}),', start))
    expect(call).toContain('lastOutputAt: (id) => core!.sessions.lastOutput(id)')
  })
})

describe('ipc.ts gives the orchestration’s typing the session’s last output', () => {
  it('passes lastOutputAt beside the coordinator’s writeToSession', () => {
    expect(ipc).toMatch(
      /writeToSession: \(id, data\) => core\.sessions\.write\(id, data\),\s*lastOutputAt: \(id\) => core\.sessions\.lastOutput\(id\),/
    )
  })
  it('passes lastOutputAt beside the Slack inbox’s write', () => {
    const start = src.indexOf('new SlackInboxController({')
    expect(start).toBeGreaterThan(-1)
    const deps = src.slice(start, src.indexOf('createClient:', start))
    expect(deps).toContain('lastOutputAt: (sid) => core!.sessions.lastOutput(sid)')
  })
  it('passes lastOutputAt beside the dispatch loop’s typeInto', () => {
    expect(ipc).toMatch(
      /typeInto: \(id, text\) => core\.sessions\.write\(id, text\),\s*lastOutputAt: \(id\) => core\.sessions\.lastOutput\(id\),/
    )
  })
})
