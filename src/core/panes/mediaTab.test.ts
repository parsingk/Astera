import { describe, expect, it } from 'vitest'
import { mediaTab, parseTab } from './tabId'
import { placeMediaTab } from './place'
import { addTab, createGroup, leafOf, leaves, splitAndMove } from './tree'

const allTabs = (root: Parameters<typeof leaves>[0]): string[] => leaves(root).flatMap((l) => l.tabIds)

describe('mediaTab', () => {
  it('the id is the path, read back whole even with a drive colon', () => {
    expect(mediaTab('D:\\clips\\g1.mp4')).toBe('media:D:\\clips\\g1.mp4')
    expect(parseTab('media:D:\\clips\\g1.mp4')).toEqual({ kind: 'media', id: 'D:\\clips\\g1.mp4' })
  })

  it('an empty path is not a tab', () => {
    expect(parseTab('media:')).toBeNull()
  })
})

describe('placeMediaTab — opening a path already open focuses that tab', () => {
  it('opens a new tab in the active pane the first time', () => {
    const g = createGroup('session:s1')
    const res = placeMediaTab(g, 'D:\\clips\\g1.mp4', { activePaneId: g.id }, 'win32')
    expect(res.paneId).toBe(g.id)
    expect(leafOf(res.root, g.id)!.activeTabId).toBe('media:D:\\clips\\g1.mp4')
  })

  it('opening the same path again adds nothing and activates the existing tab', () => {
    const g = createGroup('session:s1')
    const once = placeMediaTab(g, 'D:\\clips\\g1.mp4', { activePaneId: g.id }, 'win32')
    const back = addTab(once.root, g.id, 'session:s2') // the person moved on to another tab
    const twice = placeMediaTab(back, 'D:\\clips\\g1.mp4', { activePaneId: g.id }, 'win32')
    expect(allTabs(twice.root).filter((t) => t.startsWith('media:'))).toEqual(['media:D:\\clips\\g1.mp4'])
    expect(leafOf(twice.root, g.id)!.activeTabId).toBe('media:D:\\clips\\g1.mp4')
  })

  // The same file printed in two spellings (an agent's lower-case drive letter, a `..` in a
  // relative link) is one file on Windows, so it is one tab
  it('a differently cased or un-normalised spelling of the same file on win32 is the same tab', () => {
    const g = createGroup('session:s1')
    const once = placeMediaTab(g, 'D:\\Clips\\G1.mp4', { activePaneId: g.id }, 'win32')
    const twice = placeMediaTab(once.root, 'd:\\clips\\x\\..\\g1.MP4', { activePaneId: g.id }, 'win32')
    expect(allTabs(twice.root).filter((t) => t.startsWith('media:'))).toEqual(['media:D:\\Clips\\G1.mp4'])
  })

  it('on linux case is part of the name: two spellings are two files and two tabs', () => {
    const g = createGroup('session:s1')
    const once = placeMediaTab(g, '/clips/G1.mp4', { activePaneId: g.id }, 'linux')
    const twice = placeMediaTab(once.root, '/clips/g1.mp4', { activePaneId: g.id }, 'linux')
    expect(allTabs(twice.root).filter((t) => t.startsWith('media:'))).toHaveLength(2)
  })

  it('a tab open in another pane is focused there, not duplicated into the active one', () => {
    const a = createGroup('session:s1')
    const split = splitAndMove(a, 'media:D:\\clips\\g1.mp4', a.id, 'row', false)!
    const res = placeMediaTab(split.root, 'D:\\clips\\g1.mp4', { activePaneId: a.id }, 'win32')
    expect(res.paneId).toBe(split.paneId)
    expect(allTabs(res.root)).toEqual(['session:s1', 'media:D:\\clips\\g1.mp4'])
  })

  it('an empty layout gets a group holding the tab', () => {
    const res = placeMediaTab(null, '/a/b.png', {}, 'linux')
    expect(allTabs(res.root)).toEqual(['media:/a/b.png'])
  })
})

// Clicking a link to a file that is already open is how the person says "show me the new one": the
// caller bumps that tab's reload nonce, which needs to know which tab (by id) was found.
describe('placeMediaTab — reports the tab it reopened', () => {
  it('a first open reports nothing reopened', () => {
    const g = createGroup('session:s1')
    expect(placeMediaTab(g, '/a/b.mp4', { activePaneId: g.id }, 'linux').reopened).toBeNull()
    expect(placeMediaTab(null, '/a/b.mp4', {}, 'linux').reopened).toBeNull()
  })

  it('a second open reports the existing tab id, as it was first spelled', () => {
    const g = createGroup('session:s1')
    const once = placeMediaTab(g, 'D:\\Clips\\G1.mp4', { activePaneId: g.id }, 'win32')
    const twice = placeMediaTab(once.root, 'd:\\clips\\g1.mp4', { activePaneId: g.id }, 'win32')
    expect(twice.reopened).toBe('media:D:\\Clips\\G1.mp4')
  })
})
