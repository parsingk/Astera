// The check words (plugin Phase 5c, C13): a chip's tooltip in the run's graph and a check's verdict in its completion
// block, in all four languages.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from '../../../core/i18n'
import { GLYPH, checkChoicesOf, checkTooltip, checkVerdict, nodeMetaText, taskTitleOf, eventTitleOf } from './checkText'

const t = (key: string, p?: Record<string, string | number>): string => (p ? `${key} ${JSON.stringify(p)}` : key)

describe('checkVerdict', () => {
  it('says a command check’s exit code, a plugin’s failure without one, a check that could not be made, and a skipped one', () => {
    expect(checkVerdict({ status: 'passed' }, t)).toBe('jobs.convergence.check.passed')
    expect(checkVerdict({ status: 'failed', exitCode: 2 }, t)).toBe('jobs.convergence.check.failed {"code":2}')
    expect(checkVerdict({ status: 'failed' }, t)).toBe('jobs.convergence.check.failedNoCode')
    expect(checkVerdict({ status: 'timed-out' }, t)).toBe('jobs.convergence.check.timedOut')
    expect(checkVerdict({ status: 'error' }, t)).toBe('jobs.convergence.check.error')
    expect(checkVerdict({ status: 'not-run' }, t)).toBe('jobs.convergence.check.notRun')
    expect(checkVerdict({ status: 'not-run', skipped: true }, t)).toBe('jobs.convergence.check.skipped')
  })

  // 5c final review (declined, ruled a finding): a status this app does not know, from a Runtime of another version, is
  // said as it is rather than as "undefined"
  it('says a status it does not know as it is', () => {
    expect(checkVerdict({ status: 'paused' as never }, t)).toBe('paused')
  })
})

// 5c final review M1: the node line in words, a check that could not be made said so wherever a line names it
// G7b: the lifecycle Task's node while its round waits for GitHub CI, and its title in the app's language
describe('the lifecycle Task', () => {
  it('says it waits for GitHub CI, with the pull request when it has one', () => {
    expect(nodeMetaText({ kind: 'ci-waiting', pr: 12 }, t)).toBe('jobs.convergence.node.ciWaiting {"pr":12}')
    expect(nodeMetaText({ kind: 'ci-waiting' }, t)).toBe('jobs.convergence.node.ciWaitingNoPr')
  })
  it('its title is translated; any other Task’s is its own', () => {
    expect(taskTitleOf({ title: 'GitHub 전달', lifecycle: {} }, t)).toBe('jobs.lifecycle.title')
    expect(taskTitleOf({ title: 'Fix the login' }, t)).toBe('Fix the login')
  })
  // Final review I2: a timeline line names its Task by the Task's title, the lifecycle Task's translated
  it('a timeline line’s Task title, and a Task added line, say the lifecycle Task in the app’s language', () => {
    const tasks = [{ id: 'tsk_l', title: 'GitHub 전달', lifecycle: {} }, { id: 'tsk_1', title: 'Fix the login' }]
    expect(eventTitleOf({ taskId: 'tsk_l', taskTitle: 'GitHub 전달' }, tasks, t)).toBe('jobs.lifecycle.title')
    expect(eventTitleOf({ taskId: 'tsk_1', taskTitle: 'Fix the login' }, tasks, t)).toBe('Fix the login')
    expect(eventTitleOf({ taskId: 'tsk_gone', taskTitle: 'Old' }, tasks, t)).toBe('Old')
  })
  it('its words are in every language', () => {
    for (const k of ['jobs.convergence.node.ciWaiting', 'jobs.convergence.node.ciWaitingNoPr', 'jobs.lifecycle.title'])
      for (const lang of LANGS) expect((CATALOGS[lang].messages as Record<string, string>)[k], `${lang} ${k}`).toBeTruthy()
  })
})

describe('nodeMetaText', () => {
  it('says a check could not run on the failed and stopped lines, and drops its name from a repair’s', () => {
    expect(nodeMetaText({ kind: 'failed', name: 'D', unavailable: true }, t)).toBe('jobs.convergence.node.unavailable {"name":"D"}')
    expect(nodeMetaText({ kind: 'failed', name: 'Tests' }, t)).toBe('jobs.convergence.node.failed {"name":"Tests"}')
    expect(nodeMetaText({ kind: 'stopped', failed: 'D', unavailable: true }, t)).toBe('jobs.convergence.node.stoppedUnavailable {"failed":"D"}')
    expect(nodeMetaText({ kind: 'stopped', failed: 'Tests' }, t)).toBe('jobs.convergence.node.stoppedWithCheck {"failed":"Tests"}')
    expect(nodeMetaText({ kind: 'repairing', repairs: 1, max: 3, failed: 'D', unavailable: true }, t)).toBe(
      'jobs.convergence.node.repairingNoCheck {"repairs":1,"max":3}'
    )
    expect(nodeMetaText({ kind: 'none' }, t)).toBeUndefined()
  })
})

describe('checkTooltip', () => {
  it('names the check, its verdict, its time and a flip; a check that could not be made reads so, not "not run"', () => {
    expect(checkTooltip({ configId: 'plugin:d', name: 'D', status: 'error' }, 'error', t)).toBe('D — jobs.convergence.check.error')
    expect(checkTooltip({ configId: 'c', name: 'Tests', status: 'failed', exitCode: 1, durationMs: 18_000, unstable: true }, 'failed', t)).toBe(
      'Tests — jobs.convergence.check.failed {"code":1} (18.0s), jobs.convergence.check.unstable'
    )
    expect(checkTooltip({ configId: 'c', name: 'Tests', status: 'failed' }, 'retrying', t)).toBe('Tests — jobs.convergence.check.retrying')
    expect(GLYPH.error).toBe('!')
  })
})

describe('checkChoicesOf', () => {
  it('offers the run configurations, then the check plugins as Plugin: name, with a status when not running', () => {
    const configs = [{ id: 'cfg_t', name: 'npm test' }]
    const plugins = [
      { id: 'astera-debug-leftovers', name: 'Debug leftovers', status: 'running' },
      { id: 'astera-guard', name: 'Guard', status: 'stopped' }
    ]
    expect(checkChoicesOf(configs, plugins, t)).toEqual([
      { id: 'cfg_t', name: 'npm test' },
      { id: 'plugin:astera-debug-leftovers', name: 'jobs.task.checkPlugin {"name":"Debug leftovers"}' },
      { id: 'plugin:astera-guard', name: 'jobs.task.checkPluginStatus {"name":"Guard","status":"settings.plugins.status.stopped"}' }
    ])
  })

  it('plugins not read yet add nothing, so the run configurations are offered at once', () => {
    expect(checkChoicesOf([{ id: 'cfg_t', name: 'npm test' }], null, t)).toEqual([{ id: 'cfg_t', name: 'npm test' }])
  })
})

describe('the check words', () => {
  it('are in all four languages', () => {
    const keys = [
      'jobs.convergence.check.failedNoCode',
      'jobs.convergence.check.error',
      'jobs.convergence.check.skipped',
      'jobs.convergence.node.unavailable',
      'jobs.task.checkPlugin',
      'jobs.task.checkPluginStatus',
      'jobs.task.checksRuntimePlugins',
      'jobs.convergence.node.stoppedUnavailable'
    ]
    for (const key of keys) for (const lang of LANGS) expect((CATALOGS[lang].messages as Record<string, string>)[key], `${lang} ${key}`).toBeTruthy()
  })
})
