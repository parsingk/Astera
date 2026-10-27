// Sandbox design §6: the tab of a session that runs in its CLI's sandbox (SessionInfo.sandboxed) shows a small marker,
// titled so a hover says what it means; every other tab draws as before.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { t as translate, LANGS } from '../../../core/i18n'
import { WorkbenchTabs, type WorkbenchTab } from './WorkbenchTabs'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string) => key, tm: (m: unknown) => String(m) })
}))

const here = path.dirname(fileURLToPath(import.meta.url))

const session = (over: Partial<Extract<WorkbenchTab, { kind: 'session' }>> = {}): WorkbenchTab => ({
  tabId: 'session:s1',
  kind: 'session',
  sessionId: 's1',
  title: 'Worker',
  color: '#888',
  busy: false,
  exited: false,
  rollTooltip: null,
  profileTooltip: null,
  ...over
})

const render = (tabs: WorkbenchTab[]): string =>
  renderToStaticMarkup(
    React.createElement(WorkbenchTabs, {
      tabs,
      activeTabId: null,
      focused: false,
      onSelect: () => {},
      onClose: () => {},
      onNew: () => {},
      onContextMenu: () => {},
      onDragTabChange: () => {},
      draggingTabId: null,
      onDropTabInBar: () => {},
      renamingTabId: null,
      onRenameStart: () => {},
      onRenameEnd: () => {},
      activeSession: null
    })
  )

describe('the sandbox marker on a session tab', () => {
  it('marks a sandboxed session’s tab, titled by session.tab.sandboxed', () => {
    const html = render([session({ sandboxKind: 'sandbox' })])
    // Drawn like the rolling marker: a small icon, titled
    expect(html).toMatch(/<span class="tab-sandbox" title="session\.tab\.sandboxed"><svg/)
  })

  // Task 8 fix round 1: Claude Code on Windows has deny rules only, and its tab says that, not "in the sandbox"
  it('titles a deny-rules-only session’s marker by session.tab.denyOnly', () => {
    const html = render([session({ sandboxKind: 'deny-only' })])
    expect(html).toMatch(/<span class="tab-sandbox is-deny-only" title="session\.tab\.denyOnly"><svg/)
    expect(html).not.toContain('session.tab.sandboxed')
  })

  it('draws no marker on any other tab', () => {
    expect(render([session()])).not.toContain('tab-sandbox')
    expect(render([session({ sandboxKind: undefined })])).not.toContain('tab-sandbox')
  })

  it('says what it means in every language', () => {
    const words = { ko: 'Sandbox 안에서 실행 중', en: 'Running in the sandbox', ja: 'サンドボックスで実行中', es: 'Ejecutándose en el sandbox' }
    for (const lang of LANGS) expect(translate(lang, 'session.tab.sandboxed'), lang).toBe(words[lang])
    const denyOnly = {
      ko: 'Sandbox 없음: 파일 도구만 로그인 정보 폴더를 읽지 못합니다 (셸은 제한 없음)',
      en: 'No sandbox: only the file tools cannot read the login folders (the shell is not restricted)',
      ja: 'サンドボックスなし: ファイルツールだけがログイン情報のフォルダーを読めません（シェルは制限なし）',
      es: 'Sin sandbox: solo las herramientas de archivos no pueden leer las carpetas de inicio de sesión (el shell no tiene límites)'
    }
    for (const lang of LANGS) expect(translate(lang, 'session.tab.denyOnly'), lang).toBe(denyOnly[lang])
  })

  // The kind comes from the session (its manager knows the OS and the CLI), never from the renderer's own platform
  it('the pane grid hands the session’s own kind to its tab', () => {
    const grid = readFileSync(path.join(here, 'PaneGrid.tsx'), 'utf8')
    expect(grid).toContain("sandboxKind: s.sandboxed === true ? s.sandboxKind : undefined")
    const tabs = readFileSync(path.join(here, 'WorkbenchTabs.tsx'), 'utf8')
    expect(tabs).not.toContain('window.api.platform')
  })
})
