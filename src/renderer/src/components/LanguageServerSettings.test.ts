import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { t as translate, type MessageKey, type MessageParams } from '../../../core/i18n'
import type { LspInstalled, LspServerStatus } from '../../../core/lsp/model'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: MessageKey, params?: MessageParams) => translate('en', key, params), tm: (m: unknown) => String(m) })
}))

const { ServerRow, installConfirmBody } = await import('./LanguageServerSettings')
const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'LanguageServerSettings.tsx'), 'utf8')
const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)

// Phase 3 Part 3: Settings › language servers
const pyright: LspInstalled = {
  server: 'python',
  available: true,
  installed: false,
  folder: 'C:\\prof\\language-servers',
  packages: [{ name: 'pyright', version: '1.1.414', integrity: 'sha512-x', licence: 'MIT', bytes: 19457120 }]
}
const noop = (): void => {}
const row = (installed: LspInstalled, statuses: LspServerStatus[] = [], busy = false): string =>
  renderToStaticMarkup(React.createElement(ServerRow, { installed, statuses, busy, onInstall: noop, onRemove: noop, onLog: noop, onRestart: noop, logs: {} }))

describe('LanguageServerSettings', () => {
  it('asks before an install, naming each package’s name, version, licence, size and folder', () => {
    const body = installConfirmBody(en, pyright)
    for (const part of ['pyright', '1.1.414', 'MIT', '18.6 MB', 'C:\\prof\\language-servers']) expect(body, part).toContain(part)
  })

  it('offers Install when not installed, Remove when installed, and neither where it cannot run', () => {
    expect(row(pyright)).toContain(en('lsp.install'))
    expect(row(pyright)).toContain(en('lsp.notInstalled'))
    const installed = row({ ...pyright, installed: true })
    expect(installed).toContain(en('lsp.remove'))
    expect(installed).toContain('1.1.414')
    const unavailable = row({ ...pyright, server: 'typescript', available: false, packages: [] })
    expect(unavailable).toContain(en('lsp.unavailable'))
    expect(unavailable).not.toContain(en('lsp.install'))
  })

  it('shows each root a server runs for, with its state, why it stopped and its notes', () => {
    const html = row({ ...pyright, installed: true }, [
      { server: 'python', root: 'C:\\proj', status: 'running', pid: 4 },
      { server: 'python', root: 'C:\\other', status: 'failed', why: 'crashed', reason: 'it exited on its own (code 3)' },
      { server: 'python', root: 'C:\\third', status: 'stopped', why: 'room', notes: ['older-typescript'] }
    ])
    expect(html).toContain('C:\\proj')
    expect(html).toContain(en('lsp.status.running'))
    expect(html).toContain(en('lsp.why.crashed'))
    expect(html).toContain('it exited on its own (code 3)')
    expect(html).toContain(en('lsp.why.room'))
    expect(html).toContain(en('lsp.note.older-typescript'))
  })

  // Final review I4: a failed root, or one stopped to make room, has a way back; a running one does not need it
  it('offers Restart for a root that crashed or was stopped to make room, and says how each comes back', () => {
    const html = row({ ...pyright, installed: true }, [
      { server: 'python', root: 'C:\\proj', status: 'running', pid: 4 },
      { server: 'python', root: 'C:\\other', status: 'failed', why: 'crashed' },
      { server: 'python', root: 'C:\\third', status: 'stopped', why: 'room' }
    ])
    expect(html.match(new RegExp(`<button[^>]*>${en('lsp.restart')}</button>`, 'g'))).toHaveLength(2)
    expect(en('lsp.why.crashed')).toMatch(/Restart/)
    expect(en('lsp.why.room')).toMatch(/sav/i)
    // Found on screen: a changed path restarts the server at once (refresh), it does not wait for the next start
    expect(en('lsp.path.hint')).toMatch(/restarts/)
    expect(src).toMatch(/window\.api\.lsp\.restart\(server, root\)/)
  })

  it('installs and removes through the Host, and keeps a project’s venv choice in venvProjects', () => {
    expect(src).toMatch(/window\.api\.lsp\.install\(/)
    expect(src).toMatch(/window\.api\.lsp\.remove\(/)
    expect(src).toMatch(/confirmModal\(\{ title: t\('lsp\.installConfirm\.title'/)
    expect(src).toMatch(/venvProjects: use \? \[\.\.\.s\.python\.venvProjects, project\] : s\.python\.venvProjects\.filter/)
    expect(src).toMatch(/window\.api\.on\('lsp:state'/)
  })
})
