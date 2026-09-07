import { describe, it, expect } from 'vitest'
import type { RunConfig } from './types'
import { groupConfigs } from './grouping'

const cfg = (id: string, type: RunConfig['type'], folder?: string): RunConfig =>
  ({ id, name: id, type, folder, ...(type === 'npm' ? { script: id } : { command: id }) }) as RunConfig

describe('groupConfigs', () => {
  it('files a configuration under its folder, and under its kind when it has none', () => {
    const list = [cfg('dev', 'npm', 'Frontend'), cfg('build', 'npm'), cfg('boot', 'shell', 'Frontend')]
    expect(groupConfigs(list)).toEqual([
      { kind: 'folder', key: 'Frontend', items: [list[0], list[2]] },
      { kind: 'type', key: 'npm', items: [list[1]] }
    ])
  })

  // Store order is display order: a group takes the position of its first member, and every later
  // member joins it there rather than opening a second group.
  it('emits a group once, at its first member, however scattered its members are', () => {
    const list = [cfg('a', 'npm', 'F'), cfg('b', 'shell'), cfg('c', 'npm', 'F')]
    expect(groupConfigs(list).map((g) => g.key)).toEqual(['F', 'shell'])
    expect(groupConfigs(list)[0].items).toEqual([list[0], list[2]])
  })

  it('treats an empty folder name as no folder', () => {
    expect(groupConfigs([cfg('a', 'npm', '')])).toEqual([{ kind: 'type', key: 'npm', items: [expect.anything()] }])
  })

  it('an empty list has no groups', () => {
    expect(groupConfigs([])).toEqual([])
  })

  // The tree filters before grouping, so a group nobody matched simply is not there
  it('produces no empty group for a filtered list', () => {
    const list = [cfg('dev', 'npm', 'Frontend'), cfg('build', 'npm')]
    expect(groupConfigs(list.filter((c) => c.id === 'build')).map((g) => g.key)).toEqual(['npm'])
  })

  // A folder and a kind can share a name without colliding — they are different kinds of group
  it('keeps a folder and a kind of the same name apart', () => {
    const list = [cfg('a', 'shell', 'shell'), cfg('b', 'shell')]
    expect(groupConfigs(list)).toEqual([
      { kind: 'folder', key: 'shell', items: [list[0]] },
      { kind: 'type', key: 'shell', items: [list[1]] }
    ])
  })
})
