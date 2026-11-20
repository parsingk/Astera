import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkbenchTabs } from './WorkbenchTabs'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const noop = (): void => {}

// Kube cluster view spec 4.6, board B: a cluster object's tab is named by kind and name, with its context dimmed after.
describe('WorkbenchTabs kube tab', () => {
  it('draws the Kubernetes glyph, the kind and name, and the context dimmed', () => {
    const context = 'arn:aws:eks:ap-northeast-2:1:cluster/live'
    const html = renderToStaticMarkup(
      React.createElement(WorkbenchTabs, {
        tabs: [{ tabId: 'kube:x', kind: 'kube', title: 'Pod w-1', context }],
        activeTabId: 'kube:x',
        focused: true,
        onSelect: noop,
        onClose: noop,
        onNew: noop,
        onContextMenu: noop,
        onDragTabChange: noop,
        draggingTabId: null,
        onDropTabInBar: noop,
        renamingTabId: null,
        onRenameStart: noop,
        onRenameEnd: noop,
        activeSession: null
      })
    )
    expect(html).toContain('M8 1.4 13.2 3.9') // the Kubernetes heptagon (FileIcon)
    expect(html).toContain('<span class="tab-title">Pod w-1</span><span class="tab-hint">live</span>')
    expect(html).toContain(context) // the whole context in the tooltip
  })
})
