import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { KubeRunResult } from '../../../../core/kube/types'
import type { KubeLogEntry } from '../../hooks/useKubeOps'
import { KubeLogPanel } from './KubeLogPanel'

vi.mock('../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const noop = (): void => {}
const REQ = { selection: ['/p/a.yaml'], projectRoot: '/p', context: 'kind-dev', pill: 'dev' }
const CHECK = String.fromCharCode(0x2713)

const result = (over: Partial<KubeRunResult> = {}): KubeRunResult => ({
  id: 'r',
  verb: 'apply',
  context: 'kind-dev',
  commandLines: [['--context', 'kind-dev', 'apply', '-f', '/p/a.yaml']],
  ran: 1,
  outcomes: [],
  ok: true,
  stderr: '',
  startedAt: 1,
  finishedAt: 2,
  ...over
})

const entry = (over: Partial<KubeLogEntry> = {}): KubeLogEntry => ({
  id: 'e1',
  verb: 'apply',
  context: 'kind-dev',
  scope: '1 file',
  commandLines: [['--context', 'kind-dev', 'apply', '-f', '/p/a.yaml']],
  startedAt: 0,
  state: 'done',
  req: REQ,
  namespaceLabel: 'dev',
  ...over
})

const render = (log: KubeLogEntry[]): string =>
  renderToStaticMarkup(
    React.createElement(KubeLogPanel, { log, onRerun: noop, onCancel: noop, onCopy: noop, onClear: noop, onOpenFile: noop })
  )

describe('KubeLogPanel', () => {
  it('shows the commands, one line per outcome and an error with its file as a link button', () => {
    const html = render([
      entry({
        result: result({
          ok: false,
          outcomes: [
            { ref: 'deployment/web', outcome: 'configured' },
            { ref: '', outcome: 'error', file: '/p/b.yaml', message: 'invalid yaml' }
          ]
        })
      })
    ])
    expect(html).toContain('$ kubectl --context kind-dev apply -f /p/a.yaml')
    expect(html).toContain(`${CHECK} deployment/web configured`)
    expect(html).toContain('class="kube-log-file"')
    expect(html).toContain('/p/b.yaml')
    expect(html).toContain('invalid yaml')
    expect(html).toContain('kube.log.failed{&quot;count&quot;:1}')
  })

  it('shows stderr only when no outcome explains the failure', () => {
    const bare = render([entry({ result: result({ ok: false, stderr: 'connection refused' }) })])
    expect(bare).toContain('connection refused')
    const explained = render([
      entry({
        result: result({ ok: false, stderr: 'connection refused', outcomes: [{ ref: '', outcome: 'error', message: 'boom' }] })
      })
    ])
    expect(explained).not.toContain('connection refused')
  })

  it('a cancelled run shows its badge', () => {
    expect(render([entry({ result: result({ ok: false, cancelled: true }) })])).toContain('kube.log.cancelled')
  })

  it('a timed-out result renders as finished with the timeout badge, not running', () => {
    const html = render([entry({ result: result({ ok: false, timedOut: true }) })])
    expect(html).toContain('kube.log.timedOut')
    expect(html).not.toContain('loading-spinner')
  })

  it('a running entry shows a spinner and the cancel button; a finished one has no cancel', () => {
    const running = render([entry({ state: 'running' })])
    expect(running).toContain('loading-spinner')
    expect(running).toContain('aria-label="kube.log.cancel"')
    expect(render([entry({ result: result() })])).not.toContain('aria-label="kube.log.cancel"')
  })

  it('a refusal says why nothing was written', () => {
    const html = render([entry({ result: result({ ok: false, ran: 0, refused: { reason: 'changed' } }) })])
    expect(html).toContain('kube.log.refused')
    expect(html).toContain('kube.log.refusedChanged')
    const mixed = render([
      entry({ result: result({ ok: false, ran: 0, refused: { ok: false, reason: 'mixed-contexts', folders: ['/p'] } }) })
    ])
    expect(mixed).toContain('kube.confirm.mixedContexts')
  })

  it('lists newest first and opens only the newest finished entry', () => {
    const html = render([
      entry({ id: 'new', state: 'running', scope: 'S-running' }),
      entry({ id: 'mid', scope: 'S-mid', result: result({ outcomes: [{ ref: 'a/b', outcome: 'created' }] }) }),
      entry({ id: 'old', scope: 'S-old', result: result({ outcomes: [{ ref: 'c/d', outcome: 'created' }] }) })
    ])
    expect(html.indexOf('S-running')).toBeLessThan(html.indexOf('S-mid'))
    expect(html.indexOf('S-mid')).toBeLessThan(html.indexOf('S-old'))
    expect(html).toContain('a/b created')
    expect(html).not.toContain('c/d created')
  })

  it('every rail button is an icon with title equal to aria-label', () => {
    const html = render([entry({ result: result() })])
    for (const k of ['rerun', 'copy', 'clear']) expect(html).toContain(`title="kube.log.${k}" aria-label="kube.log.${k}"`)
  })
})
