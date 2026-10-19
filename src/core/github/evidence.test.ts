// The evidence of a failed check (GitHub lifecycle design §4.7): the failing step's lines, the annotations that say
// something, a class and a summary, all bounded and redacted. The job logs and annotations under fixtures/ are real
// (the sandbox, design §10).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { GhRunner } from './gh'
import type { GitHubCiCheck } from './lifecycle'
import {
  DIAGNOSTICS_MAX,
  LOG_EXCERPT_CHARS,
  LOG_EXCERPT_LINES,
  ciFailureEvidence,
  diagnosticsFrom,
  excerptFromJobLog,
  readAnnotations,
  readJobLog,
  type RawAnnotation
} from './evidence'

const fixture = (name: string): string => readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
const realLog = fixture('job-log-node-test.txt')
const realAnnotations = JSON.parse(fixture('annotations-fixture-jobs.json')) as Record<string, RawAnnotation[]>
const line = (text: string): string => `test\tUNKNOWN STEP\t2026-10-17T20:32:40.5407041Z ${text}`
const check = (over: Partial<GitHubCiCheck> = {}): GitHubCiCheck => ({
  externalId: 'run:117497085011', name: 'test', status: 'completed', conclusion: 'failure', required: false, jobId: 117497085011,
  ciRunId: 39050000000, detailsUrl: 'https://github.com/o/r/actions/runs/1/job/117497085011', ...over
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
    // gh writes the colour codes as the text `^[[36;1m` (measured), and could write the ESC byte; the first line's
    // timestamp carries a BOM, a format character
    expect(excerpt).not.toMatch(/\x1b\[|\^\[\[|2026-10-17T|\tUNKNOWN STEP\t|\p{Cf}/u)
  })

  it('a line the runner continued without a timestamp keeps no job or step column (real vitest log)', () => {
    const { excerpt, output } = excerptFromJobLog(fixture('job-log-vitest.txt'))
    expect(excerpt).not.toMatch(/\tRun npx vitest run\t|^vitest\t/m)
    expect(output).toContain('- Expected')
  })

  it('the output leaves the step’s header out: its command and shell are not output (real eslint log)', () => {
    const { excerpt, output, step } = excerptFromJobLog(fixture('job-log-eslint.txt'))
    expect(step).toBe('npx eslint .')
    expect(excerpt.split('\n').slice(0, 3)).toEqual(['##[group]Run npx eslint .', 'npx eslint .', 'shell: /usr/bin/bash -e {0}'])
    expect(output).not.toMatch(/npx eslint|shell:/)
    expect(output).toContain('✖ 1 problem (1 error, 0 warnings)')
  })

  // Review Focus 1
  it('without an error line, keeps the last lines before the cleanup', () => {
    const raw = [line('##[group]Run npm test'), line('working'), line('still working'), line('Post job cleanup.'), line('git config noise')].join('\n')
    expect(excerptFromJobLog(raw)).toEqual({ excerpt: '##[group]Run npm test\nworking\nstill working', output: 'working\nstill working', step: 'npm test' })
  })

  // G2 final review M2
  it('an error on the very last line ends the step there, even after the cleanup began', () => {
    const raw = [line('##[group]Run npm test'), line('out'), line('Post job cleanup.'), line('cleanup out'), line('##[error]cleanup failed')].join('\n')
    expect(excerptFromJobLog(raw).excerpt.split('\n').at(-1)).toBe('##[error]cleanup failed')
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

  // G3b1 final review M5: a warning stays a warning where the evidence is shown
  it('marks a warning as one', () => {
    expect(diagnosticsFrom([{ path: 'a.ts', start_line: 1, annotation_level: 'warning', message: 'unused' }])).toEqual([{ path: 'a.ts', line: 1, message: 'unused', warning: true }])
  })
  // G2 final review I5
  it('redacts a message before cutting it, so no part of a secret is left', () => {
    const [d] = diagnosticsFrom([{ path: 'a.sh', start_line: 1, annotation_level: 'failure', message: `${'x'.repeat(490)} ${TOKEN}` }])
    expect(d.message).not.toContain('ghp_')
    expect(d.message.length).toBeLessThanOrEqual(500)
  })
})

describe('ciFailureEvidence', () => {
  // G4 final review M2: the run to rerun is known whatever the snapshot keeps of the checks
  it('carries the failing check’s Actions run and its attempt', () => {
    const f = ciFailureEvidence({ check: { externalId: 'run:70', name: 'npm-network', status: 'completed', conclusion: 'startup-failure', required: false, jobId: 70, ciRunId: 9, ciRunAttempt: 2 } })
    expect(f).toMatchObject({ externalId: 'run:70', ciRunId: 9, ciRunAttempt: 2 })
    expect(ciFailureEvidence({ check: { externalId: 'status:ci/x', name: 'ci/x', status: 'completed', conclusion: 'failure', required: false } })).not.toHaveProperty('ciRunId')
  })

  it('classifies the real log as test and says why in one line', () => {
    const e = ciFailureEvidence({ check: check(), log: realLog, annotations: [{ path: '.github', start_line: 43, annotation_level: 'failure', message: 'Process completed with exit code 1.' }] })
    expect(e).toMatchObject({ check: 'test', externalId: 'run:117497085011', class: 'test', summary: 'test (test): not ok 1 - adds', diagnostics: [], url: 'https://github.com/o/r/actions/runs/1/job/117497085011' })
    expect(e.logExcerpt).toContain('AssertionError')
  })

  // design §10, G2 final review M13: real Actions logs and annotations from the sandbox
  it.each([
    ['vitest', 'test', 'vitest (test): ❯ sum.test.js (1 test | 1 failed) 13ms', [{ path: 'fixtures/vitest/sum.test.js', line: 4 }]],
    ['tsc', 'typecheck', "tsc (typecheck): index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.", [{}]],
    ['eslint', 'lint', "eslint (lint): 1:7  error  'unused' is assigned a value but never used  no-unused-vars", [{ path: 'fixtures/eslint/index.js', line: 1 }]],
    ['pretest-eslint', 'test', 'pretest-eslint (test): not ok 1 - adds', []],
    ['localhost-refused', 'test', 'localhost-refused (test): not ok 1 - the api answers', []],
    ['npm-network', 'infrastructure', 'npm-network (infrastructure): npm error network request to https://registry.invalid/left-pad failed, reason: getaddrinfo ENOTFOUND registry.invalid', []]
  ] as const)('the real %s log is %s', (name, cls, summary, where) => {
    const e = ciFailureEvidence({ check: check({ name }), log: fixture(`job-log-${name}.txt`), annotations: realAnnotations[name] })
    expect(e.class).toBe(cls)
    expect(e.summary).toBe(summary)
    expect(e.diagnostics.map((d) => ({ ...(d.path ? { path: d.path } : {}), ...(d.line !== undefined ? { line: d.line } : {}) }))).toEqual(where)
  })

  // G2 final review I2
  it('only failure annotations classify: a warning that names a network error leaves a test failure a test', () => {
    const annotations = [...realAnnotations['pretest-eslint'], { path: '.github', start_line: 7, annotation_level: 'warning', message: 'Failed to restore cache: read ECONNRESET' }]
    expect(ciFailureEvidence({ check: check({ name: 'pretest-eslint' }), log: fixture('job-log-pretest-eslint.txt'), annotations }).class).toBe('test')
  })

  // Review Focus 2
  it('never keeps a secret the step printed, in the excerpt, the summary or a diagnostic', () => {
    const raw = [line('##[group]Run ./ci.sh'), line(`export GITHUB_TOKEN=${TOKEN}`), line(`not ok 1 - leaked ${TOKEN}`), line('##[error]Process completed with exit code 1.')].join('\n')
    const e = ciFailureEvidence({ check: check(), log: raw, annotations: [{ path: 'a.sh', start_line: 1, annotation_level: 'failure', message: `token ${TOKEN}` }] })
    expect(JSON.stringify(e)).not.toContain(TOKEN)
  })

  // G2 final review I5, M6
  it('leaves no part of a secret in a summary made from a long annotation, nor a credential in the details URL', () => {
    const e = ciFailureEvidence({
      check: check({ jobId: undefined, detailsUrl: 'https://ci.example/build/7?token=abcdef0123456789abcdef' }),
      annotations: [{ path: 'a.sh', start_line: 1, annotation_level: 'failure', message: `${'x'.repeat(990)} ${TOKEN}` }]
    })
    expect(JSON.stringify(e)).not.toContain('ghp_')
    expect(e.url).not.toContain('abcdef0123456789abcdef')
  })

  // Review Focus 5, G2 final review I7
  it('a commit status with no log is classified from its conclusion and name only', () => {
    const status = (name: string): GitHubCiCheck => check({ externalId: `status:${name}`, name, jobId: undefined, ciRunId: undefined, detailsUrl: undefined })
    expect(ciFailureEvidence({ check: status('ci/ext') })).toEqual({ check: 'ci/ext', externalId: 'status:ci/ext', class: 'unknown', summary: 'ci/ext (unknown): failure', diagnostics: [] })
    expect(ciFailureEvidence({ check: status('ci/circleci: lint') })).toMatchObject({ class: 'lint', summary: 'ci/circleci: lint (lint): failure' })
  })

  it('a workflow that failed before any job is the workflow file’s fault', () => {
    const suite = check({ externalId: 'suite:39099661750', name: '.github/workflows/invalid.yml', jobId: undefined, ciRunId: 39099661750, detailsUrl: 'https://github.com/o/r/actions/runs/39099661750' })
    expect(ciFailureEvidence({ check: suite })).toEqual({
      check: '.github/workflows/invalid.yml',
      externalId: 'suite:39099661750',
      class: 'configuration',
      summary: '.github/workflows/invalid.yml (configuration): the workflow file could not run: no job started',
      diagnostics: [],
      url: 'https://github.com/o/r/actions/runs/39099661750',
      ciRunId: 39099661750
    })
  })

  // G3b1 final review M5: how many there were when more than the 20 kept
  it('says how many diagnostics there were when it kept fewer', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ path: `f${i}.ts`, start_line: i, annotation_level: 'failure', message: `m${i}` }))
    expect(ciFailureEvidence({ check: check(), annotations: many })).toMatchObject({ diagnosticsTotal: 30 })
    expect(ciFailureEvidence({ check: check(), annotations: many.slice(0, 3) })).not.toHaveProperty('diagnosticsTotal')
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
  // G2 final review M7
  it('keeps only the objects of an annotations answer', async () => {
    const run: GhRunner = async () => ({ ok: true, stdout: JSON.stringify([null, 'x', 3, { annotation_level: 'failure', message: 'm' }]), stderr: '' })
    expect(await readAnnotations(run, '/wt', repo, 7)).toEqual({ ok: true, annotations: [{ annotation_level: 'failure', message: 'm' }] })
  })
  it('passes gh failures on', async () => {
    const run: GhRunner = async () => ({ ok: false, stdout: '', stderr: 'HTTP 404: Not Found', exitCode: 1 })
    expect(await readJobLog(run, '/wt', repo, 7)).toMatchObject({ ok: false, kind: 'not-found' })
    expect(await readAnnotations(run, '/wt', repo, 7)).toMatchObject({ ok: false, kind: 'not-found' })
  })
})
