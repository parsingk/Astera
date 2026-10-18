// The evidence of a failed check (GitHub lifecycle design §4.7): the failing step's lines, the annotations that say
// something, a class and a summary, all bounded and redacted.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { GhRunner } from './gh'
import type { GitHubCiCheck } from './lifecycle'
import { DIAGNOSTICS_MAX, LOG_EXCERPT_CHARS, LOG_EXCERPT_LINES, ciFailureEvidence, diagnosticsFrom, excerptFromJobLog, readAnnotations, readJobLog } from './evidence'

const realLog = readFileSync(path.join(__dirname, 'fixtures', 'job-log-node-test.txt'), 'utf8')
const line = (text: string): string => `test\tUNKNOWN STEP\t2026-10-17T20:32:40.5407041Z ${text}`
const check = (over: Partial<GitHubCiCheck> = {}): GitHubCiCheck => ({
  externalId: 'run:117497085011', name: 'test', status: 'completed', conclusion: 'failure', required: false, jobId: 117497085011,
  detailsUrl: 'https://github.com/o/r/actions/runs/1/job/117497085011', ...over
})
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

describe('excerptFromJobLog', () => {
  it('keeps the failing step of the real log, from its Run line to the error, without prefixes, colours or cleanup', () => {
    const { excerpt, step } = excerptFromJobLog(realLog)
    expect(step).toBe('npm test')
    expect(excerpt.split('\n')[0]).toBe('##[group]Run npm test')
    expect(excerpt).toContain('not ok 1 - adds')
    expect(excerpt).toContain('expected: 5')
    expect(excerpt.split('\n').at(-1)).toBe('##[error]Process completed with exit code 1.')
    expect(excerpt).not.toContain('Post job cleanup')
    // gh writes the colour codes as the text `^[[36;1m` (measured), and could write the ESC byte
    expect(excerpt).not.toMatch(/\x1b\[|\^\[\[|2026-10-17T|\tUNKNOWN STEP\t|﻿/)
  })

  // Review Focus 1
  it('without an error line, keeps the last lines before the cleanup', () => {
    const raw = [line('##[group]Run npm test'), line('working'), line('still working'), line('Post job cleanup.'), line('git config noise')].join('\n')
    expect(excerptFromJobLog(raw)).toEqual({ excerpt: '##[group]Run npm test\nworking\nstill working', step: 'npm test' })
  })

  it('keeps at most 80 lines and 4000 characters, from the end', () => {
    const many = [line('##[group]Run npm test'), ...Array.from({ length: 300 }, (_, i) => line(`out ${i} ${'x'.repeat(60)}`)), line('##[error]Process completed with exit code 1.')].join('\n')
    const { excerpt } = excerptFromJobLog(many)
    expect(excerpt.split('\n').length).toBeLessThanOrEqual(LOG_EXCERPT_LINES)
    expect(excerpt.length).toBeLessThanOrEqual(LOG_EXCERPT_CHARS)
    expect(excerpt.split('\n').at(-1)).toBe('##[error]Process completed with exit code 1.')
  })

  it('strips the ESC form of a colour code too', () => {
    expect(excerptFromJobLog(line('\x1b[31mred\x1b[0m')).excerpt).toBe('red')
  })
})

describe('diagnosticsFrom', () => {
  it('drops the runner’s boilerplate and notices, keeps failures and warnings with real paths', () => {
    const d = diagnosticsFrom([
      { path: '.github', start_line: 43, annotation_level: 'failure', message: 'Process completed with exit code 1.' },
      { path: '.github', start_line: 2, annotation_level: 'warning', message: 'Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24' },
      { path: '.github', start_line: 1, annotation_level: 'notice', message: 'The ubuntu-latest label will migrate to Ubuntu 26' },
      { path: 'src/a.ts', start_line: 3, annotation_level: 'failure', message: "Type 'string' is not assignable to type 'number'." },
      { path: '.github', start_line: 9, annotation_level: 'failure', message: 'The hosted runner encountered an error while running your job.' }
    ])
    expect(d).toEqual([
      { path: 'src/a.ts', line: 3, message: "Type 'string' is not assignable to type 'number'." },
      { message: 'The hosted runner encountered an error while running your job.' }
    ])
  })
  it('keeps at most 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ path: `f${i}.ts`, start_line: i, annotation_level: 'failure', message: `m${i}` }))
    expect(diagnosticsFrom(many)).toHaveLength(DIAGNOSTICS_MAX)
  })
})

describe('ciFailureEvidence', () => {
  it('classifies the real log as test and says why in one line', () => {
    const e = ciFailureEvidence({ check: check(), log: realLog, annotations: [{ path: '.github', start_line: 43, annotation_level: 'failure', message: 'Process completed with exit code 1.' }] })
    expect(e).toMatchObject({ check: 'test', externalId: 'run:117497085011', class: 'test', summary: 'test (test): not ok 1 - adds', diagnostics: [], url: 'https://github.com/o/r/actions/runs/1/job/117497085011' })
    expect(e.logExcerpt).toContain('AssertionError')
  })

  // Review Focus 2
  it('never keeps a secret the step printed, in the excerpt, the summary or a diagnostic', () => {
    const raw = [line('##[group]Run ./ci.sh'), line(`export GITHUB_TOKEN=${TOKEN}`), line(`not ok 1 - leaked ${TOKEN}`), line('##[error]Process completed with exit code 1.')].join('\n')
    const e = ciFailureEvidence({ check: check(), log: raw, annotations: [{ path: 'a.sh', start_line: 1, annotation_level: 'failure', message: `token ${TOKEN}` }] })
    expect(JSON.stringify(e)).not.toContain(TOKEN)
  })

  // Review Focus 5
  it('a commit status with no log is classified from its conclusion and name only', () => {
    const e = ciFailureEvidence({ check: check({ externalId: 'status:ci/ext', name: 'ci/ext', jobId: undefined, detailsUrl: undefined }) })
    expect(e).toEqual({ check: 'ci/ext', externalId: 'status:ci/ext', class: 'unknown', summary: 'ci/ext (unknown): failure', diagnostics: [] })
  })

  it('keeps the summary within 1000 characters', () => {
    const raw = [line('##[group]Run npm test'), line(`not ok 1 - ${'y'.repeat(3000)}`), line('##[error]Process completed with exit code 1.')].join('\n')
    expect(ciFailureEvidence({ check: check(), log: raw }).summary.length).toBeLessThanOrEqual(1000)
  })
})

describe('readers', () => {
  const repo = { host: 'github.com', owner: 'o', name: 'r' }
  it('reads a job’s failed log through gh run view, in the repository named', async () => {
    const calls: string[][] = []
    const run: GhRunner = async (args) => (calls.push(args), { ok: true, stdout: 'log', stderr: '' })
    expect(await readJobLog(run, '/wt', repo, 7)).toEqual({ ok: true, log: 'log' })
    expect(calls[0]).toEqual(['run', 'view', '--job', '7', '--log-failed', '--repo', 'o/r'])
  })
  it('reads a check run’s annotations through the REST API', async () => {
    const calls: string[][] = []
    const run: GhRunner = async (args) => (calls.push(args), { ok: true, stdout: JSON.stringify([{ path: 'a', start_line: 1, annotation_level: 'failure', message: 'm' }]), stderr: '' })
    expect(await readAnnotations(run, '/wt', repo, 7)).toEqual({ ok: true, annotations: [{ path: 'a', start_line: 1, annotation_level: 'failure', message: 'm' }] })
    expect(calls[0]).toEqual(['api', 'repos/o/r/check-runs/7/annotations?per_page=50'])
  })
  it('passes gh failures on', async () => {
    const run: GhRunner = async () => ({ ok: false, stdout: '', stderr: 'HTTP 404: Not Found', exitCode: 1 })
    expect(await readJobLog(run, '/wt', repo, 7)).toMatchObject({ ok: false, kind: 'not-found' })
    expect(await readAnnotations(run, '/wt', repo, 7)).toMatchObject({ ok: false, kind: 'not-found' })
  })
})
