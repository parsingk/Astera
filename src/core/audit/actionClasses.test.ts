// The action-to-class table (lifecycle design §4.6): every action the resolver names arrives through the classes the
// coverage tables have rows for, and a rule's pattern reaches every class of every action it matches.
import { describe, it, expect } from 'vitest'
import { AUDIT_ACTIONS } from './policy'
import { ACTION_CLASSES, classesOfRule } from './actionClasses'

describe('the action-to-class table', () => {
  it('every action the resolver names is a key', () => {
    expect(Object.keys(ACTION_CLASSES).sort()).toEqual([...AUDIT_ACTIONS].sort())
    for (const a of AUDIT_ACTIONS) expect(Array.isArray(ACTION_CLASSES[a]), a).toBe(true)
  })

  it('names each action by the way its calls arrive', () => {
    expect(ACTION_CLASSES['git.remote.write']).toEqual(['shell'])
    expect(ACTION_CLASSES['package.install']).toEqual(['shell'])
    expect(ACTION_CLASSES['filesystem.read']).toEqual(['file-read', 'shell'])
    expect(ACTION_CLASSES['filesystem.delete']).toEqual(['file-write', 'shell'])
    expect(ACTION_CLASSES['network.request']).toEqual(['network'])
    expect(ACTION_CLASSES['mcp.call']).toEqual(['mcp'])
    // The coverage tables have no row for these (plan ruling 4)
    expect(ACTION_CLASSES['agent.spawn']).toEqual([])
    expect(ACTION_CLASSES.other).toEqual([])
  })

  it('git.* gives shell', () => {
    expect(classesOfRule('git.*')).toEqual(['shell'])
    expect(classesOfRule('git.remote.write')).toEqual(['shell'])
  })

  it('filesystem.* gives file-read, file-write and shell', () => {
    expect([...classesOfRule('filesystem.*')].sort()).toEqual(['file-read', 'file-write', 'shell'])
    // The file class comes before the shell it also arrives by, so a reason names the file class's word first
    expect(classesOfRule('filesystem.read')).toEqual(['file-read', 'shell'])
  })

  it('every class for a star, none for an action no one names or one that maps to none', () => {
    expect([...classesOfRule('*')].sort()).toEqual(['file-read', 'file-write', 'mcp', 'network', 'shell'])
    expect(classesOfRule('agent.spawn')).toEqual([])
    expect(classesOfRule('nothing.like.this')).toEqual([])
    // A `*` anywhere but the end is not a pattern (policy.ts isRuleAction)
    expect(classesOfRule('git*.read')).toEqual([])
  })
})
