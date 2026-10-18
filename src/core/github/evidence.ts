// The evidence of a failed check (GitHub lifecycle design §4.7, L22): the failing step's lines from the job log, the
// annotations that say something, a class (classify.ts) and a one-line summary; bounded, and redacted with sanitize
// before it leaves this module. Pure except the two gh readers at the end.
import { sanitize } from '../orchestration/checkpoint'
import { cutTail } from '../orchestration/taskOutput'
import { classifyCiFailure, failureCause } from './classify'
import { ghFailureSentence, type GhFailed, type GhRunner } from './gh'
import type { GitHubCiCheck, GitHubCiFailure } from './lifecycle'
import { ghRepoArg, hostnameArgs, repoSlug, type GitHubRepo } from './remote'

export const LOG_EXCERPT_CHARS = 4000
export const LOG_EXCERPT_LINES = 80
export const DIAGNOSTICS_MAX = 20
export const SUMMARY_MAX = 1000

/** `job<TAB>step<TAB><timestamp> ` as gh prints each line; the first timestamp can carry a BOM (measured). */
const PREFIX = /^[^\t]*\t[^\t]*\t﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/
/** A colour code, as the ESC byte or as the text `^[` gh writes in its place (measured on the sandbox). */
const ANSI = /(?:\x1b|\^\[)\[[0-9;]*[A-Za-z]/g
const RUN_GROUP = '##[group]Run '

/** The failing step's lines of `gh run view --job <id> --log-failed`: from the last `##[group]Run` before the last
 *  `##[error]` to that error, without gh's prefixes, colour codes, group ends and blank lines. With no error line (a step
 *  cut off), the last lines before `Post job cleanup.`. At most LOG_EXCERPT_LINES lines and LOG_EXCERPT_CHARS characters,
 *  kept from the end, where the failure is. */
export function excerptFromJobLog(raw: string): { excerpt: string; step?: string } {
  const lines = raw.split(/\r?\n/).map((l) => l.replace(PREFIX, '').replace(ANSI, ''))
  let end = lines.length
  for (let i = lines.length - 1; i >= 0; i--)
    if (lines[i].startsWith('##[error]')) {
      end = i + 1
      break
    }
  if (end === lines.length) {
    const cleanup = lines.findIndex((l) => l.startsWith('Post job cleanup'))
    if (cleanup >= 0) end = cleanup
  }
  let start = 0
  for (let i = end - 1; i >= 0; i--)
    if (lines[i].startsWith(RUN_GROUP)) {
      start = i
      break
    }
  const step = lines[start]?.startsWith(RUN_GROUP) ? lines[start].slice(RUN_GROUP.length).trim() : undefined
  const kept = lines
    .slice(start, end)
    .filter((l) => l.trim() !== '' && l !== '##[endgroup]')
    .slice(-LOG_EXCERPT_LINES)
    .join('\n')
  return { excerpt: cutTail(kept, LOG_EXCERPT_CHARS), ...(step ? { step } : {}) }
}

export interface RawAnnotation {
  path?: string
  start_line?: number
  annotation_level?: string
  message?: string
}

/** The runner's own lines that every failed job has and that say nothing about why (measured on the sandbox). */
const BOILERPLATE = /^Process completed with exit code \d+\.?$|is deprecated\. The following actions|label will migrate to/i

/** The annotations worth showing: failures and warnings, not the runner's boilerplate; a path only when it is a file
 *  (the runner's own annotations name `.github`). At most DIAGNOSTICS_MAX. */
export function diagnosticsFrom(annotations: RawAnnotation[]): GitHubCiFailure['diagnostics'] {
  return annotations
    .filter(
      (a) =>
        (a.annotation_level === 'failure' || a.annotation_level === 'warning') &&
        typeof a.message === 'string' &&
        !BOILERPLATE.test(a.message.trim())
    )
    .slice(0, DIAGNOSTICS_MAX)
    .map((a) => {
      const file = a.path && a.path !== '.github' ? a.path : undefined
      return {
        ...(file ? { path: file } : {}),
        ...(file && typeof a.start_line === 'number' ? { line: a.start_line } : {}),
        message: (a.message as string).trim().slice(0, 500)
      }
    })
}

/** One failed check's evidence. Every text is redacted before it is kept. */
export function ciFailureEvidence(a: { check: GitHubCiCheck; log?: string; annotations?: RawAnnotation[] }): GitHubCiFailure {
  const { excerpt, step } = a.log !== undefined ? excerptFromJobLog(a.log) : { excerpt: '', step: undefined }
  const messages = (a.annotations ?? []).flatMap((x) => (typeof x.message === 'string' ? [x.message] : []))
  const cls = classifyCiFailure({ conclusion: a.check.conclusion, step, excerpt, annotationMessages: messages })
  const diagnostics = diagnosticsFrom(a.annotations ?? []).map((d) => ({ ...d, message: sanitize(d.message) }))
  const cause = failureCause(
    excerpt,
    diagnostics.map((d) => d.message),
    a.check.conclusion ?? 'failure'
  )
  const logExcerpt = excerpt === '' ? undefined : cutTail(sanitize(excerpt), LOG_EXCERPT_CHARS)
  return {
    check: a.check.name,
    externalId: a.check.externalId,
    class: cls,
    summary: sanitize(`${a.check.name} (${cls}): ${cause}`).slice(0, SUMMARY_MAX),
    diagnostics,
    ...(logExcerpt !== undefined ? { logExcerpt } : {}),
    ...(a.check.detailsUrl ? { url: a.check.detailsUrl } : {})
  }
}

/** The failed steps' log of Actions job `jobId` (a check run's databaseId). */
export async function readJobLog(run: GhRunner, cwd: string, repo: GitHubRepo, jobId: number): Promise<{ ok: true; log: string } | GhFailed> {
  const r = await run(['run', 'view', '--job', String(jobId), '--log-failed', '--repo', ghRepoArg(repo)], cwd)
  return r.ok ? { ok: true, log: r.stdout } : { ok: false, ...ghFailureSentence(r) }
}

/** A check run's annotations (REST: the GraphQL id of a check run is not its databaseId). */
export async function readAnnotations(
  run: GhRunner,
  cwd: string,
  repo: GitHubRepo,
  checkRunId: number
): Promise<{ ok: true; annotations: RawAnnotation[] } | GhFailed> {
  const r = await run(['api', ...hostnameArgs(repo), `repos/${repoSlug(repo)}/check-runs/${checkRunId}/annotations?per_page=50`], cwd)
  if (!r.ok) return { ok: false, ...ghFailureSentence(r) }
  try {
    const rows = JSON.parse(r.stdout) as unknown
    return Array.isArray(rows) ? { ok: true, annotations: rows as RawAnnotation[] } : { ok: false, kind: 'other', message: 'the annotations answer is not a list' }
  } catch {
    return { ok: false, kind: 'other', message: 'the annotations answer is not JSON' }
  }
}
