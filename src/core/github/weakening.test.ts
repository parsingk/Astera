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
