import { describe, it, expect, afterEach, vi } from 'vitest'
import type { SavedLayout } from '../../../core/panes/savedLayout'
import { kubeTab } from '../../../core/panes/tabId'
import { CHECK_WAIT_MS, checkSavedTabs, keepSavedTab } from './restoreLayout'

const kube = kubeTab({ context: 'c', namespace: 'ns', resource: 'pods', kind: 'Pod', name: 'web' })

function layout(tabs: string[]): SavedLayout {
  return {
    v: 1,
    tree: { kind: 'leaf', tabs, active: tabs[0] },
    active: 0,
    panels: { sidebar: { open: true, view: 'sessions' }, bottom: { open: false, tab: 'run' } },
    tabs: {
      files: {
        'file:/p/a.ts': { path: '/p/a.ts', projectRoot: '/p' },
        'file:/p/gone.ts': { path: '/p/gone.ts', projectRoot: '/p' },
        // A record whose info names another file than its id (tampering, or a bug): never asked about, never kept
        'file:/p/b.ts': { path: '/p/secret.ts', projectRoot: '/p' }
      },
      records: { 'record:r1': { recordId: 'r1', title: 'R', projectRoot: '/p' }, 'record:r2': { recordId: 'r2', title: 'R2', projectRoot: '/gone' } },
      browsers: { 'browser:b1': { url: 'http://localhost:5173/', title: '', projectRoot: '/p' } },
      plugins: {}
    }
  }
}

function stubApi(over: { exists?: (p: string, kind: string) => Promise<boolean>; resolveLink?: (cwd: string, target: string) => Promise<unknown> } = {}) {
  const exists = vi.fn(over.exists ?? (async (p: string, kind: string) => (kind === 'file' ? p === '/p/a.ts' : p === '/p')))
  const resolveLink = vi.fn(over.resolveLink ?? (async (_cwd: string, target: string) => (target === '/p/i.png' ? { path: target } : null)))
  vi.stubGlobal('window', { api: { files: { exists, resolveLink } } })
  return { exists, resolveLink }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('what a saved layout can bring back', () => {
  it('asks main, inside the opened projects, whether each saved file and record folder is there; images through the link check', async () => {
    const { exists, resolveLink } = stubApi()
    const saved = layout(['session:s1', 'file:/p/a.ts', 'file:/p/gone.ts', 'file:/p/b.ts', 'file:/p/noinfo.ts', 'media:/p/i.png', 'media:/p/x.png', 'record:r1', 'record:r2', 'browser:b1', kube])
    const checks = await checkSavedTabs(saved)
    expect([...checks]).toEqual(['file:/p/a.ts', 'media:/p/i.png', 'record:r1'])
    expect(exists.mock.calls).toEqual([
      ['/p/a.ts', 'file'],
      ['/p/gone.ts', 'file'],
      ['/p', 'dir'],
      ['/gone', 'dir']
    ])
    // An image's own path admits it for the viewer again; a session, a preview or a cluster tab is never asked about
    expect(resolveLink.mock.calls.map((c) => c[1])).toEqual(['/p/i.png', '/p/x.png'])
  })

  it('reads a check that fails as gone, and nothing saved as nothing to check', async () => {
    stubApi({ exists: async () => Promise.reject(new Error('ipc')) })
    expect([...(await checkSavedTabs(layout(['file:/p/a.ts'])))]).toEqual([])
    expect([...(await checkSavedTabs(null))]).toEqual([])
  })

  // Final review C1: a spun-down disk or an absent network drive must not hold the restore for seconds
  it('keeps a tab whose check has not answered in time in its place, rather than waiting on a slow disk', async () => {
    vi.useFakeTimers()
    stubApi({ exists: () => new Promise<boolean>(() => {}) })
    const pending = checkSavedTabs(layout(['file:/p/a.ts']))
    await vi.advanceTimersByTimeAsync(CHECK_WAIT_MS)
    expect([...(await pending)]).toEqual(['file:/p/a.ts'])
  })

  it('keeps a live session, a checked file, image or record, a preview with its address, and a cluster object', () => {
    const saved = layout([])
    const keep = keepSavedTab(saved, new Set(['file:/p/a.ts', 'media:/p/i.png', 'record:r1']), new Set(['s1']))
    expect(['session:s1', 'file:/p/a.ts', 'media:/p/i.png', 'record:r1', 'browser:b1', kube].every(keep)).toBe(true)
    expect(['session:s2', 'file:/p/gone.ts', 'media:/p/x.png', 'record:r2', 'browser:b2', 'kube:broken', 'app:s1', 'plugin:x'].some(keep)).toBe(false)
  })
})
