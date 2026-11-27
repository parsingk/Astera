import { describe, it, expect } from 'vitest'
import { toggleSidebarView, type SidebarState } from './sidebar'
import { pluginKeyOf, pluginSidebarView, sidebarStateOf } from './sidebar'

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

  // 계정·히스토리 화면. 다른 셋과 같은 규칙을 따르되, 켜진 상태란 "아무 플래그도 없음" 이다
  it('sessions 를 고르면 세 뷰를 끄고 사이드바를 편다', () => {
    const explorer = toggleSidebarView(closed, 'explorer')
    expect(toggleSidebarView(explorer, 'sessions')).toEqual({
      open: true,
      explorer: false,
      jobs: false,
      understanding: false
    })
  })

  it('보고 있는 sessions 를 다시 누르면 접는다', () => {
    const shown: SidebarState = { open: true, explorer: false, jobs: false, understanding: false }
    expect(toggleSidebarView(shown, 'sessions')).toEqual(closed)
  })

  // 접힌 채로는 "보고 있는" 것이 아니다 — 눌러서 접는 것이 아니라 펴야 한다
  it('접혀 있으면 sessions 는 접는 것이 아니라 편다', () => {
    expect(toggleSidebarView(closed, 'sessions')).toEqual({
      open: true,
      explorer: false,
      jobs: false,
      understanding: false
    })
  })

  // 이 버튼이 생긴 이유: 한 번에 돌아올 수 없었다
  it('탐색기를 보다가 한 번에 계정·히스토리로 돌아온다', () => {
    const explorer = toggleSidebarView(closed, 'explorer')
    const back = toggleSidebarView(explorer, 'sessions')
    expect(back.open).toBe(true)
    expect(back.explorer).toBe(false)
  })

  it('leaves the other views alone when it collapses', () => {
    const jobs = toggleSidebarView(closed, 'jobs')
    const off = toggleSidebarView(jobs, 'jobs')
    expect(off.explorer).toBe(false)
    expect(off.understanding).toBe(false)
  })
})

// Phase 2 remaining: a plugin's sidebar view is one more view the rail chooses, one at a time with the rest
describe('toggleSidebarView with a plugin view', () => {
  const closed = { open: false, explorer: false, jobs: false, understanding: false, plugin: null }
  const view = pluginSidebarView('hello-panel:side')

  it('opens the sidebar on the plugin view, turning the others off', () => {
    expect(toggleSidebarView({ ...closed, open: true, explorer: true }, view)).toEqual({ open: true, explorer: false, jobs: false, understanding: false, plugin: 'hello-panel:side' })
  })

  it('collapses when the plugin view showing is pressed again', () => {
    expect(toggleSidebarView({ ...closed, open: true, plugin: 'hello-panel:side' }, view)).toEqual({ ...closed, open: false, plugin: null })
  })

  it('shows another view in its place, the plugin view off', () => {
    expect(toggleSidebarView({ ...closed, open: true, plugin: 'hello-panel:side' }, 'jobs')).toEqual({ ...closed, open: true, jobs: true, plugin: null })
  })

  it('counts the session list as showing only when no plugin view is chosen', () => {
    expect(toggleSidebarView({ ...closed, open: true, plugin: 'hello-panel:side' }, 'sessions')).toEqual({ ...closed, open: true, plugin: null })
  })

  it('swaps one plugin view for another', () => {
    expect(toggleSidebarView({ ...closed, open: true, plugin: 'a:x' }, pluginSidebarView('b:y')).plugin).toBe('b:y')
  })
})

describe('pluginKeyOf', () => {
  it('reads the contribution key a plugin view names, and nothing from another view', () => {
    expect(pluginKeyOf(pluginSidebarView('@acme/x:side'))).toBe('@acme/x:side')
    for (const v of ['explorer', 'sessions', 'plugin:', 'plugin:nokey', 'plugin::x', 'plugin:x:']) expect(pluginKeyOf(v), v).toBeNull()
  })
})

// Final review I1: a layout preset or the layout memory reset chooses the plugin view too
describe('sidebarStateOf', () => {
  it('sets one flag, or the plugin key, for the view a layout names', () => {
    expect(sidebarStateOf(true, 'explorer')).toEqual({ open: true, explorer: true, jobs: false, understanding: false, plugin: null })
    expect(sidebarStateOf(false, 'sessions')).toEqual({ open: false, explorer: false, jobs: false, understanding: false, plugin: null })
    expect(sidebarStateOf(true, pluginSidebarView('hello-panel:side'))).toEqual({ open: true, explorer: false, jobs: false, understanding: false, plugin: 'hello-panel:side' })
  })
})

// Final review M2: while the chosen plugin is off, the session list is what shows, and pressing it folds as any view does
describe('toggleSidebarView with a plugin choice its plugin does not offer now', () => {
  const kept = { open: true, explorer: false, jobs: false, understanding: false, plugin: 'hello-panel:side', pluginOffered: false }
  it('folds on the sessions press, keeping the choice for when the plugin is back', () => {
    expect(toggleSidebarView(kept, 'sessions')).toEqual({ ...kept, open: false })
  })
  it('shows the plugin view when its own button is pressed again once it is offered', () => {
    expect(toggleSidebarView({ ...kept, open: false, pluginOffered: true }, pluginSidebarView('hello-panel:side')).open).toBe(true)
  })
})
