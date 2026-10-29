// Task E fix round 3 (re-review Important 1): a sandboxed start's warnings ride the session's info (SessionInfo
// .sandboxWarnings, in the Host's note too), and the tab says them in one quiet line above the terminal or the chat, in
// the sandbox marker's manner: a small shield, dim, the whole sentence on hover. The person can close it, and it stays
// closed for that session. A line written into the terminal would sit behind the CLI's alternate screen.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { SandboxWarningLine } from './SandboxWarningLine'
import { close } from '../lib/sandboxWarningClosed'
import type { SandboxStartWarning } from '../../../core/types'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string) => key, tm: (m: unknown) => String(m) })
}))

const line = (sessionId: string, warnings: readonly SandboxStartWarning[] | undefined): string =>
  renderToStaticMarkup(React.createElement(SandboxWarningLine, { sessionId, warnings }))

describe('the sandbox warning line', () => {
  it('says nothing for a session with nothing to warn about', () => {
    expect(line('s1', undefined)).toBe('')
    expect(line('s1', [])).toBe('')
  })

  it('says a warning in one line, titled with the whole sentence, with the marker’s shield and a close button', () => {
    const html = line('s1', ['homeInWorkFolder'])
    expect(html).toMatch(/^<div class="sandbox-warning-line" role="note">/)
    expect(html).toContain('<span class="sandbox-warning-icon" aria-hidden="true"><svg')
    expect(html).toContain('lucide-shield-alert')
    expect(html).toContain('<span class="sandbox-warning-text" title="session.sandbox.warn.homeInWorkFolder">session.sandbox.warn.homeInWorkFolder</span>')
    expect(html).toMatch(/<button type="button" class="sandbox-warning-close" aria-label="common.close" title="common.close"><svg/)
  })

  it('says both warnings in one line', () => {
    expect(line('s1', ['claudeUserns', 'homeInWorkFolder'])).toContain('>session.sandbox.warn.claudeUsernsAndHome</span>')
    expect(line('s1', ['claudeUserns'])).toContain('>session.sandbox.warn.claudeUserns</span>')
    // Task E fix round 5: Codex on Linux, a named path through a link in the work folder, with the home warning
    expect(line('s1', ['linkInWorkFolder', 'homeInWorkFolder'])).toContain('>session.sandbox.warn.linkAndHome</span>')
  })

  it('stays closed for the session it was closed for, and only that one', () => {
    close('closed-1')
    expect(line('closed-1', ['homeInWorkFolder'])).toBe('')
    expect(line('open-2', ['homeInWorkFolder'])).toContain('session.sandbox.warn.homeInWorkFolder')
  })
})

// PaneGrid and ConversationPane need the whole app around them to render: guarded by their text
describe('where the line is drawn', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const paneGrid = readFileSync(path.join(here, 'PaneGrid.tsx'), 'utf8')
  const conversation = readFileSync(path.join(here, 'conversation', 'ConversationPane.tsx'), 'utf8')
  it('above a terminal session’s terminal, from its info, only when it runs in the sandbox', () => {
    // The slot's view is a column, so the line takes its height and the terminal below fits what is left
    expect(paneGrid).toContain(
      [
        `<div className="session-slot-view" style={{ display: 'flex' }}>`,
        `                <SandboxWarningLine sessionId={s.id} warnings={s.sandboxed === true ? s.sandboxWarnings : undefined} />`,
        `                <TerminalView`
      ].join('\n')
    )
  })

  it('above a chat session’s thread, beside the durable bypass mark, from its info', () => {
    expect(paneGrid).toContain(`sandboxWarnings={s.sandboxed === true ? s.sandboxWarnings : undefined}`)
    expect(conversation).toMatch(/<SandboxWarningLine sessionId=\{sessionId\} warnings=\{sandboxWarnings\} \/>\n\s*\{\/\* design F5 fix round 1 \(Critical 2\): the durable mark/)
  })
})
