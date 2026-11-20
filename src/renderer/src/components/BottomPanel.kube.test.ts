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

const render = ({
  kubeLog = [] as KubeLogEntry[],
  activeTab = 'kube',
  kubeAvailable = true,
  kubeSegment = 'cluster' as 'cluster' | 'log'
} = {}): string =>
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
      onKubeClear: noop,
      kubeAvailable,
      kubeSegment,
      onKubeSegment: noop,
      kubeCluster: (switcher: React.ReactNode) => React.createElement('div', { className: 'cluster-marker' }, switcher)
    })
  )

describe('BottomPanel Kubernetes tab', () => {
  it('has no Kubernetes tab while kubectl is missing and the log is empty', () => {
    const html = render({ kubeAvailable: false })
    expect(html).not.toContain('kube.log.tab')
    expect(html).not.toContain('kube-log')
    expect(html).not.toContain('cluster-marker')
  })

  // Spec 4.1: the tab is there whenever kubectl is found, not only after the first operation (replaces M-C18).
  it('draws the Kubernetes tab with an empty log when kubectl is found', () => {
    const html = render({ kubeLog: [], kubeSegment: 'cluster' })
    expect(html).toContain('kube.log.tab')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('cluster-marker')
  })

  // Spec 4.2: one row, the switch first; the Cluster segment's body places it at the head of its toolbar.
  it('hands the switch to the Cluster segment to lead its toolbar', () => {
    expect(render({ kubeSegment: 'cluster' })).toContain('<div class="cluster-marker"><div class="kube-segment-switch" role="radiogroup"')
  })

  it('heads the log with the switch in the same place, a row above it', () => {
    expect(render({ kubeLog: [entry()], kubeSegment: 'log' })).toMatch(
      /<div class="kube-segment-bar"><div class="kube-segment-switch" role="radiogroup"[^>]*>.*?<\/div><\/div><div class="kube-log">/
    )
  })

  // Task 13 minor: the switch sat in the bottom panel's own tablist as a nested tablist. It is a radio group: the
  // segment shown is checked and is the one tab stop of each copy of the switch (one per segment body).
  it('draws the switch as a radio group, the shown segment checked', () => {
    const html = render({ kubeSegment: 'log', kubeLog: [entry()] })
    expect(html).not.toContain('role="tablist"><button')
    expect(html).toContain('role="radiogroup" aria-label="kube.log.tab"')
    const radios = [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((m) => m[0])
    expect(radios).toHaveLength(4)
    expect(radios.filter((r) => r.includes('aria-checked="true"') && r.includes('tabindex="0"') && r.includes('data-segment="log"'))).toHaveLength(2)
    expect(radios.filter((r) => r.includes('aria-checked="false"') && r.includes('tabindex="-1"') && r.includes('data-segment="cluster"'))).toHaveLength(2)
  })

  it('shows the operation log in its segment', () => {
    const html = render({ kubeLog: [], kubeSegment: 'log' })
    expect(html).toContain('kube.cluster.noOperations')
  })

  it('shows the log panel once there is an entry', () => {
    const html = render({ kubeLog: [entry()], kubeSegment: 'log' })
    expect(html).toContain('kube.log.tab')
    expect(html).toContain('class="kube-log"')
    expect(html).not.toContain('kube.cluster.noOperations')
    expect(html).not.toContain('bottom-tab-badge')
  })

  it('counts the operations on the switch only when there are some', () => {
    const count = /kube\.cluster\.segment\.log<span class="kube-segment-count">(\d+)<\/span>/
    expect(render({ kubeLog: [] })).toContain('kube.cluster.segment.log')
    expect(render({ kubeLog: [] })).not.toMatch(count)
    expect(render({ kubeLog: [entry(), entry({ id: 'e2' })] }).match(count)?.[1]).toBe('2')
  })

  it('counts the entries that failed on the tab', () => {
    const failed = entry({
      id: 'f',
      result: { id: 'f', verb: 'apply', context: 'c', commandLines: [], ran: 1, outcomes: [], ok: false, stderr: 'x', startedAt: 1, finishedAt: 2 }
    })
    const html = render({ kubeLog: [failed, entry()] })
    expect(html).toContain('bottom-tab-badge')
    expect(html).toContain('kube.log.tabFailures{&quot;count&quot;:1}')
  })

  it('keeps the panel mounted but hidden when another tab is active', () => {
    expect(render({ kubeLog: [entry()], activeTab: 'other' })).toContain('kube-body" style="display:none"')
  })
})
