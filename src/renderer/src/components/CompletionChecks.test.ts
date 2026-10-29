// The completion block's check list (plugin Phase 5 C13): a plugin check's summary, its findings as file:line message and
// a link to its report; a check that could not be made apart, with its reason; a skipped one in this app's words.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CATALOGS, LANGS } from '../../../core/i18n'
import type { CompletionCheckDetail } from '../../../core/types'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string, p?: Record<string, unknown>) => (p ? `${key} ${JSON.stringify(p)}` : key) })
}))
const { CompletionChecks } = await import('./CompletionChecks')

const render = (checks: CompletionCheckDetail[], tails: string[] = []): string =>
  renderToStaticMarkup(React.createElement(CompletionChecks, { checks, tails: new Set(tails), onToggleTail: () => {}, onOpenLink: () => {} }))

describe('CompletionChecks', () => {
  // Task K (the person's Q1): beside its verdict, where the Task shows its check result
  it('says beside its verdict that a check ran outside the sandbox, and nothing for one that did not', () => {
    const html = render([
      { configId: 'c1', name: 'Tests', status: 'passed', outsideSandbox: true },
      { configId: 'c2', name: 'Lint', status: 'passed' }
    ])
    expect(html).toContain('jobs.convergence.check.passed · jobs.checks.outsideSandbox')
    expect(html.match(/jobs\.checks\.outsideSandbox/g)).toHaveLength(1)
  })

  // Task K fix round 2: which variables the Credentials list kept from the check, by name, so a failure for a hidden token
  // reads as that
  // Fix round 3 (N3): only under a check that did not pass, where it can explain the result; a passing check carries the
  // same names (a preset's redirects are always named) and would repeat them under every check of every Task. The results
  // that reach a Task with names are passed and failed ones: a check that timed out twice is not committed, and its
  // question names them instead (validator.test, fix round 4)
  it('names the variables the Credentials list kept from a failed check, and says nothing under a passing one', () => {
    const html = render([
      { configId: 'c1', name: 'Tests', status: 'failed', exitCode: 1, hiddenEnv: ['NPM_TOKEN', 'KUBECONFIG'] },
      { configId: 'c2', name: 'Lint', status: 'passed', hiddenEnv: ['NPM_TOKEN', 'KUBECONFIG'] },
      { configId: 'c4', name: 'Types', status: 'failed', exitCode: 2 }
    ])
    expect(html).toContain('jobs.checks.hiddenEnv {&quot;names&quot;:&quot;NPM_TOKEN, KUBECONFIG&quot;}')
    expect(html.match(/jobs\.checks\.hiddenEnv/g)).toHaveLength(1)
  })

  it('a failed plugin check: its summary, each finding at its place, a warning said as one, and its report link', () => {
    const html = render([
      {
        configId: 'plugin:astera-debug-leftovers',
        name: 'Debug leftovers',
        status: 'failed',
        summary: '2 debug leftovers in 1 file',
        diagnostics: [
          { file: 'src/a.js', line: 3, message: 'adds console.log', severity: 'error' },
          { file: 'src/b.js', message: 'adds <b>TODO</b>', severity: 'warning' },
          { message: 'no file to name' }
        ],
        externalUrl: 'https://ci.example/report/1'
      }
    ])
    expect(html).toContain('jobs.convergence.check.failedNoCode')
    expect(html).toContain('2 debug leftovers in 1 file')
    expect(html).toMatch(/<span class="detail-completion-where">src\/a\.js:3<\/span><span>adds console\.log<\/span>/)
    expect(html).toContain('<span class="detail-completion-where">src/b.js</span>')
    expect(html).toContain('jobs.completion.warning: adds &lt;b&gt;TODO&lt;/b&gt;')
    expect(html).toMatch(/<li><span>no file to name<\/span><\/li>/)
    expect(html).toContain('jobs.completion.openReport')
    expect(html).toContain('title="https://ci.example/report/1"')
    expect(html).toContain('class="detail-completion-diags"')
  })

  it('a check that could not be made is drawn apart with its reason, and a skipped one says so in this app’s words', () => {
    const html = render([
      { configId: 'plugin:a', name: 'A', status: 'error', summary: 'astera-a is stopped' },
      { configId: 'plugin:b', name: 'B', status: 'not-run', skipped: true, summary: 'Skipped by a person: astera-b is stopped' }
    ])
    expect(html).toContain('detail-completion-name--error')
    expect(html).toMatch(/<p class="detail-completion-summary detail-completion-summary--error">astera-a is stopped<\/p>/)
    expect(html).toContain('jobs.convergence.check.skipped')
    expect(html).toContain('<p class="detail-completion-summary">astera-b is stopped</p>')
    expect(html).not.toContain('Skipped by a person')
  })

  it('a command check keeps its exit code and its output toggle, and an empty list draws nothing', () => {
    const html = render([{ configId: 'cfg_t', name: 'Tests', status: 'failed', exitCode: 1, outputTail: '2 failed' }], ['cfg_t'])
    expect(html).toContain('jobs.convergence.check.failed {&quot;code&quot;:1}')
    expect(html).toContain('jobs.completion.hideTail')
    expect(html).toContain('<pre class="detail-completion-tail">2 failed</pre>')
    expect(html).not.toContain('detail-completion-summary')
    expect(render([])).toBe('')
  })

  // 5c final review M4: a summary the Host filled with the status word (the plugin gave none) says nothing the verdict
  // does not, in English beside the verdict in this app's language
  it('draws no summary that is only the status word', () => {
    const html = render([
      { configId: 'plugin:a', name: 'A', status: 'passed', summary: 'passed' },
      { configId: 'plugin:b', name: 'B', status: 'error', summary: 'error' }
    ])
    expect(html).not.toContain('detail-completion-summary')
  })

  // 5d: the Host keeps 20 findings; the block says how many more the plugin found
  it('says how many findings the Host did not keep', () => {
    const kept = Array.from({ length: 20 }, (_, i) => ({ file: 'src/a.js', line: i + 1, message: 'adds TODO' }))
    const html = render([{ configId: 'plugin:d', name: 'D', status: 'failed', summary: '150 leftovers', diagnostics: kept, diagnosticsTotal: 150 }])
    expect(html).toContain('jobs.completion.moreFindings {&quot;n&quot;:130}')
    expect(render([{ configId: 'plugin:d', name: 'D', status: 'failed', summary: 's', diagnostics: kept }])).not.toContain('moreFindings')
  })

  // 5d final review M4: the line says where the rest are only when there is a report, and reads right with no list
  it('words the rest by whether there is a report, and a count with no list as a count', () => {
    const kept = [{ message: 'm' }]
    const link = 'https://x.example/r'
    expect(render([{ configId: 'plugin:d', name: 'D', status: 'failed', summary: 's', diagnostics: kept, diagnosticsTotal: 5, externalUrl: link }])).toContain(
      'jobs.completion.moreFindingsReport {&quot;n&quot;:4}'
    )
    expect(render([{ configId: 'plugin:d', name: 'D', status: 'failed', summary: 's', diagnosticsTotal: 4 }])).toContain('jobs.completion.findingsUnlisted {&quot;n&quot;:4}')
    expect(render([{ configId: 'plugin:d', name: 'D', status: 'failed', summary: 's', diagnosticsTotal: 4, externalUrl: link }])).toContain(
      'jobs.completion.findingsUnlistedReport {&quot;n&quot;:4}'
    )
  })

  it('its words are in all four languages', () => {
    for (const key of [
      'jobs.completion.openReport',
      'jobs.completion.warning',
      'jobs.completion.moreFindings',
      'jobs.completion.moreFindingsReport',
      'jobs.completion.findingsUnlisted',
      'jobs.completion.findingsUnlistedReport',
      'jobs.checks.hiddenEnv'
    ])
      for (const lang of LANGS) expect((CATALOGS[lang].messages as Record<string, string>)[key], `${lang} ${key}`).toBeTruthy()
  })
})
