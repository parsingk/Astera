import { describe, it, expect, afterEach, vi } from 'vitest'
import type { SavedLayout } from '../../../core/panes/savedLayout'
import { kubeTab } from '../../../core/panes/tabId'
import { checkSavedTabs, keepSavedTab } from './restoreLayout'

const kube = kubeTab({ context: 'c', namespace: 'ns', resource: 'pods', kind: 'Pod', name: 'web' })

function layout(tabs: string[]): SavedLayout {
  return {
    v: 1,
    tree: { kind: 'leaf', tabs, active: tabs[0] },
    active: 0,
    panels: { sidebar: { open: true, view: 'sessions' }, bottom: { open: false, tab: 'run' } },
    tabs: {
      files: { 'file:/p/a.ts': { path: '/p/a.ts', projectRoot: '/p' }, 'file:/p/gone.ts': { path: '/p/gone.ts', projectRoot: '/p' } },
      records: { 'record:r1': { recordId: 'r1', title: 'R', projectRoot: '/p' }, 'record:r2': { recordId: 'r2', title: 'R2', projectRoot: '/gone' } },
      browsers: { 'browser:b1': { url: 'http://localhost:5173/', title: '', projectRoot: '/p' } }
    }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('what a saved layout can bring back', () => {
  it('asks main whether each saved file, image and record folder is still there, and nothing else', async () => {
    const resolveLink = vi.fn(async (_cwd: string, target: string) =>
      ['/p/a.ts', '/p/i.png', '/p'].includes(target) ? { path: target, ...(target === '/p' ? { dir: true as const } : {}) } : null
    )
    vi.stubGlobal('window', { api: { files: { resolveLink } } })
    const saved = layout(['session:s1', 'file:/p/a.ts', 'file:/p/gone.ts', 'file:/p/noinfo.ts', 'media:/p/i.png', 'media:/p/x.png', 'record:r1', 'record:r2', 'browser:b1', kube])
    const checks = await checkSavedTabs(saved)
    expect([...checks]).toEqual(['file:/p/a.ts', 'media:/p/i.png', 'record:r1'])
    // A file with no saved info is never asked about; a session, a preview or a cluster tab is never asked about
    expect(resolveLink.mock.calls.map((c) => c[1])).toEqual(['/p/a.ts', '/p/gone.ts', '/p/i.png', '/p/x.png', '/p', '/gone'])
    expect(resolveLink).toHaveBeenCalledWith('/p', '/p', undefined, { dirs: true })
  })

  it('reads a check that fails as gone, and nothing saved as nothing to check', async () => {
    vi.stubGlobal('window', { api: { files: { resolveLink: vi.fn(async () => Promise.reject(new Error('ipc'))) } } })
    expect([...(await checkSavedTabs(layout(['file:/p/a.ts'])))]).toEqual([])
    expect([...(await checkSavedTabs(null))]).toEqual([])
  })

  it('keeps a live session, a checked file, image or record, a preview with its address, and a cluster object', () => {
    const saved = layout([])
    const keep = keepSavedTab(saved, new Set(['file:/p/a.ts', 'media:/p/i.png', 'record:r1']), new Set(['s1']))
    expect(['session:s1', 'file:/p/a.ts', 'media:/p/i.png', 'record:r1', 'browser:b1', kube].every(keep)).toBe(true)
    expect(['session:s2', 'file:/p/gone.ts', 'media:/p/x.png', 'record:r2', 'browser:b2', 'kube:broken', 'app:s1', 'plugin:x'].some(keep)).toBe(false)
  })
})
