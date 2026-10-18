// The deterministic failure classes (GitHub lifecycle design L8, §4.5): a conclusion first, then causes outside the code,
// a setup step, causes inside the code, and last the failing step's command.
import { describe, it, expect } from 'vitest'
import { classifyCiFailure, failureCause, type FailureInput } from './classify'

const input = (over: Partial<FailureInput> = {}): FailureInput => ({ conclusion: 'failure', excerpt: '', annotationMessages: [], ...over })

describe('classifyCiFailure', () => {
  it.each([
    ['startup-failure', 'infrastructure'],
    ['timed-out', 'timeout'],
    ['cancelled', 'cancelled'],
    ['action-required', 'permission']
  ] as const)('a %s conclusion is %s whatever the log says', (conclusion, cls) => {
    expect(classifyCiFailure(input({ conclusion, excerpt: 'not ok 1 - adds' }))).toBe(cls)
  })

  it.each([
    ['The runner has received a shutdown signal. This can happen when the runner service is stopped', 'infrastructure'],
    ['npm error network request to https://registry.npmjs.org/x failed, reason: read ECONNRESET', 'infrastructure'],
    ['System.IO.IOException: No space left on device', 'infrastructure'],
    ['remote: Resource not accessible by integration (HTTP 403)', 'permission'],
    ['Invalid workflow file: .github/workflows/ci.yml#L12', 'configuration'],
    ['The job running on runner GitHub Actions 3 has exceeded the maximum execution time of 360 minutes.', 'timeout'],
    ["src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", 'typecheck'],
    ['✖ 3 problems (3 errors, 0 warnings)', 'lint'],
    ['not ok 1 - adds', 'test'],
    ['Tests:  2 failed, 10 passed, 12 total', 'test'],
    ['FAIL  src/add.test.ts > adds', 'test'],
    ['--- FAIL: TestAdd (0.00s)', 'test'],
    ['FAILED tests/test_add.py::test_adds - assert 1 == 2', 'test'],
    ['error[E0308]: mismatched types', 'build'],
    ['✘ [ERROR] Could not resolve "./missing"', 'build']
  ] as const)('reads %j as %s', (excerpt, cls) => {
    expect(classifyCiFailure(input({ excerpt }))).toBe(cls)
  })

  it('a cause outside the code wins over a test failure in the same log', () => {
    expect(classifyCiFailure(input({ excerpt: 'not ok 1 - adds\nError: read ECONNRESET' }))).toBe('infrastructure')
  })

  it('a failing setup step is environment unless the text names an outside cause', () => {
    expect(classifyCiFailure(input({ step: 'actions/setup-node@v4', excerpt: 'Unable to find Node version 99' }))).toBe('environment')
    expect(classifyCiFailure(input({ step: 'actions/setup-node@v4', excerpt: 'read ECONNRESET' }))).toBe('infrastructure')
  })

  it('falls back to the failing step’s command, then to unknown', () => {
    expect(classifyCiFailure(input({ step: 'npm run lint', excerpt: 'exit 1' }))).toBe('lint')
    expect(classifyCiFailure(input({ step: 'npm run typecheck', excerpt: 'exit 1' }))).toBe('typecheck')
    expect(classifyCiFailure(input({ step: 'npm test', excerpt: 'exit 1' }))).toBe('test')
    expect(classifyCiFailure(input({ step: 'npm run build', excerpt: 'exit 1' }))).toBe('build')
    expect(classifyCiFailure(input({ step: './deploy.sh', excerpt: 'exit 1' }))).toBe('unknown')
    expect(classifyCiFailure(input({}))).toBe('unknown')
  })

  it('reads annotations too: a runner annotation can name the cause', () => {
    expect(classifyCiFailure(input({ annotationMessages: ['The hosted runner encountered an error while running your job.'] }))).toBe('infrastructure')
  })
})

describe('failureCause', () => {
  it('is the first line that a rule recognises, without the runner prefix', () => {
    expect(failureCause('> x@1 test\nnot ok 1 - adds\n# fail 1\n##[error]Process completed with exit code 1.', [], 'failure')).toBe('not ok 1 - adds')
  })
  it('else the first annotation, else the last line, else the fallback', () => {
    expect(failureCause('just output', ['src/a.ts: bad'], 'failure')).toBe('src/a.ts: bad')
    expect(failureCause('first\nlast words\n##[error]Process completed with exit code 2.', [], 'failure')).toBe('last words')
    expect(failureCause('', [], 'timed-out')).toBe('timed-out')
  })
})
