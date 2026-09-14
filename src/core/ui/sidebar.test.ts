import { describe, it, expect } from 'vitest'
import { toggleSidebarView, type SidebarState } from './sidebar'

const closed: SidebarState = { open: false, explorer: false, jobs: false, understanding: false }

describe('toggleSidebarView', () => {
  it('opens the sidebar on the view that was asked for', () => {
    expect(toggleSidebarView(closed, 'explorer')).toEqual({
      open: true,
      explorer: true,
      jobs: false,
      understanding: false
    })
  })

  it('shows one view at a time — choosing another turns the first off', () => {
    const explorer = toggleSidebarView(closed, 'explorer')
    expect(toggleSidebarView(explorer, 'jobs')).toEqual({
      open: true,
      explorer: false,
      jobs: true,
      understanding: false
    })
  })

  // The bug this rule exists for: pressing Ctrl+Shift+E again used to leave the sidebar on screen
  // showing the session list, which reads as "closing does not work".
  it('collapses the sidebar when the view showing is toggled off', () => {
    const explorer = toggleSidebarView(closed, 'explorer')
    expect(toggleSidebarView(explorer, 'explorer')).toEqual({
      open: false,
      explorer: false,
      jobs: false,
      understanding: false
    })
  })

  it('round-trips: pressing twice puts every flag back', () => {
    for (const v of ['explorer', 'jobs', 'understanding'] as const) {
      expect(toggleSidebarView(toggleSidebarView(closed, v), v)).toEqual(closed)
    }
  })

  it('unfolds rather than turning off a view chosen while the sidebar was collapsed', () => {
    // The collapse button leaves the chosen view alone, so this state is reachable: explorer is the
    // chosen view but nothing is on screen. Pressing its key should show it.
    const collapsedWithExplorer: SidebarState = { open: false, explorer: true, jobs: false, understanding: false }
    expect(toggleSidebarView(collapsedWithExplorer, 'explorer')).toEqual({
      open: true,
      explorer: true,
      jobs: false,
      understanding: false
    })
  })

  it('leaves the other views alone when it collapses', () => {
    const jobs = toggleSidebarView(closed, 'jobs')
    const off = toggleSidebarView(jobs, 'jobs')
    expect(off.explorer).toBe(false)
    expect(off.understanding).toBe(false)
  })
})
