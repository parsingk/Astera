// The files changed since a head, as the suspicious-files pass reads them (GitHub lifecycle G3c1: the Host reads them
// too), on a fake git that answers with git's own output.
import { describe, it, expect } from 'vitest'
import { changedNames } from './changedNames'
import type { GitResult } from '../worktrees/git'

const answering = (r: Partial<GitResult>) => {
  const calls: { args: string[]; cwd: string }[] = []
  const run = async (args: string[], opts: { cwd: string }) => (calls.push({ args, cwd: opts.cwd }), { ok: true, stdout: '', stderr: '', ...r })
  return { run, calls }
}

describe('changedNames', () => {
  it('lists the files git diff names from the head to HEAD, in the folder', async () => {
    const g = answering({ stdout: 'package.json\nsrc/a.ts\n\n' })
    expect(await changedNames(g.run, '/wt/run', 'b'.repeat(40))).toEqual(['package.json', 'src/a.ts'])
    expect(g.calls).toEqual([{ args: ['diff', '--name-only', 'b'.repeat(40), 'HEAD'], cwd: '/wt/run' }])
  })

  it('is null when git fails', async () => {
    expect(await changedNames(answering({ ok: false, exitCode: 128, stderr: 'fatal: bad revision' }).run, '/wt/run', 'x')).toBeNull()
  })
})
