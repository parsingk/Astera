import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { KubeLogEntry } from '../hooks/useKubeOps'
import { BottomPanel } from './BottomPanel'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const noop = (): void => {}
const entry = (over: Partial<KubeLogEntry> = {}): KubeLogEntry => ({
  id: 'e1',
  verb: 'apply',
  context: 'kind-dev',
  scope: '1 file',
  commandLines: [],
  startedAt: 0,
  state: 'done',
  req: { selection: [], projectRoot: '/p', context: 'kind-dev', pill: null },
  namespaceLabel: 'dev',
  ...over
})

const render = (kubeLog: KubeLogEntry[], activeTab = 'kube'): string =>
  renderToStaticMarkup(
    React.createElement(BottomPanel, {
      runAvailable: false,
      runs: [],
      configIds: [],
      selectedRunId: null,
      onSelectRun: noop,
      onStopRun: noop,
      onRerun: noop,
      onDismissRun: noop,
      onOpenFile: noop,
      onOpenUrl: noop,
      onOpenPreview: noop,
      terminals: [],
      terminalCwd: null,
      activeTab,
      onSelectTab: noop,
      onNewTerminal: noop,
      onCloseTerminal: noop,
      onCollapse: noop,
      kubeLog,
      onKubeRerun: noop,
      onKubeCancel: noop,
      onKubeClear: noop
    })
  )

describe('BottomPanel Kubernetes tab', () => {
  it('has no Kubernetes tab while the log is empty (C18)', () => {
    const html = render([])
    expect(html).not.toContain('kube.log.tab')
    expect(html).not.toContain('kube-log')
  })

  it('shows the tab and its panel once there is an entry', () => {
    const html = render([entry()])
    expect(html).toContain('kube.log.tab')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('class="kube-log"')
    expect(html).not.toContain('bottom-tab-badge')
  })

  it('counts the entries that failed on the tab', () => {
    const failed = entry({
      id: 'f',
      result: { id: 'f', verb: 'apply', context: 'c', commandLines: [], ran: 1, outcomes: [], ok: false, stderr: 'x', startedAt: 1, finishedAt: 2 }
    })
    const html = render([failed, entry()])
    expect(html).toContain('bottom-tab-badge')
    expect(html).toContain('kube.log.tabFailures{&quot;count&quot;:1}')
  })

  it('keeps the panel mounted but hidden when another tab is active', () => {
    expect(render([entry()], 'other')).toContain('kube-body" style="display:none"')
  })
})
