// A Vitest `--reporter=json` report as one result (Phase 3 Part 2). The Jest-shaped JSON Vitest writes: a file per
// `testResults` entry, its cases in `assertionResults`. A file that failed outside its tests (Vitest 4.1's JsonReporter
// writes a load error or a throwing hook as the entry's `failed` status and `message`, with no failed assertion) gets one
// errored case named by its file, the case Vitest's JUnit reporter writes for it.
import { TEST_BOUNDS, caseId, cutMessage, failurePlace, insideRun, uniqueIds, type ParsedReport, type TestCase, type TestStatus } from './types'

const STATUS: Record<string, TestStatus> = { passed: 'passed', failed: 'failed', skipped: 'skipped', pending: 'skipped', todo: 'skipped', disabled: 'skipped' }

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** A report's cases, or null when the text is not a Vitest JSON report (no `testResults` list). */
export function parseVitestJson(json: string, cwd: string): ParsedReport | null {
  let d: unknown
  try {
    d = JSON.parse(json)
  } catch {
    return null
  }
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return null
  const results = (d as { testResults?: unknown }).testResults
  if (!Array.isArray(results)) return null
  const cases: TestCase[] = []
  let truncated = false
  outer: for (const tr of results) {
    if (tr === null || typeof tr !== 'object') continue
    const named = (tr as { name?: unknown }).name
    const file = typeof named === 'string' ? insideRun(cwd, named) : undefined
    const list = (tr as { assertionResults?: unknown }).assertionResults
    let failedHere = false
    for (const a of Array.isArray(list) ? list : []) {
      if (a === null || typeof a !== 'object') continue
      if (cases.length >= TEST_BOUNDS.cases) {
        truncated = true
        break outer
      }
      const r = a as { ancestorTitles?: unknown; title?: unknown; status?: unknown; duration?: unknown; failureMessages?: unknown; location?: { line?: unknown } }
      const suite = strings(r.ancestorTitles)
      const name = typeof r.title === 'string' ? r.title : ''
      const status = STATUS[typeof r.status === 'string' ? r.status : ''] ?? 'skipped'
      const failed = status === 'failed'
      failedHere ||= failed
      const message = strings(r.failureMessages).join('\n')
      const line = typeof r.location?.line === 'number' ? r.location.line : undefined
      const at = failed ? (failurePlace(cwd, message) ?? (file !== undefined && line !== undefined ? { file, line } : undefined)) : undefined
      cases.push({
        id: caseId(file, suite, name),
        ...(file !== undefined ? { file } : {}),
        suite,
        name,
        status,
        ...(typeof r.duration === 'number' ? { durationMs: Math.round(r.duration) } : {}),
        ...(failed ? { failure: { message: cutMessage(message), ...(at ?? {}) } } : {})
      })
    }
    if ((tr as { status?: unknown }).status === 'failed' && !failedHere) {
      if (cases.length >= TEST_BOUNDS.cases) {
        truncated = true
        break
      }
      const said = (tr as { message?: unknown }).message
      const message = typeof said === 'string' ? said : ''
      const name = file ?? (typeof named === 'string' ? named : '')
      const at = failurePlace(cwd, message)
      cases.push({
        id: caseId(file, [], name),
        ...(file !== undefined ? { file } : {}),
        suite: [],
        name,
        status: 'errored',
        failure: { message: cutMessage(message), ...(at ?? {}) },
        fileLevel: true
      })
    }
  }
  return { framework: 'vitest', cases: uniqueIds(cases), ...(truncated ? { truncated: true as const } : {}) }
}
