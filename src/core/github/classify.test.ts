// The deterministic failure classes (GitHub lifecycle design L8, §4.5): a conclusion first, then causes outside the code,
// causes inside the code, and last the failing step's command or the check's name; with the line that decided it.
import { describe, it, expect } from 'vitest'
import { classifyCiFailure, type FailureInput } from './classify'

const input = (over: Partial<FailureInput> = {}): FailureInput => ({ conclusion: 'failure', output: '', annotationMessages: [], ...over })
const cls = (over: Partial<FailureInput> = {}): string => classifyCiFailure(input(over)).class
const cause = (over: Partial<FailureInput> = {}): string => classifyCiFailure(input(over)).cause

describe('classifyCiFailure', () => {
  it.each([
    ['startup-failure', 'infrastructure'],
    ['timed-out', 'timeout'],
    ['cancelled', 'cancelled'],
    ['action-required', 'permission']
  ] as const)('a %s conclusion is %s whatever the log says', (conclusion, expected) => {
    expect(cls({ conclusion, output: 'not ok 1 - adds' })).toBe(expected)
  })

  it.each([
    ['The runner has received a shutdown signal. This can happen when the runner service is stopped', 'infrastructure'],
    ['npm error network request to https://registry.npmjs.org/x failed, reason: read ECONNRESET', 'infrastructure'],
    ['npm error network request to https://registry.invalid/left-pad failed, reason: getaddrinfo ENOTFOUND registry.invalid', 'infrastructure'],
    ['System.IO.IOException: No space left on device', 'infrastructure'],
    ['remote: Resource not accessible by integration (HTTP 403)', 'permission'],
    ['Invalid workflow file: .github/workflows/ci.yml#L12', 'configuration'],
    ['The job running on runner GitHub Actions 3 has exceeded the maximum execution time of 360 minutes.', 'timeout'],
    ["src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", 'typecheck'],
    ['✖ 3 problems (3 errors, 0 warnings)', 'lint'],
    ["1:7  error  'unused' is assigned a value but never used  no-unused-vars", 'lint'],
    ['src/a.py:1:8: F401 [*] `os` imported but unused', 'lint'],
    ['= help: for further information visit https://rust-lang.github.io/rust-clippy/master/index.html#needless_return', 'lint'],
    ['Code style issues found in 2 files. Run Prettier with --write to fix.', 'lint'],
    ['not ok 1 - adds', 'test'],
    ['Tests:  2 failed, 10 passed, 12 total', 'test'],
    ['      Tests  1 failed (1)', 'test'],
    ['FAIL  src/add.test.ts > adds', 'test'],
    ['--- FAIL: TestAdd (0.00s)', 'test'],
    ['FAILED tests/test_add.py::test_adds - assert 1 == 2', 'test'],
    ['error[E0308]: mismatched types', 'build'],
    ['✘ [ERROR] Could not resolve "./missing"', 'build']
  ] as const)('reads %j as %s', (output, expected) => {
    expect(cls({ output })).toBe(expected)
  })

  it('reads a line the runner prefixed: a problem matcher turns a tool’s line into ##[error]', () => {
    expect(cls({ output: "##[error]index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'." })).toBe('typecheck')
  })

  it('a cause outside the code wins over a test failure in the same log', () => {
    expect(cls({ output: 'not ok 1 - adds\nError: read ECONNRESET' })).toBe('infrastructure')
  })

  // G2 final review I2: a server the tests start on this machine is the code under test
  it.each([
    'Error: connect ECONNREFUSED 127.0.0.1:3000',
    'Error: read ECONNRESET (localhost:8080)',
    'Error: connect ETIMEDOUT ::1:5432',
    'Error: connect ETIMEDOUT 0.0.0.0:80'
  ])('a connection to this machine in a failing test run is the code, not the network: %j', (line) => {
    expect(cls({ output: ` FAIL src/api.test.ts > api\n${line}` })).toBe('test')
  })

  it('a refused connection and a hung-up socket are not the network causes the design names', () => {
    expect(cls({ output: 'not ok 1 - api\nError: connect ECONNREFUSED 10.0.0.5:5432' })).toBe('test')
    expect(cls({ output: 'not ok 1 - api\nError: socket hang up' })).toBe('test')
  })

  // G2 final review I3: npm echoes the scripts it runs
  it('a tool’s name in npm’s echo of a script, or anywhere, is not that tool’s output', () => {
    expect(cls({ output: '> pretest\n> eslint .\n> test\n> node --test\nnot ok 1 - adds' })).toBe('test')
    expect(cls({ step: './ci.sh', output: 'running eslint, ruff and clippy\nexit 3' })).toBe('unknown')
  })

  // G2 final review M8
  it('a count of zero failures is not a failure', () => {
    expect(cls({ step: './ci.sh', output: 'Tests:  0 failed, 3 passed, 3 total\n0 failing\n      Tests  0 failed | 3 passed (3)' })).toBe('unknown')
  })

  // G2 final review I6, design §4.5: "infrastructure (environment when it is the toolchain setup step)"
  it('an outside cause in a toolchain setup step is environment; a setup step failing for its own reason is not', () => {
    expect(cls({ step: 'actions/setup-node@v4', output: 'Error: read ECONNRESET' })).toBe('environment')
    expect(cls({ step: 'sudo apt-get install -y libfoo', output: 'Could not resolve host: archive.ubuntu.com' })).toBe('environment')
    expect(cls({ step: 'actions/setup-node@v4', output: "Unable to find Node version '99' for platform linux" })).toBe('unknown')
    expect(cls({ step: 'actions/cache@v4', output: 'remote: Resource not accessible by integration (HTTP 403)' })).toBe('permission')
  })

  it('falls back to the failing step’s command, then to unknown', () => {
    expect(cls({ step: 'npm run lint', output: 'exit 1' })).toBe('lint')
    expect(cls({ step: 'npm run typecheck', output: 'exit 1' })).toBe('typecheck')
    expect(cls({ step: 'npm test', output: 'exit 1' })).toBe('test')
    expect(cls({ step: 'npm run build', output: 'exit 1' })).toBe('build')
    expect(cls({ step: './deploy.sh', output: 'exit 1' })).toBe('unknown')
    expect(cls({})).toBe('unknown')
  })

  // G2 final review I7, Review Focus 5
  it('with no step to go by, the check’s name says what ran; with a step, the step does', () => {
    expect(cls({ name: 'ci/circleci: lint' })).toBe('lint')
    expect(cls({ name: 'test (ubuntu-latest, 22)' })).toBe('test')
    expect(cls({ name: 'deploy-preview' })).toBe('unknown')
    expect(cls({ step: 'actions/setup-node@v4', name: 'test', output: "Unable to find Node version '99'" })).toBe('unknown')
  })

  it('a workflow that ran no job could not run: its file is the cause', () => {
    expect(classifyCiFailure(input({ ranNoJob: true, name: '.github/workflows/ci.yml' }))).toEqual({
      class: 'configuration',
      cause: 'the workflow file could not run: no job started'
    })
    expect(cls({ ranNoJob: true, conclusion: 'startup-failure' })).toBe('infrastructure')
  })

  it('reads annotations too: a runner annotation can name the cause', () => {
    expect(cls({ annotationMessages: ['The hosted runner encountered an error while running your job.'] })).toBe('infrastructure')
  })
})

describe('the cause classifyCiFailure gives', () => {
  // G2 final review I4
  it('is the line the deciding rule matched, without the runner prefix', () => {
    expect(classifyCiFailure(input({ output: 'not ok 1 - adds\nError: read ECONNRESET' }))).toEqual({ class: 'infrastructure', cause: 'Error: read ECONNRESET' })
    expect(cause({ output: "x\n##[error]index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'." })).toBe(
      "index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'."
    )
    expect(cause({ output: '> x@1 test\nnot ok 1 - adds\n# fail 1\n##[error]Process completed with exit code 1.' })).toBe('not ok 1 - adds')
  })

  it('for a class a conclusion decided, the line of that class’s rule, else the fallbacks', () => {
    expect(cause({ conclusion: 'timed-out', output: 'not ok 1\n##[error]The job has exceeded the maximum execution time of 10 minutes.' })).toBe(
      'The job has exceeded the maximum execution time of 10 minutes.'
    )
    expect(cause({ conclusion: 'cancelled', output: '' })).toBe('cancelled')
  })

  // G2 final review M3
  it('else the first line of the first annotation', () => {
    expect(cause({ output: 'just output', annotationMessages: ['src/a.ts: bad\nmore detail'] })).toBe('src/a.ts: bad')
  })

  // G2 final review M9
  it('else the last line of output: not a group header, not npm’s echo, not the runner’s exit line; else the conclusion', () => {
    expect(cause({ output: '##[group]Run ./deploy.sh\n> x@1 deploy\nfirst\nlast words\n##[error]Process completed with exit code 2.' })).toBe('last words')
    expect(cause({ output: '##[group]Run ./deploy.sh\n##[error]Process completed with exit code 1.' })).toBe('failure')
    expect(cause({ conclusion: undefined })).toBe('failure')
  })
})
