import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { failedLogTail, parsePrChecks, prChecksArgs, readPrChecks, rerunFailed, runIdOf } from './checks'
import type { GhResult, GhRunner } from './gh'

// fixtures/pr-checks.json: the first two rows of
// `gh pr checks 3 --json name,state,bucket,link,workflow,startedAt,completedAt` against parsingk/Astera,
// gh 2.97.0, 2026-10-02. All checks passed and gh exited 0. Exit codes for failing (1) and pending (8)
// checks could not be measured on this repository (no PR with such checks); they are gh's documented codes.
// A PR number that does not exist (`gh pr checks 2`) measured exit 1 with stderr
// "GraphQL: Could not resolve to a PullRequest with the number of 2. (repository.pullRequest)".
const FIXTURE = readFileSync(join(__dirname, 'fixtures/pr-checks.json'), 'utf8')

const result = (over: Partial<GhResult>): GhResult => ({ ok: false, stdout: '', stderr: '', ...over })
const answering = (r: GhResult, calls: string[][] = []): GhRunner => async (args) => {
  calls.push(args)
  return r
}

const pendingRow = {
  bucket: 'pending',
  completedAt: '0001-01-01T00:00:00Z',
  link: 'https://github.com/o/r/actions/runs/42/job/7',
  name: 'build',
  startedAt: '0001-01-01T00:00:00Z',
  state: 'QUEUED',
  workflow: 'CI'
}

describe('prChecksArgs', () => {
  it('asks for exactly the fields the parser reads', () => {
    expect(prChecksArgs(3)).toEqual([
      'pr',
      'checks',
      '3',
      '--json',
      'name,state,bucket,link,workflow,startedAt,completedAt'
    ])
  })
})

describe('parsePrChecks', () => {
  it('parses the real gh output', () => {
    expect(parsePrChecks(FIXTURE)).toEqual([
      {
        name: 'build (windows-latest)',
        workflow: 'CI',
        state: 'SUCCESS',
        bucket: 'pass',
        link: 'https://github.com/parsingk/Astera/actions/runs/33575878266/job/100079618840',
        runId: 33575878266,
        startedAt: '2026-09-02T00:34:24Z',
        completedAt: '2026-09-02T00:38:23Z'
      },
      {
        name: 'build (macos-latest)',
        workflow: 'CI',
        state: 'SUCCESS',
        bucket: 'pass',
        link: 'https://github.com/parsingk/Astera/actions/runs/33575878266/job/100079618618',
        runId: 33575878266,
        startedAt: '2026-09-02T00:34:24Z',
        completedAt: '2026-09-02T00:35:45Z'
      }
    ])
  })

  it('malformed JSON or a non-array is null', () => {
    expect(parsePrChecks('no checks')).toBeNull()
    expect(parsePrChecks('{"name":"x"}')).toBeNull()
  })

  it('one malformed row is skipped, the rest kept', () => {
    const rows = JSON.parse(FIXTURE) as unknown[]
    const checks = parsePrChecks(JSON.stringify([{ name: 7 }, null, rows[1]]))
    expect(checks!.map((c) => c.name)).toEqual(['build (macos-latest)'])
  })

  it("Go's zero time (a check not started) reads as null", () => {
    const [check] = parsePrChecks(JSON.stringify([pendingRow]))!
    expect(check.startedAt).toBeNull()
    expect(check.completedAt).toBeNull()
    expect(check.runId).toBe(42)
  })
})

describe('runIdOf', () => {
  it('reads the run id from an Actions link', () => {
    expect(runIdOf('https://github.com/parsingk/Astera/actions/runs/33575878266/job/100079618840')).toBe(
      33575878266
    )
  })

  it('a commit status link has no run id', () => {
    expect(runIdOf('https://ci.example.com/builds/1234')).toBeNull()
    expect(runIdOf('')).toBeNull()
  })
})

describe('readPrChecks', () => {
  it('runs the checks argv in the given folder', async () => {
    const seen: { args: string[]; cwd: string }[] = []
    const run: GhRunner = async (args, cwd) => {
      seen.push({ args, cwd })
      return result({ ok: true, stdout: FIXTURE, exitCode: 0 })
    }
    const r = await readPrChecks(run, 'D:/repo', 3)
    expect(seen).toEqual([{ args: prChecksArgs(3), cwd: 'D:/repo' }])
    expect(r.ok && r.checks).toHaveLength(2)
  })

  it('exit 8 (pending) with JSON is a result', async () => {
    const r = await readPrChecks(answering(result({ exitCode: 8, stdout: JSON.stringify([pendingRow]) })), 'd', 1)
    expect(r).toMatchObject({ ok: true, checks: [{ name: 'build', bucket: 'pending' }] })
  })

  it('exit 1 (failing) with JSON is a result', async () => {
    const failing = { ...pendingRow, bucket: 'fail', state: 'FAILURE' }
    const r = await readPrChecks(answering(result({ exitCode: 1, stdout: JSON.stringify([failing]) })), 'd', 1)
    expect(r).toMatchObject({ ok: true, checks: [{ bucket: 'fail' }] })
  })

  it('another exit code with JSON is still a failure', async () => {
    const r = await readPrChecks(answering(result({ exitCode: 4, stdout: FIXTURE, stderr: 'boom' })), 'd', 1)
    expect(r.ok).toBe(false)
  })

  it('"no checks reported" is an empty list', async () => {
    const r = await readPrChecks(
      answering(result({ exitCode: 1, stderr: "no checks reported on the 'feat/x' branch" })),
      'd',
      1
    )
    expect(r).toEqual({ ok: true, checks: [] })
  })

  it('gh missing gives the not-installed sentence', async () => {
    const r = await readPrChecks(answering(result({ spawnError: 'ENOENT' })), 'd', 1)
    expect(r).toEqual({
      ok: false,
      kind: 'not-installed',
      message: "GitHub CLI (gh) is not installed or not on the Astera Host's PATH"
    })
  })

  it('an auth failure gives the gh auth login sentence', async () => {
    const r = await readPrChecks(
      answering(result({ exitCode: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' })),
      'd',
      1
    )
    expect(r).toEqual({ ok: false, kind: 'auth', message: 'gh is not logged in: run `gh auth login`' })
  })

  it('exit 0 with output that is not JSON is a failure, not an empty list', async () => {
    const r = await readPrChecks(answering(result({ ok: true, exitCode: 0, stdout: 'garbage' })), 'd', 1)
    expect(r).toMatchObject({ ok: false, kind: 'other' })
  })
})

describe('failedLogTail', () => {
  it('runs gh run view --log-failed and keeps a short log whole', async () => {
    const calls: string[][] = []
    const r = await failedLogTail(answering(result({ ok: true, stdout: 'line 1\nline 2' }), calls), 'd', 42)
    expect(calls).toEqual([['run', 'view', '42', '--log-failed']])
    expect(r).toEqual({ ok: true, text: 'line 1\nline 2', cut: false })
  })

  it('keeps the last 8000 characters and drops the partial first line', async () => {
    const line = 'x'.repeat(29) + '\n' // 30 chars a line; 8000 is not a multiple, so the cut falls inside one
    const log = line.repeat(400) // 12 000 chars
    const r = await failedLogTail(answering(result({ ok: true, stdout: log })), 'd', 42)
    expect(r).toEqual({ ok: true, text: line.repeat(266), cut: true }) // 7980: the partial 20 are gone
  })

  it('a failure maps to a sentence', async () => {
    const r = await failedLogTail(
      answering(result({ stderr: 'failed to get run: HTTP 404: Not Found (https://api.github.com/repos/o/r/actions/runs/1)' })),
      'd',
      1
    )
    expect(r).toMatchObject({ ok: false, kind: 'not-found' })
  })
})

describe('rerunFailed', () => {
  it('runs gh run rerun --failed', async () => {
    const calls: string[][] = []
    const r = await rerunFailed(answering(result({ ok: true }), calls), 'd', 42)
    expect(calls).toEqual([['run', 'rerun', '42', '--failed']])
    expect(r).toEqual({ ok: true })
  })

  it('a failure maps to a sentence', async () => {
    const r = await rerunFailed(answering(result({ stderr: 'HTTP 403: API rate limit exceeded for user ID 1' })), 'd', 42)
    expect(r).toEqual({
      ok: false,
      kind: 'rate-limit',
      message: 'GitHub rate limit reached: HTTP 403: API rate limit exceeded for user ID 1'
    })
  })
})
