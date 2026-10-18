// The git and gh steps the Host takes for a lifecycle round (GitHub lifecycle G3b1, design §4.2-4.3), on fake runners
// that answer with git's and gh's own words.
import { describe, it, expect } from 'vitest'
import type { GhResult } from './gh'
import type { GitResult } from '../worktrees/git'
import { createDraftPr, headOf, prNumberOf, pushBranch, refsLine, type RunGit } from './lifecyclePush'

const repo = { host: 'github.com', owner: 'parsingk', name: 'astera-lifecycle-sandbox' }
const gitAnswering = (r: Partial<GitResult>) => {
  const calls: { args: string[]; cwd: string; timeoutMs?: number }[] = []
  const run: RunGit = async (args, opts) => (calls.push({ args, ...opts }), { ok: true, stdout: '', stderr: '', ...r })
  return { run, calls }
}

describe('pushBranch', () => {
  it('pushes the branch to origin, never forced, and sets its upstream', async () => {
    const g = gitAnswering({ ok: true, stderr: 'Everything up-to-date' })
    expect(await pushBranch(g.run, '/wt', 'u/a')).toEqual({ ok: true })
    expect(g.calls[0]).toMatchObject({ args: ['push', '-u', 'origin', 'u/a'], cwd: '/wt' })
    expect(g.calls[0].args).not.toContain('--force')
  })

  it.each([
    [' ! [rejected]        u/a -> u/a (fetch first)\nerror: failed to push some refs to \'github.com:o/r.git\'', 'rejected'],
    [' ! [rejected]        u/a -> u/a (non-fast-forward)', 'rejected'],
    ['remote: Permission to o/r.git denied to someone.\nfatal: unable to access \'https://github.com/o/r.git/\': The requested URL returned error: 403', 'auth'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'auth'],
    ["fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com", 'network'],
    ['ssh: connect to host github.com port 22: Connection timed out', 'network'],
    ['fatal: something else entirely', 'other']
  ] as const)('tells a failed push apart: %j is %s', async (stderr, kind) => {
    const r = await pushBranch(gitAnswering({ ok: false, exitCode: 1, stderr }).run, '/wt', 'u/a')
    expect(r).toMatchObject({ ok: false, kind })
  })

  // Measured on the sandbox: git's first line names the remote, not the refusal
  it('says the line that tells why, not the remote it was pushing to', async () => {
    const stderr = [
      'To https://github.com/parsingk/astera-lifecycle-sandbox.git',
      ' ! [rejected]        u/g3b1-check -> u/g3b1-check (fetch first)',
      "error: failed to push some refs to 'https://github.com/parsingk/astera-lifecycle-sandbox.git'"
    ].join('\n')
    expect(await pushBranch(gitAnswering({ ok: false, exitCode: 1, stderr }).run, '/wt', 'u/a')).toEqual({
      ok: false, kind: 'rejected', detail: '! [rejected]        u/g3b1-check -> u/g3b1-check (fetch first)'
    })
  })

  it('a push that ran out of time is a network failure', async () => {
    expect(await pushBranch(gitAnswering({ ok: false, timedOut: true, stderr: '' }).run, '/wt', 'u/a')).toMatchObject({ ok: false, kind: 'network' })
  })
})

describe('headOf', () => {
  it('is the commit HEAD names, or null when git cannot say', async () => {
    expect(await headOf(gitAnswering({ stdout: `${'a'.repeat(40)}\n` }).run, '/wt')).toBe('a'.repeat(40))
    expect(await headOf(gitAnswering({ ok: false, exitCode: 128, stderr: 'fatal' }).run, '/wt')).toBeNull()
  })
})

describe('refsLine', () => {
  const source = (url: string) => ({ id: 'github', itemId: '7', label: 'GitHub issue #7', url })
  it('refers to an issue of the same repository, whatever the case, and never closes it', () => {
    expect(refsLine(source('https://github.com/Parsingk/Astera-Lifecycle-Sandbox/issues/7'), repo)).toBe('Refs #7')
  })
  it('says nothing for another repository’s issue, another source, or none', () => {
    expect(refsLine(source('https://github.com/someone/else/issues/7'), repo)).toBeNull()
    expect(refsLine({ id: 'plugin:x', itemId: '7', label: 'x' }, repo)).toBeNull()
    expect(refsLine(undefined, repo)).toBeNull()
  })
})

describe('prNumberOf', () => {
  it('reads the number of a pull request URL', () => {
    expect(prNumberOf('https://github.com/o/r/pull/34\n')).toBe(34)
    expect(prNumberOf('https://github.com/o/r/issues/34')).toBeNull()
  })
})

describe('createDraftPr', () => {
  const ghAnswering = (r: Partial<GhResult>) => {
    const calls: string[][] = []
    const run = async (args: string[]): Promise<GhResult> => (calls.push(args), { ok: true, stdout: '', stderr: '', ...r })
    return { run, calls }
  }
  const pr = { base: 'main', head: 'u/a', title: 'Fix add', body: 'Body\n\nRefs #7' }

  it('opens a draft pull request in the repository named, from the branch named, and reads its number', async () => {
    const g = ghAnswering({ stdout: 'https://github.com/parsingk/astera-lifecycle-sandbox/pull/3\n' })
    expect(await createDraftPr(g.run, '/wt', repo, pr)).toEqual({ ok: true, number: 3, url: 'https://github.com/parsingk/astera-lifecycle-sandbox/pull/3' })
    expect(g.calls[0]).toEqual(['pr', 'create', '--draft', '--repo', 'parsingk/astera-lifecycle-sandbox', '--base', 'main', '--head', 'u/a', '--title', 'Fix add', '--body', 'Body\n\nRefs #7'])
  })

  it('a pull request that already exists for the branch is read from gh’s words, not made twice', async () => {
    const g = ghAnswering({
      ok: false,
      exitCode: 1,
      stderr: 'a pull request for branch "u/a" into branch "main" already exists:\nhttps://github.com/parsingk/astera-lifecycle-sandbox/pull/3'
    })
    expect(await createDraftPr(g.run, '/wt', repo, pr)).toEqual({ ok: true, number: 3, url: 'https://github.com/parsingk/astera-lifecycle-sandbox/pull/3', existed: true })
  })

  it('passes any other failure on', async () => {
    const g = ghAnswering({ ok: false, exitCode: 1, stderr: 'HTTP 403: Resource not accessible by integration' })
    expect(await createDraftPr(g.run, '/wt', repo, pr)).toMatchObject({ ok: false })
  })
})
