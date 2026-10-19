// What in a pull request's diff can make its checks pass without the work being right (GitHub lifecycle G5a, design
// §7.4): the findings the review before merge-ready is shown and must judge against the objective.
import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff, weakeningFindings, WEAKENING_FINDINGS_MAX } from './weakening'

/** One file's diff: a header, then the hunk lines as given (each with its own +, - or space). */
const file = (path: string, lines: string[], o: { deleted?: true; renamedFrom?: string; startNew?: number } = {}): string =>
  [
    `diff --git a/${o.renamedFrom ?? path} b/${path}`,
    ...(o.deleted ? ['deleted file mode 100644'] : []),
    ...(o.renamedFrom ? ['similarity index 90%', `rename from ${o.renamedFrom}`, `rename to ${path}`] : []),
    'index 1111111..2222222 100644',
    `--- a/${o.renamedFrom ?? path}`,
    o.deleted ? '+++ /dev/null' : `+++ b/${path}`,
    `@@ -1,${lines.length} +${o.startNew ?? 1},${lines.length} @@`,
    ...lines
  ].join('\n')
const diff = (...files: string[]): string => files.join('\n') + '\n'
/** Each finding as `kind file#line`: `#`, so the expectations below are not read as line-number citations of source
 *  files (lineNumberCitations.test). */
const kinds = (text: string): string[] => weakeningFindings(text).findings.map((f) => `${f.kind} ${f.file}${f.line ? `#${f.line}` : ''}`)

describe('parseUnifiedDiff', () => {
  it('reads each file’s added and removed lines with their line numbers, and whether it was deleted or renamed', () => {
    const files = parseUnifiedDiff(
      diff(
        file('src/a.ts', [' keep', '-old', '+new', '+more', ' tail'], { startNew: 10 }),
        file('test/b.test.ts', ['-gone'], { deleted: true }),
        file('test/c.test.ts', [' x'], { renamedFrom: 'test/old.test.ts' })
      )
    )
    expect(files.map((f) => [f.path, f.deleted, f.renamed])).toEqual([
      ['src/a.ts', false, false],
      ['test/b.test.ts', true, false],
      ['test/c.test.ts', false, true]
    ])
    expect(files[0].added).toEqual([{ line: 11, text: 'new' }, { line: 12, text: 'more' }])
    expect(files[0].removed).toEqual([{ line: 2, text: 'old' }])
  })

  it('reads a content line that starts with +++ inside a hunk as an added line', () => {
    const files = parseUnifiedDiff(diff(file('a.txt', ['+++x'])))
    expect(files[0].added).toEqual([{ line: 1, text: '++x' }])
  })
})

describe('weakeningFindings', () => {
  it('finds each skip or only marker added, in any language, and none on a removed line', () => {
    const text = diff(
      file('src/a.test.ts', ['+it.skip("adds", () => {})', '+describe.only("x", () => {})', '+xit("y", () => {})', '+xdescribe("z", () => {})', '-test.skip("old")']),
      file('tests/test_a.py', ['+@pytest.mark.skip(reason="flaky")', '+@unittest.skip("later")']),
      file('src/test/java/ATest.java', ['+  @Disabled']),
      file('src/lib.rs', ['+#[ignore]'])
    )
    expect(kinds(text)).toEqual([
      'skip-marker src/a.test.ts#1', 'skip-marker src/a.test.ts#2', 'skip-marker src/a.test.ts#3', 'skip-marker src/a.test.ts#4',
      'skip-marker src/lib.rs#1', 'skip-marker src/test/java/ATest.java#1',
      'skip-marker tests/test_a.py#1', 'skip-marker tests/test_a.py#2'
    ])
  })

  it('finds continue-on-error added in a workflow', () => {
    expect(kinds(diff(file('.github/workflows/ci.yml', ['   steps:', '+      continue-on-error: true'])))).toEqual(['continue-on-error .github/workflows/ci.yml#2'])
  })

  it('finds a failure ignored with || true or exit 0 in a workflow, package.json, a shell script or a Makefile, and not in source code', () => {
    const text = diff(
      file('.github/workflows/ci.yml', ['+      - run: npm test || true']),
      file('package.json', ['+    "test": "vitest run || true",']),
      file('scripts/check.sh', ['+exit 0']),
      file('Makefile', ['+\tpytest || true']),
      file('src/a.ts', ['+const s = "a || true"'])
    )
    expect(kinds(text)).toEqual([
      'ignored-failure .github/workflows/ci.yml#1', 'ignored-failure Makefile#1', 'ignored-failure package.json#1', 'ignored-failure scripts/check.sh#1'
    ])
  })

  it('finds a deleted test file, and not a renamed one or a deleted source file', () => {
    const text = diff(
      file('src/a.test.ts', ['-it("adds")'], { deleted: true }),
      file('tests/test_b.py', ['-def test_b(): pass'], { deleted: true }),
      file('src/moved.test.ts', [' it("x")'], { renamedFrom: 'src/old.test.ts' }),
      file('src/gone.ts', ['-export {}'], { deleted: true })
    )
    expect(kinds(text)).toEqual(['test-deleted src/a.test.ts', 'test-deleted tests/test_b.py'])
  })

  it('finds a coverage threshold lowered or removed, and not one raised', () => {
    const text = diff(
      file('vitest.config.ts', ['-        lines: 80,', '+        lines: 60,', '-        branches: 70,', '+        branches: 75,']),
      file('pyproject.toml', ['-fail_under = 90']),
      file('.github/workflows/ci.yml', ['-      - run: pytest --cov-fail-under=85', '+      - run: pytest --cov-fail-under=50'])
    )
    expect(kinds(text)).toEqual(['coverage-lowered .github/workflows/ci.yml#1', 'coverage-lowered pyproject.toml', 'coverage-lowered vitest.config.ts#1'])
  })

  it('finds a workflow trigger removed and a job turned off, and not a trigger line that only moved', () => {
    const text = diff(
      file('.github/workflows/ci.yml', ['-  pull_request:', '   push:', '+    if: false']),
      file('.github/workflows/lint.yml', ['-  push:', '+  push:'])
    )
    expect(kinds(text)).toEqual(['trigger-removed .github/workflows/ci.yml', 'job-disabled .github/workflows/ci.yml#2'])
  })

  it('finds a lint or typecheck step removed from a workflow', () => {
    expect(kinds(diff(file('.github/workflows/ci.yml', ['-      - run: npm run lint', '-      - run: npx tsc --noEmit', '       - run: npm test'])))).toEqual([
      'check-step-removed .github/workflows/ci.yml',
      'check-step-removed .github/workflows/ci.yml'
    ])
  })

  it('keeps the first findings and says how many there were', () => {
    const many = Array.from({ length: WEAKENING_FINDINGS_MAX + 5 }, (_, i) => `+it.skip("t${i}")`)
    const r = weakeningFindings(diff(file('src/a.test.ts', many)))
    expect(r.findings).toHaveLength(WEAKENING_FINDINGS_MAX)
    expect(r.total).toBe(WEAKENING_FINDINGS_MAX + 5)
  })

  it('redacts a secret and drops control characters in a finding’s text, and cuts it', () => {
    const r = weakeningFindings(diff(file('.github/workflows/ci.yml', [`+      - run: TOKEN=ghp_${'a'.repeat(36)} deploy || true ${'x'.repeat(300)}`, '+      continue-on-error: true\u0007'])))
    expect(r.findings[0].text).not.toContain('ghp_aaaa')
    expect(r.findings[0].text.length).toBeLessThanOrEqual(200)
    expect(r.findings[1].text).toBe('continue-on-error: true')
  })

  it('finds nothing in an empty diff or one with no hunk', () => {
    expect(weakeningFindings('')).toEqual({ findings: [], total: 0 })
    expect(weakeningFindings('diff --git a/x b/x\nnew file mode 100644\n')).toEqual({ findings: [], total: 0 })
  })
})

// GitHub lifecycle G5a final review: the parser and the detectors on what real pull requests hold
describe('weakeningFindings — final review', () => {
  /** A raw diff from header lines and hunk lines, as git prints it. */
  const raw = (...lines: string[]): string => lines.join('\n') + '\n'

  // I-1, M-3: the path is the +++ / --- / rename line's, not a guess from the header
  it('reads a path that holds " b/", a quoted one, and a deleted file’s from its --- line', () => {
    const files = parseUnifiedDiff(
      raw(
        'diff --git a/tests b/x.test.ts b/tests b/x.test.ts', '--- a/tests b/x.test.ts', '+++ b/tests b/x.test.ts', '@@ -1 +1 @@', '-a', '+b',
        'diff --git "a/q\\ty.ts" "b/q\\ty.ts"', '--- "a/q\\ty.ts"', '+++ "b/q\\ty.ts"', '@@ -1 +1 @@', '-a', '+b',
        'diff --git a/old.test.ts b/old.test.ts', 'deleted file mode 100644', '--- a/old.test.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-x'
      )
    )
    expect(files.map((f) => f.path)).toEqual(['tests b/x.test.ts', 'q' + String.fromCharCode(9) + 'y.ts', 'old.test.ts'])
  })

  // M-4: diff.suppressBlankEmpty prints an empty context line with no space
  it('counts an empty line inside a hunk as context', () => {
    const files = parseUnifiedDiff(raw('diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', ' a', '', '+b'))
    expect(files[0].added).toEqual([{ line: 3, text: 'b' }])
  })

  // I-5
  it('finds a test step removed from a workflow', () => {
    expect(kinds(diff(file('.github/workflows/ci.yml', ['-      - run: npm test', '-      - run: pytest -q', '-      - run: go test ./...', '       - run: echo ok'])))).toEqual([
      'check-step-removed .github/workflows/ci.yml',
      'check-step-removed .github/workflows/ci.yml',
      'check-step-removed .github/workflows/ci.yml'
    ])
  })

  // M-1
  it('finds skip markers on test calls and in the forms that were missed, and not an iterator’s skip or a vendored file', () => {
    const text = diff(
      file('src/lib.rs', ['+    let rest = args.iter().skip(1);']),
      file('src/db.ts', ['+  return Model.find().skip(20)']),
      file('vendor/rx.min.js', ['+b.skip(1);it.only(x)']),
      file('src/a.test.ts', ['+it.skipIf(true)("x", () => {})', '+it.skip.each([1])("y", () => {})', '+it.skipIf(process.platform === "win32")("z", () => {})']),
      file('src/test/java/ATest.java', ['+  @Ignore']),
      file('tests/test_b.py', ['+@pytest.mark.xfail', '+        self.skipTest("later")']),
      file('pkg/a_test.go', ['+	t.Skip("later")'])
    )
    expect(kinds(text)).toEqual([
      'skip-marker pkg/a_test.go#1',
      'skip-marker src/a.test.ts#1', 'skip-marker src/a.test.ts#2',
      'skip-marker src/test/java/ATest.java#1',
      'skip-marker tests/test_b.py#1', 'skip-marker tests/test_b.py#2'
    ])
  })

  // M-2: triggers
  it('finds a trigger name that the workflow no longer has, and not a push: option of a step or a trigger added', () => {
    const text = diff(
      file('.github/workflows/docker.yml', ['-          push: true', '+          push: false']),
      file('.github/workflows/a.yml', ['-on: push', '+on: [push, pull_request]']),
      file('.github/workflows/b.yml', ['-on: [push, pull_request]', '+on: push'])
    )
    expect(kinds(text)).toEqual(['trigger-removed .github/workflows/b.yml'])
  })

  // M-2: coverage
  it('reads coverage by its own keys: not eslint’s max-lines; codecov’s target lowered and threshold raised; repeated keys in order', () => {
    const text = diff(
      file('.eslintrc.json', ['-    "max-lines": 500,', '+    "max-lines": 300,']),
      file('codecov.yml', ['-        target: 80%', '+        target: 50%', '-        threshold: 1%', '+        threshold: 5%']),
      file('.codecov.yml', ['-        threshold: 5%', '+        threshold: 1%']),
      file('vitest.config.ts', ['-        lines: 90,', '-        lines: 80,', '+        lines: 85,', '+        lines: 80,'])
    )
    expect(kinds(text)).toEqual(['coverage-lowered codecov.yml#1', 'coverage-lowered codecov.yml#2', 'coverage-lowered vitest.config.ts#1'])
  })

  // M-2: ignored failures
  it('finds a Makefile recipe that ignores its error and || :, and not || true after a cleanup or exit 0 in a new script', () => {
    const text = diff(
      file('Makefile', ['+' + String.fromCharCode(9) + '-pytest', '+' + String.fromCharCode(9) + 'pytest || :']),
      file('.github/workflows/ci.yml', ['+      - run: rm -rf dist || true']),
      ['diff --git a/scripts/new.sh b/scripts/new.sh', 'new file mode 100755', '--- /dev/null', '+++ b/scripts/new.sh', '@@ -0,0 +1,2 @@', '+echo done', '+exit 0'].join('\n')
    )
    expect(kinds(text)).toEqual(['ignored-failure Makefile#1', 'ignored-failure Makefile#2'])
  })

  // M-5
  it('drops line and paragraph separators, C1 and format characters, and cuts paths too', () => {
    const odd = [0x2028, 0x85, 0x202e, 0x9b].map((c) => String.fromCharCode(c)).join('')
    const r = weakeningFindings(diff(file('.github/workflows/ci.yml', [`+      continue-on-error: true ${odd}x`]), file(`tests/${'d'.repeat(300)}.test.ts`, ['-x'], { deleted: true })))
    const flag = r.findings.find((f) => f.kind === 'continue-on-error')!
    expect(flag.text).toBe('continue-on-error: true x')
    const gone = r.findings.find((f) => f.kind === 'test-deleted')!
    expect(gone.text.length).toBeLessThanOrEqual(200)
    expect(gone.file.length).toBeLessThanOrEqual(200)
  })

  // M-9
  it('reads a long run of spaces in a coverage line quickly', () => {
    const line = `+lines${' '.repeat(200_000)}x`
    const t0 = Date.now()
    weakeningFindings(diff(file('vitest.config.ts', ['-lines: 80', line])))
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})
