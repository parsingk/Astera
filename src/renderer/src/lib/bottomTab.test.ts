import { describe, it, expect } from 'vitest'
import { shownBottomTab } from './bottomTab'

const project = { runAvailable: true, kubeAvailable: true, terminalIds: [] as string[] }
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

  // The Kubernetes and logs tabs belong to no project: at home they show as they are.
  it('shows a logs tab or the Kubernetes tab at home, where there is no Run tab', () => {
    expect(shownBottomTab({ ...home, wanted: 'kubelog:1', terminalIds: ['t1'] })).toBe('kubelog:1')
    expect(shownBottomTab({ ...home, wanted: 'kube', terminalIds: ['t1'] })).toBe('kube')
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
