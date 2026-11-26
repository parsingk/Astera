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

export function createTestResults(a: { dir: string }): {
  load(project: string, live?: ReadonlySet<string>): Promise<TestRunResult[]>
  record(r: TestRunResult): Promise<void>
  forget(configId: string): Promise<void>
} {
  return {
    /** The project's results, newest first; with `live`, only the configurations the project still has. */
    async load(project, live) {
      let names: string[]
      try {
        names = await fs.readdir(a.dir)
      } catch {
        return []
      }
      const out: TestRunResult[] = []
      for (const n of names.filter((x) => x.endsWith('.json'))) {
        try {
          const r = JSON.parse(await fs.readFile(path.join(a.dir, n), 'utf8')) as TestRunResult
          if (r?.schemaVersion !== 1 || typeof r.projectPath !== 'string' || typeof r.configId !== 'string') continue
          if (!sameFolder(project, r.projectPath) || (live !== undefined && !live.has(r.configId))) continue
          out.push(r)
        } catch {
          // a file being replaced, or not one of ours: not a result
        }
      }
      return out.sort((x, y) => y.endedAt.localeCompare(x.endedAt))
    },
    async record(r) {
      await fs.mkdir(a.dir, { recursive: true })
      const file = fileOf(a.dir, r.configId)
      const tmp = `${file}.${randomUUID()}.tmp`
      await fs.writeFile(tmp, JSON.stringify(r), 'utf8')
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
