import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { appendLines, emptyLogBuffer, finishedText, stampText } from '../../../../../core/kube/cluster/logs'
import { KUBECTL_MISSING } from '../../../../../core/kube/cluster/types'
import type { KubeLogStream, LogState } from '../../../hooks/useKubeLogStream'

vi.mock('../../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

/** What the stubbed hook answers: a static render runs no effect, so the stream is handed in as it would stand. */
const stub = vi.hoisted(() => ({ stream: null as KubeLogStream | null }))
vi.mock('../../../hooks/useKubeLogStream', () => ({ useKubeLogStream: () => stub.stream }))

import { KubeLogView, lineWindow } from './KubeLogView'

const pod = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'worker-1', namespace: 'api' },
  spec: { initContainers: [{ name: 'migrate' }], containers: [{ name: 'worker' }, { name: 'sidecar' }] },
  status: {
    containerStatuses: [
      {
        name: 'worker',
        state: { waiting: { reason: 'CrashLoopBackOff' } },
        lastState: { terminated: { exitCode: 1, finishedAt: '2026-11-20T01:12:11Z' } }
      }
    ]
  }
}
const target = { context: 'kind-dev', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'worker-1' }

const streamOf = (lines: string[], state: LogState = 'streaming', max?: number): KubeLogStream => ({
  buffer: appendLines(emptyLogBuffer(), lines, max),
  state,
  restart: () => {},
  clear: () => {}
})
const render = (stream: KubeLogStream, initial: { container: string; previous: boolean; filter?: string } = { container: 'worker', previous: false }): string => {
  stub.stream = stream
  return renderToStaticMarkup(React.createElement(KubeLogView, { pod, target, initial, visible: true }))
}

const button = (html: string, label: string): string => {
  const m = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html)
  if (!m) throw new Error(`no button ${label}`)
  return m[0]
}

// Spec 4.8 and board E: the toolbar, then the lines; the stream itself is the hook's (Task 4).
describe('KubeLogView', () => {
  it('renders the toolbar controls', () => {
    const html = render(streamOf(['2026-11-20T01:12:03.114539874Z worker starting']))
    const select = /<select[^>]*aria-label="kube.logs.container"[^>]*>(.*?)<\/select>/.exec(html)
    expect(select).not.toBeNull()
    const options = [...(select?.[1] ?? '').matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1])
    expect(options).toEqual(['kube.logs.initContainer{&quot;name&quot;:&quot;migrate&quot;}', 'worker', 'sidecar'])
    expect(select?.[1]).toContain('<option value="worker" selected="">')

    for (const k of ['previous', 'follow', 'timestamps', 'wrap', 'save', 'clear']) expect(button(html, `kube.logs.${k}`)).toContain('title="')
    expect(html).toMatch(/<input[^>]*aria-label="kube.logs.filter"/)
    // Time stamps on and wrap off by default; the context and namespace the lines come from.
    expect(button(html, 'kube.logs.timestamps')).toContain('aria-pressed="true"')
    expect(button(html, 'kube.logs.wrap')).toContain('aria-pressed="false"')
    expect(html).toContain('kind-dev / api')
    expect(html).toContain(stampText('2026-11-20T01:12:03.114539874Z'))
    expect(html).toContain('worker starting')
  })

  // Task 5 review (ruled in): a labelled toolbar, the picker's word on screen as on board E, and live regions kept
  // quiet: a busy container would have a screen reader read out every line.
  it('labels the toolbar and the picker, and keeps the lines out of live announcements', () => {
    const html = render(streamOf(['a', 'b', 'c'], 'streaming', 2))
    expect(html).toMatch(/<div[^>]*role="toolbar"[^>]*aria-label="kube.logs.toolbar"/)
    expect(html).toMatch(/<label class="kube-pill kube-logs-picker"><span class="kube-logs-lab">kube.logs.container<\/span><select/)
    expect(html).toMatch(/<div[^>]*role="log"[^>]*aria-live="off"/)
    expect(html).toMatch(/<div class="kube-logs-dropped"[^>]*aria-live="off"/)
  })

  // Review focus 2: the filter matches what shows, not the colour codes, and the colours stay.
  it('hides lines that do not match the filter', () => {
    const lines = ['\u001b[31mERROR\u001b[0m could not connect', 'INFO ok', 'debug 31m']
    const html = render(streamOf(lines), { container: 'worker', previous: false, filter: 'error' })
    expect(html).toContain('could not connect')
    expect(html).toContain('color:var(--ansi-red)')
    expect(html).not.toContain('INFO ok')
    expect(html).not.toContain('debug 31m')
    const codes = render(streamOf(lines), { container: 'worker', previous: false, filter: '31m' })
    expect(codes).toContain('debug 31m')
    expect(codes).not.toContain('could not connect')
  })

  it('shows the dropped notice', () => {
    expect(render(streamOf(['a', 'b', 'c'], 'streaming', 2))).toContain('kube.logs.dropped{&quot;count&quot;:1}')
    expect(render(streamOf(['a', 'b', 'c']))).not.toContain('kube.logs.dropped')
  })

  it('shows the closing line with the exit code', () => {
    const html = render(streamOf(['boom'], 'ended'), { container: 'worker', previous: true })
    expect(html).toContain('kube.logs.ended{&quot;code&quot;:1}')
    expect(html).toContain(finishedText('2026-11-20T01:12:11Z', new Date()))
    expect(html).toContain('kube.logs.previousContainer')
    // The running container has not exited: the stream ended, with no code to give.
    const unknown = render(streamOf(['ok'], 'ended'), { container: 'worker', previous: false })
    expect(unknown).toContain('kube.logs.streamEnded')
    expect(unknown).not.toContain('kube.logs.ended')
    expect(unknown).not.toContain('kube.logs.previousContainer')
    expect(render(streamOf(['ok']))).not.toMatch(/kube\.logs\.(ended|streamEnded)/)
  })

  it('shows an error line', () => {
    const html = render(streamOf([], { error: 'previous terminated container worker in pod worker-1 not found' }))
    expect(html).toContain('previous terminated container worker in pod worker-1 not found')
    expect(render(streamOf([], { error: KUBECTL_MISSING }))).toContain('kube.cluster.kubectlMissing')
  })

  it('disables follow while previous is on', () => {
    const on = button(render(streamOf([]), { container: 'worker', previous: true }), 'kube.logs.follow')
    expect(on).toContain('disabled=""')
    expect(on).toContain('aria-pressed="false"')
    const off = button(render(streamOf([]), { container: 'worker', previous: false }), 'kube.logs.follow')
    expect(off).not.toContain('disabled')
    expect(off).toContain('aria-pressed="true"')
    expect(button(render(streamOf([]), { container: 'worker', previous: true }), 'kube.logs.previous')).toContain('aria-pressed="true"')
  })
})

// The lines drawn: 400px shows 20 lines, plus 10 on each side.
describe('lineWindow', () => {
  it('draws the end while the view keeps to the bottom, else the lines around the scroll position', () => {
    expect(lineWindow(1000, 0, 400, true)).toEqual({ first: 960, last: 1000 })
    expect(lineWindow(1000, 0, 400, false)).toEqual({ first: 0, last: 40 })
    expect(lineWindow(1000, 500 * 20, 400, false)).toEqual({ first: 490, last: 530 })
    expect(lineWindow(5, 0, 400, true)).toEqual({ first: 0, last: 5 })
  })

  // Wrapped lines are taller than 20px, so just above the bottom the scroll position counts past the last line; the
  // window must stay the end's, or the list shrinks and the box throws the person back to the bottom.
  it('keeps the end window where wrapped lines put the scroll position past the count', () => {
    expect(lineWindow(1000, 1500 * 20, 400, false)).toEqual({ first: 960, last: 1000 })
    expect(lineWindow(1000, 975 * 20, 400, false)).toEqual({ first: 960, last: 1000 })
  })

  // Task 5 review I4b: scrolled up in wrap mode, the end window must not follow the lines that keep coming in below, or
  // each new line takes a wrapped line off the top of the view. It holds the end it had when the person scrolled up.
  it('holds the end window the person scrolled up from', () => {
    expect(lineWindow(1010, 1500 * 20, 400, false, 960)).toEqual({ first: 960, last: 1000 })
    expect(lineWindow(1010, 500 * 20, 400, false, 960)).toEqual({ first: 490, last: 530 })
  })
})
