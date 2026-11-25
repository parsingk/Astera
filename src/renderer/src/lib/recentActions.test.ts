import { describe, it, expect, afterEach, vi } from 'vitest'
import type { ActionId } from '../../../core/keys/binding'
import { readRecentActions, rememberAction } from './recentActions'

const known: ActionId[] = ['run.run', 'job.new', 'kube.open', 'sidebar.jobs', 'sidebar.home', 'pane.splitRight', 'pane.splitDown', 'run.stop', 'run.rerun', 'session.new']

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size
    }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('recent actions', () => {
  it('remembers the last action first, without duplicates, at most eight', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    for (const id of known) rememberAction(id, known)
    rememberAction('job.new', known)
    const recent = readRecentActions(known)
    expect(recent[0]).toBe('job.new')
    expect(recent).toHaveLength(8)
    expect(new Set(recent).size).toBe(8)
  })

  it('drops ids it no longer knows and anything that is not a list of strings', () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'cm.recentActions': JSON.stringify(['gone.action', 'run.run', 7]) }))
    expect(readRecentActions(known)).toEqual(['run.run'])
    vi.stubGlobal('localStorage', memoryStorage({ 'cm.recentActions': '{not json' }))
    expect(readRecentActions(known)).toEqual([])
  })

  it('forgets quietly when storage is off', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    })
    expect(readRecentActions(known)).toEqual([])
    expect(() => rememberAction('run.run', known)).not.toThrow()
  })

  // A plugin's command is kept while its plugin is not listed (final review M2): the palette's first opening after a
  // start draws before the Host's list arrives, and a plugin turned off for a while comes back with its place
  it('keeps a plugin command’s key whether or not the palette lists it now', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    const withPlugin = [...known, 'hello-panel:open'] as const
    rememberAction('hello-panel:open', withPlugin)
    expect(readRecentActions(withPlugin)[0]).toBe('hello-panel:open')
    expect(readRecentActions(known)[0]).toBe('hello-panel:open')
    rememberAction('run.run', known)
    expect(readRecentActions(known)).toEqual(['run.run', 'hello-panel:open'])
  })
})
