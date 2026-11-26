import type { MessageKey } from '../../../core/i18n'
import type { RerunScope, RerunWhy, TestCase, TestRunResult, TestStatus } from '../../../core/tests/model'

/** What the toast says when a rerun of the failures ran by files or whole, for each reason (final review M14); null when
 *  it ran only the failures. */
export function rerunNote(scope: RerunScope, why: RerunWhy | undefined): MessageKey | null {
  if (scope === 'failures') return null
  if (scope === 'files') {
    if (why === 'file-level') return 'tests.scope.filesFileLevel'
    if (why === 'package-manager') return 'tests.scope.filesPackageManager'
    if (why === 'too-long') return 'tests.scope.filesTooLong'
    return 'tests.scope.files'
  }
  if (why === 'unsafe-names') return 'tests.scope.allUnsafe'
  if (why === 'package-manager') return 'tests.scope.allPackageManager'
  if (why === 'too-long') return 'tests.scope.allTooLong'
  return 'tests.scope.all'
}

/** One row of the Tests tab's tree: a file, a suite in it, or a case, with the counts of the cases under it. */
export interface TreeNode {
  kind: 'file' | 'suite' | 'case'
  key: string
  label: string
  counts: Record<TestStatus, number>
  children?: TreeNode[]
  case?: TestCase
}

const zero = (): Record<TestStatus, number> => ({ passed: 0, failed: 0, skipped: 0, errored: 0 })
const failing = (n: TreeNode): number => n.counts.failed + n.counts.errored

/** Failing nodes first at every level, the rest in the report's order. */
function failingFirst(nodes: TreeNode[]): TreeNode[] {
  const sorted = [...nodes.filter((n) => failing(n) > 0), ...nodes.filter((n) => failing(n) === 0)]
  for (const n of sorted) if (n.children) n.children = failingFirst(n.children)
  return sorted
}

/** A result as a tree, file > suite > case (Phase 3 Part 2). A case with no file sits under its suites at the top. */
export function testTree(r: TestRunResult): TreeNode[] {
  const top: TreeNode[] = []
  const childOf = (list: TreeNode[], kind: 'file' | 'suite', label: string, key: string): TreeNode => {
    let n = list.find((x) => x.kind === kind && x.label === label)
    if (!n) {
      n = { kind, key, label, counts: zero(), children: [] }
      list.push(n)
    }
    return n
  }
  for (const c of r.cases) {
    const path: TreeNode[] = []
    let list = top
    let key = ''
    if (c.file !== undefined) {
      key = `f:${c.file}`
      const f = childOf(list, 'file', c.file, key)
      path.push(f)
      list = f.children!
    }
    for (const s of c.suite) {
      key = `${key}/s:${s}`
      const n = childOf(list, 'suite', s, key)
      path.push(n)
      list = n.children!
    }
    const counts = zero()
    counts[c.status] = 1
    list.push({ kind: 'case', key: `${key}/c:${c.id}`, label: c.name, counts, case: c })
    for (const n of path) n.counts[c.status]++
  }
  return failingFirst(top)
}

/** Where a case opens: its failure's place, else its file, under the run's folder with that folder's separators; null
 *  when the report named no file. */
export function caseLocation(r: TestRunResult, c: TestCase): { path: string; line?: number } | null {
  const file = c.failure?.file ?? c.file
  if (file === undefined) return null
  const sep = r.cwd.includes('\\') ? '\\' : '/'
  const path = `${r.cwd.replace(/[\\/]+$/, '')}${sep}${file.split('/').join(sep)}`
  return c.failure?.file !== undefined && c.failure.line !== undefined ? { path, line: c.failure.line } : { path }
}
