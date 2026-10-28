// Sandbox follow-ups, item 2: the remote sessions dialog's list shows whether each session on the Runtime runs in its
// CLI's sandbox, and how, the way a session tab's marker does (WorkbenchTabs.tsx): the same icon, titled with the same
// words, and none for a session outside the sandbox.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RemoteSessionList } from './RemoteSessionsDialog'
import { WorkbenchTabs, type WorkbenchTab } from './WorkbenchTabs'
import type { RemoteSessionRow } from '../lib/remoteSessions'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string) => key, tm: (m: unknown) => String(m) })
}))

const row = (over: Partial<RemoteSessionRow> = {}): RemoteSessionRow => ({
  id: 's1',
  kind: 'terminal',
  title: 'Worker',
  accountId: 'a1',
  cwd: '/w',
  alive: true,
  state: 'running',
  provider: 'codex',
  ...over
})

const list = (rows: RemoteSessionRow[]): string =>
  renderToStaticMarkup(React.createElement(RemoteSessionList, { rows, runtimeId: 'rt_1', onOpen: () => {} }))

/** The marker a session tab draws for this kind, cut out of the tab bar's markup. */
const tabMarker = (sandboxKind: 'sandbox' | 'deny-only'): string => {
  const tab: WorkbenchTab = { tabId: 'session:s1', kind: 'session', sessionId: 's1', title: 'Worker', color: '#888', busy: false, exited: false, rollTooltip: null, profileTooltip: null, sandboxKind }
  const html = renderToStaticMarkup(
    React.createElement(WorkbenchTabs, {
      tabs: [tab],
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
  const m = /<span class="tab-sandbox[^"]*" title="[^"]*">.*?<\/svg><\/span>/.exec(html)
  if (!m) throw new Error(`no marker in the tab bar: ${html}`)
  return m[0]
}

describe('the sandbox on the remote sessions screen', () => {
  it('marks a session in its CLI’s sandbox as its tab does', () => {
    const html = list([row({ sandboxed: true, sandboxKind: 'sandbox' })])
    expect(html).toContain('<span class="tab-sandbox" title="session.tab.sandboxed"><svg')
    expect(html).toContain(tabMarker('sandbox'))
  })

  it('marks a deny-rules-only session as its tab does, not as one in the sandbox', () => {
    const html = list([row({ sandboxed: true, sandboxKind: 'deny-only' })])
    expect(html).toContain('<span class="tab-sandbox is-deny-only" title="session.tab.denyOnly"><svg')
    expect(html).toContain(tabMarker('deny-only'))
    expect(html).not.toContain('session.tab.sandboxed')
  })

  it('marks nothing for a session outside the sandbox, or a kind not said to be sandboxed', () => {
    expect(list([row()])).not.toContain('tab-sandbox')
    expect(list([row({ sandboxKind: 'sandbox' })])).not.toContain('tab-sandbox')
  })

  it('keeps each row’s name and meta, one button per live session', () => {
    const html = list([row({ id: 'a', title: 'One', sandboxed: true, sandboxKind: 'sandbox' }), row({ id: 'b', title: null })])
    expect(html).toContain('<span class="remote-session-name">One</span>')
    expect(html).toContain('<span class="remote-session-name">b</span>')
    expect(html).toContain('session.kind.terminal · codex · /w')
    expect(html.match(/<button/g)).toHaveLength(2)
  })
})
