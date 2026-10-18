// The evidence of a failed check (GitHub lifecycle design §4.7, L22): the failing step's lines from the job log, the
// annotations that say something, a class (classify.ts) and a one-line summary; bounded, and redacted with sanitize
// before it leaves this module, before anything is cut so no part of a secret is left (G2 final review I5). Pure except
// the two gh readers at the end.
import { sanitize } from '../orchestration/checkpoint'
import { cutTail } from '../orchestration/taskOutput'
import { classifyCiFailure } from './classify'
import { ghFailureSentence, type GhFailed, type GhRunner } from './gh'
import type { GitHubCiCheck, GitHubCiFailure } from './lifecycle'
import { ghRepoArg, hostnameArgs, repoSlug, type GitHubRepo } from './remote'

export const LOG_EXCERPT_CHARS = 4000
export const LOG_EXCERPT_LINES = 80
export const DIAGNOSTICS_MAX = 20
export const SUMMARY_MAX = 1000
const MESSAGE_MAX = 500

/** `job<TAB>step<TAB><timestamp> ` as gh prints each line. The first timestamp can carry a BOM, a format character
 *  (measured); a line the runner continued (a message of several lines) has no timestamp (measured on vitest). */
const PREFIX = /^[^\t]*\t[^\t]*\t(\p{Cf}?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?)?/u
/** A colour code, as the ESC byte or as the text `^[` gh writes in its place (measured on the sandbox). */
const ANSI = /(?:\x1b|\^\[)\[[0-9;]*[A-Za-z]/g
const RUN_GROUP = '##[group]Run '
const GROUP_END = '##[endgroup]'

/** The failing step's lines of `gh run view --job <id> --log-failed`: from the last `##[group]Run` before the last
 *  `##[error]` to that error, without gh's prefixes, colour codes, group ends and blank lines. With no error line (a step
 *  cut off), the last lines before `Post job cleanup.`. The excerpt keeps at most LOG_EXCERPT_LINES lines and
 *  LOG_EXCERPT_CHARS characters, from the end, where the failure is; `output` is the same step without its header (the
 *  command, shell and env up to the group's end), for classify.ts to read in full. */
export function excerptFromJobLog(raw: string): { excerpt: string; output: string; step?: string } {
  const lines = raw.split(/\r?\n/).map((l) => l.replace(PREFIX, '').replace(ANSI, ''))
  let end = -1
  for (let i = lines.length - 1; i >= 0; i--)
    if (lines[i].startsWith('##[error]')) {
      end = i + 1
      break
    }
  if (end < 0) {
    const cleanup = lines.findIndex((l) => l.startsWith('Post job cleanup'))
    end = cleanup >= 0 ? cleanup : lines.length
  }
  let start = 0
  for (let i = end - 1; i >= 0; i--)
    if (lines[i].startsWith(RUN_GROUP)) {
      start = i
      break
    }
  const step = lines[start]?.startsWith(RUN_GROUP) ? lines[start].slice(RUN_GROUP.length).trim() : undefined
  const headerEnd = step === undefined ? -1 : lines.indexOf(GROUP_END, start)
  const bodyStart = step === undefined ? start : headerEnd >= 0 && headerEnd < end ? headerEnd + 1 : start + 1
  const kept = (from: number): string[] => lines.slice(from, end).filter((l) => l.trim() !== '' && l !== GROUP_END)
  return {
    excerpt: cutTail(kept(start).slice(-LOG_EXCERPT_LINES).join('\n'), LOG_EXCERPT_CHARS),
    output: kept(bodyStart).join('\n'),
    ...(step ? { step } : {})
  }
}

export interface RawAnnotation {
  path?: string
  start_line?: number
  annotation_level?: string
  message?: string
}

/** The runner's own lines that every failed job has and that say nothing about why (measured on the sandbox). */
const BOILERPLATE = /^Process completed with exit code \d+\.?$|is deprecated\. The following actions|label will migrate to/i

const said = (a: RawAnnotation): a is RawAnnotation & { message: string } => typeof a.message === 'string' && !BOILERPLATE.test(a.message.trim())

/** The annotations worth showing: failures and warnings, not the runner's boilerplate; a path only when it is a file
 *  (the runner's own annotations name `.github`). At most DIAGNOSTICS_MAX, each message redacted, then cut. */
export function diagnosticsFrom(annotations: RawAnnotation[]): GitHubCiFailure['diagnostics'] {
  return annotations
    .filter((a) => (a.annotation_level === 'failure' || a.annotation_level === 'warning') && said(a))
    .slice(0, DIAGNOSTICS_MAX)
    .map((a) => {
      const file = a.path && a.path !== '.github' ? a.path : undefined
      return {
        ...(file ? { path: file } : {}),
        ...(file && typeof a.start_line === 'number' ? { line: a.start_line } : {}),
        message: sanitize((a.message as string).trim()).slice(0, MESSAGE_MAX),
        ...(a.annotation_level === 'warning' ? { warning: true as const } : {})
      }
    })
}

/** How many annotations diagnosticsFrom would keep before its bound: the total a reader is told about. */
const diagnosticsCount = (annotations: RawAnnotation[]): number =>
  annotations.filter((a) => (a.annotation_level === 'failure' || a.annotation_level === 'warning') && said(a)).length

/** One failed check's evidence. Every text is redacted before it is kept. Only failure annotations classify: a warning
 *  (a cache that could not be restored) is not why a step failed (G2 final review I2). `check` stays the name GitHub
 *  gives, as it names the check the verdict and the view point at. */
export function ciFailureEvidence(a: { check: GitHubCiCheck; log?: string; annotations?: RawAnnotation[] }): GitHubCiFailure {
  const { excerpt, output, step } = a.log !== undefined ? excerptFromJobLog(a.log) : { excerpt: '', output: '', step: undefined }
  const annotations = a.annotations ?? []
  const { class: cls, cause } = classifyCiFailure({
    conclusion: a.check.conclusion,
    step,
    name: a.check.name,
    ranNoJob: a.check.externalId.startsWith('suite:'),
    output,
    annotationMessages: annotations.filter((x) => x.annotation_level === 'failure' && said(x)).map((x) => x.message as string)
  })
  const logExcerpt = excerpt === '' ? undefined : cutTail(sanitize(excerpt), LOG_EXCERPT_CHARS)
  return {
    check: a.check.name,
    externalId: a.check.externalId,
    class: cls,
    summary: sanitize(`${a.check.name} (${cls}): ${cause}`).slice(0, SUMMARY_MAX),
    diagnostics: diagnosticsFrom(annotations),
    ...(diagnosticsCount(annotations) > DIAGNOSTICS_MAX ? { diagnosticsTotal: diagnosticsCount(annotations) } : {}),
    ...(logExcerpt !== undefined ? { logExcerpt } : {}),
    ...(a.check.detailsUrl ? { url: sanitize(a.check.detailsUrl) } : {})
  }
}

/** The failed steps' log of Actions job `jobId` (a check run's databaseId). gh gives none while any job of the run is
 *  still going (measured: "run N is still in progress; logs will be available when it is complete"). */
export async function readJobLog(run: GhRunner, cwd: string, repo: GitHubRepo, jobId: number): Promise<{ ok: true; log: string } | GhFailed> {
  const r = await run(['run', 'view', '--job', String(jobId), '--log-failed', '--repo', ghRepoArg(repo)], cwd)
  return r.ok ? { ok: true, log: r.stdout } : { ok: false, ...ghFailureSentence(r) }
}

/** A check run's annotations (REST: the GraphQL id of a check run is not its databaseId), the objects of the answer. */
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
    if (!Array.isArray(rows)) return { ok: false, kind: 'other', message: 'the annotations answer is not a list' }
    return { ok: true, annotations: rows.filter((x): x is RawAnnotation => typeof x === 'object' && x !== null && !Array.isArray(x)) }
  } catch {
    return { ok: false, kind: 'other', message: 'the annotations answer is not JSON' }
  }
}
