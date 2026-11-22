import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TerminalBuffer } from '../../../core/types'
import type { KubeLogEntry } from '../hooks/useKubeOps'
import type { KubeLogTab } from '../lib/kubeLogTabs'
import type { KubeShellTab } from '../lib/kubeShellTabs'
import { BottomPanel, holdHost } from './BottomPanel'

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

const logTab = (id: string, name: string): KubeLogTab => ({
  id,
  ref: { context: 'kind-dev', namespace: 'api', resource: 'pods', kind: 'Pod', name },
  container: 'worker',
  previous: false,
  request: 0
})

const shellTab = (id: string, name: string, container = 'worker'): KubeShellTab => ({
  id,
  ref: { context: 'kind-dev', namespace: 'api', resource: 'pods', kind: 'Pod', name },
  container,
  ended: false,
  clear: 0,
  find: 0
})

const render = ({
  kubeLog = [] as KubeLogEntry[],
  activeTab = 'kube',
  kubeAvailable = true,
  kubeSegment = 'cluster' as 'cluster' | 'log',
  logTabs = [] as KubeLogTab[],
  shellTabs = [] as KubeShellTab[],
  terminals = [] as TerminalBuffer[]
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
      terminals,
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
      kubeCluster: (switcher: React.ReactNode) => React.createElement('div', { className: 'cluster-marker' }, switcher),
      logTabs,
      onCloseLogTab: noop,
      // A static render attaches no refs: the host only has to be there.
      logHost: (id: string) => ({ id }) as unknown as HTMLElement,
      shellTabs,
      onCloseShellTab: noop,
      shellHost: (id: string) => ({ id }) as unknown as HTMLElement,
      onShellAction: noop
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

// Spec 4.8 (board E): a Pod's logs are a bottom tab of their own, "Logs <pod>", closed with a ✕ as a terminal is.
describe('BottomPanel log tabs', () => {
  const tabs = [logTab('kubelog:1', 'worker-1'), logTab('kubelog:2', 'web-2')]
  const tabTags = (html: string): string[] => [...html.matchAll(/<span role="tab"[^>]*>.*?<\/span>(?=<span role="tab"|<button class="bottom-tab-new")/g)].map((m) => m[0])

  it('draws a log tab with its label and a close button, after the Kubernetes tab', () => {
    const html = render({ logTabs: tabs })
    const strip = tabTags(html)
    expect(strip).toHaveLength(3)
    expect(strip[0]).toContain('kube.log.tab')
    expect(strip[1]).toContain('kube.logs.tab{&quot;pod&quot;:&quot;worker-1&quot;}')
    expect(strip[1]).toMatch(/<button class="bottom-tab-close" aria-label="kube\.logs\.closeTab" title="kube\.logs\.closeTab">/)
    expect(strip[2]).toContain('kube.logs.tab{&quot;pod&quot;:&quot;web-2&quot;}')
  })

  // Task 6 review minor: two tabs of one Pod read the same; the tooltip tells where each reads from.
  it('says the context, namespace and container in the tab\'s tooltip', () => {
    const strip = tabTags(render({ logTabs: tabs }))
    expect(strip[1]).toMatch(/^<span role="tab"[^>]* title="kind-dev \/ api · kube\.logs\.container worker"/)
  })

  it('names the container in the titles of two tabs of one Pod', () => {
    const strip = tabTags(render({ logTabs: [tabs[0], { ...logTab('kubelog:3', 'worker-1'), container: 'sidecar' }, tabs[1]] }))
    expect(strip[1]).toContain('kube.logs.tabContainer{&quot;pod&quot;:&quot;worker-1&quot;,&quot;container&quot;:&quot;worker&quot;}')
    expect(strip[2]).toContain('kube.logs.tabContainer{&quot;pod&quot;:&quot;worker-1&quot;,&quot;container&quot;:&quot;sidecar&quot;}')
    expect(strip[3]).toContain('kube.logs.tab{&quot;pod&quot;:&quot;web-2&quot;}')
  })

  it('draws the log tabs before the terminals', () => {
    const html = render({ logTabs: tabs.slice(0, 1), terminals: [{ id: 't1', buffer: '' }] })
    expect(html.indexOf('kube.logs.tab')).toBeGreaterThan(html.indexOf('kube.log.tab'))
    expect(html.indexOf('kube.logs.tab')).toBeLessThan(html.indexOf('terminal.tab.label'))
  })

  // Task 6 review I1: the views live in App, each in an element of its own, so collapsing the panel does not stop them;
  // the body is only where that element is held, and draws nothing itself.
  it('draws a body for every log tab, hidden unless its tab is the one shown, holding nothing of its own', () => {
    const html = render({ logTabs: tabs, activeTab: 'kubelog:2' })
    expect(html.match(/<div class="bottom-body" style="display:none"><\/div>/g)).toHaveLength(1)
    expect(html.match(/<div class="bottom-body" style="display:flex"><\/div>/g)).toHaveLength(1)
    expect(tabTags(html)[2]).toContain('aria-selected="true"')
    expect(html).toContain('kube-body" style="display:none"')
  })

  // The header's clear empties a terminal's xterm; the log view has its own clear in its toolbar.
  it('offers no terminal clear in the header while a log tab shows', () => {
    expect(render({ logTabs: tabs, activeTab: 'kubelog:1' })).not.toContain('run.panel.clear')
  })
})

// Spec 4.8: a shell into a container is a bottom tab of its own, after the logs tabs.
describe('BottomPanel shell tabs', () => {
  const tabTags = (html: string): string[] => [...html.matchAll(/<span role="tab"[^>]*>.*?<\/span>(?=<span role="tab"|<button class="bottom-tab-new")/g)].map((m) => m[0])

  it("draws a shell tab with its Pod's name", () => {
    const strip = tabTags(render({ logTabs: [logTab('kubelog:1', 'web-2')], shellTabs: [shellTab('kubeshell:1', 'worker-1')] }))
    expect(strip).toHaveLength(3)
    expect(strip[2]).toContain('kube.shell.tab{&quot;pod&quot;:&quot;worker-1&quot;}')
    expect(strip[2]).toMatch(/^<span role="tab"[^>]* title="kind-dev \/ api · kube\.logs\.container worker"/)
    expect(strip[2]).toMatch(/<button class="bottom-tab-close" aria-label="kube\.shell\.closeTab" title="kube\.shell\.closeTab">/)
  })

  it('names the container when two shells show one Pod', () => {
    const strip = tabTags(render({ shellTabs: [shellTab('kubeshell:1', 'worker-1'), shellTab('kubeshell:2', 'worker-1', 'sidecar')] }))
    expect(strip[1]).toContain('kube.shell.tabContainer{&quot;pod&quot;:&quot;worker-1&quot;,&quot;container&quot;:&quot;worker&quot;}')
    expect(strip[2]).toContain('kube.shell.tabContainer{&quot;pod&quot;:&quot;worker-1&quot;,&quot;container&quot;:&quot;sidecar&quot;}')
  })

  it('offers find and clear for the shown shell tab', () => {
    const shown = render({ shellTabs: [shellTab('kubeshell:1', 'worker-1')], activeTab: 'kubeshell:1' })
    expect(shown).toContain('aria-label="kube.shell.find"')
    expect(shown).toContain('aria-label="run.panel.clear"')
    const other = render({ shellTabs: [shellTab('kubeshell:1', 'worker-1')], activeTab: 'kube' })
    expect(other).not.toContain('kube.shell.find')
    expect(other).not.toContain('run.panel.clear')
  })

  it('draws a body for each shell tab after the logs bodies', () => {
    const html = render({ shellTabs: [shellTab('kubeshell:1', 'worker-1')], activeTab: 'kubeshell:1' })
    expect(html.match(/<div class="bottom-body" style="display:flex"><\/div>/g)).toHaveLength(1)
  })
})

describe('holdHost', () => {
  type FakeNode = { parentNode: unknown; appendChild?: (n: FakeNode) => void; removeChild?: (n: FakeNode) => void }
  const body = (moved: FakeNode[]): FakeNode => {
    const self: FakeNode = {
      parentNode: null,
      appendChild: (n) => {
        moved.push(n)
        n.parentNode = self
      }
    }
    return self
  }

  // Moving an element out and back resets its scroll position: a body drawn again keeps the view where it is.
  it('moves the view\'s element into the body only when it is not there yet', () => {
    const moved: FakeNode[] = []
    const host: FakeNode = { parentNode: null }
    const first = body(moved)
    holdHost(first as unknown as Node, host as unknown as Node)
    holdHost(first as unknown as Node, host as unknown as Node)
    expect(moved).toEqual([host])
    // The panel opened again: a new body takes the element over.
    const next = body(moved)
    holdHost(next as unknown as Node, host as unknown as Node)
    expect(moved).toHaveLength(2)
    expect(host.parentNode).toBe(next)
  })
  // Task 6 re-review: left in a body the collapse removed, the element would keep that whole panel's DOM in memory
  // until the panel opened again.
  it('takes the view\'s element out of a body that goes away', () => {
    const moved: FakeNode[] = []
    const host: FakeNode = { parentNode: null }
    const gone = body(moved)
    gone.removeChild = (n) => {
      n.parentNode = null
    }
    holdHost(gone as unknown as Node, host as unknown as Node)
    expect(host.parentNode).toBe(gone)
    holdHost(null, host as unknown as Node)
    expect(host.parentNode).toBeNull()
    holdHost(null, host as unknown as Node)
    expect(host.parentNode).toBeNull()
  })
})

// The screen check: a shell tab's view drew 27 px wide because its host element had no rule, so the container's tty
// was 2 columns. Every element App makes to hold a tab's view must fill the panel body the way the logs host does.
describe('hosted tab bodies', () => {
  it('gives every host element App creates a rule that fills the body', () => {
    const app = readFileSync(path.join(__dirname, '..', 'App.tsx'), 'utf8')
    const css = readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8')
    const names = [...app.matchAll(/host\.className = '([^']+)'/g)].map((m) => m[1])
    expect(names).toEqual(expect.arrayContaining(['kube-logs-host', 'kube-shell-host']))
    for (const name of names) {
      const rule = new RegExp(String.raw`^\.${name}\s*\{([^}]*)\}`, 'm').exec(css)
      expect(rule, `${name} has no rule in styles.css`).not.toBeNull()
      expect(rule?.[1], `${name} does not fill`).toMatch(/flex:\s*1\b/)
    }
  })
})
