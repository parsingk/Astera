// The shapes of a test result (Phase 3 Part 2), types only, so the renderer reads them too (tsconfig.web lists this file;
// the parsers and the reader beside it use Node).
import type { TestReportSpec } from '../run/types'

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'errored'

/** One test case. `id` is stable across runs (its file, suites and name); a file is relative to the run's folder with
 *  `/`; a failure's place only when it is inside that folder. */
export interface TestCase {
  id: string
  file?: string
  suite: string[]
  name: string
  status: TestStatus
  durationMs?: number
  failure?: { message: string; file?: string; line?: number }
}

/** A report read: which framework wrote it when the report says, its cases, and whether some were left out. */
export interface ParsedReport {
  framework?: 'vitest' | 'pytest' | 'junit'
  cases: TestCase[]
  truncated?: true
}

/** The last result of a configuration a person ran (main/testResults.ts): what its report said, or `stopped` for a run
 *  stopped by request, `stale` when the report was an earlier run's, `scope: 'failures'` for a rerun of the failures. */
export interface TestRunResult {
  schemaVersion: 1
  projectPath: string
  /** The folder the run worked in, absolute: its cases' files are relative to it. */
  cwd: string
  configId: string
  configName: string
  format: TestReportSpec['format']
  runId: string
  startedAt: string
  endedAt: string
  outcome: 'passed' | 'failed' | 'unknown' | 'stopped'
  stale?: true
  reason?: string
  cases: TestCase[]
  truncated?: true
  counts: Record<TestStatus, number>
  scope?: 'failures'
}
