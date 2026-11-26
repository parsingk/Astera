// The last test result of each configuration a person runs (Phase 3 Part 2, design §5 Part 2 item 3), kept under
// userData, one file per configuration. Written when such a run ends; a Task's check never writes here (its failures
// reach the person as that check's diagnostics), so one failure never shows twice.
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isUnder } from '../core/context/contextRef'
import type { RunStatus } from '../core/run/config'
import type { RunConfig } from '../core/run/types'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../core/sessions/pty'
import type { readTestReport } from '../core/tests/read'
import type { TestCase, TestRunResult, TestStatus } from '../core/tests/model'

export type { TestRunResult }

/** A configuration id as a file name: `user:<uuid>` holds a `:`, which a Windows file name cannot. */
const fileOf = (dir: string, configId: string): string => path.join(dir, `${configId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)

const sameFolder = (a: string, b: string): boolean => isUnder(a, b) && isUnder(b, a)

export function countsOf(cases: readonly TestCase[]): Record<TestStatus, number> {
  const out: Record<TestStatus, number> = { passed: 0, failed: 0, skipped: 0, errored: 0 }
  for (const c of cases) out[c.status]++
  return out
}

/**
 * A rerun of the failures laid over the result it reran: each of its cases replaces the stored one, but a case its filter
 * skipped (Vitest marks the tests a name filter left out as skipped) keeps what it was, and the cases it did not run stay.
 */
function merged(prev: TestRunResult, rerun: TestRunResult): TestRunResult {
  const ran = new Map(rerun.cases.map((c) => [c.id, c]))
  const known = new Set(prev.cases.map((c) => c.id))
  const cases = prev.cases.map((c) => {
    const n = ran.get(c.id)
    return n === undefined || n.status === 'skipped' ? c : n
  })
  for (const n of rerun.cases) if (!known.has(n.id)) cases.push(n)
  return {
    ...rerun,
    cases,
    counts: countsOf(cases),
    outcome: cases.some((c) => c.status === 'failed' || c.status === 'errored') ? 'failed' : 'passed',
    ...(prev.truncated || rerun.truncated ? { truncated: true as const } : {})
  }
}

/** A stored result with every field the Tests tab and the Problems list read (final review M8: a hand edit or a future
 *  shape is skipped, never thrown on). */
function isResult(v: unknown): v is TestRunResult {
  if (v === null || typeof v !== 'object') return false
  const r = v as Partial<TestRunResult>
  return (
    r.schemaVersion === 1 &&
    typeof r.projectPath === 'string' &&
    typeof r.cwd === 'string' &&
    typeof r.configId === 'string' &&
    typeof r.configName === 'string' &&
    typeof r.startedAt === 'string' &&
    typeof r.endedAt === 'string' &&
    typeof r.outcome === 'string' &&
    Array.isArray(r.cases) &&
    r.counts !== null &&
    typeof r.counts === 'object' &&
    (['passed', 'failed', 'skipped', 'errored'] as const).every((k) => typeof r.counts?.[k] === 'number')
  )
}

/** The configuration's stored result, or null when there is none or it is not one. */
async function readStored(file: string): Promise<TestRunResult | null> {
  try {
    const r: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    return isResult(r) ? r : null
  } catch {
    // nothing stored yet, a file being replaced, or not one of ours
    return null
  }
}

export function createTestResults(a: { dir: string }): {
  load(project: string, live: ReadonlyMap<string, string>): Promise<TestRunResult[]>
  record(r: TestRunResult, base?: TestRunResult): Promise<void>
  forget(configId: string): Promise<void>
} {
  return {
    /** The project's results, newest first: one per configuration in `live` (the project's configurations that name a
     *  test report, by id with their name now), each read from its own file and named as it is called now (final review
     *  M5, M6 and M7). */
    async load(project, live) {
      const out: TestRunResult[] = []
      for (const [id, name] of live) {
        const r = await readStored(fileOf(a.dir, id))
        if (r !== null && r.configId === id && sameFolder(project, r.projectPath)) out.push({ ...r, configName: name })
      }
      return out.sort((x, y) => y.endedAt.localeCompare(x.endedAt))
    },
    /**
     * A rerun of the failures that read a fresh report is merged into the result it reran (`base`, taken when it was asked
     * for, or the stored one), anything else replaces it. A run that started before the stored result's run is older news
     * and is not kept: two runs of one configuration can end out of order (final review M11).
     */
    async record(r, base) {
      await fs.mkdir(a.dir, { recursive: true })
      const file = fileOf(a.dir, r.configId)
      const stored = await readStored(file)
      const ours = (x: TestRunResult | null | undefined): x is TestRunResult => !!x && x.configId === r.configId && sameFolder(x.projectPath, r.projectPath)
      if (ours(stored) && Date.parse(stored.startedAt) > Date.parse(r.startedAt)) return
      let out = r
      if (r.scope === 'failures' && !r.stale && (r.outcome === 'passed' || r.outcome === 'failed')) {
        // The result it reran, unless a full result came after it: a stop recorded in between (the rerun restarted a live
        // run of the configuration) is not what it reran (final review M1)
        const read = (x: TestRunResult): boolean => !x.stale && (x.outcome === 'passed' || x.outcome === 'failed')
        const onto = ours(base) ? (ours(stored) && read(stored) && Date.parse(stored.startedAt) > Date.parse(base.startedAt) ? stored : base) : stored
        if (ours(onto)) out = merged(onto, r)
      }
      const tmp = `${file}.${randomUUID()}.tmp`
      await fs.writeFile(tmp, JSON.stringify(out), 'utf8')
      await fs.rename(tmp, file)
    },
    async forget(configId) {
      await fs.rm(fileOf(a.dir, configId), { force: true })
    }
  }
}

/**
 * What to record for a run that ended, or null: only a person's run (not a validation) of a configuration with a test
 * report, whose exit is a real one (not the app losing sight of it). A run stopped by request is `stopped` with no
 * cases: a report it left may be half written (person, 2026-11-26). Otherwise the report is read against the run's
 * start, so one an earlier run left is stale.
 */
export async function resultOfRun(a: {
  status: RunStatus
  config: RunConfig | undefined
  cwd: string
  read: typeof readTestReport
}): Promise<TestRunResult | null> {
  const s = a.status
  if (s.status !== 'exited' || s.validation === true || s.exitCode === PTY_LOST_SIGHT_EXIT_CODE) return null
  const spec = a.config?.testReport
  if (!a.config || !spec) return null
  const base = {
    schemaVersion: 1 as const,
    projectPath: s.projectPath,
    cwd: a.cwd,
    configId: a.config.id,
    configName: a.config.name,
    format: spec.format,
    runId: s.runId,
    startedAt: new Date(s.startedAt).toISOString(),
    endedAt: new Date(s.exitedAt ?? Date.now()).toISOString()
  }
  if (s.stopped) return { ...base, outcome: 'stopped', cases: [], counts: countsOf([]) }
  const r = await a.read({ cwd: a.cwd, spec, sinceMs: s.startedAt })
  const cases = r.report?.cases ?? []
  return {
    ...base,
    outcome: r.outcome,
    ...(r.stale ? { stale: true as const } : {}),
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
    cases,
    ...(r.report?.truncated ? { truncated: true as const } : {}),
    counts: countsOf(cases)
  }
}
