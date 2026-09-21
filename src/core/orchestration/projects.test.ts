import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { emptyState } from './state'
import { ensureProject, findProject, findProjectByPath, nameFromPath, renameProject } from './projects'

/** An absolute path this platform actually produces, so the case and separator rules under test are
 *  the real ones rather than a win32 string a posix runner never sees. */
const abs = (...parts: string[]): string => path.resolve(path.sep, ...parts)

describe('nameFromPath', () => {
  it('takes the last segment whichever separator the path was written with', () => {
    expect(nameFromPath('D:\\work\\astera')).toBe('astera')
    expect(nameFromPath('/home/me/astera')).toBe('astera')
  })

  // A trailing separator would otherwise name the project the empty string, and an empty name is
  // what a person sees in the list.
  it('ignores a trailing separator', () => {
    expect(nameFromPath('D:\\work\\astera\\')).toBe('astera')
    expect(nameFromPath('/home/me/astera/')).toBe('astera')
  })
})

describe('ensureProject', () => {
  it('registers a project with a name taken from the folder', () => {
    const { state, project } = ensureProject(emptyState(), { path: abs('work', 'astera'), now: 'T0' })
    expect(project).toMatchObject({ path: abs('work', 'astera'), name: 'astera', addedAt: 'T0' })
    expect(project.id).toMatch(/^proj_/)
    expect(state.projects).toHaveLength(1)
  })

  // The caller is `orch.list`, which runs every time the Jobs sidebar is shown. If this grew the
  // array each time, opening a project twice would register it twice.
  it('answers with the existing project and the same state object when it is already registered', () => {
    const first = ensureProject(emptyState(), { path: abs('work', 'astera'), now: 'T0' })
    const second = ensureProject(first.state, { path: abs('work', 'astera'), now: 'T1' })
    expect(second.project.id).toBe(first.project.id)
    expect(second.state.projects).toHaveLength(1)
    // Identity, not just equality: the wiring skips its save when nothing changed.
    expect(second.state).toBe(first.state)
  })

  // The same repository arrives spelled differently — the renderer sends the active tab's cwd and
  // win32 ignores case. Two entries for one repository would give the CLI two ids for one thing.
  it('matches a path that differs only in case or separator', () => {
    const first = ensureProject(emptyState(), { path: abs('Work', 'Astera'), now: 'T0' })
    const again = findProjectByPath(first.state, abs('Work', 'Astera').toLowerCase())
    expect(again?.id).toBe(first.project.id)
  })

  it('keeps separate entries for sibling folders that share a prefix', () => {
    const one = ensureProject(emptyState(), { path: abs('work', 'proj'), now: 'T0' })
    const two = ensureProject(one.state, { path: abs('work', 'proj2'), now: 'T1' })
    expect(two.state.projects).toHaveLength(2)
    expect(two.project.id).not.toBe(one.project.id)
  })
})

describe('renameProject', () => {
  it('changes the name and leaves the path alone', () => {
    const { state, project } = ensureProject(emptyState(), { path: abs('work', 'astera'), now: 'T0' })
    const r = renameProject(state, project.id, '  Astera (main)  ')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.name).toBe('Astera (main)')
    expect(r.value.path).toBe(project.path)
    expect(findProject(r.state, project.id)?.name).toBe('Astera (main)')
  })

  it('refuses a blank name and an unknown id', () => {
    const { state, project } = ensureProject(emptyState(), { path: abs('work', 'astera'), now: 'T0' })
    expect(renameProject(state, project.id, '   ').ok).toBe(false)
    expect(renameProject(state, 'proj_nope', 'x').ok).toBe(false)
  })
})
