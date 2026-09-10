import { describe, it, expect } from 'vitest'
import { terminalsWithCreated } from './terminalTabs'

const tab = (id: string, buffer = ''): { id: string; buffer: string } => ({ id, buffer })

describe('terminalsWithCreated', () => {
  it('adds a tab for a terminal adopted into the project the panel is showing', () => {
    const prev = [tab('a', 'old output')]
    expect(terminalsWithCreated(prev, { id: 'b', projectPath: 'C:\p' }, 'C:\p')).toEqual([
      tab('a', 'old output'),
      tab('b')
    ])
  })

  // Another project's terminals stay alive in main and are simply not shown here — the same rule the
  // list query follows. Returning the array unchanged, rather than an equal copy, is what keeps the
  // panel from re-rendering over a terminal it is not showing.
  it('leaves the list untouched for a terminal of another project', () => {
    const prev = [tab('a')]
    expect(terminalsWithCreated(prev, { id: 'b', projectPath: 'C:\other' }, 'C:\p')).toBe(prev)
  })

  // A reconnect sweep adopts by id, and the reattach walk skips a terminal the app still holds live —
  // but an event that arrives twice must not put a second tab on one shell either.
  it('never puts a second tab on a terminal it is already showing', () => {
    const prev = [tab('a'), tab('b', 'output b')]
    expect(terminalsWithCreated(prev, { id: 'b', projectPath: 'C:\p' }, 'C:\p')).toBe(prev)
  })

  it('shows nothing when the panel has no root of its own', () => {
    const prev = [tab('a')]
    expect(terminalsWithCreated(prev, { id: 'b', projectPath: 'C:\p' }, null)).toBe(prev)
  })
})
