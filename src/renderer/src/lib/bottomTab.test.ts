import { describe, it, expect } from 'vitest'
import { shownBottomTab } from './bottomTab'

const project = { runAvailable: true, kubeAvailable: true, problemsAvailable: true, testsAvailable: true, terminalIds: [] as string[] }
const home = { ...project, runAvailable: false }

describe('shownBottomTab', () => {
  it('shows the tab asked for in a project', () => {
    expect(shownBottomTab({ ...project, wanted: 'run' })).toBe('run')
    expect(shownBottomTab({ ...project, wanted: 'kube' })).toBe('kube')
    expect(shownBottomTab({ ...project, wanted: 't1', terminalIds: ['t1'] })).toBe('t1')
    expect(shownBottomTab({ ...project, wanted: 'kubelog:1' })).toBe('kubelog:1')
  })

  it('falls back to Run when the Kubernetes tab is gone', () => {
    expect(shownBottomTab({ ...project, kubeAvailable: false, wanted: 'kube' })).toBe('run')
  })

  // Final review I1: Layout: Agent Review, or a saved preset, asks for the Problems tab while it is turned off
  it('falls back to Run when the Problems tab is turned off, and shows it while it is on', () => {
    expect(shownBottomTab({ ...project, problemsAvailable: false, wanted: 'problems' })).toBe('run')
    // Phase 3 Part 2: the Tests tab turned off falls back the same way
    expect(shownBottomTab({ ...project, testsAvailable: false, wanted: 'tests' })).toBe('run')
    expect(shownBottomTab({ ...project, wanted: 'tests' })).toBe('tests')
    expect(shownBottomTab({ ...project, wanted: 'problems' })).toBe('problems')
  })

  // The Kubernetes and logs tabs belong to no project: at home they show as they are.
  it('shows a logs tab or the Kubernetes tab at home, where there is no Run tab', () => {
    expect(shownBottomTab({ ...home, wanted: 'kubelog:1', terminalIds: ['t1'] })).toBe('kubelog:1')
    expect(shownBottomTab({ ...home, wanted: 'kube', terminalIds: ['t1'] })).toBe('kube')
  })

  it('keeps a shell tab shown without a project', () => {
    expect(shownBottomTab({ ...home, wanted: 'kubeshell:1', terminalIds: ['t1'] })).toBe('kubeshell:1')
  })

  it('at home, shows the terminal asked for, and for Run the first terminal', () => {
    expect(shownBottomTab({ ...home, wanted: 't2', terminalIds: ['t1', 't2'] })).toBe('t2')
    expect(shownBottomTab({ ...home, wanted: 'run', terminalIds: ['t1', 't2'] })).toBe('t1')
  })

  // Task 6 review minor: closing the shown logs tab asks for Run, which home does not have; the panel showed nothing.
  it('at home without terminals, falls to the Kubernetes tab when it is there, else Run', () => {
    expect(shownBottomTab({ ...home, wanted: 'run' })).toBe('kube')
    expect(shownBottomTab({ ...home, kubeAvailable: false, wanted: 'run' })).toBe('run')
    expect(shownBottomTab({ ...home, kubeAvailable: false, wanted: 'kube' })).toBe('run')
  })
})
