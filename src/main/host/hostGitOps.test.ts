import { it, expect } from 'vitest'
import { createHostGitOps } from './hostGitOps'

const collector = () => {
  const c = {
    open: new Set<string>(),
    seq: 0,
    beginGitOperation(_k: 'job-merge', _cwd: string) {
      const id = `local${++c.seq}`
      c.open.add(id)
      return id
    },
    endGitOperation(id: string) {
      c.open.delete(id)
    }
  }
  return c
}

it('opens a Work Unit operation on begin and closes that one on end', () => {
  const c = collector()
  const g = createHostGitOps(c)
  g.pushed({ t: 'git-op', op: 'h1', phase: 'begin', kind: 'job-merge', cwd: 'D:/p' })
  g.pushed({ t: 'git-op', op: 'h2', phase: 'begin', kind: 'job-merge', cwd: 'D:/p' })
  g.pushed({ t: 'git-op', op: 'h1', phase: 'end', kind: 'job-merge', cwd: 'D:/p' })
  expect([...c.open]).toEqual(['local2'])
})

// §3.3: a Host that dies between the two leaves no operation open for ever.
it('closes every open one when the Host goes', () => {
  const c = collector()
  const g = createHostGitOps(c)
  g.pushed({ t: 'git-op', op: 'h1', phase: 'begin', kind: 'job-merge', cwd: 'D:/p' })
  g.hostGone()
  expect(c.open.size).toBe(0)
})

it('ignores an end it never saw begin, and a kind it does not know', () => {
  const c = collector()
  const g = createHostGitOps(c)
  g.pushed({ t: 'git-op', op: 'x', phase: 'end', kind: 'job-merge', cwd: 'D:/p' })
  g.pushed({ t: 'git-op', op: 'y', phase: 'begin', kind: 'rebase', cwd: 'D:/p' } as never)
  expect(c.seq).toBe(0)
})
